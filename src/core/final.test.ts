import { describe, expect, it } from "vitest";
import { ARENA, LOOP_PHRASES, makeTitan, Stage } from "./titan";
import { Field, INK_FLOOR, newFrame, planPhrase, PLAYER_R, RAIN_SPARE, RAIN_TOP, SPENT_ALPHA, touch, Touch } from "./field";
import { GENTLE_S, Hunt, Input, STILL_AFTER, STILL_HOUNDS_AFTER, STILL_MUL } from "./hunt";
import { Bot } from "./bot/bot";
import { hash32 } from "./rng";
// @ts-ignore plain js module
import { REHEARSAL_HP, REHEARSAL_LEFT, REHEARSAL_RESONANCE, REHEARSAL_STAGE } from "../ui/localWorld.js";

// R6 final fixes: spent ink never strikes, rain is seen falling, a first hunt's rain spares the spawn, a still
// light strikes weakly and is hunted, and a rehearsal is a fight you have to play.

const LIVE = 2870491872;
const tc = (): Touch => ({ hit: false, grazes: [], nearest: 99 });

describe("spent ink", () => {
  it("a faded drop (alpha < SPENT_ALPHA) on the light only grazes; a whole one strikes", () => {
    const f = newFrame();
    f.bulletCount = 1;
    f.bulletIds[0] = 77;
    f.bullets.set([0, 1.2, 0.3, 0, 0.6, 3, 0, -4], 0); // a wall drop fading out near the foot, right on the light
    const t = touch(f, 0, 1.2, tc());
    expect(t.hit).toBe(false);
    expect(t.grazes).toEqual([77]);
    f.bullets[4] = 1;
    expect(touch(f, 0, 1.2, tc()).hit).toBe(true);
  });

  it("no sampled wall or rain drop drawn below SPENT_ALPHA can strike, for any titan, stage or moment", () => {
    let faded = 0;
    for (const seed of [LIVE, 10, 14, 33, 2]) {
      const field = new Field(makeTitan(seed, 1));
      const f = newFrame();
      for (const stage of [0, 1, 2] as Stage[])
        for (let t = 30; t < 230; t += 0.37) {
          field.sample(t, stage, f);
          for (let i = 0; i < f.bulletCount; i++) {
            const o = i * 8;
            if (f.bullets[o + 4] >= SPENT_ALPHA) continue;
            faded++;
            expect(f.bullets[o + 1]).toBeGreaterThanOrEqual(INK_FLOOR);
            const one = newFrame(1);
            one.bulletCount = 1;
            one.bullets.set(f.bullets.subarray(o, o + 8), 0);
            const r = touch(one, f.bullets[o], f.bullets[o + 1], tc());
            expect(r.hit).toBe(false);
            expect(r.grazes).toHaveLength(1);
          }
        }
    }
    expect(faded).toBeGreaterThan(50);
  });
});

describe("rain", () => {
  it("leaves from above the page: every drop is seen falling for >= 0.25 s before it can reach a light on the top row", () => {
    const topLight = ARENA.H - 1.2; // hunt.ts clamps y here
    let rains = 0;
    for (let seed = 1; seed < 40; seed++) {
      const spec = makeTitan(seed, 1);
      for (let ph = 0; ph < LOOP_PHRASES; ph++)
        for (const stage of [0, 1, 2] as Stage[])
          for (const v of planPhrase(spec, ph, stage).volleys) {
            if (v.kind !== "rain") continue;
            rains++;
            const seen = (RAIN_TOP - (topLight + v.p.rad + PLAYER_R)) / v.p.speed; // seconds from leaving to striking
            expect(seen).toBeGreaterThanOrEqual(0.25);
          }
    }
    expect(rains).toBeGreaterThan(100);
    // and the first sample of every drop is above the page
    const field = new Field(makeTitan(LIVE, 1));
    const f = newFrame();
    const first = new Map<number, number>();
    for (let t = 100; t < 160; t += 1 / 60) {
      field.sample(t, 1, f);
      for (let i = 0; i < f.bulletCount; i++) if (f.bullets[i * 8 + 5] === 4 && !first.has(f.bulletIds[i])) first.set(f.bulletIds[i], f.bullets[i * 8 + 1]);
    }
    expect(first.size).toBeGreaterThan(20);
    for (const y of first.values()) expect(y).toBeGreaterThan(ARENA.TOP + 1.5);
  });

  it("a first hunt's grace field keeps every other rain column, none within RAIN_SPARE of the spawn, then the whole page", () => {
    const spec = makeTitan(LIVE, 1);
    const field = new Field(spec);
    const t0 = 6400;
    const h = new Hunt(spec, field, "ember", { gentle: true });
    h.place(t0, 0);
    expect(h.thin?.x).toBe(h.x);
    const shared = newFrame(),
      mine = newFrame();
    let cols = 0,
      fewer = 0;
    for (let s = 0; s < GENTLE_S - 3; s += 0.25) {
      field.sample(t0 + s, 0, shared);
      field.sample(t0 + s, 0, mine, h.thin);
      for (let i = 0; i < mine.bulletCount; i++) {
        if (mine.bullets[i * 8 + 5] !== 4) continue; // rain
        expect(Math.abs(mine.bullets[i * 8] - h.x)).toBeGreaterThanOrEqual(RAIN_SPARE - 1e-6);
      }
      const rain = (fr: ReturnType<typeof newFrame>) => Array.from({ length: fr.bulletCount }, (_, i) => fr.bullets[i * 8 + 5]).filter((k) => k === 4).length;
      const a = rain(shared),
        b = rain(mine);
      cols += a;
      if (b < a) fewer++;
    }
    expect(cols).toBeGreaterThan(0);
    expect(fewer).toBeGreaterThan(0);
    // after the grace field, this hunter's rain is the shared page's
    field.sample(t0 + 60, 0, shared);
    field.sample(t0 + 60, 0, mine, h.thin);
    expect(mine.bulletCount).toBe(shared.bulletCount);
  });
});

describe("a still light", () => {
  // an empty field (no ink), titan seed LIVE: only the hunter's own hounds
  const quiet = () => {
    const spec = makeTitan(LIVE, 1);
    const field = new Field(spec);
    field.sample = (_t, _s, f) => {
      f.bulletCount = f.beamCount = f.ringCount = f.zoneCount = f.markCount = 0;
    };
    return { spec, field };
  };
  const run = (move: boolean, secs: number, opts: { gentle?: boolean } = {}, houndsOff = true) => {
    const { spec, field } = quiet();
    const h = new Hunt(spec, field, "ember", opts);
    if (houndsOff) h.houndsAfter = 1e9;
    const dmgAt: number[] = [];
    for (let i = 0; i < secs * 60 && h.alive; i++) {
      // a mover sways left and right across the middle
      const inp: Input = move ? { mx: Math.sin(i / 30) > 0 ? 1 : -1, my: 0, dash: false } : { mx: 0, my: 0, dash: false };
      h.step(600 + i / 60, 1 / 60, inp, 0);
      dmgAt.push(h.damage);
    }
    return { h, dmgAt };
  };

  it(`strikes at ${STILL_MUL * 100}% once it has been still for ${STILL_AFTER} s; moving restores full strength`, () => {
    const still = run(false, 40).h;
    const moving = run(true, 40).h;
    expect(still.still).toBe(true);
    expect(moving.still).toBe(false);
    // the same cores, the same windows: a still light deals well under half of what a moving one does
    expect(still.damage).toBeLessThan(moving.damage * 0.55);
    expect(still.damage).toBeGreaterThan(moving.damage * 0.25);
    // and in its first STILL_AFTER seconds it strikes in full
    const s = new Hunt(makeTitan(LIVE, 1), quiet().field, "ember");
    for (let i = 0; i < (STILL_AFTER - 0.5) * 60; i++) s.step(600 + i / 60, 1 / 60, { mx: 0, my: 0, dash: false }, 0);
    expect(s.still).toBe(false);
  });

  it(`in a first hunt's grace field, hounds come for a light still for ${STILL_HOUNDS_AFTER} s, not before, and stop when it moves`, () => {
    const { spec, field } = quiet();
    const h = new Hunt(spec, field, "ember", { gentle: true });
    const aims = () => Array.from({ length: h.frame.beamCount }, (_, i) => h.frame.beams[i * 7 + 5]).filter((l) => l === 0).length; // hound aim lines
    let firstAim = -1;
    for (let i = 0; i < 14 * 60; i++) {
      h.step(600 + i / 60, 1 / 60, { mx: 0, my: 0, dash: false }, 0);
      if (firstAim < 0 && aims() > 0) firstAim = h.time;
    }
    expect(firstAim).toBeGreaterThan(STILL_HOUNDS_AFTER);
    expect(firstAim).toBeLessThan(STILL_HOUNDS_AFTER + 3);
    expect(h.time).toBeLessThan(GENTLE_S); // all inside the grace field
    // it moves: no new hound winds up while it keeps moving (the ones already thrown fly on)
    let wound = 0;
    for (let i = 0; i < 5 * 60; i++) {
      h.step(614 + i / 60, 1 / 60, { mx: Math.sin(i / 20) > 0 ? 1 : -1, my: 0, dash: false }, 0);
      if (i > 2 * 60 && aims() > 0) wound++;
    }
    expect(wound).toBe(0);
    // a light that keeps moving through the grace field never meets a hound before it ends
    const m = run(true, GENTLE_S - 1, { gentle: true }, false).h;
    expect(m.houndWarned).toBe(false);
  });

  it("an idle light (no input at all) on the live titan lives far shorter and strikes far less than R6's 26-30 s and ~1,900 blows", () => {
    const rows: string[] = [];
    for (const [t0, gentle] of [[1500, false], [6400, false], [1500, true], [6400, true]] as const) {
      const spec = makeTitan(LIVE, 1);
      const h = new Hunt(spec, new Field(spec), "ember", { gentle });
      for (let i = 0; i < 90 * 60 && h.alive; i++) h.step(t0 + i / 60, 1 / 60, { mx: 0, my: 0, dash: false }, 0);
      rows.push(`t0 ${t0} gentle ${gentle}: ${h.time.toFixed(1)} s, ${Math.round(h.damage)} blows`);
      expect(h.alive).toBe(false);
      expect(h.time).toBeLessThan(20);
      expect(h.damage).toBeLessThan(800);
    }
    console.log(rows.join("\n"));
  });
});

describe("the end of a first hunt's grace", () => {
  it("graceEnding is up for the last seconds of the grace field, and graceEndedAt marks when the titan stops holding back", () => {
    const spec = makeTitan(LIVE, 1);
    const field = new Field(spec);
    field.sample = (_t, _s, f) => {
      f.bulletCount = f.beamCount = f.ringCount = f.zoneCount = f.markCount = 0;
    };
    const h = new Hunt(spec, field, "ember", { gentle: true });
    h.houndsAfter = 1e9;
    let warnedAt = -1;
    for (let i = 0; i < 25 * 60; i++) {
      h.step(600 + i / 60, 1 / 60, { mx: Math.sin(i / 25) > 0 ? 1 : -1, my: 0, dash: false }, 0);
      if (warnedAt < 0 && h.graceEnding) warnedAt = h.time;
    }
    expect(warnedAt).toBeGreaterThan(GENTLE_S - 2.2);
    expect(warnedAt).toBeLessThan(GENTLE_S - 1.5);
    expect(h.graceEnding).toBe(false);
    expect(h.graceEndedAt).toBeGreaterThan(GENTLE_S - 0.1);
    expect(h.graceEndedAt).toBeLessThan(GENTLE_S + 0.1);
    expect(new Hunt(spec, field, "ember").graceEndedAt).toBe(-1);
  });
});

describe("a rehearsal is a fight you play", () => {
  // harness: the rehearsal's own rules (core/hunt.ts forgiving, Resonance REHEARSAL_RESONANCE, Wrath), its
  // titan ~REHEARSAL_LEFT of a life from falling; the player decides with a human reaction delay
  const HP = Math.round(REHEARSAL_HP * REHEARSAL_LEFT);
  function rehearse(seed: number, t0: number, who: "idle" | "player") {
    const spec = makeTitan(seed, 1);
    const field = new Field(spec);
    const h = new Hunt(spec, field, "ember", { forgiving: true, gentle: false });
    h.resonance = REHEARSAL_RESONANCE;
    const bot = who === "idle" ? null : new Bot(field, 1, 0.5);
    let inp: Input = { mx: 0, my: 0, dash: false };
    let next = 0;
    let surge = -1;
    for (let i = 0; i < 60 * 60; i++) {
      const t = t0 + i / 60;
      if (bot && h.time >= next) {
        inp = bot.decide(h, t, REHEARSAL_STAGE);
        next = h.time + 0.18;
      }
      h.step(t, 1 / 60, inp, REHEARSAL_STAGE);
      if (surge < 0 && h.surges > 0) surge = h.time;
      if (h.damage >= HP) return { fall: h.time, surge };
    }
    return { fall: Infinity, surge };
  }
  const seeds = Array.from({ length: 8 }, (_, k) => hash32("rehearsal", 1_700_000_000_000 + k * 7919));

  it("no input never fells it in under 10 s; a player fells it in ~10-15 s (median), its Surge over before the fall", () => {
    const idle = seeds.map((s) => rehearse(s, 42, "idle"));
    const play = seeds.map((s) => rehearse(s, 42, "player"));
    const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    console.log(`rehearsal ${HP}: idle ${idle.map((r) => r.fall.toFixed(1)).join(", ")} | player ${play.map((r) => `${r.fall.toFixed(1)} (surge ${r.surge.toFixed(1)})`).join(", ")}`);
    for (const r of idle) expect(r.fall).toBeGreaterThan(10);
    const m = med(play.map((r) => r.fall));
    expect(m).toBeGreaterThan(9);
    expect(m).toBeLessThan(17);
    // the Surge comes early (once the spawn grace is over) and has ended before the fall in nearly every fight
    const before = play.filter((r) => r.surge > 0 && r.surge + 3.2 < r.fall).length;
    expect(before).toBeGreaterThanOrEqual(play.length - 1);
    for (const r of play) expect(r.surge).toBeGreaterThan(2.5);
  }, 300_000);
});

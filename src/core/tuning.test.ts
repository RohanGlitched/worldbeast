import { describe, expect, it } from "vitest";
import { ARENA, archetypeOf, makeTitan, PHRASE_BEATS, LOOP_PHRASES, seedUnlike, Stage } from "./titan";
import { Field, gapSight, GAP, newFrame, planPhrase, rainColumns, RING_FLOOR, touch, Touch } from "./field";
import { FORGIVE_COST, Hunt, marginMul, MAX_HITS, MAX_RELIGHTS, RELIGHT_AFTER } from "./hunt";

// R5 tuning: a gentler Calm, shockwaves that never trap you on the floor, relights you can see, a rehearsal
// that cannot fail, and titans that never repeat a body.

const LIVE = 2870491872;

describe("Calm", () => {
  it("has no rail hems and no corner footfalls; they begin in Wrath", () => {
    for (const seed of [LIVE, 10, 14, 33]) {
      const spec = makeTitan(seed, 1);
      for (let ph = 0; ph < LOOP_PHRASES; ph++) {
        const calm = planPhrase(spec, ph, 0).volleys;
        expect(calm.filter((v) => v.p.hem)).toHaveLength(0);
        for (const v of calm.filter((v) => v.kind === "slam")) expect(v.p.tread).toBe(0);
        const wrath = planPhrase(spec, ph, 1).volleys;
        expect(wrath.filter((v) => v.p.hem).length).toBeGreaterThan(0);
        for (const v of wrath.filter((v) => v.kind === "slam")) expect(v.p.tread).toBe(1);
      }
    }
  });

  it("puts rail columns in at most one rain in three", () => {
    let rains = 0, railed = 0;
    for (let seed = 1; seed < 60; seed++) {
      const spec = makeTitan(seed, 1);
      for (let ph = 0; ph < LOOP_PHRASES; ph++)
        for (const v of planPhrase(spec, ph, 0).volleys) {
          if (v.kind !== "rain") continue;
          rains++;
          const rail = ARENA.W / 2 - 0.45;
          if (rainColumns(v.p).some((x) => Math.abs(Math.abs(x) - rail) < 1e-6)) railed++;
        }
    }
    expect(rains).toBeGreaterThan(50);
    expect(railed / rains).toBeLessThan(0.4);
  });
});

describe("shockwaves", () => {
  const slams = (stage: Stage) => {
    const out = [];
    for (let seed = 1; seed < 80; seed++) {
      const spec = makeTitan(seed, 1);
      for (let ph = 0; ph < LOOP_PHRASES; ph++) for (const v of planPhrase(spec, ph, stage).volleys) if (v.kind === "slam") out.push(v);
    }
    return out;
  };

  it("in Calm and Wrath: one ring, two gaps at least 1.6 wide and well apart", () => {
    for (const stage of [0, 1] as Stage[]) {
      const s = slams(stage);
      expect(s.length).toBeGreaterThan(10);
      for (const v of s) {
        expect(v.p.rings).toBe(1);
        expect(v.p.gapW).toBeGreaterThanOrEqual(1.6);
        const TAU = 2 * Math.PI;
        const delta = (((v.p.gapB - v.p.gapA) % TAU) + TAU) % TAU;
        expect(Math.min(delta, TAU - delta)).toBeGreaterThan(v.p.gapW); // the gaps never overlap
      }
    }
  });

  it("are ~15% slower in Calm and Wrath than in Ruin", () => {
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const calm = mean(slams(0).map((v) => v.p.speed));
    const ruin = mean(slams(2).filter((v) => v.p.rings < 3).map((v) => v.p.speed)) / 1.16;
    expect(calm / ruin).toBeGreaterThan(0.8);
    expect(calm / ruin).toBeLessThan(0.9);
  });

  it("spend themselves above the foot of the page: a hunter in the bottom lane is never struck by a ring", () => {
    const f = newFrame();
    const tc: Touch = { hit: false, grazes: [], nearest: 99 };
    f.ringCount = 1;
    f.rings.set([0, 5, 5, 0.32, 0, 0.01, 0, 1, 0], 0); // a ring of radius 5 around (0,5): it crosses (0,0)
    expect(touch(f, 0, 0.4, tc).hit).toBe(false);
    expect(touch(f, 0, RING_FLOOR - 0.01, tc).hit).toBe(false);
    expect(touch(f, 0, 10, tc).hit).toBe(true);
  });

  it("show their gaps on the rails or the foot of the page, from the telegraph on", () => {
    expect(gapSight(0, 10, 0, 12)).toEqual({ x: ARENA.W / 2 + 0.35, y: 10 }); // straight right: the right rail
    const down = gapSight(0, 10, -Math.PI / 2, 12)!;
    expect(down.y).toBeLessThan(0); // straight down: under the arena's foot
    expect(gapSight(0, 10, Math.PI / 2, 12)).toBeNull(); // up into the titan
    expect(gapSight(0, 10, 0, 4)).toBeNull(); // spent before the rail
    // a live Calm slam pushes its sights as GAP marks
    for (let seed = 1; seed < 40; seed++) {
      const spec = makeTitan(seed, 1);
      const field = new Field(spec);
      const v = planPhrase(spec, 1, 0).volleys.find((x) => x.kind === "slam");
      if (!v) continue;
      const f = newFrame();
      field.sample((PHRASE_BEATS + v.beat - 0.5) * spec.beat, 0, f); // telegraphing
      let gaps = 0;
      for (let i = 0; i < f.markCount; i++) if (f.marks[i * 4 + 3] >= GAP) gaps++;
      expect(gaps).toBeGreaterThan(0);
      return;
    }
    throw new Error("no Calm slam found");
  });
});

describe("lights", () => {
  const still = (h: Hunt, secs: number, t0: number) => {
    for (let i = 0; i < secs * 60; i++) h.step(t0 + i / 60, 1 / 60, { mx: 0, my: 0, dash: false }, 0);
  };
  // an empty field: a titan whose plan never fires in the window (phrase 0 has two silent bars)
  const quiet = () => {
    const spec = makeTitan(LIVE, 1);
    const field = new Field(spec);
    field.sample = (_t, _s, f) => {
      f.bulletCount = f.beamCount = f.ringCount = f.zoneCount = f.markCount = 0;
    };
    return { spec, field };
  };

  it(`a lost light returns after ${RELIGHT_AFTER} s unstruck, at most ${MAX_RELIGHTS} a run`, () => {
    const { spec, field } = quiet();
    const h = new Hunt(spec, field, "ember");
    h.houndsAfter = 1e9;
    still(h, 1, 0);
    h.hits = 2;
    (h as any).lastHitAt = h.time;
    still(h, RELIGHT_AFTER - 0.5, 1);
    expect(h.hits).toBe(2);
    still(h, 1, 100);
    expect(h.hits).toBe(1);
    expect(h.relights).toBe(1);
    for (let k = 0; k < 6; k++) {
      h.hits = 2;
      still(h, RELIGHT_AFTER + 0.2, 200 + k * 30);
    }
    expect(h.relights).toBe(MAX_RELIGHTS);
  });

  it("a Surge rekindles a lost light too", () => {
    const { spec, field } = quiet();
    const h = new Hunt(spec, field, "ember");
    h.houndsAfter = 1e9;
    h.hits = 1;
    h.resonance = 100;
    // step until a core is open and the Surge fires
    let t = 0;
    while (h.surges === 0 && t < 120) {
      h.step(t, 1 / 60, { mx: 0, my: 0, dash: false }, 0);
      t += 1 / 60;
    }
    expect(h.surges).toBe(1);
    expect(h.hits).toBe(0);
    expect(h.relights).toBe(1);
  });

  it("a forgiving hunt (a rehearsal) never loses a light: a hit costs Resonance", () => {
    const spec = makeTitan(LIVE, 1);
    const field = new Field(spec);
    const h = new Hunt(spec, field, "ember", { forgiving: true });
    h.resonance = 80;
    h.invuln = 0;
    h.inGrace = false;
    h.autoSpawn = false;
    // park on a live hazard: a bullet placed on the hunter every frame
    field.sample = (_t, _s, f) => {
      f.beamCount = f.ringCount = f.zoneCount = f.markCount = 0;
      f.bulletCount = 1;
      f.bullets.set([h.x, h.y, 0.3, 0, 1, 0, 0, 0], 0);
    };
    for (let i = 0; i < 60 * 20; i++) h.step(i / 60, 1 / 60, { mx: 0, my: 0, dash: false }, 1);
    expect(h.alive).toBe(true);
    expect(h.hits).toBe(0);
    expect(h.forgiven).toBeGreaterThan(MAX_HITS);
    expect(h.hurtEvents).toBe(h.forgiven);
    expect(h.resonance).toBeLessThanOrEqual(80 - FORGIVE_COST);
    const plain = new Hunt(spec, field, "ember");
    expect(plain.forgiving).toBe(false);
  });

  it("blows from the margins glance off", () => {
    expect(marginMul(0)).toBe(1);
    expect(marginMul(5)).toBe(1);
    expect(marginMul(ARENA.W / 2 - 0.5)).toBe(0.7);
    expect(marginMul(-(ARENA.W / 2 - 0.5))).toBe(0.7);
  });
});

describe("the next titan", () => {
  it("never repeats the archetype it must avoid, and keeps the first candidate when it already differs", () => {
    for (let s = 1; s < 300; s++) {
      const avoid = archetypeOf(s);
      const next = seedUnlike((k) => s * 7919 + k * 104729, avoid);
      expect(archetypeOf(next)).not.toBe(avoid);
      expect(makeTitan(next, 2).archetype).toBe(archetypeOf(next));
    }
    expect(seedUnlike(() => 12345, null)).toBe(12345);
    const a = archetypeOf(12345);
    const other = (["coil", "strider", "bloom", "throne", "swarmheart"] as const).find((x) => x !== a)!;
    expect(seedUnlike((k) => 12345 + k, other)).toBe(12345);
  });
});

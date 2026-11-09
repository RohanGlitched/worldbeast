import { describe, expect, it } from "vitest";
import { ARENA, archetypeOf, makeTitan, PHRASE_BEATS, LOOP_PHRASES, seedUnlike, Stage } from "./titan";
import { BEAM_POCKET, beamEndSight, Field, FOOT_CORNER, gapSight, GAP, INK_FLOOR, newFrame, planPhrase, rainColumns, RING_FLOOR, thinned, touch, Touch } from "./field";
import { FORGIVE_COST, GENTLE_GRACE, GENTLE_HEAVY_S, GENTLE_S, Hunt, marginMul, MAX_HITS, MAX_RELIGHTS, RELIGHT_AFTER } from "./hunt";

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

describe("R6: beams, the foot of the page, first hunts", () => {
  const each = (stage: Stage, fn: (v: any, spec: any, ph: number) => void) => {
    for (const seed of [LIVE, 2, 7, 10, 14, 33, 99, 1234, 777, 4242]) {
      const spec = makeTitan(seed, 1);
      for (let ph = 0; ph < LOOP_PHRASES; ph++) for (const v of planPhrase(spec, ph, stage).volleys) fn(v, spec, ph);
    }
  };

  it("a beam's sweep stops at least BEAM_POCKET short of the foot corner it swings toward", () => {
    let n = 0;
    for (const stage of [0, 1, 2] as Stage[])
      each(stage, (v) => {
        if (v.kind !== "beam" || v.p.twin) return;
        n++;
        const dir = Math.sign(v.p.a2 - v.p.a1);
        const cx = dir * FOOT_CORNER.x, cy = FOOT_CORNER.y;
        // distance from the corner to the beam's centre line at its last angle
        const ux = Math.cos(v.p.a2), uy = Math.sin(v.p.a2);
        const d = Math.abs((cx - v.p.ox) * uy - (cy - v.p.oy) * ux);
        expect(d - v.p.width / 2).toBeGreaterThanOrEqual(BEAM_POCKET - 1e-6);
        expect(Math.abs(v.p.a2 - v.p.a1)).toBeGreaterThanOrEqual(0.25 - 1e-9);
      });
    expect(n).toBeGreaterThan(10);
  });

  it("marks where a beam's sweep will stop with a gilt tick, from its telegraph to its end", () => {
    each(0, (v, spec, ph) => {
      if (v.kind !== "beam") return;
      const field = new Field(spec);
      for (const age of [-1, 0.5, v.p.dur - 0.5]) {
        const f = newFrame();
        field.sample(((ph + LOOP_PHRASES) * PHRASE_BEATS + v.beat + age) * spec.beat, 0, f);
        const end = beamEndSight(v.p.ox, v.p.oy, v.p.a2);
        let found = false;
        for (let i = 0; i < f.markCount; i++) if (f.marks[i * 4 + 3] >= GAP && Math.abs(f.marks[i * 4] - end.x) < 1e-3 && Math.abs(f.marks[i * 4 + 1] - end.y) < 1e-3) found = true;
        expect(found).toBe(true);
      }
    });
  });

  it("walls and rain spend themselves above the foot of the page (INK_FLOOR), fading as they go", () => {
    for (const stage of [0, 1, 2] as Stage[])
      for (const seed of [LIVE, 14, 10]) {
        const spec = makeTitan(seed, 1);
        const field = new Field(spec);
        const f = newFrame();
        const WALL = 3, RAIN = 4; // KIND_LIST indices
        for (let b = 0; b < PHRASE_BEATS * 2; b += 0.25) {
          field.sample((PHRASE_BEATS + b) * spec.beat, stage, f);
          for (let i = 0; i < f.bulletCount; i++) {
            const k = f.bullets[i * 8 + 5];
            if (k !== WALL && k !== RAIN) continue;
            expect(f.bullets[i * 8 + 1]).toBeGreaterThanOrEqual(INK_FLOOR);
            if (f.bullets[i * 8 + 1] < 1.5) expect(f.bullets[i * 8 + 4]).toBeLessThan(1);
          }
        }
      }
  });

  it("a first hunt's grace field: lead volleys only for 20 s, no walls or beams for 12 s, then the full page", () => {
    const spec = makeTitan(LIVE, 1);
    const field = new Field(spec);
    const t0 = 6400;
    const h = new Hunt(spec, field, "ember", { gentle: true });
    expect(h.invuln).toBe(GENTLE_GRACE);
    expect(h.houndsAfter).toBe(GENTLE_S);
    h.place(t0, 0);
    expect(h.thin).toEqual({ until: t0 + GENTLE_S, heavyUntil: t0 + GENTLE_HEAVY_S });
    let hidden = 0, kept = 0;
    each(0, (v) => {
      for (const s of [t0 - 5, t0 + 5, t0 + 15, t0 + 25]) {
        const out = thinned(v, s, h.thin);
        if (s >= t0 + GENTLE_S) expect(out).toBe(false);
        else if ((v.sub ?? 0) > 0) expect(out).toBe(true);
        else if (s < t0 + GENTLE_HEAVY_S && (v.kind === "wall" || v.kind === "beam")) expect(out).toBe(true);
        else expect(out).toBe(false);
        out ? hidden++ : kept++;
      }
    });
    expect(hidden).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(hidden);
    // what this hunter sees is thinner than the shared page in the first seconds, and the same after
    const shared = newFrame(), mine = newFrame();
    let less = 0;
    for (let s = 0; s < GENTLE_S; s += 0.5) {
      field.sample(t0 + s, 0, shared);
      field.sample(t0 + s, 0, mine, h.thin);
      expect(mine.bulletCount + mine.beamCount).toBeLessThanOrEqual(shared.bulletCount + shared.beamCount);
      if (mine.bulletCount + mine.beamCount < shared.bulletCount + shared.beamCount) less++;
    }
    expect(less).toBeGreaterThan(5);
    field.sample(t0 + 60, 0, shared);
    field.sample(t0 + 60, 0, mine, h.thin);
    expect(mine.bulletCount).toBe(shared.bulletCount);
    expect(new Hunt(spec, field, "ember").thin).toBeNull();
  });

  it("in Calm a beam's hit keeps you safe until its sweep ends, however long", () => {
    const spec = makeTitan(LIVE, 1);
    const field = new Field(spec);
    field.beamLeft = () => 5.6;
    const sit = (stage: Stage) => {
      const h = new Hunt(spec, field, "ember");
      h.invuln = 0;
      h.inGrace = false;
      h.autoSpawn = false;
      h.houndsAfter = 1e9;
      field.sample = (_t, _s, f) => {
        f.bulletCount = f.ringCount = f.zoneCount = f.markCount = 0;
        f.beamCount = 1;
        f.beams.set([h.x, h.y + 5, h.x, h.y - 5, 0.5, 1, 0], 0);
      };
      h.step(100, 1 / 60, { mx: 0, my: 0, dash: false }, stage);
      return h.invuln;
    };
    expect(sit(0)).toBeGreaterThan(5.5);
    expect(sit(1)).toBeLessThanOrEqual(4.5);
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

  it("never repeats the epithet of the titan just ended either (R5: two 'Salt Regent's in a row)", () => {
    let moved = 0;
    for (let s = 1; s < 400; s++) {
      const prev = makeTitan(s, 1);
      const next = seedUnlike((k) => (s * 7919 + k * 104729) >>> 0, prev.archetype, prev.epithet);
      const spec = makeTitan(next, 2);
      expect(spec.archetype).not.toBe(prev.archetype);
      expect(spec.epithet).not.toBe(prev.epithet);
      if (next !== seedUnlike((k) => (s * 7919 + k * 104729) >>> 0, prev.archetype)) moved++;
    }
    expect(moved).toBeGreaterThan(0); // the rule did bite somewhere
    // a candidate that already differs on both is kept (an awake titan's name never changes)
    const a = makeTitan(12345, 1);
    const other = makeTitan(777, 1);
    if (other.archetype !== a.archetype && other.epithet !== a.epithet) expect(seedUnlike(() => 12345, other.archetype, other.epithet)).toBe(12345);
  });
});

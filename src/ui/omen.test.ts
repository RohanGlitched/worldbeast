import { describe, expect, it } from "vitest";
import { omenFor, judgeOmen, liveStreak, dayIndex, OMEN_POOL } from "./omen";

const run = (o: Partial<Record<string, unknown>> = {}) => ({ grazes: 0, time: 0, damage: 0, surges: 0, cleanTime: 0, bestCombo: 0, aspect: "ember", ...o });
const DAY = 86_400_000;

describe("daily omen", () => {
  it("is the same for everyone on a day and varies across days", () => {
    const d = dayIndex(Date.UTC(2026, 10, 9, 12));
    expect(omenFor(d).text).toBe(omenFor(d).text);
    const texts = new Set(Array.from({ length: 30 }, (_, i) => omenFor(d + i).text));
    expect(texts.size).toBeGreaterThan(10);
  });

  it("a superhuman run fulfils any omen when it bears the asked light", () => {
    for (let d = 20000; d < 20060; d++) {
      const o = omenFor(d);
      const s = run({ grazes: 999, time: 999, damage: 99999, surges: 9, cleanTime: 999, bestCombo: 99, aspect: o.aspect ?? "ember" });
      expect(o.test(s)).toBe(true);
      if (o.aspect) expect(o.test({ ...s, aspect: o.aspect === "ember" ? "lance" : "ember" })).toBe(false);
      expect(o.test(run())).toBe(false);
    }
  });

  it("is within a decent hunter's reach: a typical run (measured medians) fulfils most omens, a weak one some", () => {
    // medians of non-first Calm/Wrath hunts on the live Strider (human-model harness, Nov 9): 36 s alight,
    // 14.6 s clean, 23 grazes, best chain 7, 1 Surge, 2,250 blows; the weak run is about the 25th percentile
    const typical = run({ time: 36, cleanTime: 14.6, grazes: 23, bestCombo: 7, surges: 1, damage: 2250 });
    const weak = run({ time: 22, cleanTime: 9, grazes: 13, bestCombo: 4, surges: 1, damage: 1100 });
    let met = 0, weakMet = 0, days = 0;
    for (let d = 20000; d < 20365; d++) {
      const o = omenFor(d);
      const asp = o.aspect ?? "ember";
      days++;
      if (o.test({ ...typical, aspect: asp })) met++;
      if (o.test({ ...weak, aspect: asp })) weakMet++;
    }
    expect(met / days).toBeGreaterThan(0.6);
    expect(weakMet / days).toBeGreaterThan(0.25);
    // and nothing asks for more than R4's longest clean stretch (20.5 s) or a minute alight
    for (const k of OMEN_POOL) {
      if (k.id === "clean") expect(Math.max(...k.ns)).toBeLessThanOrEqual(20);
      if (k.id === "time") expect(Math.max(...k.ns)).toBeLessThanOrEqual(60);
    }
    expect(omenFor(20001).text).toMatch(/\.$/);
  });

  it("counts a streak once a day and lapses after a missed day", () => {
    const t0 = Date.UTC(2026, 10, 9, 10);
    const strong = (t: number) => run({ grazes: 999, time: 999, damage: 99999, surges: 9, cleanTime: 999, bestCombo: 99, aspect: omenFor(dayIndex(t)).aspect ?? "ember" });
    let p: Record<string, number> = {};
    p = { ...p, ...judgeOmen(p, strong(t0), t0)! };
    expect(p.omenStreak).toBe(1);
    expect(judgeOmen(p, strong(t0), t0 + 1000)).toBeNull(); // once a day
    p = { ...p, ...judgeOmen(p, strong(t0 + DAY), t0 + DAY)! };
    expect(p.omenStreak).toBe(2);
    expect(liveStreak(p, dayIndex(t0 + 2 * DAY))).toBe(2); // still alive the next day
    expect(liveStreak(p, dayIndex(t0 + 3 * DAY))).toBe(0); // lapsed
    p = { ...p, ...judgeOmen(p, strong(t0 + 3 * DAY), t0 + 3 * DAY)! };
    expect(p.omenStreak).toBe(1);
    expect(p.omenBest).toBe(2);
  });
});

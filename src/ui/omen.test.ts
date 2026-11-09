import { describe, expect, it } from "vitest";
import { omenFor, judgeOmen, liveStreak, dayIndex } from "./omen";

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

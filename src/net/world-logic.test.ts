import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coreOpen, LOOP_BEATS, makeTitan, PHRASE_BEATS } from "@/core/titan";
import { maxDps } from "@/core/hunt";
import {
  ACTIVITY_H, addDamage, checkHit, checkRun, creditBlow, DmgBuckets, SOLO_RESIST, SOLO_SHARE, titanSeed, echoEviction, hashKey, HOUR_MS, HP_CAP, HP_FLOOR, HP_PER_HUNTER, hpMaxFor,
  LIFETIME_H, loopKey, maxHitDmg, prepareEcho, RATE_BUDGET, RateWindow, recentActivity, resizeTitan, Bucket, sanitizeName, segDist, stageAtT,
} from "../../base44/actors/world/logic";
import { decodePath, encodePath } from "./pathcodec";
import { decodeEcho, echoesAt } from "./echoes";

const spec = makeTitan(12345, 1);
const wokeAt = 1_700_000_000_000;
const at = (beat: number) => wokeAt + beat * spec.beat * 1000;

function findBeat(open: boolean, core = 0, from = 70) {
  for (let b = from; b < from + 400; b += 0.25) if (coreOpen(spec.cores[core], b, 0) === open) return b;
  throw new Error("no beat");
}

describe("hit validation", () => {
  const ctx = (beat: number, stage: 0 | 1 | 2 = 0) => ({ spec, stage, nowMs: at(beat), wokeAt });

  it("accepts a hit on an open core at the server's beat", () => {
    const b = findBeat(true);
    const r = checkHit([0, 12, b], ctx(b + 0.5));
    expect(r).toMatchObject({ ok: true, core: 0, dmg: 12 });
  });
  it("rejects a closed core", () => {
    const b = findBeat(false);
    expect(checkHit([0, 12, b], ctx(b))).toEqual({ ok: false, why: "closed" });
  });
  it("rejects beats more than 2 beats from the server clock", () => {
    const b = findBeat(true);
    expect(checkHit([0, 12, b], ctx(b + 2.5))).toEqual({ ok: false, why: "beat" });
    expect(checkHit([0, 12, b + 3], ctx(b))).toEqual({ ok: false, why: "beat" });
    expect(checkHit([0, 12, b], ctx(b + 1.9)).ok).toBe(true);
  });
  it("rejects garbage", () => {
    const b = findBeat(true);
    for (const row of [[0, NaN, b], [0, -5, b], [0, 0, b], [0, maxHitDmg() + 1, b], [99, 10, b], [0.5, 10, b], [0, 10, NaN], "x", null, [0, 10]])
      expect(checkHit(row, ctx(b))).toEqual({ ok: false, why: "bad" });
  });
  it("rejects hits before the titan wakes", () => {
    expect(checkHit([0, 10, 0], { spec, stage: 0, nowMs: wokeAt - 5000, wokeAt })).toEqual({ ok: false, why: "asleep" });
  });
  it("Ruin keeps cores open a little longer (server stage is never stricter)", () => {
    const [, end] = spec.cores[0].windows[0];
    const b = PHRASE_BEATS * 2 + end + 0.5;
    expect(checkHit([0, 10, b], ctx(b, 0)).ok).toBe(false);
    expect(checkHit([0, 10, b], ctx(b, 2)).ok).toBe(true);
  });
  it("max single hit covers every aspect's biggest dart", () => {
    expect(maxHitDmg()).toBeGreaterThanOrEqual(210);
    expect(maxHitDmg()).toBeLessThan(260);
  });
});

describe("damage rate", () => {
  it("caps a hunter at maxDps x 1.15 over a sliding 2 s window", () => {
    expect(RATE_BUDGET).toBeCloseTo(maxDps() * 1.15 * 2, 5);
    const w = new RateWindow(1000, 2000);
    let ok = 0;
    for (let i = 0; i < 20; i++) if (w.take(10_000 + i * 10, 100)) ok++;
    expect(ok).toBe(10);
    expect(w.take(11_000, 100)).toBe(false);
    expect(w.take(12_001, 100)).toBe(true); // window slid
  });
  it("token buckets limit message rates", () => {
    const b = new Bucket(2, 3);
    const t = 50_000;
    expect([b.take(t), b.take(t), b.take(t), b.take(t)]).toEqual([true, true, true, false]);
    expect(b.take(t + 500)).toBe(true);
  });
});

describe("adaptive hp", () => {
  const now = 100 * HOUR_MS + 1234;
  it("a quiet world gets a titan a few runs can fell (the floor), never more than the cap", () => {
    expect(HP_FLOOR).toBeGreaterThanOrEqual(8_000);
    expect(HP_FLOOR).toBeLessThanOrEqual(12_000);
    expect(hpMaxFor([], now)).toBe(HP_FLOOR);
    const b: DmgBuckets = [];
    addDamage(b, now, 1e12, 1);
    expect(hpMaxFor(b, now)).toBe(HP_CAP);
  });
  it("a handful of visitors a day: every titan is floor-sized, so one falls to a few runs and several fall a day", () => {
    // five hunters a day, one session each of ~10k blows, spread through the day
    const b: DmgBuckets = [];
    for (const h of [1, 6, 11, 16, 21]) addDamage(b, 100 * HOUR_MS - (24 - h) * HOUR_MS, 10_000, 1);
    for (let h = 0; h < 24; h++) expect(hpMaxFor(b, 100 * HOUR_MS - h * HOUR_MS)).toBeLessThanOrEqual(HP_FLOOR + 3_000);
    // a judge alone (2-3 runs of 1.5-5k blows) wounds a fresh floor titan to 40% struck at full strength
    expect(3 * 3_500).toBeGreaterThanOrEqual(HP_FLOOR * SOLO_SHARE);
  });
  it("credits one hunter in full up to 40% of the titan's life, then at a quarter", () => {
    expect(SOLO_SHARE).toBe(0.4);
    expect(SOLO_RESIST).toBe(0.25);
    expect(creditBlow(50, 0, 10_000)).toBe(50);
    expect(creditBlow(50, 3_990, 10_000)).toBe(10 + 40 * 0.25);
    expect(creditBlow(50, 5_000, 10_000)).toBe(12.5);
  });
  it("no titan falls to one hunter without a long siege; two need far less; three never meet the rule", () => {
    const blowsToFell = (hunters: number, hp = HP_FLOOR) => {
      const credited = new Array(hunters).fill(0);
      let left = hp, raw = 0, i = 0;
      while (left > 0) {
        const w = Math.min(left, creditBlow(10, credited[i], hp));
        credited[i] += w;
        left -= w;
        raw += 10;
        i = (i + 1) % hunters;
      }
      return raw;
    };
    expect(blowsToFell(1)).toBeGreaterThanOrEqual(27_000); // 4,000 + 6,000 x 4
    expect(blowsToFell(2)).toBeLessThan(17_000);
    expect(blowsToFell(3)).toBe(HP_FLOOR);
  });
  it("the next titan's seed avoids the archetype just felled, deterministically", () => {
    for (let n = 2; n < 200; n++) {
      const prev = makeTitan(titanSeed(n - 1, "salt"), n - 1).archetype;
      const s = titanSeed(n, "salt", prev);
      expect(makeTitan(s, n).archetype).not.toBe(prev);
      expect(titanSeed(n, "salt", prev)).toBe(s);
    }
    expect(titanSeed(1, "salt")).toBe(titanSeed(1, "salt", null)); // the first titan's seed is unchanged
  });
  it("grows with recent damage (lives ~LIFETIME_H at the last ACTIVITY_H hours' rate) and with the crowd", () => {
    const b: DmgBuckets = [];
    for (let h = 0; h < ACTIVITY_H; h++) addDamage(b, now - h * HOUR_MS, 60_000, 3);
    expect(recentActivity(b, now)).toEqual({ damage: 60_000 * ACTIVITY_H, hunters: 3 });
    expect(hpMaxFor(b, now)).toBe(60_000 * LIFETIME_H);
    // twenty hunters arriving together in one hour
    const c: DmgBuckets = [];
    addDamage(c, now, 30_000, 20);
    expect(hpMaxFor(c, now)).toBe(20 * HP_PER_HUNTER);
  });
  it("counts the busiest hour's hunters, keeps the larger count within an hour", () => {
    const b: DmgBuckets = [];
    addDamage(b, now, 10, 4);
    addDamage(b, now + 1000, 10, 2);
    expect(b).toEqual([[100, 20, 4]]);
  });
  it("forgets damage older than its window, and buckets older than a day", () => {
    const b: DmgBuckets = [];
    addDamage(b, 0, 9e9, 50);
    addDamage(b, 30 * HOUR_MS, 10);
    expect(b.length).toBe(1);
    expect(hpMaxFor(b, 30 * HOUR_MS)).toBe(HP_FLOOR);
    const c: DmgBuckets = [];
    addDamage(c, now - ACTIVITY_H * HOUR_MS, 9e9, 50);
    expect(hpMaxFor(c, now)).toBe(HP_FLOOR);
    // old two-field buckets (saved before hunters were counted) still read
    expect(hpMaxFor([[100, 3_000_000]] as DmgBuckets, now)).toBe(HP_CAP);
  });
  it("re-sizes an awake titan without inventing or erasing a blow", () => {
    // live titan #1 under the old rule: 40,000 and untouched
    expect(resizeTitan({ hpMax: 40_000, hp: 40_000 }, HP_FLOOR)).toEqual({ hpMax: HP_FLOOR, hp: HP_FLOOR });
    // 2,000 blows struck: they all still count
    expect(resizeTitan({ hpMax: 40_000, hp: 38_000 }, HP_FLOOR)).toEqual({ hpMax: 10_000, hp: 8_000 });
    // 30,000 struck: never left more than 3/4 struck, never felled by a re-size
    const r = resizeTitan({ hpMax: 60_000, hp: 30_000 }, HP_FLOOR)!;
    expect(r).toEqual({ hpMax: 40_000, hp: 10_000 });
    expect((r.hpMax - r.hp) / r.hpMax).toBeLessThanOrEqual(0.75);
    expect(resizeTitan({ hpMax: 40_000, hp: 10_000 }, HP_FLOOR)).toBeNull(); // already 3/4 struck: left as it is
    // never grows a titan
    expect(resizeTitan({ hpMax: 10_000, hp: 9_000 }, 50_000)).toBeNull();
  });
});

describe("identity", () => {
  it("sanitises names", () => {
    expect(sanitizeName("  Ana  ")).toBe("Ana");
    expect(sanitizeName("visit http://evil.com now")).not.toMatch(/http|evil\.com/);
    expect(sanitizeName("www.spam.io")).not.toMatch(/www|spam\.io/);
    expect(sanitizeName("a".repeat(40)).length).toBe(18);
    expect(sanitizeName("<script>x</script>")).not.toMatch(/[<>]/);
    expect(sanitizeName("\u0000​")).toBe("Hunter");
    expect(sanitizeName(42)).toBe("Hunter");
  });
  it("hashes keys with the salt", () => {
    expect(hashKey("ab".repeat(16), "s1")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashKey("ab".repeat(16), "s1")).not.toBe(hashKey("ab".repeat(16), "s2"));
  });
});

describe("runs", () => {
  it("clamps damage to what the world accepted", () => {
    expect(checkRun({ damage: 500, time: 30, startT: 100 }, 480, 135)).toMatchObject({ ok: true, damage: 500, clamped: false });
    expect(checkRun({ damage: 99999, time: 30, startT: 100 }, 480, 135)).toMatchObject({ ok: true, damage: 480, clamped: true });
  });
  it("rejects impossible times", () => {
    expect(checkRun({ damage: 10, time: 300, startT: 100 }, 10, 135).ok).toBe(false);
    expect(checkRun({ damage: 10, time: -1, startT: 100 }, 10, 135).ok).toBe(false);
    expect(checkRun({ damage: NaN, time: 3, startT: 100 }, 10, 135).ok).toBe(false);
    expect(checkRun({ damage: 10, time: 3, startT: 500 }, 10, 135).ok).toBe(false);
  });
});

describe("paths and echoes", () => {
  const walk = (n: number, jump = -1) => {
    const flat: number[] = [];
    for (let i = 0; i < n; i++) flat.push(Math.round(Math.sin(i / 9) * 120) + (i === jump ? 100 : 0), 60 + Math.round(Math.cos(i / 7) * 50));
    return flat;
  };
  it("round-trips, including deltas too big for int8", () => {
    const flat = walk(300);
    flat[200] = 160;
    flat[202] = -160;
    expect(decodePath(encodePath(flat))).toEqual(flat);
    expect(encodePath(walk(300)).length).toBeLessThan(900);
  });
  it("rejects malformed strings", () => {
    expect(decodePath("")).toBeNull();
    expect(decodePath("!!!!")).toBeNull();
    expect(decodePath("AQ")).toBeNull();
  });
  it("prepares echoes: min length, no teleports, cut at the next stage", () => {
    const p = encodePath(walk(200));
    expect(prepareEcho(p, 20, 50, [])).toMatchObject({ duration: 20, stage: 0 });
    expect(prepareEcho(encodePath(walk(60)), 6, 50, [])).toBeNull();
    expect(prepareEcho(encodePath(walk(200, 100)), 20, 50, [])).toBeNull();
    expect(prepareEcho(p, 10, 50, [])).toBeNull(); // more samples than the run lasted
    const cut = prepareEcho(p, 20, 50, [62]);
    expect(cut).toMatchObject({ duration: 12, stage: 0 });
    expect(decodePath(cut!.path)!.length).toBe(240);
    expect(prepareEcho(p, 20, 70, [62])).toMatchObject({ stage: 1, duration: 20 });
    expect(stageAtT([62, 90], 95)).toBe(2);
  });
  it("evicts the weakest echo only for a better one", () => {
    const ex = Array.from({ length: 6 }, (_, i) => ({ id: "e" + i, damage: 100 * i, duration: 10 }));
    expect(echoEviction(ex.slice(0, 3), { damage: 1, duration: 8 })).toBeNull();
    expect(echoEviction(ex, { damage: 1, duration: 8 })).toBe("skip");
    expect(echoEviction(ex, { damage: 900, duration: 30 })).toBe("e0");
  });
  it("replays an echo at the same loop beat, one loop later", () => {
    const startT = 123.4;
    const flat = walk(150);
    const { loopBeat, phrase } = loopKey(startT, spec.beat);
    expect(phrase).toBe(Math.floor(((startT / spec.beat) % LOOP_BEATS) / PHRASE_BEATS));
    const e = decodeEcho({ id: "x", titanSeed: spec.seed, phrase, loopBeat, stage: 0, path: encodePath(flat), duration: 15 })!;
    const loopSec = LOOP_BEATS * spec.beat;
    for (const k of [1, 2]) {
      const t = startT + k * loopSec + 0.1 + 4.0; // sample 40
      const [pos] = echoesAt([e], t, spec.beat);
      expect(pos.x).toBeCloseTo(flat[80] / 20, 1);
      expect(pos.y).toBeCloseTo(flat[81] / 20, 1);
    }
    expect(echoesAt([e], startT + loopSec + 20, spec.beat)).toHaveLength(0);
  });
});

describe("revive sweep", () => {
  it("measures distance to the flown segment, not just the endpoint", () => {
    expect(segDist(0, 0, -2, 0.5, 2, 0.5)).toBeCloseTo(0.5);
    expect(segDist(0, 0, 1, 1, 3, 1)).toBeCloseTo(Math.SQRT2);
  });
});

describe("actor copies", () => {
  it("are in sync with src (run npm run sync-core)", () => {
    const root = join(__dirname, "..", "..");
    const pairs = [["src/core/titan.ts", "core/titan.ts"], ["src/core/field.ts", "core/field.ts"], ["src/core/hunt.ts", "core/hunt.ts"], ["src/core/rng.ts", "core/rng.ts"], ["src/net/types.ts", "shared/types.ts"], ["src/net/pathcodec.ts", "shared/pathcodec.ts"]];
    for (const [src, dst] of pairs) {
      const a = readFileSync(join(root, src), "utf8");
      const b = readFileSync(join(root, "base44/actors/world", dst), "utf8").split("\n").slice(1).join("\n").replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1$2");
      expect(b, dst).toBe(a);
    }
  });
});

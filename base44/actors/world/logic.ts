// Pure rules of the world actor: no runtime imports, so vitest can check them directly.
import { hash32 } from "./core/rng.ts";
import { ARENA, coreOpen, LOOP_BEATS, PHRASE_BEATS, Stage, stageFor, TitanSpec } from "./core/titan.ts";
import { ASPECTS, maxDps, sustainedBudget, type AspectId } from "./core/hunt.ts";
import { decodePath, encodePath, PATH_HZ } from "./shared/pathcodec.ts";
import type { HitRow, HitWhy } from "./shared/types.ts";
import { Q } from "./shared/types.ts";

export const HOUR_MS = 3_600_000;
export const ESCAPE_MS = 8 * HOUR_MS;
export const INTERLUDE_MS = 20_000;
export const LIFETIME_H = 2.5;
/** ~12-20 min for one hunter alone (humans deal ~30-60 dps): a lone visitor can see a titan fall */
export const HP_FLOOR = 40_000;
export const HP_CAP = 60_000_000;
export const BEAT_TOL = 2;
export const RATE_WINDOW_MS = 2_000;
export const RATE_MUL = 1.15;
export const SPARK_MS = 8_000;
export const REVIVE_R = 0.9;
export const MAX_HITS_PER_MSG = 64;
export const ECHO_MIN_S = 8;
export const ECHO_CAP = 6;
export const RUN_SLACK = 60;

// ---------- titan lifecycle

export function titanSeed(number: number, salt: string): number {
  return hash32("titan", number, salt);
}

/** [hourIndex, damage] buckets for the last 24 h */
export type DmgBuckets = Array<[number, number]>;

export function addDamage(b: DmgBuckets, nowMs: number, dmg: number): void {
  const h = Math.floor(nowMs / HOUR_MS);
  const last = b[b.length - 1];
  if (last && last[0] === h) last[1] += dmg;
  else b.push([h, dmg]);
  while (b.length && b[0][0] <= h - 24) b.shift();
}

export function damagePerHour(b: DmgBuckets, nowMs: number): number {
  const h = Math.floor(nowMs / HOUR_MS);
  let sum = 0;
  for (const [hi, d] of b) if (hi > h - 24) sum += d;
  return sum / 24;
}

/** Sized so that, at the last day's average world damage rate, the titan lives ~2.5 h. */
export function hpMaxFor(b: DmgBuckets, nowMs: number): number {
  const raw = damagePerHour(b, nowMs) * LIFETIME_H;
  return Math.round(Math.max(HP_FLOOR, Math.min(HP_CAP, raw)) / 1000) * 1000;
}

export function titanT(nowMs: number, wokeAt: number): number {
  return (nowMs - wokeAt) / 1000;
}

/** stage at titan time t, given the times stage 1 and 2 began */
export function stageAtT(stageAt: number[], t: number): Stage {
  let s = 0;
  for (let i = 0; i < stageAt.length; i++) if (stageAt[i] != null && t >= stageAt[i]) s = i + 1;
  return Math.min(2, s) as Stage;
}

export { stageFor };

// ---------- hits

/** biggest single dart the core can produce: the hardest-hitting aspect, highest reach, full combo, surge */
export function maxHitDmg(): number {
  let best = 55 * 1.4; // mirror shard
  for (const a of Object.values(ASPECTS)) best = Math.max(best, a.dart * 1.4 * 1.5 * 2.5 * (a.id === "bloom" ? 1.65 : 1));
  return Math.ceil(best) + 1;
}
const MAX_HIT = maxHitDmg();
export const RATE_BUDGET = maxDps() * RATE_MUL * (RATE_WINDOW_MS / 1000);

export interface HitCtx {
  spec: TitanSpec;
  stage: Stage;
  nowMs: number;
  wokeAt: number;
}

export type HitCheck = { ok: true; core: number; dmg: number; beat: number; flags: number } | { ok: false; why: HitWhy };

export function checkHit(row: unknown, ctx: HitCtx): HitCheck {
  if (!Array.isArray(row) || row.length < 3) return { ok: false, why: "bad" };
  const [core, dmg, beat, flags] = row as HitRow;
  if (!Number.isInteger(core) || core < 0 || core >= ctx.spec.cores.length) return { ok: false, why: "bad" };
  if (typeof dmg !== "number" || !Number.isFinite(dmg) || dmg <= 0 || dmg > MAX_HIT) return { ok: false, why: "bad" };
  if (typeof beat !== "number" || !Number.isFinite(beat)) return { ok: false, why: "bad" };
  const serverBeat = titanT(ctx.nowMs, ctx.wokeAt) / ctx.spec.beat;
  if (serverBeat < 0) return { ok: false, why: "asleep" };
  if (beat < 0 || Math.abs(beat - serverBeat) > BEAT_TOL) return { ok: false, why: "beat" };
  // stage only rises and Ruin's windows are a superset, so the server's stage is never stricter than the client's
  if (!coreOpen(ctx.spec.cores[core], beat, ctx.stage)) return { ok: false, why: "closed" };
  return { ok: true, core, dmg: Math.round(dmg), beat, flags: typeof flags === "number" ? flags | 0 : 0 };
}

/** Sliding-window damage budget per hunter: a hit that does not fit is dropped whole. */
export class RateWindow {
  private q: Array<[number, number]> = [];
  private sum = 0;
  constructor(readonly budget = RATE_BUDGET, readonly windowMs = RATE_WINDOW_MS) {}
  take(nowMs: number, dmg: number): boolean {
    while (this.q.length && this.q[0][0] <= nowMs - this.windowMs) this.sum -= this.q.shift()![1];
    if (this.sum + dmg > this.budget) return false;
    this.q.push([nowMs, dmg]);
    this.sum += dmg;
    return true;
  }
  get used() {
    return this.sum;
  }
}

/** Two windows per hunter, sized for the light they carry: a 2 s burst cap and a 12 s sustained cap. */
export class AspectRate {
  private burst: RateWindow;
  private long: RateWindow;
  constructor(readonly aspect: string) {
    const a = (aspect in ASPECTS ? aspect : "ember") as AspectId;
    this.burst = new RateWindow(maxDps(a) * RATE_MUL * (RATE_WINDOW_MS / 1000), RATE_WINDOW_MS);
    this.long = new RateWindow(sustainedBudget(a, 12) * RATE_MUL, 12_000);
  }
  take(nowMs: number, dmg: number): boolean {
    // check both before committing to either
    const b = this.burst as unknown as { q: Array<[number, number]>; sum: number; budget: number; windowMs: number };
    const l = this.long as unknown as { q: Array<[number, number]>; sum: number; budget: number; windowMs: number };
    for (const w of [b, l]) while (w.q.length && w.q[0][0] <= nowMs - w.windowMs) w.sum -= w.q.shift()![1];
    if (b.sum + dmg > b.budget || l.sum + dmg > l.budget) return false;
    this.burst.take(nowMs, dmg);
    this.long.take(nowMs, dmg);
    return true;
  }
}

/** token bucket for per-connection message rate limits */
export class Bucket {
  private tokens: number;
  private at = 0;
  constructor(readonly perSec: number, readonly burst: number) {
    this.tokens = burst;
  }
  take(nowMs: number): boolean {
    if (this.at) this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.at) / 1000) * this.perSec);
    this.at = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export const LIMITS: Record<string, [perSec: number, burst: number]> = {
  hello: [0.5, 4],
  pos: [14, 20],
  hit: [6, 10],
  down: [0.5, 2],
  run: [0.2, 2],
  ping: [4, 12],
};

// ---------- identity

const URLISH = /(https?:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|gg|xyz|app|me|ru|cn|co|ly|tk|link|site|online|dev|ai)\b)/gi;

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "Hunter";
  let s = raw.slice(0, 64).normalize("NFKC");
  s = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>{}[\]\\`"]/g, "");
  s = s.replace(URLISH, "");
  s = s.replace(/[/@#]+/g, " ").replace(/\s+/g, " ").trim();
  s = Array.from(s).slice(0, 18).join("").trim();
  return s || "Hunter";
}

export function sanitizeSigil(raw: unknown): number {
  return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= 15 ? (raw as number) : 0;
}

export function sanitizeAspect(raw: unknown): string {
  return typeof raw === "string" && raw in ASPECTS ? raw : "ember";
}

export function validKey(raw: unknown): raw is string {
  return typeof raw === "string" && /^[0-9a-f]{16,64}$/i.test(raw);
}

/** public id of a hunter: salted, so the browser's secret key never leaves the actor */
export function hashKey(key: string, salt: string): string {
  const a = hash32("hk1", salt, key).toString(16).padStart(8, "0");
  const b = hash32("hk2", key, salt).toString(16).padStart(8, "0");
  return a + b;
}

// ---------- positions, sparks

export function clampPos(x: unknown, y: unknown): [number, number] | null {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.max(-ARENA.W / 2, Math.min(ARENA.W / 2, x)), Math.max(0, Math.min(ARENA.H, y))];
}

/** distance from point p to the segment a-b (a hunter's last 100 ms of flight) */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const k = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * k), py - (ay + dy * k));
}

// ---------- runs and echoes

export interface RunClaim {
  damage: unknown;
  time: unknown;
  startT: unknown;
}

/**
 * Bound a finished run by what the actor saw. `accepted` = damage the actor accepted from this
 * hunter since startT; `nowT` = titan time now (or when that titan ended).
 */
export function checkRun(c: RunClaim, accepted: number, nowT: number): { ok: boolean; damage: number; time: number; clamped: boolean } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const damage = num(c.damage), time = num(c.time), startT = num(c.startT);
  if (Number.isNaN(damage) || Number.isNaN(time) || Number.isNaN(startT)) return { ok: false, damage: 0, time: 0, clamped: false };
  if (damage < 0 || time <= 0 || startT < -1 || startT > nowT + 1) return { ok: false, damage: 0, time: 0, clamped: false };
  if (time > nowT - startT + 3 || time > ESCAPE_MS / 1000) return { ok: false, damage: 0, time: 0, clamped: false };
  const allowed = accepted * 1.02 + RUN_SLACK;
  const clamped = damage > allowed;
  return { ok: true, damage: Math.round(clamped ? accepted : damage), time: Math.round(time * 10) / 10, clamped };
}

export function loopKey(startT: number, beatSec: number): { loopBeat: number; phrase: number } {
  const b = startT / beatSec;
  const loopBeat = ((b % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  return { loopBeat: Math.round(loopBeat * 1000) / 1000, phrase: Math.floor(loopBeat / PHRASE_BEATS) };
}

/**
 * Validate an echo path and cut it where the run left its starting stage (the attacks change there,
 * so the echo would dodge things that are not there). Returns null if it is not worth keeping.
 */
export function prepareEcho(path: unknown, time: number, startT: number, stageAt: number[]): { path: string; duration: number; stage: Stage } | null {
  if (typeof path !== "string" || path.length > 12_000) return null;
  const pts = decodePath(path);
  if (!pts) return null;
  let n = pts.length / 2;
  if (n > time * PATH_HZ + 6) return null; // more samples than the run lasted
  const maxStep = 3 * Q; // 26 u/s dash = 2.6 units per sample
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    if (x < (-ARENA.W / 2) * Q - 1 || x > (ARENA.W / 2) * Q + 1 || y < -1 || y > ARENA.H * Q + 1) return null;
    if (i && Math.abs(x - pts[i * 2 - 2]) + Math.abs(y - pts[i * 2 - 1]) > maxStep * 1.5) return null;
  }
  const stage = stageAtT(stageAt, startT);
  const nextChange = stageAt[stage];
  if (nextChange != null && nextChange > startT) n = Math.min(n, Math.floor((nextChange - startT) * PATH_HZ));
  const duration = n / PATH_HZ;
  if (duration < ECHO_MIN_S) return null;
  const s = n === pts.length / 2 ? path : encodePath(pts.slice(0, n * 2));
  if (s.length > 6000) return null;
  return { path: s, duration, stage };
}

export const echoScore = (e: { damage?: number; duration?: number }) => (e.duration ?? 0) * 40 + (e.damage ?? 0);

/** which existing echo (if any) a new one should replace when the slot is full; "skip" if it is not better */
export function echoEviction<T extends { id: string; damage?: number; duration?: number }>(existing: T[], incoming: { damage: number; duration: number }, cap = ECHO_CAP): string | null | "skip" {
  if (existing.length < cap) return null;
  let worst = existing[0];
  for (const e of existing) if (echoScore(e) < echoScore(worst)) worst = e;
  return echoScore(incoming) > echoScore(worst) ? worst.id : "skip";
}

/** top N hunters from a credit map */
export function topHunters(credits: Map<string, { name: string; sigil: number; dmg: number }>, n = 5) {
  return [...credits.values()]
    .sort((a, b) => b.dmg - a.dmg)
    .slice(0, n)
    .map((c) => ({ name: c.name, sigil: c.sigil, damage: Math.round(c.dmg) }));
}

/** threshold for a "core break" feed event: damage to one core within one phrase */
export function breakThreshold(hpMax: number): number {
  return Math.max(300, Math.min(20_000, Math.round(hpMax * 0.0025)));
}

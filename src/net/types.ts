// The wire protocol between browsers and the `world` actor. Shared verbatim with the actor
// (scripts/sync-core.mjs copies this file), so keep it free of imports.

export const WORLD_ACTOR = "world";
export const WORLD_SESSION = "world-2"; // world-1 was the test world before launch (Nov 9)

/** Positions travel quantised to 1/20 of an arena unit (the same grid echoes are stored on). */
export const Q = 20;

export type TitanStatus = "awake" | "felled" | "escaped";
export type AspectName = "ember" | "lance" | "bloom" | "mirror";

export interface TitanInfo {
  number: number;
  seed: number;
  wokeAt: number; // server ms; titan time t = (serverNow - wokeAt) / 1000 (negative during the interlude)
  hpMax: number;
  status: TitanStatus;
}

export interface TopHunter {
  name: string;
  sigil: number;
  damage: number;
}

export interface TitanEnd extends TitanInfo {
  endedAt: number;
  blow: { name: string; sigil: number } | null; // final blow (felled only)
  top: TopHunter[];
  damageTotal: number;
  hunterCount: number;
}

export type FeedKind = "join" | "surge" | "break" | "down" | "revive" | "stage" | "felled" | "escaped" | "wake" | "run";
export interface FeedItem {
  k: FeedKind;
  name: string;
  sigil: number;
  v?: number; // core id (break), stage (stage), damage (felled), titan number (wake), recorded blows (run)
  n: number; // server ms
}

/** [id, xq, yq, sigil, flags] — x = xq / Q, y = yq / Q */
export type HunterRow = [number, number, number, number, number];
/** [id, name, sigil, aspect] */
export type RosterRow = [number, string, number, string];
/** [id, xq, yq, expiresAt server ms] */
export type SparkRow = [number, number, number, number];
/** [core, dmg, beatAbs, flags?]  flags: HIT_SURGE | HIT_MIRROR */
export type HitRow = [number, number, number, number?];

export const HIT_SURGE = 1;
export const HIT_MIRROR = 2;

/** pos flags (client-set) */
export const F_DASH = 1;
export const F_SURGE = 2;
export const F_INVULN = 4;
/** set by the actor in HunterRow flags */
export const F_DOWN = 128;

export interface RunMsg {
  t: "run";
  titan?: number; // titan number the run was fought against
  damage: number;
  time: number;
  grazes: number;
  bestCombo: number;
  surges: number;
  aspect: string;
  startT: number; // titan time when the run began
  stage: number;
  path: string; // pathcodec
}

export type ToServer =
  | { t: "hello"; key: string; name: string; sigil: number; aspect: string }
  | { t: "pos"; x: number; y: number; alive: boolean; flags: number }
  | { t: "hit"; hits: HitRow[] }
  | { t: "down"; x: number; y: number }
  | RunMsg
  | { t: "ping"; c: number };

/** Hit rejection reasons, for acks and the live check. */
export type HitWhy = "noHello" | "asleep" | "bad" | "beat" | "closed" | "rate" | "down";

export type ToClient =
  | {
      t: "welcome";
      n: number;
      you: number;
      titan: TitanInfo;
      hp: number;
      stage: number;
      stageAt: number[]; // titan seconds when stage 1 and 2 began (for echo trimming)
      online: number;
      feed: FeedItem[];
      roster: RosterRow[];
      h: HunterRow[];
      sparks: SparkRow[];
      last: TitanEnd | null; // the titan that just ended, during the interlude
    }
  | { t: "s"; n: number; hp: number; c: number; h: HunterRow[]; f?: FeedItem[] }
  | { t: "join"; n: number; r: RosterRow }
  | { t: "leave"; n: number; id: number }
  | { t: "stage"; n: number; stage: number; hp: number; at: number }
  | { t: "felled"; n: number; end: TitanEnd; next: TitanInfo }
  | { t: "wake"; n: number; titan: TitanInfo; hp: number }
  | { t: "down"; n: number; id: number; x: number; y: number; until: number }
  | { t: "revive"; n: number; who: number; by: number; byName: string }
  | { t: "ack"; n: number; ok: number; bad: number; why?: HitWhy; hp: number }
  | { t: "runAck"; n: number; damage: number; echo: boolean; clamped: boolean }
  | { t: "pong"; n: number; c: number };

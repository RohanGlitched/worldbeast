import { LOOP_BEATS } from "@/core/titan";
import { decodePath, PATH_HZ } from "./pathcodec";
import { Q } from "./types";

// Echoes: real earlier runs replayed at the same point of the titan's loop, so they weave through
// exactly the attacks they once dodged. An echo recorded from loop beat B (in stage S) replays
// whenever the loop comes round to B again while the titan is in stage S.

export interface EchoRecord {
  id: string;
  titanSeed: number;
  titanNumber?: number;
  phrase: number;
  loopBeat: number;
  stage: number;
  aspect?: string;
  name?: string;
  sigil?: number;
  path: string;
  duration: number;
  damage?: number;
}

export interface Echo {
  id: string;
  name: string;
  sigil: number;
  aspect: string;
  loopBeat: number;
  duration: number;
  damage: number;
  pts: Int16Array; // flat quantised x, y at PATH_HZ
}

export interface EchoPos {
  id: string;
  name: string;
  sigil: number;
  aspect: string;
  x: number;
  y: number;
  /** 0..1 through its flight; fade in/out near the ends */
  life: number;
}

/** Game.ts records sample i at runStart + (i + 1) / PATH_HZ */
const T0 = 1 / PATH_HZ;

export function decodeEcho(r: EchoRecord): Echo | null {
  const pts = decodePath(r.path);
  if (!pts || pts.length < 4) return null;
  return {
    id: r.id,
    name: r.name ?? "Hunter",
    sigil: r.sigil ?? 0,
    aspect: r.aspect ?? "ember",
    loopBeat: r.loopBeat,
    duration: Math.min(r.duration, pts.length / 2 / PATH_HZ),
    damage: r.damage ?? 0,
    pts: Int16Array.from(pts),
  };
}

/** Positions of every echo flying at titan time t (seconds since the titan woke). */
export function echoesAt(list: readonly Echo[], t: number, beatSec: number, out: EchoPos[] = []): EchoPos[] {
  out.length = 0;
  if (t < 0) return out;
  const loopSec = LOOP_BEATS * beatSec;
  const loopStart = Math.floor(t / loopSec) * loopSec;
  for (const e of list) {
    // this loop's start, or the previous loop's for an echo still flying across the seam
    for (const base of [loopStart, loopStart - loopSec]) {
      const el = t - (base + e.loopBeat * beatSec) - T0;
      if (el < 0 || el >= e.duration) continue;
      const f = el * PATH_HZ;
      const i = Math.min(Math.floor(f), e.pts.length / 2 - 1);
      const j = Math.min(i + 1, e.pts.length / 2 - 1);
      const k = f - i;
      out.push({
        id: e.id,
        name: e.name,
        sigil: e.sigil,
        aspect: e.aspect,
        x: (e.pts[i * 2] + (e.pts[j * 2] - e.pts[i * 2]) * k) / Q,
        y: (e.pts[i * 2 + 1] + (e.pts[j * 2 + 1] - e.pts[i * 2 + 1]) * k) / Q,
        life: el / e.duration,
      });
      break;
    }
  }
  return out;
}

interface EntityApi {
  filter(q: Record<string, unknown>, sort?: string, limit?: number): Promise<EchoRecord[]>;
}

/** Loads the echoes for one titan + stage from the public Echo entity and keeps them fresh. */
export class EchoBank {
  list: Echo[] = [];
  private key = "";
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private api: () => EntityApi | null, private limit = 48, private refreshMs = 90_000) {}

  /** call often; it only fetches when the titan/stage changes or the cache is stale */
  ensure(seed: number, stage: number): void {
    const key = `${seed}:${stage}`;
    const stale = performance.now() - this.loadedAt > this.refreshMs;
    if (this.loading || (key === this.key && !stale)) return;
    if (key !== this.key) this.list = [];
    this.key = key;
    this.loadedAt = performance.now();
    const api = this.api();
    if (!api) return;
    this.loading = api
      .filter({ titanSeed: seed, stage }, "-damage", this.limit)
      .then((rows) => {
        if (this.key !== key) return;
        const out: Echo[] = [];
        for (const r of rows ?? []) {
          const e = decodeEcho(r);
          if (e) out.push(e);
        }
        this.list = out;
      })
      .catch(() => {
        /* offline or entity down: no echoes this time */
      })
      .finally(() => {
        this.loading = null;
      });
  }
}

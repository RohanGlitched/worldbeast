import { rngFor, Rng } from "./rng";
import { ARENA, LOOP_PHRASES, PHRASE_BEATS, Stage, TitanSpec } from "./titan";

// The battlefield is closed-form: every hazard's position is a pure function of time.
// Any browser (and the world actor) that knows the titan seed and the clock sees the same fight.

export type Kind =
  | "ring"
  | "spiral"
  | "fan"
  | "wall"
  | "rain"
  | "wave"
  | "curve"
  | "bloom"
  | "beam"
  | "slam"
  | "glyph"
  | "cross";

export interface Volley {
  id: number; // unique within the loop: phraseInLoop * 1000 + index
  kind: Kind;
  beat: number; // start beat within the phrase (fractional allowed for off-beats)
  tele: number; // telegraph lead in beats
  ink: 0 | 1; // which attack ink
  heavy: boolean;
  p: Record<string, number>; // parameters (numbers only, deterministic)
  /** 0 (or absent): the bar's lead volley; 1+: a secondary one (a bar's second or third, or a rail hem) */
  sub?: number;
}

/**
 * A first hunt's grace field (Hunt `gentle`): one hunter's own view of the shared plan, thinned for the first
 * seconds of their first run. Volleys that leave the titan before `until` (titan seconds) keep only each bar's
 * lead volley (the overture's density), and walls and beams that leave before `heavyUntil` are held back.
 * Pure numbers, so the same hunter at the same moment always sees the same thinned page; a volley is kept or
 * hidden whole, for its whole life, so nothing vanishes mid-flight once the run is under way.
 */
export interface Thin {
  until: number;
  heavyUntil: number;
  /**
   * Where this hunter's light entered the page (set once the spawn is chosen). Rain that leaves the titan
   * before `until` keeps only every other column, and none within RAIN_SPARE units of this x (R6: the first
   * hits of a first hunt, 4.6-7.8 s in, were rain on the spawn).
   */
  x?: number;
}

/** a first hunt's rain keeps this far (in x) from where the light entered the page */
export const RAIN_SPARE = 2;

/** Is rain column `c` (at x) hidden from this hunter's grace field? (only for rain leaving before thin.until) */
export function rainSpared(c: number, x: number, thin: Thin): boolean {
  return c % 2 === 1 || (thin.x !== undefined && Math.abs(x - thin.x) < RAIN_SPARE);
}

export function thinned(v: Volley, spawnSec: number, thin: Thin | null | undefined): boolean {
  if (!thin) return false;
  if (spawnSec < thin.until && (v.sub ?? 0) > 0) return true;
  return spawnSec < thin.heavyUntil && (v.kind === "wall" || v.kind === "beam");
}

export interface PhrasePlan {
  phrase: number; // 0..7 within the loop
  stage: Stage;
  volleys: Volley[];
}

const TAU = Math.PI * 2;
const DOWN = -Math.PI / 2;
const MAX_LIFE_BEATS = 24; // nothing lives longer than this

// ---------------------------------------------------------------------------------------------
// Planning: which attacks happen on which beats, for each phrase of the Canticle and each stage.

function originOf(spec: TitanSpec, r: Rng) {
  return r.pick(spec.origins);
}

function planVolley(spec: TitanSpec, r: Rng, kind: Kind, beat: number, idx: number, phrase: number, stage: Stage): Volley {
  const o = originOf(spec, r);
  const hard = stage; // 0,1,2
  const sp = (lo: number, hi: number) => r.range(lo, hi) * (1 + 0.08 * hard);
  // Calm aims its fans, glyphs, blooms and waves a little wider (the same draws, pushed toward the margins),
  // so the margins are no refuge without the rail hems Wrath and Ruin add
  const wide = (x: number, from: number, to: number) => (hard === 0 ? Math.sign(x) * to * Math.pow(Math.min(1, Math.abs(x) / from), 0.7) : x);
  const v: Volley = { id: phrase * 1000 + idx, kind, beat, tele: 1, ink: r.chance(0.7) ? 0 : 1, heavy: false, p: {} };
  switch (kind) {
    case "ring": {
      v.p = { ox: o.x, oy: o.y, n: r.int(10, 16) + hard * 3, speed: sp(3.6, 5.2), a0: r.range(0, TAU), arc: r.range(Math.PI * 0.55, Math.PI * 0.95), rad: 0.28 };
      break;
    }
    case "spiral": {
      v.p = { ox: o.x, oy: o.y, n: r.int(16, 26) + hard * 6, speed: sp(3.4, 4.8), turns: r.range(0.6, 1.4), dur: r.pick([4, 6, 8]), dir: r.chance(0.5) ? 1 : -1, a0: r.range(0, TAU), rad: 0.24 };
      v.heavy = true;
      break;
    }
    case "fan": {
      v.p = { ox: o.x, oy: o.y, tx: wide(r.range(-ARENA.W * 0.4, ARENA.W * 0.4), ARENA.W * 0.4, ARENA.W / 2 - 0.8), ty: r.range(1, ARENA.H * 0.45), n: r.int(5, 7) + hard, spread: r.range(0.45, 0.8), speed: sp(5.2, 7), waves: r.int(2, 3) + (hard > 1 ? 1 : 0), gap: r.pick([0.5, 1]), rad: 0.26 };
      break;
    }
    case "wall": {
      const gapW = Math.max(2.1, r.range(2.6, 3.6) - hard * 0.25);
      // (a Calm wall leaves its lane nearer the middle: the margins are walled, the way through is central)
      v.p = { gapX: r.range(-ARENA.W / 2 + gapW, ARENA.W / 2 - gapW) * (hard === 0 ? 0.6 : 1), gapW, speed: sp(3.2, 4.4), spacing: 0.72, rad: 0.3, rows: hard > 0 && r.chance(0.5) ? 2 : 1, shift: r.range(-3, 3) };
      v.tele = 2;
      v.heavy = true;
      break;
    }
    case "rain": {
      v.p = { cols: r.int(4, 6) + hard, seed: r.int(0, 1e6), speed: sp(7, 9.5), drops: r.int(3, 5), every: r.pick([0.5, 1]), rad: 0.3 };
      // how many of its columns hug a side rail: in Calm only one rain in three touches the rails (both, so
      // the margins are no refuge, but no worse than the middle); from Wrath on one always does, both in a third
      v.p.rails = hard === 0 ? (v.p.seed % 3 === 0 ? 2 : 0) : v.p.seed % 3 === 2 ? 2 : 1;
      // (a Calm rain that spares the rails drops the column a rail would have taken, not moves it inward)
      if (v.p.rails === 0) v.p.cols--;
      v.tele = 2;
      break;
    }
    case "wave": {
      v.p = { ox: wide(o.x, 6.5, ARENA.W / 2 - 1), oy: o.y, n: r.int(7, 11) + hard * 2, speed: sp(3.4, 4.6), amp: r.range(1.2, 2.6), freq: r.range(0.6, 1.1), every: r.pick([0.25, 0.5]), rad: 0.26, phase: r.range(0, TAU) };
      break;
    }
    case "curve": {
      v.p = { ox: o.x, oy: o.y, n: r.int(8, 12) + hard * 2, speed: sp(3.8, 5), omega: (r.chance(0.5) ? 1 : -1) * r.range(0.35, 0.7), arc: r.range(Math.PI * 0.5, Math.PI * 0.8), a0: r.range(-0.3, 0.3), rad: 0.26 };
      break;
    }
    case "bloom": {
      v.p = { ox: o.x, oy: o.y, tx: wide(r.range(-ARENA.W * 0.38, ARENA.W * 0.38), ARENA.W * 0.38, ARENA.W / 2 - 1), ty: r.range(4, ARENA.H * 0.7), travel: r.pick([2, 3]), n: r.int(10, 14) + hard * 2, speed: sp(3, 4.2), rad: 0.27, seedRad: 0.55 };
      v.heavy = true;
      break;
    }
    case "beam": {
      const side = r.chance(0.5) ? 1 : -1;
      const from = DOWN + side * r.range(0.45, 0.8);
      const to = DOWN - side * r.range(0.25, 0.7);
      const width = r.range(0.4, 0.58);
      // (the sweep stops short of the foot corner it swings toward: R5's beams pinned hunters there, 6/17 deaths)
      v.p = { ox: o.x, oy: o.y, a1: from, a2: beamStop(o.x, o.y, from, to, width), len: ARENA.H * 1.45, width, dur: r.pick([6, 8, 8]) };
      // Calm and Wrath give a beam a full extra beat of warning (beams made the R3 kill chains)
      v.tele = hard < 2 ? 3 : 2;
      v.heavy = true;
      break;
    }
    case "slam": {
      // Calm and Wrath: one ring, slower, with two wide gaps set well apart (R4: rings that met the floor
      // trapped hunters there and made slams the top killer); the corner footfall comes only from Wrath on
      const gentle = hard < 2;
      const cx = r.range(-ARENA.W * 0.35, ARENA.W * 0.35),
        cy = r.range(3, ARENA.H * 0.6),
        speed = sp(5, 6.5) * (gentle ? 0.85 : 1),
        gapA = r.range(0, TAU),
        gw = r.range(1.15, 1.45),
        gb = r.range(0, TAU);
      // (two gaps that overlap read as one: in Calm and Wrath the second sits at least 126 degrees away)
      const gapB = gentle ? gapA + Math.PI * (0.7 + 0.6 * (gb / TAU)) : gb;
      v.p = { cx, cy, speed, width: 0.32, gapA, gapW: gentle ? 1.6 + (gw - 1.15) : Math.max(0.95, gw - hard * 0.1), gapB, rings: hard > 1 ? 2 : 1, reach: r.range(9, 12), tread: hard > 0 ? 1 : 0 };
      v.tele = 2;
      v.heavy = true;
      break;
    }
    case "glyph": {
      v.p = { cx: wide(r.range(-ARENA.W * 0.38, ARENA.W * 0.38), ARENA.W * 0.38, ARENA.W / 2 - 1), cy: r.range(2, ARENA.H * 0.7), R: r.range(1.6, 2.6), dur: r.pick([2, 3, 4]) };
      v.tele = 2;
      break;
    }
    case "cross": {
      v.p = { rows: r.int(3, 4) + hard, speed: sp(3.4, 4.4), slope: r.range(0.45, 0.8), spacing: r.range(2.1, 2.8), rad: 0.27, every: 1 };
      v.tele = 2;
      v.heavy = true;
      break;
    }
  }
  return v;
}

const KINDS: Kind[] = ["ring", "spiral", "fan", "wall", "rain", "wave", "curve", "bloom", "beam", "slam", "glyph", "cross"];

/** Archetypes lean on different attacks so each titan fights with its own grammar. */
const LEANS: Record<string, Partial<Record<Kind, number>>> = {
  coil: { beam: 3, curve: 2, wave: 2, spiral: 1.5 },
  strider: { slam: 3.5, rain: 2, wall: 1.5, glyph: 1.5 },
  bloom: { bloom: 3, spiral: 2, curve: 2, glyph: 1 },
  throne: { ring: 3, fan: 2, wall: 2, cross: 1.5 },
  swarmheart: { spiral: 2.5, ring: 2, fan: 2, wave: 1.5 },
};

export function planPhrase(spec: TitanSpec, phrase: number, stage: Stage): PhrasePlan {
  const r = rngFor("phrase", spec.seed, phrase, stage);
  const lean = LEANS[spec.archetype] ?? {};
  // a titan's personal vocabulary: 6..8 of the 12 kinds, weighted by archetype and temperament
  const vocabR = rngFor("vocab", spec.seed);
  const vocab = vocabR.shuffle(KINDS.slice()).slice(0, 7 + vocabR.int(0, 1));
  for (const k of Object.keys(lean) as Kind[]) if (!vocab.includes(k)) vocab.push(k);
  const weights = vocab.map((k) => (lean[k] ?? 1) * (k === "beam" || k === "slam" ? 0.8 + spec.temperament.aggression : 1));

  const overture = phrase === 0;
  const crescendo = phrase === LOOP_PHRASES - 1;
  const density = (overture ? 0.65 : crescendo ? 1.2 : 1) * [1, 1.3, 1.52][stage];
  // bars 0..15; each bar gets 0..2 volleys; heavy ones consume the next bar's budget
  const volleys: Volley[] = [];
  let idx = 0;
  let heavyCooldown = 0;
  for (let bar = 0; bar < 16; bar++) {
    if (overture && bar < 2) continue; // breathing room at the top of the Canticle
    let count = r.chance(0.55 * density) ? 1 : 0;
    if (r.chance(0.28 * density)) count++;
    if (stage === 2 && r.chance(0.2)) count++;
    for (let c = 0; c < count; c++) {
      let kind = r.weighted(vocab, weights);
      const tmp = planVolley(spec, r, kind, 0, 0, 0, stage);
      if (tmp.heavy && heavyCooldown > 0) {
        kind = r.pick(["ring", "fan", "wave", "curve", "glyph"] as Kind[]);
      }
      const beat = bar * 4 + (c === 0 ? 0 : r.pick([1, 2, 3, 2.5]));
      const v = planVolley(spec, r, kind, beat, idx++, phrase, stage);
      if (c > 0) v.sub = c;
      if (v.heavy) heavyCooldown = stage === 2 ? 1 : 2;
      volleys.push(v);
    }
    if (heavyCooldown > 0) heavyCooldown--;
  }
  // Hems: short rains down both side rails, so the margins are never a refuge (R3: the edge columns
  // were half as dangerous as the centre for every titan). Drawn from their own stream, so the rest
  // of the plan is unchanged. Only from Wrath on: in Calm they made the margins the most dangerous place
  // on the page (R4: edge coverage 1.27x the centre's).
  const hr = rngFor("hem", spec.seed, phrase, stage);
  const hems = stage === 0 ? 0 : overture ? 1 : [0, 2, 3][stage];
  const used = new Set<number>();
  for (let k = 0; k < hems; k++) {
    let bar = hr.int(overture ? 4 : 1, 14);
    while (used.has(bar)) bar = (bar % 14) + 1;
    used.add(bar);
    volleys.push({ id: phrase * 1000 + idx++, kind: "rain", beat: bar * 4 + 2, tele: 2, ink: 1, heavy: false, sub: 1, p: { cols: 2, seed: hr.int(0, 1e6), speed: 5.6 + stage * 0.5, drops: 3 + (stage > 0 ? 1 : 0), every: 0.5, rad: 0.28, hem: 1 } });
  }
  // Ruin: the titan's signature, twice per phrase
  if (stage === 2) {
    for (const bar of [7, 15]) volleys.push(signature(spec, r, bar * 4, idx++, phrase));
  }
  volleys.sort((a, b) => a.beat - b.beat);
  return { phrase, stage, volleys };
}

function signature(spec: TitanSpec, r: Rng, beat: number, idx: number, phrase: number): Volley {
  const base = { id: phrase * 1000 + idx, beat, tele: 3, ink: 1 as const, heavy: true };
  switch (spec.archetype) {
    case "coil":
      return { ...base, kind: "beam", p: { ox: 0, oy: ARENA.TOP + 0.6, a1: DOWN + 1.1, a2: DOWN - 1.1, len: ARENA.H * 1.5, width: 0.9, dur: 8, twin: 1 } };
    case "strider":
      return { ...base, kind: "slam", p: { cx: 0, cy: ARENA.H * 0.42, speed: 6, width: 0.38, gapA: r.range(0, TAU), gapW: 1.1, gapB: r.range(0, TAU), rings: 3, reach: 13, tread: 1 } };
    case "bloom":
      return { ...base, kind: "spiral", p: { ox: 0, oy: ARENA.TOP + 0.6, n: 48, speed: 3.6, turns: 2.5, dur: 8, dir: 1, a0: 0, rad: 0.24, twin: 1 } };
    case "throne":
      return { ...base, kind: "ring", p: { ox: 0, oy: ARENA.TOP + 0.6, n: 36, speed: 3.3, a0: r.range(0, TAU), arc: Math.PI * 0.98, rad: 0.3, echoes: 3 } };
    default:
      return { ...base, kind: "spiral", p: { ox: 0, oy: ARENA.TOP + 0.6, n: 40, speed: 4, turns: 1.6, dur: 6, dir: -1, a0: 0, rad: 0.24, twin: 1 } };
  }
}

// ---------------------------------------------------------------------------------------------
// Sampling: where is everything at time t?

export interface FieldFrame {
  // bullets: x, y, radius, ink (0/1/2 = gold seed), alpha, kind, vx, vy
  bullets: Float32Array;
  bulletIds: Uint32Array;
  bulletCount: number;
  // beams: x1,y1,x2,y2,width,live(0 telegraph / 1 live),ink
  beams: Float32Array;
  beamCount: number;
  // rings: cx,cy,R,width,gapA,gapW,gapB,live,ink
  rings: Float32Array;
  ringCount: number;
  // zones (glyphs and slam telegraphs): cx,cy,R,progress(0..1 telegraph, >=1 live),ink
  zones: Float32Array;
  zoneCount: number;
  // origin telegraphs: x,y,progress(0..1),ink
  marks: Float32Array;
  markCount: number;
}

const B = 8,
  BM = 7,
  RG = 9,
  ZN = 5,
  MK = 4;

export function newFrame(cap = 4096): FieldFrame {
  return {
    bullets: new Float32Array(cap * B),
    bulletIds: new Uint32Array(cap),
    bulletCount: 0,
    beams: new Float32Array(64 * BM),
    beamCount: 0,
    rings: new Float32Array(64 * RG),
    ringCount: 0,
    zones: new Float32Array(128 * ZN),
    zoneCount: 0,
    marks: new Float32Array(256 * MK),
    markCount: 0,
  };
}

const inArena = (x: number, y: number, pad: number) => x > -ARENA.W / 2 - pad && x < ARENA.W / 2 + pad && y > -pad && y < ARENA.TOP + 3;

export class Field {
  readonly spec: TitanSpec;
  private plans = new Map<string, PhrasePlan>();
  constructor(spec: TitanSpec) {
    this.spec = spec;
  }
  plan(phraseInLoop: number, stage: Stage): PhrasePlan {
    const key = phraseInLoop + ":" + stage;
    let p = this.plans.get(key);
    if (!p) {
      p = planPhrase(this.spec, phraseInLoop, stage);
      this.plans.set(key, p);
    }
    return p;
  }

  /**
   * Fill `f` with every hazard alive at `t` seconds since the titan woke. `thin`: a first hunt's grace field
   * (see Thin), applied to this hunter's own view only; null for the shared page.
   */
  sample(t: number, stage: Stage, f: FieldFrame, thin: Thin | null = null) {
    f.bulletCount = f.beamCount = f.ringCount = f.zoneCount = f.markCount = 0;
    const beatLen = this.spec.beat;
    const beatNow = t / beatLen;
    const phraseAbs = Math.floor(beatNow / PHRASE_BEATS);
    // the phrase before (its volleys still flying), this one, and the next one's first bar: a volley on the
    // next phrase's downbeat telegraphs in this one's last beats (R6: before, a beam or wall on beat 0 of a
    // phrase struck with no warning at all)
    const nextIn = (phraseAbs + 1) * PHRASE_BEATS - beatNow;
    for (let back = 1; back >= -1; back--) {
      const pa = phraseAbs - back;
      if (pa < 0 || (back < 0 && nextIn > 4)) continue;
      const pl = this.plan(((pa % LOOP_PHRASES) + LOOP_PHRASES) % LOOP_PHRASES, stage);
      const phraseStartBeat = pa * PHRASE_BEATS;
      for (const v of pl.volleys) {
        if (back < 0 && v.beat >= 4) break; // (sorted by beat) only the downbeat bar can telegraph this early
        const vb = phraseStartBeat + v.beat; // absolute spawn beat
        const age = beatNow - vb; // in beats; negative = still telegraphing
        if (age < -v.tele || age > MAX_LIFE_BEATS) continue;
        if (thin && thinned(v, vb * beatLen, thin)) continue;
        emit(v, age, beatLen, f, pa, thin && v.kind === "rain" && vb * beatLen < thin.until ? thin : null);
      }
    }
  }

  /** Seconds until every beam sweeping at `t` has finished its sweep (0 if none is live). */
  beamLeft(t: number, stage: Stage, thin: Thin | null = null): number {
    const beatLen = this.spec.beat;
    const beatNow = t / beatLen;
    const phraseAbs = Math.floor(beatNow / PHRASE_BEATS);
    let left = 0;
    for (let back = 1; back >= 0; back--) {
      const pa = phraseAbs - back;
      if (pa < 0) continue;
      const pl = this.plan(((pa % LOOP_PHRASES) + LOOP_PHRASES) % LOOP_PHRASES, stage);
      for (const v of pl.volleys) {
        if (v.kind !== "beam") continue;
        if (thin && thinned(v, (pa * PHRASE_BEATS + v.beat) * beatLen, thin)) continue;
        const age = beatNow - (pa * PHRASE_BEATS + v.beat);
        if (age >= 0 && age < v.p.dur) left = Math.max(left, (v.p.dur - age) * beatLen);
      }
    }
    return left;
  }
}

let curKind = 0;
export const KIND_LIST: Kind[] = ["ring", "spiral", "fan", "wall", "rain", "wave", "curve", "bloom", "beam", "slam", "glyph", "cross"];
export const HOUND_KIND = KIND_LIST.length; // personal volleys aimed at one hunter

/** add a drop that only this hunter sees (their hounds); marked so the renderer can tint it */
export function pushPersonal(f: FieldFrame, x: number, y: number, r: number, id: number, vx: number, vy: number) {
  const k = curKind;
  curKind = HOUND_KIND;
  pushBullet(f, x, y, r, 1, 1, id, vx, vy);
  curKind = k;
}
export function pushPersonalMark(f: FieldFrame, x: number, y: number, progress: number) {
  pushMark(f, x, y, progress, 1);
}
/** the aim line from a winding-up hound to the hunter it hunts (a telegraph, never a hazard) */
export function pushPersonalAim(f: FieldFrame, x1: number, y1: number, x2: number, y2: number) {
  pushBeam(f, x1, y1, x2, y2, 0.2, 0, 1);
}

function pushBullet(f: FieldFrame, x: number, y: number, r: number, ink: number, alpha: number, id: number, vx = 0, vy = 0) {
  if (!inArena(x, y, r) || f.bulletCount * B >= f.bullets.length) return;
  const o = f.bulletCount * B;
  f.bullets[o] = x;
  f.bullets[o + 1] = y;
  f.bullets[o + 2] = r;
  f.bullets[o + 3] = ink;
  f.bullets[o + 4] = alpha;
  f.bullets[o + 5] = curKind;
  f.bullets[o + 6] = vx;
  f.bullets[o + 7] = vy;
  f.bulletIds[f.bulletCount] = id >>> 0;
  f.bulletCount++;
}
function pushMark(f: FieldFrame, x: number, y: number, progress: number, ink: number) {
  if (f.markCount * MK >= f.marks.length) return;
  const o = f.markCount * MK;
  f.marks[o] = x;
  f.marks[o + 1] = y;
  f.marks[o + 2] = progress;
  f.marks[o + 3] = ink;
  f.markCount++;
}
function pushZone(f: FieldFrame, cx: number, cy: number, R: number, progress: number, ink: number) {
  if (f.zoneCount * ZN >= f.zones.length) return;
  const o = f.zoneCount * ZN;
  f.zones[o] = cx;
  f.zones[o + 1] = cy;
  f.zones[o + 2] = R;
  f.zones[o + 3] = progress;
  f.zones[o + 4] = ink;
  f.zoneCount++;
}
function pushBeam(f: FieldFrame, x1: number, y1: number, x2: number, y2: number, w: number, live: number, ink: number) {
  if (f.beamCount * BM >= f.beams.length) return;
  const o = f.beamCount * BM;
  f.beams[o] = x1;
  f.beams[o + 1] = y1;
  f.beams[o + 2] = x2;
  f.beams[o + 3] = y2;
  f.beams[o + 4] = w;
  f.beams[o + 5] = live;
  f.beams[o + 6] = ink;
  f.beamCount++;
}
function pushRing(f: FieldFrame, cx: number, cy: number, R: number, w: number, gapA: number, gapW: number, gapB: number, live: number, ink: number) {
  if (f.ringCount * RG >= f.rings.length) return;
  const o = f.ringCount * RG;
  f.rings[o] = cx;
  f.rings[o + 1] = cy;
  f.rings[o + 2] = R;
  f.rings[o + 3] = w;
  f.rings[o + 4] = gapA;
  f.rings[o + 5] = gapW;
  f.rings[o + 6] = gapB;
  f.rings[o + 7] = live;
  f.rings[o + 8] = ink;
  f.ringCount++;
}

/**
 * Ink codes for guides that are never hazards (touch() skips any zone with ink >= COLUMN):
 * zones: ink + COLUMN = a rain column guide, ink + LANE = a wall's safe lane (cy = top of the lane);
 * marks: ink + RAIL = a rider on a falling wall (its gap posts and the side rails at its height).
 */
export const TREAD = 4; // zones: ink + TREAD = a slam's footfall (a hazard, reported as "slam")
export const COLUMN = 10;
export const LANE = 20;
export const RAIL = 20;
/** marks: ink + GAP = where a shockwave's gap meets the page's rails or foot (stand on that line to pass through) */
export const GAP = 30;
/** a shockwave spends itself this far above the foot of the page, so the bottom lane is never a trap */
export const RING_FLOOR = 1.2;

/** Rain columns. `rails` of them hug a side rail (planVolley sets how many by stage), so the margins are never a refuge. */
export function rainColumns(p: Record<string, number>): number[] {
  const rail = ARENA.W / 2 - 0.45;
  if (p.hem) return [-rail, rail]; // a hem: both side rails at once
  const r = rngFor("rain", p.seed);
  const cols: number[] = [];
  const rails = p.rails ?? (p.seed % 3 === 2 ? 2 : 1);
  const L = ARENA.W / 2 - 0.6;
  for (let c = 0; c < p.cols; c++) {
    const x = r.range(-L, L);
    // a Calm rain that spares the rails leans its columns a little outward instead (a column near the
    // middle can be dodged either way; one near the margin only one way, so the margins get a fair share)
    cols.push(rails === 0 ? Math.sign(x) * L * Math.pow(Math.abs(x) / L, 0.75) : x);
  }
  const side = p.seed % 2 ? 1 : -1;
  if (rails > 0) cols[0] = side * rail;
  if (rails > 1 && cols.length > 1) cols[1] = -side * rail;
  return cols;
}

/**
 * Where a shockwave's gap (the ray from its centre at angle `a`) meets the page frame: a side rail, or the
 * line it spends itself on above the foot of the page (drawn just below the arena). Null when the gap points
 * up into the titan, or the ring spends itself before it gets there.
 */
export function gapSight(cx: number, cy: number, a: number, reach: number): { x: number; y: number } | null {
  const c = Math.cos(a),
    s = Math.sin(a);
  let t = 1e9;
  if (c > 1e-3) t = (ARENA.W / 2 - cx) / c;
  else if (c < -1e-3) t = (-ARENA.W / 2 - cx) / c;
  let floor = false;
  if (s < -1e-3) {
    const tf = (RING_FLOOR - cy) / s;
    if (tf < t) {
      t = tf;
      floor = true;
    }
  }
  if (t > reach + 0.5) return null;
  const y = cy + s * t;
  if (y > ARENA.H) return null;
  return floor ? { x: cx + c * t, y: -0.35 } : { x: (c > 0 ? 1 : -1) * (ARENA.W / 2 + 0.35), y };
}

/** a beam's sweep ends at least this far (from its edge) short of the foot corner it swings toward */
export const BEAM_POCKET = 1.5;
/** the farthest a light can reach into a foot corner (hunt.ts clamps x to W/2 - 0.3, y to 0.4) */
export const FOOT_CORNER = { x: ARENA.W / 2 - 0.3, y: 0.4 };

/**
 * Where a beam swinging from `a1` toward `a2` must stop: short of the foot corner on the side it swings to,
 * so a hunter who runs ahead of the sweep into that corner is left a pocket of BEAM_POCKET units. A sweep that
 * already stops short is unchanged.
 */
export function beamStop(ox: number, oy: number, a1: number, a2: number, width: number): number {
  const dir = Math.sign(a2 - a1) || 1; // +1 swings toward the right rail, -1 toward the left
  const cx = dir * FOOT_CORNER.x,
    cy = FOOT_CORNER.y;
  const ac = Math.atan2(cy - oy, cx - ox);
  const g = Math.asin(Math.min(1, (BEAM_POCKET + width / 2) / Math.hypot(cx - ox, cy - oy)));
  const limit = ac - dir * g;
  let a = dir > 0 ? Math.min(a2, limit) : Math.max(a2, limit);
  // never a sweep that barely moves (or turns back): at least ~14 degrees of travel
  if ((a - a1) * dir < 0.25) a = a1 + dir * 0.25;
  return a;
}

/** Where a beam at angle `a` from (ox, oy) meets the page's frame: a side rail, or just below the foot. */
export function beamEndSight(ox: number, oy: number, a: number): { x: number; y: number } {
  const c = Math.cos(a),
    s = Math.sin(a);
  let t = 1e9;
  if (c > 1e-3) t = (ARENA.W / 2 - ox) / c;
  else if (c < -1e-3) t = (-ARENA.W / 2 - ox) / c;
  if (s < -1e-3) {
    const tf = (0 - oy) / s;
    if (tf < t) return { x: ox + c * tf, y: -0.35 };
  }
  return { x: (c > 0 ? 1 : -1) * (ARENA.W / 2 + 0.35), y: oy + s * t };
}

/**
 * Walls and rain spend themselves this far above the foot of the page (like a shockwave at RING_FLOOR): the
 * bottom lane is never where they finish you (R5: 34 of 64 hits were below y 1.6). They thin out from
 * INK_FADE down to INK_FLOOR, then they are gone.
 */
export const INK_FLOOR = 1;
export const INK_FADE = 1.8;
export const fadeAt = (y: number) => (y >= INK_FADE ? 1 : 0.35 + (0.65 * (y - INK_FLOOR)) / (INK_FADE - INK_FLOOR));
/**
 * Ink drawn fainter than this is spent: it can still be grazed, but it never strikes (R6: 10 of 63 hits came
 * from wall and rain drops drawn at 44-87% near the foot, and every reader takes fading ink as harmless).
 */
export const SPENT_ALPHA = 0.95;
/**
 * Rain leaves the titan this high, above the page: the fastest drop is seen falling for 0.3 s before it can
 * reach a light on the top row (R6: 7 hits at y 18.6-18.8 were drops that appeared on the light).
 */
export const RAIN_TOP = ARENA.TOP + 2.5;

/** A slam's tread: where the titan's foot comes down at the top of the page (top corners, under its body). */
export function slamTread(p: Record<string, number>) {
  return { x: (p.cx >= 0 ? 1 : -1) * (ARENA.W / 2 - 1.5), y: ARENA.H - 0.5, R: 2.4 };
}

/** id space: (phraseAbs, volley index within loop, bullet index) folded into 32 bits */
const bid = (pa: number, vid: number, i: number) => (((pa & 0x3ff) << 22) | ((vid % 1000 & 0x3ff) << 12) | (i & 0xfff)) >>> 0;

function emit(v: Volley, age: number, beatLen: number, f: FieldFrame, pa: number, rainThin: Thin | null = null) {
  const p = v.p;
  const tSec = age * beatLen; // seconds since spawn (negative while telegraphing)
  const tele = age < 0 ? 1 + age / v.tele : 1; // 0..1 telegraph progress
  const vid = v.id;
  curKind = KIND_LIST.indexOf(v.kind);
  switch (v.kind) {
    case "ring": {
      const echoes = p.echoes ?? 1;
      if (age < 0) {
        pushMark(f, p.ox, p.oy, tele, v.ink);
        return;
      }
      for (let e = 0; e < echoes; e++) {
        const te = tSec - e * beatLen * 2;
        if (te < 0) continue;
        const n = p.n;
        for (let i = 0; i < n; i++) {
          const a = DOWN - p.arc / 2 + (p.arc * (i + 0.5)) / n + (e % 2 ? p.arc / n / 2 : 0) + Math.sin(p.a0) * 0.05;
          const d = p.speed * te;
          pushBullet(f, p.ox + Math.cos(a) * d, p.oy + Math.sin(a) * d, p.rad, v.ink, 1, bid(pa, vid, e * 64 + i), Math.cos(a) * p.speed, Math.sin(a) * p.speed);
        }
      }
      return;
    }
    case "spiral": {
      const twin = p.twin ? 2 : 1;
      if (age < 0) {
        pushMark(f, p.ox, p.oy, tele, v.ink);
        return;
      }
      const durSec = p.dur * beatLen;
      for (let k = 0; k < twin; k++) {
        for (let i = 0; i < p.n; i++) {
          const ts = (durSec * i) / p.n;
          const te = tSec - ts;
          if (te < 0) break;
          let a = p.a0 + p.dir * ((TAU * p.turns * i) / p.n) + k * Math.PI;
          // fold upward shots downward so nothing is wasted off the top of the page
          if (Math.sin(a) > 0.1) a = -a;
          const d = p.speed * te;
          pushBullet(f, p.ox + Math.cos(a) * d, p.oy + Math.sin(a) * d, p.rad, v.ink, 1, bid(pa, vid, k * 256 + i), Math.cos(a) * p.speed, Math.sin(a) * p.speed);
        }
      }
      return;
    }
    case "fan": {
      const base = Math.atan2(p.ty - p.oy, p.tx - p.ox);
      if (age < 0) {
        pushMark(f, p.ox, p.oy, tele, v.ink);
        return;
      }
      for (let w = 0; w < p.waves; w++) {
        const te = tSec - w * p.gap * beatLen;
        if (te < 0) break;
        for (let i = 0; i < p.n; i++) {
          const a = base - p.spread / 2 + (p.spread * i) / Math.max(1, p.n - 1) + (w % 2 ? p.spread / (p.n - 1) / 2 : 0);
          const d = p.speed * te;
          pushBullet(f, p.ox + Math.cos(a) * d, p.oy + Math.sin(a) * d, p.rad, v.ink, 1, bid(pa, vid, w * 32 + i), Math.cos(a) * p.speed, Math.sin(a) * p.speed);
        }
      }
      return;
    }
    case "wall": {
      const W = ARENA.W;
      for (let row = 0; row < p.rows; row++) {
        const te = tSec - row * beatLen * 2;
        const gx = p.gapX + (row ? p.shift : 0);
        if (te < 0) {
          if (row === 0 || age >= 0) {
            // telegraph: gap posts at the top edge, and the safe lane lit down the whole page
            // (brightening through the last beat before the wall drops)
            const pr = row === 0 ? Math.max(0, tele) : Math.max(0, 1 + te / (beatLen * 2));
            pushMark(f, gx - p.gapW / 2, ARENA.TOP - 0.3, pr, v.ink);
            pushMark(f, gx + p.gapW / 2, ARENA.TOP - 0.3, pr, v.ink);
            pushZone(f, gx, ARENA.TOP, p.gapW / 2, pr * 0.999, v.ink + LANE);
          }
          continue;
        }
        const y = ARENA.TOP + 0.5 - p.speed * te;
        if (y < INK_FLOOR) continue; // spent above the foot of the page
        const alpha = fadeAt(y);
        let i = 0;
        for (let x = -W / 2; x <= W / 2; x += p.spacing, i++) {
          if (Math.abs(x - gx) < p.gapW / 2) continue;
          pushBullet(f, x, y, p.rad, v.ink, alpha, bid(pa, vid, row * 128 + i), 0, -p.speed);
        }
        // while it falls: the gap's posts ride with the wall, the side rails mark its height,
        // and the lane below it stays lit so a hunter at the bottom sees where to stand
        pushMark(f, gx - p.gapW / 2, y, 1, v.ink + RAIL);
        pushMark(f, gx + p.gapW / 2, y, 1, v.ink + RAIL);
        pushMark(f, -W / 2 - 0.35, y, 1, v.ink + RAIL);
        pushMark(f, W / 2 + 0.35, y, 1, v.ink + RAIL);
        pushZone(f, gx, y, p.gapW / 2, 1 + Math.min(0.999, Math.max(0, (ARENA.TOP - y) / ARENA.TOP)), v.ink + LANE);
      }
      return;
    }
    case "rain": {
      // (a first hunt's grace field spares some columns, whole, for their whole life: rainSpared)
      const cols = rainColumns(p).map((x, c) => (rainThin && rainSpared(c, x, rainThin) ? NaN : x));
      const fallBeats = (p.drops - 1) * p.every + 0.5; // the last drop leaves the top this many beats in
      if (age < 0) {
        for (const x of cols) if (x === x) pushZone(f, x, ARENA.H * 0.5, 0.35, tele * 0.999, v.ink + COLUMN); // column telegraph
        return;
      }
      // the guide stays (faintly) while its column is still raining
      if (age < fallBeats) for (const x of cols) if (x === x) pushZone(f, x, ARENA.H * 0.5, 0.35, 1 + (age / fallBeats) * 0.999, v.ink + COLUMN);
      cols.forEach((x, c) => {
        if (x !== x) return;
        for (let d = 0; d < p.drops; d++) {
          const te = tSec - (d * p.every + (c % 2) * 0.5) * beatLen;
          if (te < 0) continue;
          // every drop leaves from above the page (over the titan) and is seen falling before it reaches the top row
          const y = RAIN_TOP - p.speed * te;
          if (y < INK_FLOOR) continue; // spent above the foot of the page
          pushBullet(f, x, y, p.rad, v.ink, fadeAt(y), bid(pa, vid, c * 16 + d), 0, -p.speed);
        }
      });
      return;
    }
    case "wave": {
      if (age < 0) {
        pushMark(f, p.ox, p.oy, tele, v.ink);
        return;
      }
      for (let i = 0; i < p.n; i++) {
        const te = tSec - i * p.every * beatLen;
        if (te < 0) break;
        const y = p.oy - p.speed * te;
        const x = p.ox + Math.sin(p.phase + te * p.freq * TAU) * p.amp + Math.sin(i * 1.7) * 0.4;
        pushBullet(f, x, y, p.rad, v.ink, 1, bid(pa, vid, i), Math.cos(p.phase + te * p.freq * TAU) * p.amp * p.freq * TAU, -p.speed);
      }
      return;
    }
    case "curve": {
      if (age < 0) {
        pushMark(f, p.ox, p.oy, tele, v.ink);
        return;
      }
      for (let i = 0; i < p.n; i++) {
        const a0 = DOWN - p.arc / 2 + (p.arc * i) / Math.max(1, p.n - 1) + p.a0;
        const w = p.omega;
        const R = p.speed / w;
        const x = p.ox + R * (Math.sin(a0 + w * tSec) - Math.sin(a0));
        const y = p.oy - R * (Math.cos(a0 + w * tSec) - Math.cos(a0));
        pushBullet(f, x, y, p.rad, v.ink, 1, bid(pa, vid, i), p.speed * Math.cos(a0 + w * tSec), p.speed * Math.sin(a0 + w * tSec));
      }
      return;
    }
    case "bloom": {
      if (age < 0) {
        pushMark(f, p.ox, p.oy, tele, v.ink);
        return;
      }
      const travel = p.travel * beatLen;
      if (tSec < travel) {
        const k = tSec / travel;
        const e = 1 - (1 - k) * (1 - k);
        pushBullet(f, p.ox + (p.tx - p.ox) * e, p.oy + (p.ty - p.oy) * e, p.seedRad, 2, 1, bid(pa, vid, 4000), ((p.tx - p.ox) * 2 * (1 - k)) / travel, ((p.ty - p.oy) * 2 * (1 - k)) / travel);
        pushZone(f, p.tx, p.ty, 0.9, k * 0.999, v.ink);
        return;
      }
      const te = tSec - travel;
      for (let i = 0; i < p.n; i++) {
        const a = (TAU * i) / p.n + p.tx;
        const d = p.speed * te;
        pushBullet(f, p.tx + Math.cos(a) * d, p.ty + Math.sin(a) * d, p.rad, v.ink, 1, bid(pa, vid, i), Math.cos(a) * p.speed, Math.sin(a) * p.speed);
      }
      return;
    }
    case "beam": {
      const durSec = p.dur * beatLen;
      const twin = p.twin ? 2 : 1;
      for (let k = 0; k < twin; k++) {
        const a1 = k ? 2 * DOWN - p.a1 : p.a1;
        const a2 = k ? 2 * DOWN - p.a2 : p.a2;
        // where the sweep will stop, as a gilt tick on the rail or the foot (a GAP mark, like a shockwave's sight)
        const end = beamEndSight(p.ox, p.oy, a2);
        if (age < 0) {
          // telegraph: live = 0.02..0.98 carries its progress (0 is a hound's aim line), so the
          // guide can thicken as the strike nears; anything below 1 is never a hazard
          pushBeam(f, p.ox, p.oy, p.ox + Math.cos(a1) * p.len, p.oy + Math.sin(a1) * p.len, p.width, 0.02 + 0.96 * tele, v.ink);
          pushMark(f, end.x, end.y, tele * 0.999, v.ink + GAP);
          continue;
        }
        if (tSec > durSec) continue;
        const k2 = tSec / durSec;
        pushMark(f, end.x, end.y, 1 + k2 * 0.999, v.ink + GAP);
        const e = k2 * k2 * (3 - 2 * k2);
        const a = a1 + (a2 - a1) * e;
        pushBeam(f, p.ox, p.oy, p.ox + Math.cos(a) * p.len, p.oy + Math.sin(a) * p.len, p.width, 1, v.ink);
      }
      return;
    }
    case "slam": {
      const tr = slamTread(p);
      const tread = p.tread ?? 1;
      const reach = p.reach ?? ARENA.H * 1.6;
      // each gap's sight on the rails (or the foot of the page), from the telegraph on: a hunter sees where
      // to stand before the ring arrives, as a wall's posts show its lane
      const sights = (k: number, pr: number) => {
        for (const g of [p.gapA + k * 1.3, p.gapB + k * 0.7]) {
          const s = gapSight(p.cx, p.cy, g, reach);
          if (s) pushMark(f, s.x, s.y, pr, v.ink + GAP);
        }
      };
      if (age < 0) {
        pushZone(f, p.cx, p.cy, 1.1, tele * 0.999, v.ink + TREAD);
        if (tread) pushZone(f, tr.x, tr.y, tr.R, tele * 0.999, v.ink + TREAD);
        sights(0, tele * 0.999);
        return;
      }
      // the foot itself lands for most of a beat: a splash under the titan in the top corner (from Wrath on)
      if (tread && tSec < beatLen * 0.75) pushZone(f, tr.x, tr.y, tr.R, 1 + tSec / (beatLen * 0.75), v.ink + TREAD);
      for (let k = 0; k < p.rings; k++) {
        const te = tSec - k * beatLen * 2;
        if (te < 0) {
          if (te > -beatLen * 2) sights(k, Math.max(0, 1 + te / (beatLen * 2)) * 0.999);
          continue;
        }
        const R = p.speed * te;
        if (R > reach) continue; // the shockwave spends itself
        pushRing(f, p.cx, p.cy, R, p.width, p.gapA + k * 1.3, p.gapW, p.gapB + k * 0.7, 1, v.ink);
        sights(k, 1 + Math.min(0.999, R / reach));
      }
      if (tSec < beatLen) pushZone(f, p.cx, p.cy, 1.1, 1 + tSec / beatLen, v.ink + TREAD);
      return;
    }
    case "glyph": {
      if (age < 0) {
        pushZone(f, p.cx, p.cy, p.R, tele * 0.999, v.ink);
        return;
      }
      if (age < p.dur) pushZone(f, p.cx, p.cy, p.R, 1 + age / p.dur, v.ink);
      return;
    }
    case "cross": {
      for (let row = 0; row < p.rows; row++) {
        const te = tSec - row * p.every * beatLen;
        const side = row % 2 ? 1 : -1; // enters from the left or right edge
        if (te < 0) {
          if (row === 0) pushMark(f, side * (ARENA.W / 2 - 0.3), ARENA.TOP - 0.3, Math.max(0, tele), v.ink);
          continue;
        }
        const n = Math.ceil((ARENA.W + 6) / p.spacing);
        const dirx = -side * p.slope;
        const diry = -1;
        const L = Math.hypot(dirx, diry);
        for (let i = 0; i < n; i++) {
          const x0 = side * (ARENA.W / 2) - side * i * p.spacing * 0.5 + side * 2;
          const y0 = ARENA.TOP + 0.5 + i * p.spacing * 0.85;
          const d = p.speed * te;
          pushBullet(f, x0 + (dirx / L) * d, y0 + (diry / L) * d, p.rad, v.ink, 1, bid(pa, vid, row * 64 + i), (dirx / L) * p.speed, (diry / L) * p.speed);
        }
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Collision against one hunter. Returns a hit (and the hazard kind) and collects grazes.

export interface Touch {
  hit: boolean;
  hitKind?: string;
  grazes: number[]; // bullet ids grazed this frame
  nearest: number; // closest clearance to any live hazard
}

export const PLAYER_R = 0.13;
export const GRAZE_R = 0.75;

const angDist = (a: number, b: number) => {
  let d = (a - b) % TAU;
  if (d < -Math.PI) d += TAU;
  if (d > Math.PI) d -= TAU;
  return Math.abs(d);
};

export function touch(f: FieldFrame, x: number, y: number, out: Touch): Touch {
  out.hit = false;
  out.hitKind = undefined;
  out.grazes.length = 0;
  let nearest = 99;
  for (let i = 0; i < f.bulletCount; i++) {
    const o = i * B;
    const dx = f.bullets[o] - x;
    const dy = f.bullets[o + 1] - y;
    const d = Math.sqrt(dx * dx + dy * dy) - f.bullets[o + 2] - PLAYER_R;
    // spent ink (fading out near the foot of the page) only grazes: brushing through it still feeds Resonance
    const live = f.bullets[o + 4] >= SPENT_ALPHA;
    if (live && d < nearest) nearest = d;
    if (d < 0 && live) {
      out.hit = true;
      out.hitKind = f.bullets[o + 5] >= KIND_LIST.length ? "hound" : (KIND_LIST[f.bullets[o + 5]] ?? "ring");
    } else if (d < GRAZE_R) out.grazes.push(f.bulletIds[i]);
  }
  for (let i = 0; i < f.beamCount; i++) {
    const o = i * BM;
    if (f.beams[o + 5] < 1) continue;
    const x1 = f.beams[o],
      y1 = f.beams[o + 1],
      x2 = f.beams[o + 2],
      y2 = f.beams[o + 3];
    const vx = x2 - x1,
      vy = y2 - y1;
    const k = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy)));
    const d = Math.hypot(x - (x1 + vx * k), y - (y1 + vy * k)) - f.beams[o + 4] / 2 - PLAYER_R;
    if (d < nearest) nearest = d;
    if (d < 0) {
      out.hit = true;
      out.hitKind = "beam";
    }
  }
  for (let i = 0; i < f.ringCount; i++) {
    if (y < RING_FLOOR) break; // a shockwave spends itself above the foot of the page
    const o = i * RG;
    const dx = x - f.rings[o],
      dy = y - f.rings[o + 1];
    const r = Math.hypot(dx, dy);
    const d = Math.abs(r - f.rings[o + 2]) - f.rings[o + 3] / 2 - PLAYER_R;
    if (d < nearest) nearest = d;
    if (d < 0) {
      const a = Math.atan2(dy, dx);
      const inGap = angDist(a, f.rings[o + 4]) < f.rings[o + 5] / 2 || angDist(a, f.rings[o + 6]) < f.rings[o + 5] / 2;
      if (!inGap) {
        out.hit = true;
        out.hitKind = "slam";
      }
    }
  }
  for (let i = 0; i < f.zoneCount; i++) {
    const o = i * ZN;
    if (f.zones[o + 3] < 1 || f.zones[o + 4] >= COLUMN) continue;
    const d = Math.hypot(x - f.zones[o], y - f.zones[o + 1]) - f.zones[o + 2] - PLAYER_R;
    if (d < nearest) nearest = d;
    if (d < 0) {
      out.hit = true;
      out.hitKind = f.zones[o + 4] >= TREAD ? "slam" : "zone";
    }
  }
  out.nearest = nearest;
  return out;
}

export const STRIDE = { B, BM, RG, ZN, MK };

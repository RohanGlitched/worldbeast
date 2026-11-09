import { ARENA, coreOpen, Stage, TitanSpec } from "./titan";
import { Field, FieldFrame, newFrame, pushPersonal, pushPersonalAim, pushPersonalMark, touch, Touch, STRIDE } from "./field";
import { rngFor } from "./rng";

// One hunter's run: movement, dash, grazes, resonance, darts and damage. Pure logic, no DOM.

export type AspectId = "ember" | "lance" | "bloom" | "mirror";

export interface Aspect {
  id: AspectId;
  name: string;
  line: string;
  fireEvery: number; // seconds between shots
  dart: number; // base damage per shot
  speed: number; // move speed, units/s
  dashCd: number; // seconds
  pierce: boolean;
  spread: number; // darts per shot
}

export const ASPECTS: Record<AspectId, Aspect> = {
  ember: { id: "ember", name: "Ember", line: "Quick darts, steady hands. The first light most hunters carry.", fireEvery: 0.11, dart: 9, speed: 8.6, dashCd: 1.1, pierce: false, spread: 1 },
  lance: { id: "lance", name: "Lance", line: "Slow, heavy bolts. Every shot lands like a bell.", fireEvery: 0.42, dart: 40, speed: 8.0, dashCd: 1.2, pierce: true, spread: 1 },
  bloom: { id: "bloom", name: "Bloom", line: "A spray of petals that hits hardest from close to the titan.", fireEvery: 0.24, dart: 7, speed: 9.2, dashCd: 1.0, pierce: false, spread: 4 },
  mirror: { id: "mirror", name: "Mirror", line: "Dash through an attack at the last moment and it turns back on the titan.", fireEvery: 0.16, dart: 8, speed: 8.8, dashCd: 0.85, pierce: false, spread: 1 },
};

export const MAX_HITS = 3;
const DASH_TIME = 0.16;
const DASH_SPEED = 26;
const INVULN_AFTER_HIT = 1.6;
/** a beam's hit keeps you safe until its sweep is over, up to this long */
const INVULN_BEAM_MAX = 4.5;
/** grace at spawn, seconds (the caller may lengthen it for first hunts) */
export const SPAWN_GRACE = 3;
/** seconds without being struck that rekindle a lost light */
export const RELIGHT_AFTER = 30;
/** where a fresh light enters the page: low, but above the bottom lane where walls finish */
export const SPAWN_Y = 5;
/** the most a grace may be held open while an attack is passing over you, seconds */
const GRACE_HOLD = 1.5;
const RESONANCE_PER_GRAZE = 9;
const SURGE_TIME = 3.2;
const DART_SPEED = 30;

export interface Dart {
  x: number;
  y: number;
  tx: number;
  ty: number;
  core: number;
  dmg: number;
  t: number; // flight time left
  surge: boolean;
}

export interface HitEvent {
  core: number;
  dmg: number;
  x: number;
  y: number;
  surge: boolean;
  beat: number;
}

export interface Input {
  mx: number; // -1..1
  my: number;
  dash: boolean;
  /** absolute target (touch drag), overrides mx/my when set */
  tx?: number;
  ty?: number;
}

export class Hunt {
  readonly spec: TitanSpec;
  readonly field: Field;
  readonly aspect: Aspect;
  frame: FieldFrame = newFrame();
  private tch: Touch = { hit: false, grazes: [], nearest: 99 };

  x = 0;
  y = SPAWN_Y;
  vx = 0;
  vy = 0;
  hits = 0;
  invuln = SPAWN_GRACE; // grace at spawn
  /** the grace this run started with (for the shrinking spawn ring) */
  graceMax = SPAWN_GRACE;
  /**
   * On the first step the hunt picks its own spawn: the point on the spawn row that stays clear of
   * the shared field through the grace and two beats beyond it. Set false to keep a caller's x/y.
   */
  autoSpawn = true;
  /** true until the spawn (or revive) grace has run out */
  inGrace = true;
  private graceExtra = 0;
  /** lights given back after RELIGHT_AFTER clean seconds (the caller cues each one) */
  relights = 0;
  dashT = 0;
  dashCd = 0;
  dashDir = { x: 0, y: 1 };
  fireT = 0;
  resonance = 0; // 0..100
  surgeT = 0;
  surges = 0;
  damage = 0;
  grazeCount = 0;
  combo = 0;
  bestCombo = 0;
  comboT = 0;
  alive = true;
  time = 0; // seconds alive this run
  darts: Dart[] = [];
  events: HitEvent[] = []; // drained by the caller
  hurtEvents = 0; // incremented when hit (caller reads deltas)
  mirrorReflects = 0;
  lastHitKind = "";
  /** clearance to the nearest live hazard this frame (for the music's danger swell) */
  nearest = 99;
  /** longest stretch without being struck, seconds */
  cleanBest = 0;
  private lastHitAt = 0;
  private lastRelightAt = 0;
  hitLog: string[] = [];
  private dashId = 0;
  private mirroredDash = -1;
  private grazed = new Set<number>();
  /**
   * Hounds: small volleys only you face, thrown at where you are. They stop a still hunter from
   * farming the titan, fill the quiet bars of Calm, and grow fiercer the longer a run lasts.
   */
  private hounds: Array<{ beat: number; ox: number; oy: number; a: number; n: number; spread: number; speed: number; id: number }> = [];
  private nextHound = -1;
  /** a hound has been thrown at this hunter at least once (for the first-run note) */
  houndWarned = false;
  /** seconds into a run before hounds begin (first hunts are gentler) */
  houndsAfter = 0;
  private houndId = 0;
  private stillT = 0;
  private lastX = 0;
  private lastY = SPAWN_Y;
  /** seconds spent hugging a side rail or the top edge (hounds come oftener for a camper) */
  private edgeT = 0;
  private lastBeat = 0;

  constructor(spec: TitanSpec, field: Field, aspect: AspectId) {
    this.spec = spec;
    this.field = field;
    this.aspect = ASPECTS[aspect];
  }

  /** Advance one frame. `t` = seconds since the titan woke (synced), `dt` = frame seconds. */
  step(t: number, dt: number, input: Input, stage: Stage, coreBroken: (id: number) => boolean = () => false) {
    dt = Math.min(dt, 1 / 20);
    const beat = t / this.spec.beat;
    if (this.autoSpawn && this.time === 0 && this.alive) {
      this.autoSpawn = false;
      this.pickSpawn(t, stage);
    }
    this.field.sample(t, stage, this.frame);
    if (!this.alive) return;
    this.time += dt;
    this.lastBeat = beat;

    // --- movement
    const a = this.aspect;
    this.dashCd = Math.max(0, this.dashCd - dt);
    let dx = input.mx,
      dy = input.my;
    if (input.tx !== undefined && input.ty !== undefined) {
      const ddx = input.tx - this.x,
        ddy = input.ty - this.y;
      const dist = Math.hypot(ddx, ddy);
      const want = Math.min(1, dist / 0.9);
      dx = dist > 1e-4 ? (ddx / dist) * want : 0;
      dy = dist > 1e-4 ? (ddy / dist) * want : 0;
    }
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    if (input.dash && this.dashCd <= 0 && this.dashT <= 0) {
      const m = Math.hypot(dx, dy);
      this.dashDir = m > 0.1 ? { x: dx / m, y: dy / m } : { x: 0, y: 1 };
      this.dashT = DASH_TIME;
      this.dashCd = a.dashCd;
      this.dashId++;
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vx = this.dashDir.x * DASH_SPEED;
      this.vy = this.dashDir.y * DASH_SPEED;
    } else {
      const k = 1 - Math.exp(-dt * 22);
      this.vx += (dx * a.speed - this.vx) * k;
      this.vy += (dy * a.speed - this.vy) * k;
    }
    this.x = Math.max(-ARENA.W / 2 + 0.3, Math.min(ARENA.W / 2 - 0.3, this.x + this.vx * dt));
    this.y = Math.max(0.4, Math.min(ARENA.H - 1.2, this.y + this.vy * dt));

    // --- hounds (personal, local-only volleys)
    this.houndsStep(t, beat, stage, dt);

    // --- hazards
    this.invuln = Math.max(0, this.invuln - dt);
    const tc = touch(this.frame, this.x, this.y, this.tch);
    this.nearest = tc.nearest;
    if (this.inGrace) {
      // the grace never runs out inside an attack: it holds (up to GRACE_HOLD s) until your spot is clear
      if (this.invuln < 0.2 && tc.nearest < 0.45 && this.graceExtra < GRACE_HOLD) {
        this.graceExtra += 0.2 - this.invuln;
        this.invuln = 0.2;
      }
      if (this.invuln <= 0) this.inGrace = false;
    }
    const dashing = this.dashT > 0;
    if (tc.hit) {
      if (dashing) {
        if (a.id === "mirror" && this.dashT > DASH_TIME * 0.35) this.mirror(stage);
      } else if (this.invuln <= 0) {
        this.hits++;
        this.hurtEvents++;
        this.lastHitKind = tc.hitKind ?? "?";
        this.lastHitAt = this.time;
        this.hitLog.push(this.lastHitKind);
        // a beam sweeps on after it strikes you: stay safe until its sweep ends, so one beam is one light
        this.invuln = tc.hitKind === "beam" ? Math.max(INVULN_AFTER_HIT, Math.min(INVULN_BEAM_MAX, this.field.beamLeft(t, stage) + 0.25)) : INVULN_AFTER_HIT;
        this.combo = 0;
        // a hit costs a light, not your Resonance
        if (this.hits >= MAX_HITS) {
          this.alive = false;
          return;
        }
      }
    }
    for (const id of tc.grazes) {
      if (this.grazed.has(id)) continue;
      this.grazed.add(id);
      this.grazeCount++;
      this.combo++;
      this.comboT = 1.4;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      const hound = id >= 0x7f000000; // brushing past your own hounds is worth twice as much
      if (this.surgeT <= 0) this.resonance = Math.min(100, this.resonance + RESONANCE_PER_GRAZE * (hound ? 2 : 1));
    }
    if (this.grazed.size > 4000) this.grazed.clear();
    this.cleanBest = Math.max(this.cleanBest, this.time - this.lastHitAt);
    // a long clean stretch rekindles a lost light (and the clock starts again for the next one)
    if (this.hits > 0 && this.time - Math.max(this.lastHitAt, this.lastRelightAt) >= RELIGHT_AFTER) {
      this.hits--;
      this.relights++;
      this.lastRelightAt = this.time;
    }
    this.comboT -= dt;
    if (this.comboT <= 0) this.combo = 0;

    // --- surge
    const openCores = t < 0 ? [] : this.spec.cores.filter((c) => !coreBroken(c.id) && coreOpen(c, beat, stage));
    if (this.resonance >= 100 && openCores.length && this.surgeT <= 0) {
      this.surgeT = SURGE_TIME;
      this.surges++;
      this.resonance = 0;
    }
    if (this.surgeT > 0) this.surgeT -= dt;

    // --- firing at the nearest open core
    this.fireT -= dt;
    if (openCores.length && this.fireT <= 0) {
      const surge = this.surgeT > 0;
      this.fireT = surge ? a.fireEvery * 0.5 : a.fireEvery;
      let best = openCores[0],
        bd = 1e9;
      for (const c of openCores) {
        const d = Math.hypot(c.x - this.x, c.y - this.y);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      // closer to the titan strikes harder, but the graze chain matters more: weaving through the
      // ink is the reward, so a hunter parked in a quiet corner under the titan cannot farm it
      const reach = reachAt(this.y);
      const comboMul = chainMul(this.combo);
      for (let s = 0; s < a.spread; s++) {
        const spreadMul = a.id === "bloom" ? 0.75 + 0.7 * (this.y / ARENA.H) : 1;
        const dmg = a.dart * reach * comboMul * spreadMul * (surge ? 2.5 : 1);
        const off = a.spread > 1 ? (s - (a.spread - 1) / 2) * 0.6 : 0;
        this.darts.push({ x: this.x, y: this.y, tx: best.x + off, ty: best.y, core: best.id, dmg, t: bd / DART_SPEED, surge });
      }
    }
    // --- darts in flight
    for (let i = this.darts.length - 1; i >= 0; i--) {
      const d = this.darts[i];
      const k = Math.min(1, dt / Math.max(d.t, 1e-4));
      d.x += (d.tx - d.x) * k;
      d.y += (d.ty - d.y) * k;
      d.t -= dt;
      if (d.t <= 0) {
        const core = this.spec.cores[d.core];
        if (core && coreOpen(core, beat, stage) && !coreBroken(core.id)) {
          const dmg = Math.round(d.dmg);
          this.damage += dmg;
          this.events.push({ core: d.core, dmg, x: d.tx, y: d.ty, surge: d.surge, beat });
        }
        this.darts.splice(i, 1);
      }
    }
  }

  private houndsStep(t: number, beat: number, stage: Stage, dt: number) {
    if (t < 0) return;
    if (this.time < this.houndsAfter) {
      this.nextHound = -1;
      return;
    }
    const moved = Math.hypot(this.x - this.lastX, this.y - this.lastY);
    this.lastX = this.x;
    this.lastY = this.y;
    this.stillT = moved < dt * 1.2 ? this.stillT + dt : 0;
    const hugging = Math.abs(this.x) > ARENA.W / 2 - 1.4 || this.y > ARENA.H - 3;
    this.edgeT = hugging ? this.edgeT + dt : Math.max(0, this.edgeT - dt * 2);
    // interval in beats: shorter as the run goes on, in harder stages, and much shorter for a hunter who sits still
    const runRamp = Math.min(1, this.time / 90);
    let every = (stage === 0 ? 6 : stage === 1 ? 5 : 4) - runRamp * 2.5;
    if (this.edgeT > 3) every = Math.min(every, 2.5);
    if (this.stillT > 1.6) every = 1.5;
    // the first hound winds up only once the spawn grace is over
    if (this.nextHound < 0) this.nextHound = Math.ceil(beat + Math.max(0, this.invuln) / this.spec.beat) + 1;
    if (beat >= this.nextHound) {
      const r = rngFor("hound", this.spec.seed, this.houndId);
      const o = this.spec.origins[this.houndId % this.spec.origins.length];
      const lead = 1; // a beat of warning
      const n = 3 + Math.floor(runRamp * 2) + (stage > 1 ? 1 : 0);
      this.hounds.push({ beat: this.nextHound + lead, ox: o.x, oy: o.y, a: 0, n, spread: 0.32 - runRamp * 0.08, speed: 6.2 + runRamp * 1.6 + stage * 0.5, id: this.houndId++ });
      this.nextHound += Math.max(1.5, Math.round(every * 2) / 2) + (r.chance(0.3) ? 0.5 : 0);
    }
    const bl = this.spec.beat;
    for (let i = this.hounds.length - 1; i >= 0; i--) {
      const h = this.hounds[i];
      const age = beat - h.beat; // beats since release (negative = winding up)
      if (age < -1) continue;
      if (age < 0) {
        // aim tracks you until the moment of release, then it is committed
        h.a = Math.atan2(this.y - h.oy, this.x - h.ox);
        pushPersonalMark(this.frame, h.ox, h.oy, 1 + age);
        pushPersonalAim(this.frame, h.ox, h.oy, h.ox + Math.cos(h.a) * 34, h.oy + Math.sin(h.a) * 34);
        this.houndWarned = true;
        continue;
      }
      const ts = age * bl;
      const d = h.speed * ts;
      if (d > 34) {
        this.hounds.splice(i, 1);
        continue;
      }
      for (let k = 0; k < h.n; k++) {
        const a = h.a + (k - (h.n - 1) / 2) * h.spread;
        pushPersonal(this.frame, h.ox + Math.cos(a) * d, h.oy + Math.sin(a) * d, 0.25, 0x7f000000 + h.id * 16 + k, Math.cos(a) * h.speed, Math.sin(a) * h.speed);
      }
    }
  }

  /** a passing hunter rekindled this light: back in the fight with one hit left and a moment's grace */
  revive() {
    this.alive = true;
    this.hits = MAX_HITS - 1;
    this.invuln = 2.5;
    this.graceMax = 2.5;
    this.inGrace = true;
    this.graceExtra = 0;
    this.resonance = 0;
  }

  private mirror(stage: Stage) {
    // a perfect dash through an attack sends a gilded shard straight to the best open core
    const beat = this.lastBeat;
    const open = this.spec.cores.filter((c) => coreOpen(c, beat, stage));
    if (!open.length) return;
    if (this.mirroredDash === this.dashId) return; // once per dash
    this.mirroredDash = this.dashId;
    this.mirrorReflects++;
    const c = open[0];
    const reach = reachAt(this.y);
    this.darts.push({ x: this.x, y: this.y, tx: c.x, ty: c.y, core: c.id, dmg: 55 * reach, t: Math.hypot(c.x - this.x, c.y - this.y) / DART_SPEED, surge: true });
  }

  /**
   * Choose where this light enters: on the spawn row, the point whose clearance from the shared
   * field stays largest through the end of the grace and two beats past it (a hunter who has not
   * moved yet is never struck the moment grace ends). Deterministic for a given (seed, t, stage).
   */
  private pickSpawn(t: number, stage: Stage) {
    this.graceMax = Math.max(this.invuln, 0.001);
    const probe = newFrame(2048);
    const tc: Touch = { hit: false, grazes: [], nearest: 99 };
    const xs = [0, -1.2, 1.2, -2.4, 2.4, -3.6, 3.6, -4.8, 4.8];
    const ys = [SPAWN_Y, SPAWN_Y - 0.8, SPAWN_Y + 0.8];
    const graceEnd = this.invuln;
    const horizon = graceEnd + 2 * this.spec.beat + 0.3;
    const during = new Array(xs.length * ys.length).fill(9);
    const after = new Array(xs.length * ys.length).fill(9);
    for (let s = 0; s <= horizon + 1e-6; s += 0.1) {
      this.field.sample(t + s, stage, probe);
      let k = 0;
      for (const y of ys)
        for (const x of xs) {
          const c = touch(probe, x, y, tc).nearest;
          if (s >= graceEnd - 0.6) after[k] = Math.min(after[k], c);
          else during[k] = Math.min(during[k], c);
          k++;
        }
    }
    let best = 0,
      bs = -1e9,
      k = 0;
    for (const y of ys)
      for (const x of xs) {
        const score = Math.min(after[k], 2) * 3 + Math.min(during[k], 1.5) - Math.abs(x) * 0.08 - Math.abs(y - SPAWN_Y) * 0.1;
        if (score > bs) {
          bs = score;
          best = k;
        }
        k++;
      }
    this.x = xs[best % xs.length];
    this.y = ys[Math.floor(best / xs.length)];
    this.lastX = this.x;
    this.lastY = this.y;
  }

  get dashing() {
    return this.dashT > 0;
  }
  get surging() {
    return this.surgeT > 0;
  }
}

/** Height factor of a blow: nearer the titan strikes harder (x0.81 at the bottom, x1.13 at the top). */
export function reachAt(y: number): number {
  return 0.8 + 0.35 * (y / ARENA.H);
}
/** Graze-chain factor of a blow: x1 with no chain, x1.5 at a 30-graze chain. */
export function chainMul(combo: number): number {
  return 1 + (Math.min(combo, 30) / 30) * 0.5;
}

/** The most damage per second any aspect can deal (used by the world actor to reject impossible claims). */
export function maxDps(aspect?: AspectId): number {
  let best = 0;
  for (const a of Object.values(ASPECTS)) {
    if (aspect && a.id !== aspect) continue;
    const perShot = a.dart * 1.4 * 1.5 * (a.id === "bloom" ? 1.65 : 1) * a.spread * 2.5;
    best = Math.max(best, perShot / (a.fireEvery * 0.5) + (a.id === "mirror" || !aspect ? (55 * 1.4) / 0.85 : 0));
  }
  return best;
}

/**
 * The most damage an aspect can deal over a 12 s stretch: full reach and combo throughout,
 * plus one 3.2 s Surge (a Surge needs ~29 grazes, so two cannot fit in 12 s of honest play).
 */
export function sustainedBudget(aspect: AspectId, windowS = 12): number {
  const a = ASPECTS[aspect] ?? ASPECTS.ember;
  const spreadMul = a.id === "bloom" ? 1.65 : 1;
  const steady = (a.dart * 1.4 * 1.5 * spreadMul * a.spread) / a.fireEvery;
  const surge = (a.dart * 1.4 * 1.5 * spreadMul * a.spread * 2.5) / (a.fireEvery * 0.5);
  const mirror = a.id === "mirror" ? (55 * 1.4) / 0.85 : 0;
  return (steady + mirror) * windowS + (surge - steady) * 3.2;
}

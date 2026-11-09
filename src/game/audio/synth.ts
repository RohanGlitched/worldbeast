// Instruments of the living bestiary, synthesised from oscillators, noise and filters.
//
// Two ways to sound a note:
// - live: a short-lived graph of native nodes (sustained and swept voices: reed, organ, glass, bass,
//   bowed metal, air, gong);
// - from the bank: the struck instruments (bells, psaltery, drums, clacks, jingles, ticks, booms) are
//   rendered once by these same live voices on an OfflineAudioContext (bank.ts) and replayed as
//   buffer + gain. Same sound, a fraction of the CPU, which matters on phones.
// Every note is admitted by its group's polyphony cap and disconnected when its sources end.
// No per-sample JS runs on the audio thread.

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export type Group = "perc" | "bass" | "mel" | "bell" | "cue" | "impact" | "sfx" | "fx";
const CAPS: Record<Group, number> = { perc: 14, bass: 4, mel: 10, bell: 8, cue: 8, impact: 12, sfx: 14, fx: 6 };

/** Reference pitches rendered into the bank; playback shifts at most half an octave. */
export const BELL_REFS = [48, 60, 72, 84, 96];
export const PLUCK_REFS = [48, 60, 72, 84];
export const TICK_REFS = [72, 84, 96];
export const BANK_BELL_DECAY = 3.6;
export const BANK_PLUCK_DECAY = 2.6;
export const BOOM_F = 58;
export const BOOM_DECAY = 1.1;

const nearest = (refs: number[], m: number) => {
  let best = refs[0];
  for (const r of refs) if (Math.abs(r - m) < Math.abs(best - m)) best = r;
  return best;
};
const pluckScale = (midi: number) => clamp(1.6 - (midi - 60) / 40, 0.5, 1.6);

interface Voice {
  start: number;
  end: number;
  env: GainNode;
  srcs: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  prio: number;
}

export interface SynthStats {
  created: number; // nodes ever created for notes
  live: number; // note nodes not yet released
  voices: number; // voices tracked as sounding
  peakVoices: number;
  dropped: number; // notes refused by a polyphony cap
  stolen: number; // voices faded early to make room
  notes: number; // notes admitted
  sampled: number; // notes played from the bank
  panBuses: number; // persistent pan positions
}

export interface BankLink {
  buffers: Map<string, AudioBuffer>;
  low: unknown; // the drum params the titan bank was rendered with (identity match)
  frame: unknown;
}

type Pan = { pan?: number };

export class Synth {
  readonly ctx: BaseAudioContext;
  readonly noise: AudioBuffer;
  readonly waves: { pluck: PeriodicWave; organ: PeriodicWave; reed: PeriodicWave; hollow: PeriodicWave; bassDark: PeriodicWave; bassBright: PeriodicWave };
  stats: SynthStats = { created: 0, live: 0, voices: 0, peakVoices: 0, dropped: 0, stolen: 0, notes: 0, sampled: 0, panBuses: 0 };
  /** quiet mode lowers transients and drops the sub */
  quiet = false;
  bank: BankLink | null = null;
  private groups = new Map<Group, Voice[]>();
  private cur: { nodes: AudioNode[]; srcs: AudioScheduledSourceNode[] } = { nodes: [], srcs: [] };
  private nrand = 1;
  private buses = new Map<AudioNode, Map<number, StereoPannerNode>>();

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    // 2 s of white noise, shared by every noisy voice (sources are cheap, buffers are not)
    const len = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let s = 0x1234567;
    for (let i = 0; i < len; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
    }
    const pw = (amps: number[]) => {
      const re = new Float32Array(amps.length + 1);
      const im = new Float32Array(amps.length + 1);
      amps.forEach((a, i) => (im[i + 1] = a));
      return ctx.createPeriodicWave(re, im);
    };
    const series = (n: number, f: (k: number) => number) => Array.from({ length: n }, (_, i) => f(i + 1));
    this.waves = {
      // plucked string at 1/7 of its length: a_n = sin(n pi p) / n^1.4
      pluck: pw(series(28, (n) => Math.sin(n * Math.PI * 0.14) / Math.pow(n, 1.4))),
      // organ: principal 8', octave 4', twelfth, fifteenth, a touch of mixture
      organ: pw([1, 0.55, 0.32, 0.26, 0, 0.12, 0, 0.08]),
      // shawm: nasal, odd-leaning, a formant bump around the 3rd-5th harmonics, gentle roll-off
      reed: pw(series(20, (n) => ((n % 2 ? 1 : 0.6) * (n >= 3 && n <= 5 ? 1.5 : 1)) / Math.pow(n, 1.05))),
      // hollow: a soft flute / glass tone
      hollow: pw([1, 0.08, 0.22, 0.03, 0.06]),
      // bowed pedal bass: a dark and a brighter cut of the same string
      bassDark: pw(series(10, (n) => 1 / Math.pow(n, 1.9))),
      bassBright: pw(series(16, (n) => 1 / Math.pow(n, 1.25))),
    };
  }

  // ---------------------------------------------------------------------------- voice plumbing

  /** Can a note in `group` start at `when`? Steals the oldest voice for important notes. */
  private admit(group: Group, when: number, prio: number): boolean {
    let list = this.groups.get(group);
    if (!list) this.groups.set(group, (list = []));
    let w = 0;
    for (let i = 0; i < list.length; i++) if (list[i].end > when) list[w++] = list[i];
    list.length = w;
    if (list.length >= CAPS[group]) {
      if (prio < 1) {
        this.stats.dropped++;
        return false;
      }
      this.steal(list.shift()!, when);
    }
    this.cur.nodes = [];
    this.cur.srcs = [];
    return true;
  }

  private steal(v: Voice, when: number) {
    this.stats.stolen++;
    const g = v.env.gain;
    const t = Math.max(when, this.ctx.currentTime);
    if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(t);
    else g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.012);
    for (const s of v.srcs) {
      try {
        s.stop(t + 0.08);
      } catch {
        /* already stopped */
      }
    }
    v.end = t + 0.08;
  }

  private commit(group: Group, when: number, end: number, env: GainNode, prio: number) {
    const nodes = this.cur.nodes;
    const srcs = this.cur.srcs;
    this.groups.get(group)!.push({ start: when, end, env, srcs, nodes, prio });
    this.stats.notes++;
    let pending = srcs.length;
    const done = () => {
      if (--pending > 0) return;
      for (const n of nodes) n.disconnect();
      this.stats.live -= nodes.length;
    };
    for (const s of srcs) {
      s.onended = done;
      s.stop(end);
    }
  }

  private track<T extends AudioNode>(n: T): T {
    this.cur.nodes.push(n);
    this.stats.created++;
    this.stats.live++;
    return n;
  }
  private gain(v = 0): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }
  private filter(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.track(this.ctx.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }
  private osc(type: OscillatorType | PeriodicWave, f: number, when: number, detune = 0): OscillatorNode {
    const o = this.track(this.ctx.createOscillator());
    if (typeof type === "string") o.type = type as OscillatorType;
    else o.setPeriodicWave(type);
    o.frequency.value = f;
    o.detune.value = detune;
    o.start(when);
    this.cur.srcs.push(o);
    return o;
  }
  private noiseSrc(when: number): AudioBufferSourceNode {
    const s = this.track(this.ctx.createBufferSource());
    s.buffer = this.noise;
    s.loop = true;
    this.nrand = (this.nrand * 16807) % 2147483647;
    s.start(when, (this.nrand / 2147483647) * 1.9);
    this.cur.srcs.push(s);
    return s;
  }

  /** A persistent stereo position on `dest`, shared by every note panned there (11 positions). */
  private out(dest: AudioNode, o: Pan): AudioNode {
    if (o.pan === undefined) return dest;
    const q = Math.round(clamp(o.pan, -1, 1) * 5);
    if (q === 0) return dest;
    let m = this.buses.get(dest);
    if (!m) this.buses.set(dest, (m = new Map()));
    let p = m.get(q);
    if (!p) {
      p = this.ctx.createStereoPanner();
      p.pan.value = q / 5;
      p.connect(dest);
      m.set(q, p);
      this.stats.panBuses++;
    }
    return p;
  }

  /** Voices still sounding now, for stats. */
  countVoices(now: number): number {
    let n = 0;
    for (const l of this.groups.values()) for (const v of l) if (v.end > now) n++;
    this.stats.voices = n;
    if (n > this.stats.peakVoices) this.stats.peakVoices = n;
    return n;
  }

  /**
   * Replay a bank buffer. `natural` is the buffer's own decay at this rate; a shorter `decay`
   * adds an extra exponential so the two together fall by 60 dB in `decay` seconds.
   */
  private sample(name: string, dest: AudioNode, when: number, vel: number, rate: number, o: Pan & { group: Group; prio?: number; decay?: number; natural?: number }): boolean {
    const b = this.bank?.buffers.get(name);
    if (!b) return false;
    const prio = o.prio ?? 0;
    if (!this.admit(o.group, when, prio)) return true;
    const src = this.track(this.ctx.createBufferSource());
    src.buffer = b;
    src.playbackRate.value = rate;
    src.start(when);
    this.cur.srcs.push(src);
    const env = this.gain(vel);
    let end = when + b.duration / rate;
    if (o.decay !== undefined && o.natural !== undefined && o.decay < o.natural * 0.95) {
      const tau = 1 / (6.9 / o.decay - 6.9 / o.natural);
      env.gain.setValueAtTime(vel, when);
      env.gain.setTargetAtTime(0, when + 0.004, tau);
      end = Math.min(end, when + o.decay * 1.05);
    }
    src.connect(env).connect(this.out(dest, o));
    this.stats.sampled++;
    this.commit(o.group, when, end, env, prio);
    return true;
  }

  // ---------------------------------------------------------------------------- envelopes

  /** percussive: fast attack, exponential fall (decay = time to about -60 dB) */
  private perc(g: AudioParam, when: number, peak: number, decay: number, attack = 0.002) {
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(peak, when + attack);
    g.setTargetAtTime(0, when + attack, decay / 6.9);
  }
  /** sustained: attack, hold, release */
  private ahr(g: AudioParam, when: number, peak: number, attack: number, hold: number, release: number) {
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(peak, when + attack);
    g.setValueAtTime(peak, when + attack + hold);
    g.setTargetAtTime(0, when + attack + hold, release / 4);
  }

  // ---------------------------------------------------------------------------- struck instruments (bankable)

  /** Psaltery: a double course of plucked strings, bright then darkening. */
  pluck(dest: AudioNode, when: number, midi: number, vel: number, o: Pan & { decay?: number; bright?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "mel";
    const decay = (o.decay ?? 2.2) * pluckScale(midi);
    if (this.bank) {
      const ref = nearest(PLUCK_REFS, midi);
      const rate = Math.pow(2, (midi - ref) / 12);
      if (this.sample("pluck" + ref, dest, when, vel, rate, { ...o, group, decay, natural: (BANK_PLUCK_DECAY * pluckScale(ref)) / rate })) return;
    }
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    const lp = this.filter("lowpass", 1000, 0.9);
    const bright = o.bright ?? 0.6;
    lp.frequency.setValueAtTime(Math.min(16000, f * (5 + 10 * bright)), when);
    lp.frequency.setTargetAtTime(f * 1.8, when + 0.01, decay * 0.18);
    this.osc(this.waves.pluck, f, when, 3).connect(lp);
    this.osc(this.waves.pluck, f, when, -4).connect(lp);
    lp.connect(env);
    this.perc(env.gain, when, vel * 0.32, decay, 0.003);
    env.connect(this.out(dest, o));
    this.commit(group, when, when + decay, env, o.prio ?? 0);
  }

  /**
   * Church bell: inharmonic partials (hum, prime, minor-third tierce, quint, nominal...).
   * `midi` is the strike note (the nominal).
   */
  bell(dest: AudioNode, when: number, midi: number, vel: number, o: Pan & { decay?: number; partials?: number; group?: Group; prio?: number; bright?: number } = {}) {
    const group = o.group ?? "bell";
    const decay = o.decay ?? 3;
    if (this.bank) {
      const ref = nearest(BELL_REFS, midi);
      const rate = Math.pow(2, (midi - ref) / 12);
      if (this.sample("bell" + ref, dest, when, vel, rate, { ...o, group, decay, natural: BANK_BELL_DECAY / rate })) return;
    }
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const base = mtof(midi) / 2;
    const P: Array<[number, number, number]> = [
      [2.0, 1, 0.7], // nominal
      [1.0, 0.55, 1], // prime
      [1.19, 0.45, 0.8], // tierce (minor third)
      [0.5, 0.35, 1.4], // hum
      [1.5, 0.22, 0.55], // quint
      [2.51, 0.28, 0.35],
      [2.98, 0.2, 0.28],
      [4.07, 0.12, 0.18],
    ];
    const n = Math.min(P.length, o.partials ?? 6);
    const env = this.gain(vel * 0.2);
    const bright = o.bright ?? 1;
    for (let i = 0; i < n; i++) {
      const [ratio, amp, dk] = P[i];
      const fr = base * ratio;
      if (fr > 16000) continue;
      const g = this.gain();
      this.perc(g.gain, when, amp * (ratio > 2.2 ? bright : 1), decay * dk, 0.0015);
      this.osc("sine", fr, when, ((i * 7) % 5) - 2).connect(g).connect(env);
    }
    env.connect(this.out(dest, o));
    this.commit(group, when, when + decay * 1.4, env, o.prio ?? 0);
  }

  /** Big drum (taiko / tapan): a pitch-falling membrane with a skin slap; `flam` adds a second player. */
  low(dest: AudioNode, when: number, vel: number, p: { f0: number; f1: number; decay: number }, o: Pan & { flam?: boolean; group?: Group; prio?: number; size?: number } = {}) {
    const group = o.group ?? "perc";
    const size = o.size ?? 1;
    if (this.bank && p === this.bank.low && this.sample(o.flam ? "lowFlam" : "low", dest, when, vel, 1 / size, { ...o, group })) return;
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const decay = p.decay * size;
    const env = this.gain(1);
    const body = this.osc("sine", (p.f0 * 2.4) / size, when, 0);
    body.frequency.setValueAtTime((p.f0 * 2.4) / size, when);
    body.frequency.exponentialRampToValueAtTime(p.f0 / size, when + 0.035);
    body.frequency.exponentialRampToValueAtTime(p.f1 / size, when + decay);
    const bg = this.gain();
    this.perc(bg.gain, when, vel * 0.85, decay, 0.0015);
    body.connect(bg).connect(env);
    // second mode of the membrane
    const m2 = this.osc("triangle", (p.f0 * 1.58) / size, when, 0);
    m2.frequency.exponentialRampToValueAtTime((p.f1 * 1.5) / size, when + decay * 0.6);
    const m2g = this.gain();
    this.perc(m2g.gain, when, vel * 0.22, decay * 0.45, 0.0015);
    m2.connect(m2g).connect(env);
    // skin
    const nf = this.filter("lowpass", 1400, 0.8);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * (this.quiet ? 0.18 : 0.38), 0.07, 0.001);
    this.noiseSrc(when).connect(nf).connect(ng).connect(env);
    if (o.flam) {
      const fl = this.osc("sine", p.f0 * 1.04, when + 0.018, 0);
      fl.frequency.setValueAtTime(p.f0 * 1.04, when + 0.018);
      fl.frequency.exponentialRampToValueAtTime(p.f1 * 1.03, when + 0.018 + decay * 0.8);
      const flg = this.gain();
      this.perc(flg.gain, when + 0.018, vel * 0.45, decay * 0.8, 0.002);
      fl.connect(flg).connect(env);
    }
    env.connect(this.out(dest, o));
    this.commit(group, when, when + decay + 0.05, env, o.prio ?? 0);
  }

  /** Frame drum (bendir / daf): a mid thump with a buzzing rim. Ghosts are rim only. */
  frame(dest: AudioNode, when: number, vel: number, p: { f: number; decay: number }, o: Pan & { group?: Group; prio?: number } = {}) {
    const group = o.group ?? "perc";
    const ghost = vel < 0.5;
    if (this.bank && p === this.bank.frame && this.sample(ghost ? "frameGhost" : "frame", dest, when, ghost ? vel / 0.4 : vel, 1, { ...o, group })) return;
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const env = this.gain(1);
    if (!ghost) {
      const b = this.osc("sine", p.f * 1.5, when, 0);
      b.frequency.setValueAtTime(p.f * 1.5, when);
      b.frequency.exponentialRampToValueAtTime(p.f, when + 0.03);
      const bg = this.gain();
      this.perc(bg.gain, when, vel * 0.5, p.decay, 0.0015);
      b.connect(bg).connect(env);
    }
    const nf = this.filter("bandpass", ghost ? 2600 : 1700, 1.1);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * (ghost ? 0.3 : 0.32), ghost ? 0.06 : 0.12, 0.001);
    this.noiseSrc(when).connect(nf).connect(ng).connect(env);
    env.connect(this.out(dest, o));
    this.commit(group, when, when + Math.max(p.decay, 0.14) + 0.03, env, o.prio ?? 0);
  }

  /** Clack: bones / wood block / rim, short and dry. `pitch` 0..1.6 shifts it. */
  clack(dest: AudioNode, when: number, vel: number, o: Pan & { pitch?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "perc";
    const pf = 1 + (o.pitch ?? 0.4);
    if (this.bank && this.sample("clack", dest, when, vel, pf / 1.4, { ...o, group })) return;
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const env = this.gain(1);
    const nf = this.filter("bandpass", 1700 * pf, 7);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * 1.1, 0.045, 0.0008);
    this.noiseSrc(when).connect(nf).connect(ng).connect(env);
    const tg = this.gain();
    this.perc(tg.gain, when, vel * 0.22, 0.05, 0.0008);
    this.osc("sine", 620 * pf, when, 0).connect(tg).connect(env);
    env.connect(this.out(dest, o));
    this.commit(group, when, when + 0.08, env, o.prio ?? 0);
  }

  /** Jingles / zills: bright metal shimmer. */
  jingle(dest: AudioNode, when: number, vel: number, o: Pan & { long?: boolean; group?: Group } = {}) {
    const group = o.group ?? "perc";
    if (this.bank) {
      const name = o.long ? "jingleLong" : vel > 0.6 ? "jingleHi" : "jingleLo";
      if (this.sample(name, dest, when, name === "jingleLo" ? vel / 0.5 : vel, 1, { ...o, group })) return;
    }
    if (!this.admit(group, when, 0)) return;
    const env = this.gain(1);
    const dk = o.long ? 0.5 : vel > 0.6 ? 0.12 : 0.06;
    const nf = this.filter("highpass", 6500, 0.7);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * 0.16, dk, vel > 0.6 ? 0.001 : 0.008);
    this.noiseSrc(when).connect(nf).connect(ng).connect(env);
    if (vel > 0.6 || o.long) {
      const zg = this.gain();
      this.perc(zg.gain, when, vel * 0.03, dk * 2.4, 0.001);
      this.osc("sine", 5230, when, 0).connect(zg);
      this.osc("sine", 7349, when, 0).connect(zg);
      zg.connect(env);
    }
    env.connect(this.out(dest, o));
    this.commit(group, when, when + dk * 2.6 + 0.02, env, 0);
  }

  /** Sub boom: the floor of the cathedral moves (skipped in quiet mode). */
  boom(dest: AudioNode, when: number, vel: number, o: { f?: number; decay?: number; group?: Group } = {}) {
    if (this.quiet) return;
    const group = o.group ?? "impact";
    const f = o.f ?? BOOM_F;
    const decay = o.decay ?? BOOM_DECAY;
    const rate = f / BOOM_F;
    if (this.bank && this.sample("boom", dest, when, vel, rate, { group, prio: 1, decay, natural: BOOM_DECAY / rate })) return;
    if (!this.admit(group, when, 1)) return;
    const env = this.gain();
    const s = this.osc("sine", f * 1.6, when, 0);
    s.frequency.setValueAtTime(f * 1.6, when);
    s.frequency.exponentialRampToValueAtTime(f, when + 0.06);
    s.frequency.exponentialRampToValueAtTime(f * 0.55, when + decay);
    this.perc(env.gain, when, vel * 0.7, decay, 0.004);
    s.connect(env).connect(dest);
    this.commit(group, when, when + decay + 0.05, env, 1);
  }

  /** Glass tick: the graze. A tiny bright strike tuned to the song. */
  tick(dest: AudioNode, when: number, midi: number, vel: number, o: Pan = {}) {
    if (this.bank) {
      const ref = nearest(TICK_REFS, midi);
      if (this.sample("tick" + ref, dest, when, vel, Math.pow(2, (midi - ref) / 12), { ...o, group: "sfx", prio: 1 })) return;
    }
    if (!this.admit("sfx", when, 1)) return;
    const f = mtof(midi);
    const env = this.gain(1);
    const ag = this.gain();
    const bg = this.gain();
    this.perc(ag.gain, when, vel * 0.22, 0.32, 0.001);
    this.perc(bg.gain, when, vel * 0.07, 0.09, 0.001);
    this.osc("sine", f, when, 0).connect(ag).connect(env);
    this.osc("sine", f * 2.756, when, 0).connect(bg).connect(env);
    const nf = this.filter("highpass", 5000, 0.7);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * 0.08, 0.012, 0.0005);
    this.noiseSrc(when).connect(nf).connect(ng).connect(env);
    env.connect(this.out(dest, o));
    this.commit("sfx", when, when + 0.36, env, 1);
  }

  // ---------------------------------------------------------------------------- sustained / swept voices (live)

  /** Shawm / hurdy-gurdy chanter: a straight-toned nasal reed with a breathy onset. */
  reed(dest: AudioNode, when: number, midi: number, dur: number, vel: number, o: Pan & { group?: Group } = {}) {
    const group = o.group ?? "mel";
    if (!this.admit(group, when, 0)) return;
    const env = this.gain();
    this.osc(this.waves.reed, mtof(midi), when, 2).connect(env);
    const rel = 0.14;
    this.ahr(env.gain, when, vel * 0.13, 0.035, Math.max(0.02, dur - 0.035), rel);
    env.connect(this.out(dest, o));
    this.commit(group, when, when + dur + rel, env, 0);
  }

  /** Positive organ: steady flue pipes. */
  organ(dest: AudioNode, when: number, midi: number, dur: number, vel: number, o: Pan & { group?: Group } = {}) {
    const group = o.group ?? "mel";
    if (!this.admit(group, when, 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    this.osc(this.waves.organ, f, when, 0).connect(env);
    this.osc(this.waves.organ, f * 1.002, when, 0).connect(env);
    this.ahr(env.gain, when, vel * 0.1, 0.03, Math.max(0.02, dur - 0.03), 0.18);
    env.connect(this.out(dest, o));
    this.commit(group, when, when + dur + 0.2, env, 0);
  }

  /** Bowed glass: a slow-speaking pure tone with a faint metallic halo. */
  glass(dest: AudioNode, when: number, midi: number, dur: number, vel: number, o: Pan & { group?: Group } = {}) {
    const group = o.group ?? "mel";
    if (!this.admit(group, when, 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    const bg = this.gain(0.12);
    this.osc(this.waves.hollow, f, when, 0).connect(env);
    this.osc("sine", f * 2.756, when, 0).connect(bg).connect(env);
    this.ahr(env.gain, when, vel * 0.2, 0.04, Math.max(0.03, dur - 0.04), 0.35);
    env.connect(this.out(dest, o));
    this.commit(group, when, when + dur + 0.4, env, 0);
  }

  /** Bass: a bowed organ pedal; `sub` adds weight an octave down (off in quiet mode). */
  bass(dest: AudioNode, when: number, midi: number, dur: number, vel: number, o: { sub?: boolean; bright?: boolean } = {}) {
    if (!this.admit("bass", when, 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    this.osc(o.bright ? this.waves.bassBright : this.waves.bassDark, f, when, -3).connect(env);
    if (o.sub && !this.quiet) {
      const sg = this.gain(0.6);
      this.osc("sine", f / 2, when, 0).connect(sg).connect(env);
    }
    const rel = 0.12;
    this.ahr(env.gain, when, vel * 0.1, 0.012, Math.max(0.03, dur - 0.02), rel);
    env.connect(dest);
    this.commit("bass", when, when + dur + rel, env, 0);
  }

  /** Bowed metal: a crescendo on inharmonic partials that cuts off at `end` (or rings past it). */
  bowed(dest: AudioNode, when: number, end: number, midi: number, vel: number, o: Pan & { ring?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "fx";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    for (const [r, a] of [[1, 1], [2.32, 0.5], [4.25, 0.3], [6.63, 0.16]]) {
      const g = this.gain(a);
      this.osc("sine", f * r, when, 0).connect(g).connect(env);
    }
    const nf = this.filter("bandpass", f * 4.25, 14);
    const ng = this.gain(0.9);
    this.noiseSrc(when).connect(nf).connect(ng).connect(env);
    const ring = o.ring ?? 0.5;
    const len = Math.max(0.05, end - when);
    const v = Math.max(0.01, vel);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(v * 0.03, when + len * 0.5);
    env.gain.exponentialRampToValueAtTime(v * 0.14, end);
    env.gain.setTargetAtTime(0, end, ring / 5);
    env.connect(this.out(dest, o));
    this.commit(group, when, end + ring, env, o.prio ?? 0);
  }

  /** Air: band-passed noise sweeping between two frequencies (dash, launches, risers, beams). */
  air(dest: AudioNode, when: number, dur: number, f0: number, f1: number, vel: number, o: Pan & { pan2?: number; q?: number; attack?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "sfx";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const env = this.gain();
    const bp = this.filter("bandpass", f0, o.q ?? 1.4);
    bp.frequency.setValueAtTime(f0, when);
    bp.frequency.exponentialRampToValueAtTime(f1, when + dur);
    this.noiseSrc(when).connect(bp).connect(env);
    const at = o.attack ?? dur * 0.3;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(vel * 0.5, when + at);
    env.gain.setTargetAtTime(0, when + at, Math.max(0.01, (dur - at) / 3));
    if (o.pan2 !== undefined && o.pan !== undefined) {
      // a moving source needs its own panner
      const p = this.track(this.ctx.createStereoPanner());
      p.pan.setValueAtTime(clamp(o.pan, -1, 1), when);
      p.pan.linearRampToValueAtTime(clamp(o.pan2, -1, 1), when + dur);
      env.connect(p).connect(dest);
    } else env.connect(this.out(dest, o));
    this.commit(group, when, when + dur * 1.3 + 0.05, env, o.prio ?? 0);
  }

  /** Gong / tam-tam: slow-blooming inharmonic metal with a long shimmer. */
  gong(dest: AudioNode, when: number, f: number, vel: number, o: { decay?: number; group?: Group } = {}) {
    const group = o.group ?? "fx";
    if (!this.admit(group, when, 1)) return;
    const decay = o.decay ?? 5;
    const env = this.gain(vel * 0.16);
    for (const [r, a, d] of [[1, 1, 1], [1.48, 0.7, 0.8], [2.19, 0.55, 0.6], [2.74, 0.4, 0.5], [3.66, 0.3, 0.35], [5.1, 0.18, 0.25]]) {
      const g = this.gain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a * 0.5, when + 0.004);
      g.gain.linearRampToValueAtTime(a, when + 0.25 * d);
      g.gain.setTargetAtTime(0, when + 0.25 * d, (decay * d) / 6);
      this.osc("sine", f * r, when, ((r * 13) % 7) - 3).connect(g).connect(env);
    }
    const nf = this.filter("bandpass", f * 9, 2);
    const ng = this.gain();
    ng.gain.setValueAtTime(0, when);
    ng.gain.linearRampToValueAtTime(0.5, when + 0.15);
    ng.gain.setTargetAtTime(0, when + 0.15, decay / 8);
    this.noiseSrc(when).connect(nf).connect(ng).connect(env);
    env.connect(dest);
    this.commit(group, when, when + decay * 1.1, env, 1);
  }
}

/** A cathedral impulse response: pre-delay, sparse early reflections, a darkening stereo tail. */
export function cathedralIR(ctx: BaseAudioContext, seconds = 3.2, preDelay = 0.028): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * (seconds + preDelay));
  const buf = ctx.createBuffer(2, len, sr);
  const pd = Math.floor(sr * preDelay);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    let lp2 = 0;
    // early reflections off stone: a dozen taps in the first 90 ms
    for (let k = 0; k < 12; k++) {
      const at = pd + Math.floor(sr * (0.006 + 0.08 * Math.pow((k + 0.5 + rnd() * 0.4) / 12, 1.3)));
      if (at < len) d[at] += (0.55 - k * 0.03) * (rnd() > 0 ? 1 : -1);
    }
    for (let i = pd; i < len; i++) {
      const t = (i - pd) / sr;
      const env = Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.06);
      // high frequencies die first: cutoff glides from ~9 kHz down to ~900 Hz
      const fc = 900 + 8000 * Math.exp(-t * 1.6);
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      lp = (1 - a) * rnd() + a * lp;
      lp2 = (1 - a) * lp + a * lp2;
      d[i] += lp2 * env * 2.2;
    }
  }
  // normalise to unit energy so the send level means the same for every IR length
  let e = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) e += d[i] * d[i];
  }
  const k = 1 / Math.sqrt(e / 2);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= k * 0.9;
  }
  return buf;
}

/** Soft ceiling: unity below 0.7, a smooth knee into an absolute ceiling of 0.88 (-1.1 dBFS). */
export function ceilingCurve(): Float32Array<ArrayBuffer> {
  const n = 8192;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  const knee = 0.7;
  const top = 0.88;
  for (let i = 0; i < n; i++) {
    // the shaper's input is pre-scaled by 1/2, so the curve spans -2..2 of the real signal
    const u = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(u);
    const y = a < knee ? a : knee + (top - knee) * Math.tanh((a - knee) / (top - knee));
    c[i] = Math.sign(u) * y;
  }
  return c;
}

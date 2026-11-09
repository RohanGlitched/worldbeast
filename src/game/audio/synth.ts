// Instruments of the living bestiary, synthesised from oscillators, noise and filters.
// Every note is a short-lived voice: it is admitted by its group's polyphony cap, built from
// native nodes, and disconnected when its sources end. No per-sample JS runs on the audio thread.

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export type Group = "perc" | "bass" | "mel" | "bell" | "cue" | "impact" | "sfx" | "fx";
const CAPS: Record<Group, number> = { perc: 14, bass: 4, mel: 10, bell: 8, cue: 8, impact: 12, sfx: 14, fx: 6 };

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
}

/** Small helper that keeps sounds tidy: build nodes, then commit them as one voice. */
export class Synth {
  readonly ctx: BaseAudioContext;
  readonly noise: AudioBuffer;
  readonly waves: { pluck: PeriodicWave; organ: PeriodicWave; reed: PeriodicWave; hollow: PeriodicWave };
  stats: SynthStats = { created: 0, live: 0, voices: 0, peakVoices: 0, dropped: 0, stolen: 0, notes: 0 };
  /** global quietness 0..1 (quiet mode lowers transients and sub) */
  quiet = false;
  private groups = new Map<Group, Voice[]>();
  private cur: { nodes: AudioNode[]; srcs: AudioScheduledSourceNode[] } = { nodes: [], srcs: [] };
  private nrand = 1;

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
    // plucked string at 1/7 of its length: a_n = sin(n pi p) / n^1.4
    const pluck: number[] = [];
    for (let n = 1; n <= 28; n++) pluck.push(Math.sin(n * Math.PI * 0.14) / Math.pow(n, 1.4));
    // organ: principal 8', octave 4', twelfth, fifteenth, a touch of mixture
    const organ = [1, 0.55, 0.32, 0.26, 0, 0.12, 0, 0.08];
    // reed (shawm): odd-heavy, nasal, bright
    const reed: number[] = [];
    for (let n = 1; n <= 24; n++) reed.push((n % 2 ? 1 : 0.55) / Math.pow(n, 0.85) * (n === 3 || n === 4 ? 1.4 : 1));
    // hollow: a soft flute/glass tone
    const hollow = [1, 0.08, 0.22, 0.03, 0.06];
    this.waves = { pluck: pw(pluck), organ: pw(organ), reed: pw(reed), hollow: pw(hollow) };
  }

  // ---------------------------------------------------------------------------- voice plumbing

  /** Can a note in `group` start at `when`? Steals the oldest voice for important notes. */
  private admit(group: Group, when: number, prio: number): boolean {
    let list = this.groups.get(group);
    if (!list) this.groups.set(group, (list = []));
    let w = 0;
    for (let i = 0; i < list.length; i++) if (list[i].end > when) list[w++] = list[i];
    list.length = w;
    const cap = CAPS[group];
    if (list.length >= cap) {
      if (prio < 1) {
        this.stats.dropped++;
        return false;
      }
      const old = list.shift()!;
      this.steal(old, when);
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
    const v: Voice = { start: when, end, env, srcs, nodes, prio };
    this.groups.get(group)!.push(v);
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
  gain(v = 0): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }
  filter(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.track(this.ctx.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }
  pan(x: number): StereoPannerNode {
    const p = this.track(this.ctx.createStereoPanner());
    p.pan.value = clamp(x, -1, 1);
    return p;
  }
  osc(type: OscillatorType | PeriodicWave, f: number, when: number, detune = 0): OscillatorNode {
    const o = this.track(this.ctx.createOscillator());
    if (typeof type === "string") o.type = type as OscillatorType;
    else o.setPeriodicWave(type);
    o.frequency.value = f;
    o.detune.value = detune;
    o.start(when);
    this.cur.srcs.push(o);
    return o;
  }
  noiseSrc(when: number, rate = 1): AudioBufferSourceNode {
    const s = this.track(this.ctx.createBufferSource());
    s.buffer = this.noise;
    s.loop = true;
    s.playbackRate.value = rate;
    this.nrand = (this.nrand * 16807) % 2147483647;
    s.start(when, (this.nrand / 2147483647) * 1.9);
    this.cur.srcs.push(s);
    return s;
  }

  /** Voices still sounding now, for stats. */
  countVoices(now: number): number {
    let n = 0;
    for (const l of this.groups.values()) for (const v of l) if (v.end > now) n++;
    this.stats.voices = n;
    if (n > this.stats.peakVoices) this.stats.peakVoices = n;
    return n;
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

  // ---------------------------------------------------------------------------- instruments

  /** Psaltery: a double course of plucked strings, bright then darkening. */
  pluck(dest: AudioNode, when: number, midi: number, vel: number, o: { decay?: number; bright?: number; pan?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "mel";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const f = mtof(midi);
    const decay = (o.decay ?? 2.2) * clamp(1.6 - (midi - 60) / 40, 0.5, 1.6);
    const env = this.gain();
    const lp = this.filter("lowpass", 1000, 0.9);
    const bright = o.bright ?? 0.6;
    lp.frequency.setValueAtTime(Math.min(16000, f * (5 + 10 * bright)), when);
    lp.frequency.setTargetAtTime(f * 1.8, when + 0.01, decay * 0.18);
    const a = this.osc(this.waves.pluck, f, when, 3);
    const b = this.osc(this.waves.pluck, f, when, -4);
    a.connect(lp);
    b.connect(lp);
    lp.connect(env);
    this.perc(env.gain, when, vel * 0.32, decay, 0.003);
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, when + decay, env, o.prio ?? 0);
  }

  /** Shawm / hurdy-gurdy chanter: nasal reed with a breathy onset; vibrato from a shared LFO. */
  reed(dest: AudioNode, when: number, midi: number, dur: number, vel: number, vib?: AudioNode, o: { pan?: number; group?: Group } = {}) {
    const group = o.group ?? "mel";
    if (!this.admit(group, when, 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    const lp = this.filter("lowpass", Math.min(7000, f * 7), 0.6);
    const a = this.osc(this.waves.reed, f, when, 2);
    const b = this.osc("sawtooth", f * 2, when, -5);
    const bg = this.gain(0.12);
    if (vib) {
      vib.connect(a.detune);
      vib.connect(b.detune);
    }
    a.connect(lp);
    b.connect(bg).connect(lp);
    lp.connect(env);
    const rel = 0.14;
    this.ahr(env.gain, when, vel * 0.17, 0.04, Math.max(0.02, dur - 0.04), rel);
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    const end = when + dur + rel;
    this.commit(group, when, end, env, 0);
    if (vib) {
      // drop the LFO's links when the note ends
      const disc = () => {
        try {
          vib.disconnect(a.detune);
          vib.disconnect(b.detune);
        } catch {
          /* gone */
        }
      };
      const prev = a.onended as (() => void) | null;
      a.onended = () => {
        disc();
        prev?.call(a);
      };
    }
  }

  /** Positive organ: steady flue pipes with a chiff. */
  organ(dest: AudioNode, when: number, midi: number, dur: number, vel: number, o: { group?: Group } = {}) {
    const group = o.group ?? "mel";
    if (!this.admit(group, when, 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    const a = this.osc(this.waves.organ, f, when, 0);
    const b = this.osc(this.waves.organ, f * 1.002, when, 0);
    const chiff = this.noiseSrc(when);
    const cf = this.filter("bandpass", f * 4, 3);
    const cg = this.gain();
    cg.gain.setValueAtTime(vel * 0.06, when);
    cg.gain.setTargetAtTime(0, when + 0.01, 0.02);
    chiff.connect(cf).connect(cg).connect(env);
    a.connect(env);
    b.connect(env);
    this.ahr(env.gain, when, vel * 0.11, 0.03, Math.max(0.02, dur - 0.03), 0.18);
    env.connect(dest);
    this.commit(group, when, when + dur + 0.2, env, 0);
  }

  /** Bowed glass: a slow-speaking pure tone with a faint metallic halo. */
  glass(dest: AudioNode, when: number, midi: number, dur: number, vel: number, o: { pan?: number; group?: Group } = {}) {
    const group = o.group ?? "mel";
    if (!this.admit(group, when, 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    const a = this.osc(this.waves.hollow, f, when, 0);
    const b = this.osc("sine", f * 2.756, when, 0);
    const bg = this.gain(0.1);
    a.connect(env);
    b.connect(bg).connect(env);
    // a struck onset so the line still reads rhythmically
    const t = this.osc("triangle", f * 2, when, 0);
    const tg = this.gain();
    this.perc(tg.gain, when, vel * 0.07, 0.35);
    t.connect(tg).connect(env);
    this.ahr(env.gain, when, vel * 0.2, 0.05, Math.max(0.03, dur - 0.05), 0.35);
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, when + dur + 0.4, env, 0);
  }

  /**
   * Church bell: inharmonic partials (hum, prime, minor-third tierce, quint, nominal...).
   * `midi` is the strike note (the nominal). `partials` trades richness for nodes.
   */
  bell(dest: AudioNode, when: number, midi: number, vel: number, o: { decay?: number; partials?: number; pan?: number; group?: Group; prio?: number; bright?: number } = {}) {
    const group = o.group ?? "bell";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const base = mtof(midi) / 2;
    const decay = o.decay ?? 3;
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
      const osc = this.osc("sine", fr, when, (i * 7) % 5 - 2);
      const g = this.gain();
      this.perc(g.gain, when, amp * (ratio > 2.2 ? bright : 1), decay * dk, 0.0015);
      osc.connect(g).connect(env);
    }
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, when + decay * 1.4, env, o.prio ?? 0);
  }

  /** Big drum (taiko / tapan): a pitch-falling membrane with a skin slap; `flam` adds a second player. */
  low(dest: AudioNode, when: number, vel: number, p: { f0: number; f1: number; decay: number }, o: { flam?: boolean; group?: Group; prio?: number; pan?: number; size?: number } = {}) {
    const group = o.group ?? "perc";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const size = o.size ?? 1;
    const decay = p.decay * size;
    const env = this.gain(1);
    const body = this.osc("sine", p.f0 * 2.4, when, 0);
    body.frequency.setValueAtTime(p.f0 * 2.4 / size, when);
    body.frequency.exponentialRampToValueAtTime(p.f0 / size, when + 0.035);
    body.frequency.exponentialRampToValueAtTime(p.f1 / size, when + decay);
    const bg = this.gain();
    this.perc(bg.gain, when, vel * 0.85, decay, 0.0015);
    body.connect(bg).connect(env);
    // second mode of the membrane
    const m2 = this.osc("triangle", p.f0 * 1.58 / size, when, 0);
    m2.frequency.exponentialRampToValueAtTime((p.f1 * 1.5) / size, when + decay * 0.6);
    const m2g = this.gain();
    this.perc(m2g.gain, when, vel * 0.22, decay * 0.45, 0.0015);
    m2.connect(m2g).connect(env);
    // skin
    const n = this.noiseSrc(when);
    const nf = this.filter("lowpass", 1400, 0.8);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * (this.quiet ? 0.18 : 0.38), 0.07, 0.001);
    n.connect(nf).connect(ng).connect(env);
    if (o.flam) {
      const fl = this.osc("sine", p.f0 * 1.04, when + 0.018, 0);
      fl.frequency.exponentialRampToValueAtTime(p.f1 * 1.03, when + 0.018 + decay * 0.8);
      const flg = this.gain();
      this.perc(flg.gain, when + 0.018, vel * 0.45, decay * 0.8, 0.002);
      fl.connect(flg).connect(env);
    }
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, when + decay + 0.05, env, o.prio ?? 0);
  }

  /** Frame drum (bendir / daf): a mid thump with a buzzing rim. Ghosts are rim only. */
  frame(dest: AudioNode, when: number, vel: number, p: { f: number; decay: number }, o: { pan?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "perc";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const env = this.gain(1);
    const ghost = vel < 0.5;
    if (!ghost) {
      const b = this.osc("sine", p.f * 1.5, when, 0);
      b.frequency.exponentialRampToValueAtTime(p.f, when + 0.03);
      const bg = this.gain();
      this.perc(bg.gain, when, vel * 0.5, p.decay, 0.0015);
      b.connect(bg).connect(env);
    }
    const n = this.noiseSrc(when);
    const nf = this.filter("bandpass", ghost ? 2600 : 1700, 1.1);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * (ghost ? 0.3 : 0.32), ghost ? 0.06 : 0.12, 0.001);
    n.connect(nf).connect(ng).connect(env);
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, when + Math.max(p.decay, 0.14) + 0.03, env, o.prio ?? 0);
  }

  /** Clack: bones / wood block / rim, short and dry. `pitch` 0..1 shifts it. */
  clack(dest: AudioNode, when: number, vel: number, o: { pan?: number; pitch?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "perc";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const pf = 1 + (o.pitch ?? 0.4);
    const env = this.gain(1);
    const n = this.noiseSrc(when);
    const nf = this.filter("bandpass", 1700 * pf, 7);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * 1.1, 0.045, 0.0008);
    n.connect(nf).connect(ng).connect(env);
    const t = this.osc("sine", 620 * pf, when, 0);
    const tg = this.gain();
    this.perc(tg.gain, when, vel * 0.22, 0.05, 0.0008);
    t.connect(tg).connect(env);
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, when + 0.08, env, o.prio ?? 0);
  }

  /** Jingles / zills: bright metal shimmer. */
  jingle(dest: AudioNode, when: number, vel: number, o: { pan?: number; long?: boolean; group?: Group } = {}) {
    const group = o.group ?? "perc";
    if (!this.admit(group, when, 0)) return;
    const env = this.gain(1);
    const dk = o.long ? 0.5 : vel > 0.6 ? 0.12 : 0.06;
    const n = this.noiseSrc(when);
    const nf = this.filter("highpass", 6500, 0.7);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * 0.16, dk, vel > 0.6 ? 0.001 : 0.008);
    n.connect(nf).connect(ng).connect(env);
    if (vel > 0.6 || o.long) {
      const z = this.osc("sine", 5230, when, 0);
      const z2 = this.osc("sine", 7349, when, 0);
      const zg = this.gain();
      this.perc(zg.gain, when, vel * 0.03, dk * 2.4, 0.001);
      z.connect(zg);
      z2.connect(zg);
      zg.connect(env);
    }
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, when + dk * 2.6 + 0.02, env, 0);
  }

  /** Bass: a bowed organ pedal; `sub` adds weight an octave down (off in quiet mode). */
  bass(dest: AudioNode, when: number, midi: number, dur: number, vel: number, o: { sub?: boolean; bright?: number } = {}) {
    if (!this.admit("bass", when, 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    const lp = this.filter("lowpass", f * (2.5 + 4 * (o.bright ?? 0.3)), 1.2);
    lp.frequency.setValueAtTime(f * (4 + 6 * (o.bright ?? 0.3)), when);
    lp.frequency.setTargetAtTime(f * 2.2, when + 0.02, 0.18);
    const a = this.osc("sawtooth", f, when, -3);
    const b = this.osc("triangle", f, when, 4);
    a.connect(lp);
    b.connect(lp);
    lp.connect(env);
    if (o.sub && !this.quiet) {
      const s = this.osc("sine", f / 2, when, 0);
      const sg = this.gain(0.7);
      s.connect(sg).connect(env);
    }
    const rel = 0.12;
    this.ahr(env.gain, when, vel * 0.3, 0.012, Math.max(0.03, dur - 0.02), rel);
    env.connect(dest);
    this.commit("bass", when, when + dur + rel, env, 0);
  }

  /** Bowed metal: a crescendo on inharmonic partials that cuts off at `end` (or rings past it). */
  bowed(dest: AudioNode, when: number, end: number, midi: number, vel: number, o: { pan?: number; ring?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "fx";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const f = mtof(midi);
    const env = this.gain();
    const R: Array<[number, number]> = [[1, 1], [2.32, 0.5], [4.25, 0.3], [6.63, 0.16]];
    for (const [r, a] of R) {
      const osc = this.osc("sine", f * r, when, 0);
      const g = this.gain(a);
      osc.connect(g).connect(env);
    }
    const n = this.noiseSrc(when);
    const nf = this.filter("bandpass", f * 4.25, 14);
    const ng = this.gain(0.9);
    n.connect(nf).connect(ng).connect(env);
    const ring = o.ring ?? 0.5;
    const len = Math.max(0.05, end - when);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(vel * 0.03, when + len * 0.5);
    env.gain.exponentialRampToValueAtTime(vel * 0.14, end);
    env.gain.setTargetAtTime(0, end, ring / 5);
    let out: AudioNode = env;
    if (o.pan !== undefined) out = env.connect(this.pan(o.pan));
    out.connect(dest);
    this.commit(group, when, end + ring, env, o.prio ?? 0);
  }

  /** Air: band-passed noise sweeping between two frequencies (dash, launches, risers, beams). */
  air(dest: AudioNode, when: number, dur: number, f0: number, f1: number, vel: number, o: { pan?: number; pan2?: number; q?: number; attack?: number; group?: Group; prio?: number } = {}) {
    const group = o.group ?? "sfx";
    if (!this.admit(group, when, o.prio ?? 0)) return;
    const env = this.gain();
    const n = this.noiseSrc(when);
    const bp = this.filter("bandpass", f0, o.q ?? 1.4);
    bp.frequency.setValueAtTime(f0, when);
    bp.frequency.exponentialRampToValueAtTime(f1, when + dur);
    n.connect(bp).connect(env);
    const at = o.attack ?? dur * 0.3;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(vel * 0.5, when + at);
    env.gain.setTargetAtTime(0, when + at, Math.max(0.01, (dur - at) / 3));
    let out: AudioNode = env;
    if (o.pan !== undefined) {
      const p = this.pan(o.pan);
      if (o.pan2 !== undefined) {
        p.pan.setValueAtTime(clamp(o.pan, -1, 1), when);
        p.pan.linearRampToValueAtTime(clamp(o.pan2, -1, 1), when + dur);
      }
      out = env.connect(p);
    }
    out.connect(dest);
    this.commit(group, when, when + dur * 1.3 + 0.05, env, o.prio ?? 0);
  }

  /** Gong / tam-tam: slow-blooming inharmonic metal with a long shimmer. */
  gong(dest: AudioNode, when: number, f: number, vel: number, o: { decay?: number; group?: Group } = {}) {
    const group = o.group ?? "fx";
    if (!this.admit(group, when, 1)) return;
    const decay = o.decay ?? 5;
    const env = this.gain(vel * 0.16);
    const R: Array<[number, number, number]> = [[1, 1, 1], [1.48, 0.7, 0.8], [2.19, 0.55, 0.6], [2.74, 0.4, 0.5], [3.66, 0.3, 0.35], [5.1, 0.18, 0.25]];
    for (const [r, a, d] of R) {
      const osc = this.osc("sine", f * r, when, (r * 13) % 7 - 3);
      const g = this.gain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a * 0.5, when + 0.004);
      g.gain.linearRampToValueAtTime(a, when + 0.25 * d);
      g.gain.setTargetAtTime(0, when + 0.25 * d, (decay * d) / 6);
      osc.connect(g).connect(env);
    }
    const n = this.noiseSrc(when);
    const nf = this.filter("bandpass", f * 9, 2);
    const ng = this.gain();
    ng.gain.setValueAtTime(0, when);
    ng.gain.linearRampToValueAtTime(0.5, when + 0.15);
    ng.gain.setTargetAtTime(0, when + 0.15, decay / 8);
    n.connect(nf).connect(ng).connect(env);
    env.connect(dest);
    this.commit(group, when, when + decay * 1.1, env, 1);
  }

  /** Sub boom: the floor of the cathedral moves (skipped in quiet mode). */
  boom(dest: AudioNode, when: number, vel: number, o: { f?: number; decay?: number; group?: Group } = {}) {
    if (this.quiet) return;
    const group = o.group ?? "impact";
    if (!this.admit(group, when, 1)) return;
    const f = o.f ?? 58;
    const decay = o.decay ?? 1.1;
    const env = this.gain();
    const s = this.osc("sine", f * 1.6, when, 0);
    s.frequency.exponentialRampToValueAtTime(f, when + 0.06);
    s.frequency.exponentialRampToValueAtTime(f * 0.55, when + decay);
    this.perc(env.gain, when, vel * 0.7, decay, 0.004);
    s.connect(env).connect(dest);
    this.commit(group, when, when + decay + 0.05, env, 1);
  }

  /** Glass tick: the graze. A tiny bright strike tuned to the song. */
  tick(dest: AudioNode, when: number, midi: number, vel: number, pan: number) {
    if (!this.admit("sfx", when, 1)) return;
    const f = mtof(midi);
    const env = this.gain(1);
    const a = this.osc("sine", f, when, 0);
    const b = this.osc("sine", f * 2.756, when, 0);
    const ag = this.gain();
    const bg = this.gain();
    this.perc(ag.gain, when, vel * 0.22, 0.32, 0.001);
    this.perc(bg.gain, when, vel * 0.07, 0.09, 0.001);
    a.connect(ag).connect(env);
    b.connect(bg).connect(env);
    const n = this.noiseSrc(when);
    const nf = this.filter("highpass", 5000, 0.7);
    const ng = this.gain();
    this.perc(ng.gain, when, vel * 0.08, 0.012, 0.0005);
    n.connect(nf).connect(ng).connect(env);
    env.connect(this.pan(pan)).connect(dest);
    this.commit("sfx", when, when + 0.36, env, 1);
  }
}

/** A cathedral impulse response: pre-delay, sparse early reflections, a darkening stereo tail. */
export function cathedralIR(ctx: BaseAudioContext, seconds = 3.4, preDelay = 0.028): AudioBuffer {
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

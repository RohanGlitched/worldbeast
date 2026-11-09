// WORLDBEAST audio: the titan's Canticle and every sound of the hunt, synthesised live.
//
// - The score is generated from the titan's seed (score.ts): drone, drums, bass and a motif that
//   develops across the 8 phrases of the Canticle, with layers added by wrath stage.
// - The titan's volleys are voiced from the same deterministic plan the field uses: a pitched tell
//   one beat before each lands, a swell under heavy ones, a percussive impact on the beat.
// - Notes are scheduled slightly ahead on the AudioContext clock. Titan time t maps to context
//   time through a smoothed offset measured from the output timestamp, so what you hear lines up
//   with what every other hunter sees.

import type { Field, Kind } from "../../core/field";
import { LOOP_PHRASES, Stage, TitanSpec } from "../../core/titan";
import { AEv, BLOCK_STEPS, buildSong, degToMidi, Lead, PERC_VOICES, PHRASE_STEPS, Song, STEPS_PER_BEAT, volleyEvents } from "./score";
import { cathedralIR, ceilingCurve, mtof, Synth, SynthStats } from "./synth";

export interface AudioEngineOptions {
  /** Use this context instead of creating one on unlock (e.g. an OfflineAudioContext). */
  context?: BaseAudioContext;
  /** Seconds of audio scheduled ahead of the clock. Default 0.12. */
  lookahead?: number;
  /** Quiet mode: softer transients, no sub booms, lower master. */
  quiet?: boolean;
  /** Chime when a core's open window begins (on the beat). Default true. */
  autoCores?: boolean;
  /** Shift the music later (+) or earlier (-) to match display latency. Seconds. Default 0. */
  syncTrim?: number;
  /** Keep a trace of scheduled beats for timing tests. */
  debug?: boolean;
}

export interface UpdateOpts {
  /** true while the player is in a run; false in the lobby (music muffled behind the page, no tells) */
  playing: boolean;
  /** 0..1, how close the player is to a hazard (1 = brushing it). Ducks the music a little. */
  nearDanger?: number;
}

export interface AudioStats extends SynthStats {
  offset: number; // context time - titan time
  rawOffset: number;
  resyncs: number;
  late: number; // steps skipped because they were already past
  steps: number; // sixteenths scheduled
  persistent: number; // long-lived nodes (buses + drone)
  contextTime: number;
  state: string;
}

const RESYNC_AT = 0.06; // seconds of disagreement that forces a hard resync
const SMOOTH = 0.04; // per-update offset smoothing

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const panOf = (x = 0) => clamp(x / 8, -1, 1) * 0.85;

interface Channels {
  perc: GainNode;
  bass: GainNode;
  mel: GainNode;
  bell: GainNode;
  choir: GainNode;
  bourdon: GainNode;
  cue: GainNode;
  impact: GainNode;
  sfx: GainNode;
}

interface Graph {
  ch: Channels;
  musicSum: GainNode;
  lobby: BiquadFilterNode;
  duck: GainNode; // scheduled ducking under heavy impacts
  danger: GainNode; // realtime ducking near hazards
  musicVol: GainNode;
  titanSfx: GainNode; // cues + impacts (quieter in the lobby)
  sfxVol: GainNode;
  verbMusic: GainNode;
  verbSfx: GainNode;
  verbOut: GainNode;
  glue: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
  trim: GainNode; // quiet-mode trim
  master: GainNode;
  nodes: AudioNode[];
}

interface Drone {
  fades: GainNode[];
  choirVoices: Array<{ a: OscillatorNode; b: OscillatorNode; g: GainNode }>;
  choirOut: GainNode;
  choirLP: BiquadFilterNode;
  bourdonOut: GainNode;
  buzz: GainNode; // chuffed per eighth
  buzzOut: GainNode;
  vib: GainNode; // reed vibrato depth (cents), fed by an LFO
  oscs: OscillatorNode[];
  nodes: AudioNode[];
}

type Family = "shot" | "ground" | "sweep";
const FAMILY: Record<Kind, Family> = {
  ring: "shot",
  spiral: "shot",
  fan: "shot",
  wave: "shot",
  curve: "shot",
  bloom: "shot",
  rain: "ground",
  slam: "ground",
  glyph: "ground",
  beam: "sweep",
  wall: "sweep",
  cross: "sweep",
};
/** Each attack kind has its own tell pitch (scale degrees above the chord root). */
const CUE_DEG: Record<Kind, number> = { ring: 4, spiral: 6, fan: 2, wave: 3, curve: 5, bloom: 7, beam: 4, slam: 0, glyph: -3, rain: 2, wall: 0, cross: 2 };

export class AudioEngine {
  ctx: BaseAudioContext | null = null;
  private realtime = true;
  private g: Graph | null = null;
  private synth: Synth | null = null;
  private drone: Drone | null = null;
  private spec: TitanSpec | null = null;
  private field: Field | null = null;
  private song: Song | null = null;
  private vmaps = new Map<string, Map<number, AEv[]>>();

  private lookahead: number;
  private autoCores: boolean;
  private syncTrim: number;
  private quiet: boolean;
  private debug: boolean;

  private offset = 0;
  private raw = 0;
  private synced = false;
  private lastT = 0;
  private nextStep = 0;
  private stage: Stage = 0;
  private hpFrac = 1;
  private playing = false;
  private danger = 0;
  private vol = { master: 0.9, music: 0.8, sfx: 0.9 };
  private muted = false;
  private chord = 0; // current chord-root degree
  private counters = { resyncs: 0, late: 0, steps: 0 };
  private graze = { combo: 0, last: -9, lastTick: -9 };
  private strikeN = 0;
  private lastStrike = -9;
  private muffleUntil = 0;
  private persistent = 0;
  private visHandler: (() => void) | null = null;

  /** [step, titanTime, contextTime, rawOffset] for the last scheduled beats (debug only) */
  trace: Array<[number, number, number, number]> = [];

  constructor(opts: AudioEngineOptions = {}) {
    this.lookahead = opts.lookahead ?? 0.12;
    this.autoCores = opts.autoCores ?? true;
    this.syncTrim = opts.syncTrim ?? 0;
    this.quiet = !!opts.quiet;
    this.debug = !!opts.debug;
    if (opts.context) {
      this.ctx = opts.context;
      this.realtime = typeof OfflineAudioContext === "undefined" || !(opts.context instanceof OfflineAudioContext);
      this.build();
    }
  }

  // =========================================================================== public API

  /** Call from a user gesture. Creates or resumes the AudioContext. Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.realtime = true;
      this.build();
      this.watchVisibility();
    }
    const ctx = this.ctx as AudioContext;
    if (this.realtime && ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        /* the browser refused; a later gesture will try again */
      }
      // iOS: a silent buffer started inside the gesture unlocks output
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      b.connect(ctx.destination);
      b.start();
    }
    this.synced = false;
  }

  get unlocked(): boolean {
    return !!this.ctx && (!this.realtime || (this.ctx as AudioContext).state === "running");
  }

  /** Build the titan's instruments, score and attack sounds. Can be called before unlock. */
  setTitan(spec: TitanSpec, field: Field) {
    if (this.spec?.seed === spec.seed && this.field === field) return;
    this.spec = spec;
    this.field = field;
    this.song = buildSong(spec);
    this.vmaps.clear();
    this.synced = false;
    this.graze.combo = 0;
    if (this.g) this.buildDrone();
  }

  /**
   * Call every animation frame with the synced titan time (seconds since it woke).
   * Schedules everything due within the lookahead window.
   */
  update(t: number, stage: Stage, hpFrac: number, opts: UpdateOpts = { playing: true }) {
    const ctx = this.ctx;
    if (!ctx || !this.g || !this.song || !this.spec) return;
    if (this.realtime && ctx.state !== "running") {
      this.synced = false;
      this.lastT = t;
      return;
    }
    this.hpFrac = hpFrac;
    this.setPlaying(opts.playing);
    this.setDanger(opts.nearDanger ?? 0);
    if (stage !== this.stage) this.changeStage(stage);

    const raw = this.measureOffset(t);
    this.raw = raw;
    const jumped = !this.synced || Math.abs(raw - this.offset) > RESYNC_AT || t < this.lastT - 0.05 || t - this.lastT > 1;
    if (jumped) this.resync(t, raw);
    else this.offset += (raw - this.offset) * SMOOTH;
    this.lastT = t;
    this.scheduleTo(ctx.currentTime + this.lookahead - this.offset);
    this.synth!.countVoices(ctx.currentTime);
  }

  /** One-shot sounds. x = arena x in [-8, 8] for panning, strength 0..1 (graze: count). */
  sfx(name: string, x = 0, strength = 1, at?: number) {
    const ctx = this.ctx;
    const sy = this.synth;
    const g = this.g;
    if (!ctx || !sy || !g) return;
    if (this.realtime && (ctx as AudioContext).state !== "running") return;
    const now = at ?? ctx.currentTime + 0.004;
    const out = g.ch.sfx;
    const pan = panOf(x);
    const m = (deg: number, oct: number) => this.midi(deg, oct);
    switch (name) {
      case "graze": {
        if (now - this.graze.last > 1.4) this.graze.combo = 0;
        this.graze.last = now;
        this.graze.combo += Math.max(1, Math.round(strength));
        if (now - this.graze.lastTick < 0.045) return;
        this.graze.lastTick = now;
        const c = this.graze.combo;
        // climb the tonic's arpeggio: 1 3 5 8 10 12 15 17 19, then shimmer at the top
        const ladder = [0, 2, 4, 7, 9, 11, 14, 16, 18];
        const deg = c <= ladder.length ? ladder[c - 1] : ladder[7 + (c % 2)];
        sy.tick(out, now, m(deg, 2), 0.5 + 0.05 * Math.min(c, 9), pan);
        if (c % 10 === 0) sy.bell(out, now + 0.06, m(deg + 7, 2), 0.35, { partials: 4, decay: 1.2, pan, group: "sfx" });
        return;
      }
      case "strike": {
        if (now - this.lastStrike < 0.07) return;
        this.lastStrike = now;
        const s = clamp(strength, 0, 1);
        const deg = this.chord + [0, 4, 2, 7][this.strikeN++ % 4];
        sy.bell(out, now, m(deg, 3), 0.3 + 0.45 * s, { partials: 4, decay: 0.7 + 0.6 * s, pan, group: "sfx", bright: 0.5 + s * 0.5, prio: 1 });
        sy.clack(out, now, 0.22 + 0.3 * s, { pan, pitch: 1.3, group: "sfx" });
        if (s > 0.55) sy.jingle(out, now + 0.01, 0.5, { pan, group: "sfx" });
        return;
      }
      case "dash":
        sy.air(out, now, 0.24, 380, 2800, 0.55, { pan, q: 1.3, attack: 0.03 });
        sy.clack(out, now, 0.12, { pan, pitch: 1.6, group: "sfx" });
        return;
      case "hurt":
        this.graze.combo = 0;
        sy.low(out, now, 1, { f0: 58, f1: 30, decay: 0.6 }, { group: "sfx", prio: 1 });
        sy.bell(out, now, m(0, 3) + 1, 0.42, { partials: 4, decay: 0.9, pan, group: "sfx", prio: 1 });
        sy.bell(out, now, m(0, 3), 0.36, { partials: 3, decay: 0.7, pan, group: "sfx" });
        this.muffle(520, 0.45, now);
        this.duckMusic(now, 0.6, 0.6);
        return;
      case "surge": {
        sy.bowed(out, now, now + 0.6, m(7, 2), 1, { pan, ring: 0.4, group: "sfx", prio: 1 });
        sy.air(out, now, 0.6, 400, 4200, 0.45, { pan, q: 0.9, attack: 0.55, prio: 1 });
        sy.bell(out, now + 0.6, m(7, 2), 0.75, { partials: 8, decay: 2.6, pan, group: "sfx", prio: 1 });
        sy.low(out, now + 0.6, 0.9, this.song?.timbre.low ?? { f0: 70, f1: 42, decay: 0.8 }, { flam: true, group: "sfx", prio: 1 });
        this.choirSwell(now, 2, 1.7);
        return;
      }
      case "down": {
        this.graze.combo = 0;
        [4, 2, 0].forEach((d, i) => sy.bell(out, now + i * 0.45, m(d, 2), 0.55, { partials: 6, decay: 3, group: "sfx", prio: 1 }));
        sy.boom(out, now, 0.6, { group: "sfx" });
        this.muffle(380, 2.2, now);
        return;
      }
      case "revive":
        [0, 2, 4, 7, 9].forEach((d, i) => sy.pluck(out, now + i * 0.07, m(d, 2), 0.7, { decay: 1.6, bright: 0.8, pan, group: "sfx", prio: 1 }));
        sy.bell(out, now + 0.36, m(14, 2), 0.45, { partials: 5, decay: 2.2, pan, group: "sfx" });
        sy.jingle(out, now + 0.36, 0.6, { long: true, pan, group: "sfx" });
        return;
      case "core-open":
        sy.bell(out, now, m(4, 3), 0.32, { partials: 4, decay: 1.3, pan, group: "sfx" });
        sy.bell(out, now + 0.11, m(7, 3), 0.28, { partials: 4, decay: 1.5, pan, group: "sfx" });
        sy.jingle(out, now, 0.4, { pan, group: "sfx" });
        return;
      case "start":
        sy.low(out, now, 1, this.song?.timbre.low ?? { f0: 70, f1: 42, decay: 0.8 }, { flam: true, group: "sfx", prio: 1 });
        sy.bell(out, now, m(0, 3), 0.55, { partials: 6, decay: 2.4, group: "sfx", prio: 1 });
        sy.air(out, now, 0.5, 300, 3000, 0.3, { q: 0.8, attack: 0.1 });
        return;
      case "wake": {
        const root = this.song?.root ?? 45;
        sy.gong(out, now, mtof(root), 1, { decay: 6, group: "fx" });
        sy.bowed(out, now, now + 1.8, root + 12, 1, { ring: 1.2, group: "fx", prio: 1 });
        sy.bell(out, now + 1.8, m(0, 2), 0.8, { partials: 8, decay: 4, group: "sfx", prio: 1 });
        sy.low(out, now + 1.8, 1, { f0: 60, f1: 34, decay: 1.2 }, { flam: true, group: "sfx", prio: 1 });
        sy.boom(out, now + 1.8, 0.9, { group: "sfx" });
        return;
      }
      case "felled": {
        const root = this.song?.root ?? 45;
        sy.gong(out, now, mtof(root) / 2 * 1.5, 1, { decay: 7, group: "fx" });
        sy.boom(out, now, 1, { decay: 2, group: "sfx" });
        // a peal tumbling down the scale, then a Picardy chord: the world exhales in major
        for (let i = 0; i < 8; i++) sy.bell(out, now + 0.12 + i * 0.17, m(7 - i, 3), 0.42, { partials: 5, decay: 2.4, pan: ((i % 3) - 1) * 0.5, group: "sfx", prio: 1 });
        const tonic = root + 36;
        [0, 4, 7, 12].forEach((iv, i) => sy.bell(out, now + 1.6 + i * 0.03, tonic + iv, 0.5, { partials: 7, decay: 5, pan: (i - 1.5) * 0.3, group: "bell", prio: 1 }));
        this.duckMusic(now, 0.3, 4);
        return;
      }
      case "ui":
        sy.pluck(out, now, m(4, 2), 0.55, { decay: 0.6, bright: 0.5, group: "sfx", prio: 1 });
        return;
      case "ui-hover":
        sy.tick(out, now, m(7, 2), 0.22, 0);
        return;
      case "beat":
        return; // the Canticle already keeps the beat
    }
  }

  setVolume(master: number, music: number, sfx: number) {
    this.vol = { master: clamp(master, 0, 1), music: clamp(music, 0, 1), sfx: clamp(sfx, 0, 1) };
    this.applyVolumes();
  }

  mute(on: boolean) {
    this.muted = on;
    this.applyVolumes();
  }

  /** Reduced / quiet mode: softer transients, no sub, gentler master. */
  setQuiet(on: boolean) {
    this.quiet = on;
    if (this.synth) this.synth.quiet = on;
    this.applyVolumes();
  }

  /** The titan time currently coming out of the speakers (for visuals that want to follow audio). */
  heardTime(): number {
    return this.ctx ? this.ctx.currentTime - this.offset : 0;
  }

  stats(): AudioStats {
    const s = this.synth?.stats ?? { created: 0, live: 0, voices: 0, peakVoices: 0, dropped: 0, stolen: 0, notes: 0 };
    return {
      ...s,
      offset: this.offset,
      rawOffset: this.raw,
      resyncs: this.counters.resyncs,
      late: this.counters.late,
      steps: this.counters.steps,
      persistent: this.persistent + (this.drone?.nodes.length ?? 0),
      contextTime: this.ctx?.currentTime ?? 0,
      state: this.ctx ? ((this.ctx as AudioContext).state ?? "offline") : "none",
    };
  }

  dispose() {
    if (this.visHandler) document.removeEventListener("visibilitychange", this.visHandler);
    this.visHandler = null;
    if (this.realtime && this.ctx) void (this.ctx as AudioContext).close();
    this.ctx = null;
    this.g = null;
    this.synth = null;
    this.drone = null;
  }

  /**
   * Render an excerpt offline: `seconds` of the Canticle from titan time t0, at a fixed stage.
   * Optional sfx are placed at offsets (seconds from the start of the excerpt).
   */
  static async renderExcerpt(
    spec: TitanSpec,
    field: Field,
    o: {
      t0: number;
      seconds: number;
      stage: Stage;
      hpFrac?: number;
      playing?: boolean;
      sampleRate?: number;
      quiet?: boolean;
      sfx?: Array<{ at: number; name: string; x?: number; strength?: number }>;
      /** diagnostics: only these channels sound (perc, bass, mel, bell, choir, bourdon, cue, impact, sfx) */
      solo?: string[];
      /** diagnostics: render without the cathedral */
      dry?: boolean;
    },
  ): Promise<AudioBuffer> {
    const sr = o.sampleRate ?? 44100;
    const off = new OfflineAudioContext(2, Math.ceil(sr * o.seconds), sr);
    const eng = new AudioEngine({ context: off, quiet: o.quiet });
    eng.setTitan(spec, field);
    if (o.solo) for (const [k, n] of Object.entries(eng.g!.ch)) if (!o.solo.includes(k)) (n as GainNode).gain.value = 0;
    if (o.dry) eng.g!.verbOut.gain.value = 0;
    const a = performance.now();
    eng.renderSchedule(o.t0, o.t0 + o.seconds, o.stage, o.hpFrac ?? [0.9, 0.5, 0.2][o.stage], o.playing ?? true);
    for (const s of o.sfx ?? []) eng.sfx(s.name, s.x ?? 0, s.strength ?? 1, s.at);
    const b = performance.now();
    const buf = await off.startRendering();
    AudioEngine.lastRender = { scheduleMs: b - a, renderMs: performance.now() - b, notes: eng.synth!.stats.notes, nodes: eng.synth!.stats.created };
    return buf;
  }

  /** Timing of the last offline render (diagnostics). */
  static lastRender = { scheduleMs: 0, renderMs: 0, notes: 0, nodes: 0 };

  /** Offline: schedule [t0, t1) of titan time onto context time 0.. in one go. */
  renderSchedule(t0: number, t1: number, stage: Stage, hpFrac: number, playing: boolean) {
    if (!this.ctx || !this.g || !this.spec) return;
    this.hpFrac = hpFrac;
    this.stage = stage;
    this.playing = playing;
    this.applyStage(0, true);
    this.applyPlaying(0, true);
    this.offset = -t0;
    this.synced = true;
    this.lastT = t0;
    const stepDur = this.spec.beat / STEPS_PER_BEAT;
    this.nextStep = Math.ceil(t0 / stepDur - 1e-9);
    this.setChordAt(this.nextStep, 0, true);
    this.scheduleTo(t1);
  }

  // =========================================================================== graph

  private build() {
    const ctx = this.ctx!;
    const nodes: AudioNode[] = [];
    const G = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      nodes.push(n);
      return n;
    };
    const mix = G(1);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 28;
    hp.Q.value = 0.6;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 12;
    glue.ratio.value = 2.6;
    glue.attack.value = 0.012;
    glue.release.value = 0.28;
    const makeup = G(1.5);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const trim = G(1);
    const pre = G(0.5); // the ceiling curve spans +-2 of real signal
    const ceil = ctx.createWaveShaper();
    ceil.curve = ceilingCurve();
    ceil.oversample = "none";
    const master = G(0.9);
    nodes.push(hp, glue, limiter, ceil);
    mix.connect(hp).connect(glue).connect(makeup).connect(limiter).connect(trim).connect(pre).connect(ceil).connect(master).connect(ctx.destination);

    // reverb: one cathedral shared by music and sfx
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = cathedralIR(ctx);
    nodes.push(conv);
    const verbIn = G(1);
    const verbOut = G(0.55);
    verbIn.connect(conv).connect(verbOut).connect(mix);
    const verbMusic = G(this.vol.music);
    const verbSfx = G(this.vol.sfx);
    verbMusic.connect(verbIn);
    verbSfx.connect(verbIn);

    // music
    const musicSum = G(1);
    const lobby = ctx.createBiquadFilter();
    lobby.type = "lowpass";
    lobby.frequency.value = 1100;
    lobby.Q.value = 0.5;
    nodes.push(lobby);
    const duck = G(1);
    const danger = G(1);
    const musicVol = G(this.vol.music);
    musicSum.connect(lobby).connect(duck).connect(danger).connect(musicVol).connect(mix);
    // sfx
    const sfxVol = G(this.vol.sfx);
    sfxVol.connect(mix);
    const titanSfx = G(1);
    titanSfx.connect(sfxVol);

    const chan = (level: number, to: AudioNode, send: number, verb: AudioNode) => {
      const c = G(level);
      c.connect(to);
      if (send > 0) {
        const s = G(send);
        c.connect(s).connect(verb);
      }
      return c;
    };
    const ch: Channels = {
      perc: chan(0.95, musicSum, 0.2, verbMusic),
      bass: chan(0.9, musicSum, 0.06, verbMusic),
      mel: chan(1, musicSum, 0.42, verbMusic),
      bell: chan(0.85, musicSum, 0.6, verbMusic),
      choir: chan(1, musicSum, 0.7, verbMusic),
      bourdon: chan(1, musicSum, 0.3, verbMusic),
      cue: chan(1, titanSfx, 0.3, verbSfx),
      impact: chan(1, titanSfx, 0.32, verbSfx),
      sfx: chan(1, sfxVol, 0.3, verbSfx),
    };
    this.persistent = nodes.length;
    this.g = { ch, musicSum, lobby, duck, danger, musicVol, titanSfx, sfxVol, verbMusic, verbSfx, verbOut, glue, limiter, trim, master, nodes };
    this.synth = new Synth(ctx);
    this.synth.quiet = this.quiet;
    this.applyVolumes();
    if (this.spec) this.buildDrone();
  }

  /** The long-lived voices: choir, bourdon and hurdy-gurdy buzz. Rebuilt per titan with a crossfade. */
  private buildDrone() {
    const ctx = this.ctx!;
    const g = this.g!;
    const song = this.song!;
    const tm = song.timbre;
    const now = ctx.currentTime;
    if (this.drone) {
      const old = this.drone;
      for (const f of old.fades) f.gain.setTargetAtTime(0, now, 0.4);
      for (const o of old.oscs) o.stop(now + 2.5);
      old.oscs[0].onended = () => old.nodes.forEach((n) => n.disconnect());
    }
    const nodes: AudioNode[] = [];
    const oscs: OscillatorNode[] = [];
    const G = (v: number) => {
      const n = ctx.createGain();
      n.gain.value = v;
      nodes.push(n);
      return n;
    };
    const O = (type: OscillatorType, f: number, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      o.start(now);
      nodes.push(o);
      oscs.push(o);
      return o;
    };
    const F = (type: BiquadFilterType, f: number, q: number) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      nodes.push(b);
      return b;
    };
    // two fade handles (choir, bourdon) so a new titan crossfades over the old one
    const choirFade = G(0);
    const bourdonFade = G(0);
    for (const f of [choirFade, bourdonFade]) {
      if (this.realtime) f.gain.setTargetAtTime(1, now, 0.6);
      else f.gain.setValueAtTime(1, now);
    }

    // --- choir: four voices of paired detuned saws through a vowel's formants
    const choirSum = G(1);
    const lfo = O("sine", 0.21);
    const lfoDepth = G(7); // cents of slow pitch drift
    lfo.connect(lfoDepth);
    const choirVoices: Drone["choirVoices"] = [];
    for (let i = 0; i < 4; i++) {
      const f = mtof(degToMidi(song, [0, 2, 4, 7][i], 1));
      const a = O("sawtooth", f, -9 + i);
      const b = O("sawtooth", f, 8 - i);
      lfoDepth.connect(a.detune);
      const gv = G(0);
      a.connect(gv);
      b.connect(gv);
      gv.connect(choirSum);
      choirVoices.push({ a, b, g: gv });
    }
    const choirOut = G(0);
    const [f1, f2, f3] = tm.vowel;
    [
      [f1, 6, 1],
      [f2, 8, 0.55],
      [f3, 10, 0.3],
    ].forEach(([f, q, a]) => {
      const bp = F("bandpass", f, q);
      const bg = G(a * 2.4);
      choirSum.connect(bp).connect(bg).connect(choirOut);
    });
    const choirLP = F("lowpass", 1600, 0.5);
    // breath: a slow swell in the choir's level
    const breath = O("sine", 0.13);
    const breathDepth = G(0.18);
    const breathG = G(1);
    breath.connect(breathDepth).connect(breathG.gain);
    choirOut.connect(choirLP).connect(breathG).connect(choirFade).connect(g.ch.choir);

    // --- bourdon: the tonic and its fifth, never moving (organ / hurdy-gurdy drone strings)
    const tonic = mtof(song.root + 12);
    const bourdonOut = G(0);
    const blp = F("lowpass", 760, 0.7);
    const t1 = O("triangle", tonic, 0);
    const t2 = O("sine", tonic / 2, 0);
    const t3 = O("square", tonic * 1.5, 3);
    const t3g = G(0.08);
    const t2g = G(0.9);
    t1.connect(blp);
    t2.connect(t2g).connect(blp);
    t3.connect(t3g).connect(blp);
    blp.connect(bourdonOut);
    // trompette buzz: a driven saw, chuffed by the wheel on every eighth
    const bz = O("sawtooth", tonic, -4);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(new ArrayBuffer(1024 * 4));
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 4.5);
    }
    shaper.curve = curve;
    nodes.push(shaper);
    const bbp = F("bandpass", 1500, 1.4);
    const buzz = G(0.15);
    const buzzOut = G(0);
    bz.connect(shaper).connect(bbp).connect(buzz).connect(buzzOut).connect(bourdonOut);

    bourdonOut.connect(bourdonFade).connect(g.ch.bourdon);

    // reed vibrato source
    const vibLfo = O("sine", 5.1);
    const vib = G(13);
    vibLfo.connect(vib);

    this.drone = { fades: [choirFade, bourdonFade], choirVoices, choirOut, choirLP, bourdonOut, buzz, buzzOut, vib, oscs, nodes };
    this.applyStage(now, true);
  }

  // =========================================================================== mix state

  private applyVolumes() {
    const g = this.g;
    if (!g || !this.ctx) return;
    const now = this.ctx.currentTime;
    const m = this.muted ? 0 : this.vol.master * (this.quiet ? 0.7 : 1);
    g.master.gain.setTargetAtTime(m, now, 0.05);
    g.musicVol.gain.setTargetAtTime(this.vol.music, now, 0.05);
    g.verbMusic.gain.setTargetAtTime(this.vol.music, now, 0.05);
    g.sfxVol.gain.setTargetAtTime(this.vol.sfx, now, 0.05);
    g.verbSfx.gain.setTargetAtTime(this.vol.sfx, now, 0.05);
    g.trim.gain.setTargetAtTime(this.quiet ? 0.8 : 1, now, 0.05);
    g.glue.threshold.setTargetAtTime(this.quiet ? -26 : -20, now, 0.05);
  }

  private lobbyCutoff() {
    return this.playing ? 18000 : 1100;
  }

  private setPlaying(on: boolean) {
    if (on === this.playing) return;
    this.playing = on;
    this.applyPlaying(this.ctx!.currentTime, false);
  }

  private applyPlaying(when: number, immediate: boolean) {
    const g = this.g!;
    const f = this.lobbyCutoff();
    const lvl = this.playing ? 1 : 0.45;
    if (immediate) {
      g.lobby.frequency.setValueAtTime(f, when);
      g.titanSfx.gain.setValueAtTime(lvl, when);
    } else {
      g.lobby.frequency.cancelScheduledValues(when);
      g.lobby.frequency.setTargetAtTime(f, when, this.playing ? 0.35 : 0.6);
      g.titanSfx.gain.setTargetAtTime(lvl, when, 0.3);
    }
  }

  private setDanger(d: number) {
    d = clamp(d, 0, 1);
    if (Math.abs(d - this.danger) < 0.02) return;
    this.danger = d;
    this.g!.danger.gain.setTargetAtTime(1 - 0.3 * d, this.ctx!.currentTime, 0.12);
  }

  /** Concussion: the cathedral goes muffled for a moment. */
  private muffle(cut: number, hold: number, when: number) {
    const p = this.g!.lobby.frequency;
    p.cancelScheduledValues(when);
    p.setTargetAtTime(cut, when, 0.03);
    p.setTargetAtTime(this.lobbyCutoff(), when + hold, 0.45);
    this.muffleUntil = when + hold;
  }

  private duckMusic(when: number, depth: number, hold: number) {
    const p = this.g!.duck.gain;
    p.setTargetAtTime(depth, when, 0.012);
    p.setTargetAtTime(1, when + hold, 0.25);
  }

  private choirSwell(when: number, mul: number, dur: number) {
    const d = this.drone;
    if (!d) return;
    const base = this.choirLevel();
    d.choirOut.gain.setTargetAtTime(base * mul, when, dur * 0.25);
    d.choirOut.gain.setTargetAtTime(base, when + dur, dur * 0.4);
  }

  private choirLevel() {
    const tm = this.song!.timbre;
    return [0.55, 0.72, 0.9][this.stage] * tm.choir * (0.9 + 0.2 * (1 - this.hpFrac));
  }

  private changeStage(stage: Stage) {
    const up = stage > this.stage;
    this.stage = stage;
    const ctx = this.ctx!;
    if (!this.spec) return;
    // land the change on the next bar line
    const bar = this.spec.beat * 4;
    const tNext = Math.ceil((ctx.currentTime + 0.05 - this.offset) / bar) * bar;
    const when = Math.max(ctx.currentTime + 0.02, tNext + this.offset);
    this.applyStage(when, false);
    if (up && this.synced) {
      const sy = this.synth!;
      const g = this.g!;
      sy.gong(g.ch.impact, when, mtof(this.song!.root + 12), 0.9, { decay: 5 });
      sy.bell(g.ch.bell, when, this.midi(0, 2), 0.7, { partials: 8, decay: 4, prio: 1 });
      sy.low(g.ch.impact, when, 1, this.song!.timbre.low, { flam: true, group: "impact", prio: 1 });
      sy.boom(g.ch.impact, when, 0.8);
      this.choirSwell(when, 1.5, this.spec.beat * 8);
    }
  }

  private applyStage(when: number, immediate: boolean) {
    const d = this.drone;
    if (!d || !this.song) return;
    const tm = this.song.timbre;
    const s = this.stage;
    const set = (p: AudioParam, v: number, k = 0.6) => (immediate ? p.setValueAtTime(v, when) : p.setTargetAtTime(v, when, k));
    const vg = [
      [1, 1, 1],
      [0.45, 0.75, 0.85],
      [0.8, 0.9, 1],
      [0, 0.28, 0.55],
    ];
    d.choirVoices.forEach((v, i) => set(v.g.gain, vg[i][s] * 0.05));
    set(d.choirOut.gain, this.choirLevel());
    set(d.choirLP.frequency, [1500, 2300, 3600][s], 1);
    set(d.bourdonOut.gain, [0.11, 0.13, 0.15][s] * tm.bourdon);
    set(d.buzzOut.gain, [0, 0.05, 0.075][s] * tm.buzz);
  }

  // =========================================================================== timing

  /** context time minus titan time, measured against the moment audio actually leaves the speakers */
  private measureOffset(t: number): number {
    const ctx = this.ctx as AudioContext;
    if (this.realtime && typeof ctx.getOutputTimestamp === "function") {
      const ts = ctx.getOutputTimestamp();
      const ct = ts.contextTime ?? 0;
      const pt = ts.performanceTime ?? 0;
      if (ct > 0 && pt > 0) {
        const out = ct + (performance.now() - pt) / 1000;
        if (out <= ctx.currentTime + 0.05 && out > ctx.currentTime - 0.5) return out - t + this.syncTrim;
      }
    }
    const lat = this.realtime ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0;
    return ctx.currentTime - lat - t + this.syncTrim;
  }

  private resync(t: number, raw: number) {
    const ctx = this.ctx!;
    const spec = this.spec!;
    this.offset = raw;
    this.synced = true;
    this.counters.resyncs++;
    const stepDur = spec.beat / STEPS_PER_BEAT;
    // never replay the past: start from the first step that can still be heard on time
    const earliest = Math.max(t, ctx.currentTime + 0.005 - this.offset);
    this.nextStep = Math.ceil(earliest / stepDur - 1e-9);
    this.setChordAt(this.nextStep, ctx.currentTime, false);
    this.applyStage(ctx.currentTime, false);
  }

  private scheduleTo(tHorizon: number) {
    const spec = this.spec!;
    const ctx = this.ctx!;
    const stepDur = spec.beat / STEPS_PER_BEAT;
    // a stall (tab hidden, debugger) must never turn into a burst of stale notes
    const tEarliest = ctx.currentTime - this.offset;
    if (this.realtime && this.nextStep * stepDur < tEarliest - 0.25) {
      this.counters.late += Math.floor((tEarliest - this.nextStep * stepDur) / stepDur);
      this.nextStep = Math.ceil(tEarliest / stepDur);
    }
    let guard = 0;
    while (this.nextStep * stepDur < tHorizon && guard++ < 4096) {
      const s = this.nextStep++;
      const ts = s * stepDur;
      let when = ts + this.offset;
      if (this.realtime && when < ctx.currentTime) {
        if (when < ctx.currentTime - 0.012) {
          this.counters.late++;
          continue;
        }
        when = ctx.currentTime;
      }
      this.counters.steps++;
      if (this.debug && s % STEPS_PER_BEAT === 0) {
        this.trace.push([s, ts, when, this.raw]);
        if (this.trace.length > 4096) this.trace.splice(0, 1024);
      }
      this.step(s, when);
    }
  }

  // =========================================================================== the score, one sixteenth at a time

  private midi(deg: number, oct: number) {
    if (!this.song) return 45 + 12 * oct + deg;
    return degToMidi(this.song, deg, oct);
  }

  private setChordAt(s: number, when: number, immediate: boolean) {
    const song = this.song!;
    const pa = Math.floor(s / PHRASE_STEPS);
    const phrase = ((pa % LOOP_PHRASES) + LOOP_PHRASES) % LOOP_PHRASES;
    const local = s - pa * PHRASE_STEPS;
    this.setChord(song.progs[phrase][Math.floor(local / BLOCK_STEPS)], when, immediate);
  }

  private setChord(deg: number, when: number, immediate: boolean) {
    this.chord = deg;
    const d = this.drone;
    if (!d || !this.song) return;
    d.choirVoices.forEach((v, i) => {
      const f = mtof(degToMidi(this.song!, deg + [0, 2, 4, 7][i], 1));
      if (immediate) {
        v.a.frequency.setValueAtTime(f, when);
        v.b.frequency.setValueAtTime(f, when);
      } else {
        v.a.frequency.setTargetAtTime(f, when, 0.07);
        v.b.frequency.setTargetAtTime(f, when, 0.09);
      }
    });
  }

  private step(s: number, when: number) {
    const song = this.song!;
    const spec = this.spec!;
    const sy = this.synth!;
    const ch = this.g!.ch;
    const tm = song.timbre;
    const stage = this.stage;
    const beatSec = spec.beat;
    const stepDur = beatSec / STEPS_PER_BEAT;
    const pa = Math.floor(s / PHRASE_STEPS);
    const phrase = ((pa % LOOP_PHRASES) + LOOP_PHRASES) % LOOP_PHRASES;
    const local = s - pa * PHRASE_STEPS;
    const bar = local >> 4;
    const sib = local & 15;
    const block = local >> 6;
    const chord = song.progs[phrase][block];
    const drive = song.phraseDrive[phrase];
    const swung = sib & 1 ? when + tm.swing * stepDur : when;
    const overture = phrase === 0 && bar < 8;
    const crescendo = phrase === LOOP_PHRASES - 1 && bar >= 12;

    // --- structure: chords, phrase bells, the Canticle's own breath
    if (local % BLOCK_STEPS === 0) {
      this.setChord(chord, when, false);
      if (stage === 2 && block > 0) sy.bowed(ch.bell, when, when + beatSec * 2, this.midi(chord + 7, 2), 0.55, { ring: 1.2, pan: block % 2 ? 0.4 : -0.4 });
    }
    if (local === 0) {
      if (phrase === 0) {
        sy.gong(ch.impact, when, mtof(song.root + 12), 0.8, { decay: 6 });
        sy.bell(ch.bell, when, this.midi(0, 2), 0.75, { partials: 8, decay: 5, prio: 1 });
      } else {
        sy.bell(ch.bell, when, this.midi(0, 2), 0.32 + 0.06 * stage, { partials: 6, decay: 3.5 });
      }
      if (this.drone) this.drone.choirOut.gain.setTargetAtTime(this.choirLevel() * (0.85 + 0.25 * drive), when, beatSec * 4);
    }
    if (crescendo && local === 12 * 16) {
      // four bars of rising air and bowed metal into the overture
      const end = when + beatSec * 16;
      sy.air(ch.impact, when, end - when, 180, 5200, 0.22 + 0.08 * stage, { q: 0.7, attack: (end - when) * 0.95, group: "fx", prio: 1 });
      sy.bowed(ch.bell, when + beatSec * 8, end, this.midi(4, 2), 0.8, { ring: 0.6, prio: 1 });
      this.choirSwell(when, 1.45, beatSec * 16);
    }

    // --- percussion
    const fillBar = stage > 0 && bar % 4 === 3 && !overture && !crescendo;
    for (const v of PERC_VOICES) {
      let vel: number;
      if (overture) vel = v === "low" && sib === 0 && bar >= 2 && bar % 2 === 0 ? 0.75 : v === "jingle" && bar >= 4 && sib === 8 ? 0.35 : 0;
      else if (crescendo && v === "frame") vel = Math.min(1, 0.3 + ((bar - 12) * 16 + sib) / 80) * (stage > 0 || sib % 2 === 0 ? 1 : 0);
      else if (crescendo && v === "low") vel = sib % 4 === 0 ? 0.6 + 0.1 * (bar - 12) : 0;
      else vel = fillBar && sib >= 8 ? song.fills[v][sib] : song.perc[v][stage][sib];
      if (vel <= 0) continue;
      vel *= drive;
      const t = sib & 1 && vel < 0.5 ? swung : when;
      switch (v) {
        case "low":
          sy.low(ch.perc, t, Math.min(1, vel), tm.low, { flam: stage === 2 && vel > 0.7 });
          break;
        case "frame":
          sy.frame(ch.perc, t, vel, tm.frame, { pan: -0.25 });
          break;
        case "clack":
          sy.clack(ch.perc, t, vel * 0.7, { pan: 0.3, pitch: 0.3 + 0.2 * stage });
          break;
        case "jingle":
          sy.jingle(ch.perc, t, vel, { pan: 0.45 });
          break;
      }
    }

    // --- hurdy-gurdy wheel: the buzz chuffs on eighths in Wrath and Ruin
    if (stage > 0 && tm.buzz > 0 && sib % 2 === 0 && this.drone) {
      const p = this.drone.buzz.gain;
      p.setValueAtTime(sib % 4 === 0 ? 1 : 0.7, swung);
      p.setTargetAtTime(0.18, swung + 0.015, stepDur * 0.7);
    }

    // --- bass
    const bp = song.bass[overture ? 0 : stage];
    if (bp[sib] > 0 && (!overture || bar % 2 === 0)) {
      let next = 1;
      while (next < 16 && bp[(sib + next) % 16] === 0) next++;
      const durSteps = stage === 0 || overture ? 16 * (overture ? 2 : 1) : next;
      let midi = degToMidi(song, chord, 0);
      if (midi > 50) midi -= 12;
      if (stage === 2 && sib % 4 === 2) midi += 12;
      sy.bass(ch.bass, when, midi, durSteps * stepDur * 0.92, bp[sib] * (0.75 + 0.25 * drive), { sub: stage === 2 && sib % 8 === 0, bright: 0.2 + 0.25 * stage });
    }

    // --- melody
    const notes = song.melodyAt[phrase].get(local);
    if (notes) {
      for (const n of notes) {
        let midi = degToMidi(song, n.deg, 2);
        while (midi > 86) midi -= 12;
        while (midi < 55) midi += 12;
        const dur = n.dur * stepDur;
        const t = sib & 1 ? swung : when;
        const vel = n.vel * (0.75 + 0.25 * drive);
        if (n.bell) {
          sy.bell(ch.bell, t, midi, vel * 0.55, { partials: 6, decay: 3 });
          continue;
        }
        if (n.counter) {
          sy.pluck(ch.mel, t, midi, vel * 0.55, { decay: 1.4, bright: 0.4, pan: 0.35 });
          continue;
        }
        this.lead(tm.lead, t, midi, dur, vel * (stage === 0 ? 0.85 : 1), 0);
        if (stage >= 1) this.lead(tm.lead2, t, tm.lead2 === "bell" ? midi : midi - 12, dur, vel * 0.5, -0.3);
        if (stage === 2 && n.vel >= 0.9) sy.bell(ch.bell, t, midi + 12, vel * 0.32, { partials: 5, decay: 2.2, pan: 0.3 });
      }
    }

    // --- cores opening, on the beat
    if (this.autoCores && this.playing && sib % 4 === 0) {
      const beatIn = local / 4; // windows open on the beat
      for (const c of spec.cores) {
        for (const [a] of c.windows) {
          if (a === beatIn) {
            this.sfx("core-open", c.x, 1, when);
            break;
          }
        }
      }
    }

    // --- the titan's volleys
    for (let k = -1; k <= 1; k++) {
      const pk = pa + k;
      if (pk < 0) continue;
      const evs = this.vmap(((pk % LOOP_PHRASES) + LOOP_PHRASES) % LOOP_PHRASES, stage).get(s - pk * PHRASE_STEPS);
      if (evs) for (const e of evs) this.voiceVolley(e, when, chord);
    }
  }

  private lead(kind: Lead, when: number, midi: number, dur: number, vel: number, pan: number) {
    const sy = this.synth!;
    const ch = this.g!.ch;
    switch (kind) {
      case "psaltery":
        sy.pluck(ch.mel, when, midi, vel, { decay: 1.6 + dur, pan });
        break;
      case "reed":
        sy.reed(ch.mel, when, midi, Math.max(0.08, dur * 0.92), vel, this.drone?.vib, { pan });
        break;
      case "glass":
        sy.glass(ch.mel, when, midi, Math.max(0.1, dur), vel, { pan });
        break;
      case "organ":
        sy.organ(ch.mel, when, midi, Math.max(0.08, dur * 0.95), vel);
        break;
      case "bell":
        sy.bell(ch.bell, when, midi, vel * 0.6, { partials: 5, decay: 2 });
        break;
    }
  }

  private vmap(phrase: number, stage: Stage): Map<number, AEv[]> {
    const key = phrase + ":" + stage;
    let m = this.vmaps.get(key);
    if (!m) {
      m = volleyEvents(this.field!, phrase, stage);
      this.vmaps.set(key, m);
    }
    return m;
  }

  /** The titan's attacks, voiced: tells before, swells under, impacts on the beat. */
  private voiceVolley(e: AEv, when: number, chord: number) {
    const sy = this.synth!;
    const ch = this.g!.ch;
    const song = this.song!;
    const tm = song.timbre;
    const beatSec = this.spec!.beat;
    const v = e.v;
    const pan = panOf(e.x);
    const heavy = v.heavy || e.sig;
    const vel = (heavy ? 1 : 0.72) * (1 + 0.08 * this.stage);
    const m = (deg: number, oct: number) => this.midi(deg, oct);
    switch (e.type) {
      case "cue": {
        if (!this.playing) return;
        const deg = chord + CUE_DEG[v.kind];
        const fam = FAMILY[v.kind];
        const cv = heavy ? 0.5 : 0.36;
        if (fam === "shot") {
          sy.bell(ch.cue, when, m(deg, 3), cv, { partials: 3, decay: 0.8, pan, group: "cue", prio: 1 });
        } else if (fam === "ground") {
          sy.pluck(ch.cue, when, m(deg, 1), cv * 1.4, { decay: 0.7, bright: 0.25, pan, group: "cue", prio: 1 });
          sy.clack(ch.cue, when, cv * 0.5, { pan, pitch: 0.05, group: "cue" });
        } else {
          sy.glass(ch.cue, when, m(deg, 2), beatSec * 0.85, cv * 1.2, { pan, group: "cue" });
        }
        if (heavy) sy.pluck(ch.cue, when, m(deg - 7, 2), cv * 0.8, { decay: 0.9, bright: 0.3, pan, group: "cue" });
        return;
      }
      case "swell": {
        const end = when + e.durBeats * beatSec;
        sy.bowed(ch.impact, when, end, m(chord + (e.sig ? 0 : 4), e.sig ? 2 : 3), e.sig ? 1 : 0.7, { pan, ring: 0.25, group: "fx", prio: e.sig ? 1 : 0 });
        if (e.sig) {
          sy.bell(ch.bell, when, m(0, 1) + 12, 0.7, { partials: 8, decay: 4, prio: 1 });
          this.choirSwell(when, 1.6, e.durBeats * beatSec);
        }
        return;
      }
      case "impact":
      case "echo": {
        const ev = e.type === "echo" ? vel * 0.7 : vel;
        if (heavy && e.type === "impact") this.duckMusic(when, 0.72, 0.18);
        if (e.sig && e.type === "impact") {
          sy.gong(ch.impact, when, mtof(song.root + 12) * 0.75, 1, { decay: 6 });
          sy.boom(ch.impact, when, 1, { decay: 1.8 });
        }
        this.impact(v.kind, when, ev, pan, chord, heavy, e);
        return;
      }
      case "tick":
        sy.clack(ch.impact, when, 0.3 * vel, { pan, pitch: 0.9 + (e.k % 3) * 0.15, group: "impact" });
        return;
      case "burst":
        sy.bell(ch.impact, when, m(chord, 3), 0.55 * vel, { partials: 5, decay: 1.8, pan, group: "impact", prio: 1 });
        sy.low(ch.impact, when, 0.8 * vel, tm.low, { group: "impact", pan: pan * 0.5, size: 0.8 });
        sy.jingle(ch.impact, when, 0.7, { long: true, pan, group: "impact" });
        return;
      case "sustain": {
        const dur = e.durBeats * beatSec;
        if (v.kind === "beam") {
          const p = v.p;
          const pan1 = clamp(Math.cos(p.a1) * 1.4, -1, 1);
          const pan2 = clamp(Math.cos(p.a2) * 1.4, -1, 1);
          sy.air(ch.impact, when, dur, 220, 700, 0.42 * vel, { pan: p.twin ? 0 : pan1, pan2: p.twin ? 0 : pan2, q: 1.1, attack: 0.04, group: "impact", prio: 1 });
          sy.bowed(ch.impact, when, when + dur, m(chord, 1), 0.8, { pan: pan1 * 0.5, ring: 0.4, group: "fx" });
        } else if (v.kind === "spiral") {
          // the spiral unspools as a rising (or falling) arpeggio, one note a beat
          const n = Math.max(1, Math.round(e.durBeats));
          const dir = v.p.dir ?? 1;
          for (let k = 1; k < n; k++) {
            const d = [0, 2, 4, 7, 9, 11, 14][(dir > 0 ? k : n - k) % 7];
            sy.pluck(ch.impact, when + k * beatSec, m(chord + d, 2), 0.4 * vel, { decay: 0.9, bright: 0.7, pan: pan * (1 - k / n), group: "impact" });
          }
        } else if (v.kind === "glyph") {
          sy.air(ch.impact, when, dur, 5200, 3400, 0.18 * vel, { pan, q: 5, attack: 0.02, group: "impact" });
        }
        return;
      }
    }
  }

  private impact(kind: Kind, when: number, vel: number, pan: number, chord: number, heavy: boolean, e: AEv) {
    const sy = this.synth!;
    const out = this.g!.ch.impact;
    const tm = this.song!.timbre;
    const m = (deg: number, oct: number) => this.midi(deg, oct);
    const grp = { group: "impact" as const, pan };
    switch (kind) {
      case "ring":
        sy.bell(out, when, m(chord + 4, 3), 0.5 * vel, { partials: 5, decay: 1.6, ...grp, prio: 1 });
        sy.frame(out, when, vel, tm.frame, grp);
        break;
      case "spiral":
        sy.frame(out, when, vel, tm.frame, grp);
        sy.bell(out, when, m(chord, 3), 0.4 * vel, { partials: 4, decay: 1.4, ...grp });
        break;
      case "fan":
        sy.clack(out, when, 0.8 * vel, { ...grp, pitch: 0.6 + 0.1 * e.k });
        sy.low(out, when, 0.55 * vel, tm.low, { ...grp, size: 0.55 });
        break;
      case "wall":
        sy.low(out, when, vel, tm.low, { ...grp, flam: true, prio: 1 });
        sy.clack(out, when, 0.6 * vel, { ...grp, pitch: 0.15 });
        if (heavy) sy.boom(out, when, 0.6 * vel);
        break;
      case "rain":
        sy.frame(out, when, 0.8 * vel, tm.frame, grp);
        sy.clack(out, when, 0.4 * vel, { ...grp, pitch: 0.9 });
        break;
      case "wave":
        sy.frame(out, when, 0.85 * vel, tm.frame, grp);
        sy.air(out, when, 0.35, 900, 260, 0.22 * vel, { pan, q: 1.2, attack: 0.02, group: "impact" });
        break;
      case "curve":
        sy.frame(out, when, 0.85 * vel, tm.frame, grp);
        sy.pluck(out, when, m(chord + 4, 2), 0.45 * vel, { decay: 0.8, ...grp });
        break;
      case "bloom":
        // the seed leaves the body: a soft launch; the burst comes later
        sy.air(out, when, 0.4, 260, 1400, 0.25 * vel, { pan, q: 1.5, attack: 0.05, group: "impact" });
        sy.clack(out, when, 0.35 * vel, { ...grp, pitch: 0.4 });
        break;
      case "beam":
        sy.low(out, when, vel, tm.low, { ...grp, prio: 1 });
        break;
      case "slam":
        sy.low(out, when, Math.min(1, vel), tm.low, { ...grp, flam: true, size: 1.15, prio: 1 });
        sy.boom(out, when, 0.8 * vel, { decay: 1.2 });
        sy.air(out, when, 0.7, 2600, 380, 0.4 * vel, { pan, q: 0.6, attack: 0.004, group: "impact", prio: 1 });
        break;
      case "glyph":
        sy.bell(out, when, m(chord, 2), 0.6 * vel, { partials: 6, decay: 3, ...grp, prio: 1 });
        sy.frame(out, when, 0.7 * vel, tm.frame, grp);
        break;
      case "cross":
        sy.clack(out, when, 0.7 * vel, { ...grp, pitch: 0.45 });
        sy.frame(out, when, 0.75 * vel, tm.frame, grp);
        break;
    }
  }

  // =========================================================================== lifecycle

  private watchVisibility() {
    if (typeof document === "undefined" || this.visHandler) return;
    this.visHandler = () => {
      const ctx = this.ctx as AudioContext | null;
      if (!ctx || !this.g) return;
      const now = ctx.currentTime;
      if (document.hidden) {
        // fade out, then sleep the context to save the battery; resync on return
        this.g.master.gain.setTargetAtTime(0, now, 0.04);
        setTimeout(() => {
          if (document.hidden && ctx.state === "running") void ctx.suspend();
        }, 250);
      } else {
        this.synced = false;
        void ctx.resume().then(() => this.applyVolumes());
      }
    };
    document.addEventListener("visibilitychange", this.visHandler);
  }
}

export type { Stage };

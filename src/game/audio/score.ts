// The titan's Canticle: a deterministic score generated from its seed.
// Pure data, no Web Audio here. The engine turns it into sound on the beat.

import { rngFor, Rng } from "../../core/rng";
import { Archetype, LOOP_PHRASES, PHRASE_BEATS, Stage, TitanSpec } from "../../core/titan";
import type { Field, Kind, Volley } from "../../core/field";

export const STEPS_PER_BEAT = 4; // sixteenth notes
export const STEPS_PER_BAR = 16;
export const PHRASE_STEPS = PHRASE_BEATS * STEPS_PER_BEAT; // 256
export const BLOCK_STEPS = 64; // one chord = 4 bars

export const MODES: Record<TitanSpec["mode"], number[]> = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/** Modal progressions: chord-root scale degrees, one chord per 4 bars. */
const PROGRESSIONS: Record<TitanSpec["mode"], number[][]> = {
  aeolian: [[0, 5, 6, 0], [0, 3, 6, 2], [0, 5, 3, 4], [0, 6, 5, 6], [0, 2, 5, 4], [0, 3, 0, 6]],
  dorian: [[0, 3, 0, 6], [0, 3, 6, 0], [0, 2, 3, 0], [0, 6, 3, 4], [0, 1, 0, 3]],
  phrygian: [[0, 1, 0, 6], [0, 1, 6, 0], [0, 5, 1, 0], [0, 6, 1, 1], [0, 3, 1, 0]],
  lydian: [[0, 1, 0, 4], [0, 1, 6, 0], [0, 4, 1, 0], [0, 5, 1, 4]],
  mixolydian: [[0, 6, 3, 0], [0, 6, 0, 3], [0, 3, 6, 0], [0, 4, 6, 0]],
};

export type Lead = "psaltery" | "reed" | "glass" | "organ" | "bell";

/** The voice of an archetype: what its choir sings, what plays its melody, how its drums speak. */
export interface Timbre {
  vowel: [number, number, number]; // choir formants (Hz)
  choir: number; // choir level
  bourdon: number; // tonic drone level (organ / hurdy-gurdy bourdon)
  buzz: number; // hurdy-gurdy trompette buzz in Wrath and Ruin
  lead: Lead; // melody instrument
  lead2: Lead; // doubles the melody from Wrath on
  low: { f0: number; f1: number; decay: number }; // big drum (taiko / tapan) pitch sweep
  frame: { f: number; decay: number }; // frame drum
  swing: number; // 0..0.2 of a sixteenth, odd sixteenths only (ghost notes)
  bellBias: number; // how often bells join
  rhythmCells: number[]; // which motif rhythms suit the beast
}

export const TIMBRES: Record<Archetype, Timbre> = {
  // a serpent: nasal shawm over a buzzing hurdy-gurdy, sinuous dotted rhythms
  coil: { vowel: [570, 840, 2410], choir: 0.9, bourdon: 1, buzz: 0.75, lead: "reed", lead2: "psaltery", low: { f0: 74, f1: 44, decay: 0.75 }, frame: { f: 190, decay: 0.22 }, swing: 0.12, bellBias: 0.4, rhythmCells: [0, 3, 5] },
  // a colossus that walks: deep "oo" choir, giant taiko footfalls, low organ
  strider: { vowel: [310, 870, 2240], choir: 1, bourdon: 0.9, buzz: 0.3, lead: "psaltery", lead2: "organ", low: { f0: 62, f1: 36, decay: 1.05 }, frame: { f: 150, decay: 0.26 }, swing: 0, bellBias: 0.5, rhythmCells: [2, 4, 1] },
  // a drifting crown: bowed glass, psaltery and bells, light hand drums
  bloom: { vowel: [400, 1900, 2600], choir: 0.8, bourdon: 0.6, buzz: 0, lead: "glass", lead2: "psaltery", low: { f0: 86, f1: 52, decay: 0.6 }, frame: { f: 230, decay: 0.18 }, swing: 0.08, bellBias: 1, rhythmCells: [3, 1, 5] },
  // a seated king: "ah" choir, organ, carillon, processional timpani
  throne: { vowel: [730, 1090, 2440], choir: 1, bourdon: 1, buzz: 0.15, lead: "psaltery", lead2: "bell", low: { f0: 70, f1: 46, decay: 0.9 }, frame: { f: 170, decay: 0.24 }, swing: 0, bellBias: 0.9, rhythmCells: [4, 2, 0] },
  // a hollow heart orbited by a thousand things: buzzing reeds, jingles, restless sixteenths
  swarmheart: { vowel: [530, 1840, 2480], choir: 0.85, bourdon: 0.8, buzz: 0.9, lead: "reed", lead2: "psaltery", low: { f0: 80, f1: 50, decay: 0.55 }, frame: { f: 210, decay: 0.17 }, swing: 0.05, bellBias: 0.5, rhythmCells: [1, 3, 5] },
};

// --- percussion -------------------------------------------------------------------------------
// One bar = 16 sixteenths. X = accent (1), x = normal (0.72), o = ghost (0.4), - = rest.

export type PercVoice = "low" | "frame" | "clack" | "jingle";
export const PERC_VOICES: PercVoice[] = ["low", "frame", "clack", "jingle"];

type StagePats = [string, string, string]; // Calm, Wrath, Ruin
const TEMPLATES: Record<Archetype, Record<PercVoice, StagePats>> = {
  coil: {
    low: ["X---------------", "X-----x-----x---", "X-----x-----x-x-"],
    frame: ["--------x-------", "----x-------x--o", "--o-x--o--x-x--x"],
    clack: ["----------------", "------x-------x-", "--x---x---x---x-"],
    jingle: ["----------------", "o-o-o-o-o-o-o-o-", "oxo-oxo-oxo-oxo-"],
  },
  strider: {
    low: ["X-------X-------", "X---x---X---x---", "X--xX---X--xX-x-"],
    frame: ["----------------", "----x-------x---", "----X--o----X-oo"],
    clack: ["----------------", "--x---x---x---x-", "--x-x-x---x-x-x-"],
    jingle: ["----------------", "----------------", "o---o---o---o---"],
  },
  bloom: {
    low: ["X---------------", "X-------x-------", "X-----x-X-----x-"],
    frame: ["x--o--x---x-----", "x--o--x---x--o--", "x-ox-ox-x-x-oxo-"],
    clack: ["----------------", "----------x-----", "----x-------x---"],
    jingle: ["--------o-------", "--o---o---o---o-", "-o-x-o-x-o-x-o-x"],
  },
  throne: {
    low: ["X-------x-------", "X-------x-----x-", "X-----x-X---x-x-"],
    frame: ["----------------", "----x-------x---", "----X---o---X-o-"],
    clack: ["----------------", "x---------------", "x-----x---x-----"],
    jingle: ["----------------", "--------o-------", "--o---o---o---o-"],
  },
  swarmheart: {
    low: ["X-------------x-", "X--x---xX--x----", "X--x-x-xX--x-x-x"],
    frame: ["----x-------x---", "----x--o----x-o-", "-o-ox-o--o-ox-ox"],
    clack: ["----------------", "-x---x---x---x--", "-xx--x-x-xx--x-x"],
    jingle: ["o-o-o-o-o-o-o-o-", "oooxoooxoooxooox", "xoxoxoxoxoxoxoxo"],
  },
};

const FILLS: Record<PercVoice, string> = {
  low: "X-------x--x-xx-",
  frame: "----x-o-xoxoxxXX",
  clack: "--x---x-x-x-xxxx",
  jingle: "o-o-o-o-oooooooo",
};

function parsePat(s: string): Float32Array {
  const a = new Float32Array(16);
  for (let i = 0; i < 16; i++) a[i] = s[i] === "X" ? 1 : s[i] === "x" ? 0.72 : s[i] === "o" ? 0.4 : 0;
  return a;
}

// --- melody -----------------------------------------------------------------------------------

/** Rhythm cells for a 2-bar motif: [onset, duration] in sixteenths, within 32 steps. */
const CELLS: Array<Array<[number, number]>> = [
  [[0, 6], [6, 2], [8, 4], [12, 4], [16, 8], [24, 8]], // 0 dotted
  [[0, 4], [4, 4], [8, 8], [16, 4], [20, 2], [22, 2], [24, 8]], // 1 walking
  [[0, 8], [8, 4], [12, 4], [16, 12], [28, 4]], // 2 chant
  [[0, 2], [2, 2], [4, 4], [8, 8], [16, 6], [22, 2], [24, 8]], // 3 ornamented
  [[0, 12], [12, 4], [16, 4], [20, 4], [24, 8]], // 4 processional
  [[0, 3], [3, 3], [6, 2], [8, 8], [16, 3], [19, 3], [22, 2], [24, 8]], // 5 tresillo
];

export interface MotifNote {
  at: number; // sixteenth within the motif
  dur: number; // sixteenths
  deg: number; // scale degrees above the chord root
  vel: number;
}

export interface MelNote {
  step: number; // sixteenth within the phrase (0..255)
  dur: number;
  deg: number; // absolute scale degree (0 = tonic in the melody octave)
  vel: number;
  bell: boolean; // carried by bells rather than the lead
  counter: boolean; // a countermelody voice
}

export interface Song {
  spec: TitanSpec;
  scale: number[];
  root: number; // MIDI tonic (octave 2)
  timbre: Timbre;
  progs: number[][]; // per phrase of the Canticle: 4 chord-root degrees
  motif: MotifNote[];
  answer: MotifNote[];
  perc: Record<PercVoice, [Float32Array, Float32Array, Float32Array]>;
  fills: Record<PercVoice, Float32Array>;
  bass: [Float32Array, Float32Array, Float32Array]; // per stage, bar pattern (0 = rest, else velocity)
  melody: MelNote[][]; // per phrase
  melodyAt: Array<Map<number, MelNote[]>>;
  /** how hard each phrase of the Canticle pushes (0 overture .. 7 crescendo) */
  phraseDrive: number[];
}

export function degToMidi(song: Song, deg: number, octave: number): number {
  const n = song.scale.length;
  const o = Math.floor(deg / n);
  const i = deg - o * n;
  return song.root + 12 * (octave + o) + song.scale[i];
}

function makeMotif(r: Rng, cell: Array<[number, number]>, endOnRoot: boolean): MotifNote[] {
  const out: MotifNote[] = [];
  let deg = r.pick([0, 2, 4, 4, 2]);
  for (let i = 0; i < cell.length; i++) {
    const [at, dur] = cell[i];
    if (i > 0) {
      const step = r.weighted([-2, -1, 1, 2, 3, -3, 4], [1.2, 3, 3, 1.4, 0.6, 0.5, 0.3]);
      deg = Math.max(-2, Math.min(7, deg + step));
    }
    if (i === cell.length - 1) deg = endOnRoot ? r.pick([0, 0, 4]) : r.pick([2, 4, 4, 1]);
    const vel = at % 8 === 0 ? 0.95 : at % 4 === 0 ? 0.8 : 0.62;
    out.push({ at, dur, deg, vel });
  }
  return out;
}

function transform(m: MotifNote[], kind: "plain" | "invert" | "retro" | "augment" | "diminish"): MotifNote[] {
  switch (kind) {
    case "plain":
      return m.map((n) => ({ ...n }));
    case "invert": {
      const a = m[0].deg;
      return m.map((n) => ({ ...n, deg: Math.max(-3, Math.min(8, a - (n.deg - a))) }));
    }
    case "retro": {
      const degs = m.map((n) => n.deg).reverse();
      return m.map((n, i) => ({ ...n, deg: degs[i] }));
    }
    case "augment":
      return m.map((n) => ({ ...n, at: n.at * 2, dur: n.dur * 2 }));
    case "diminish": {
      const half = m.map((n) => ({ ...n, at: Math.floor(n.at / 2), dur: Math.max(1, Math.floor(n.dur / 2)) }));
      return [...half, ...half.map((n) => ({ ...n, at: n.at + 16, deg: n.deg + 1 }))];
    }
  }
}

function place(out: MelNote[], m: MotifNote[], blockStart: number, offset: number, chordDeg: number, shift: number, opts: { bell?: boolean; counter?: boolean; velMul?: number; every?: number } = {}) {
  m.forEach((n, i) => {
    if (opts.every && i % opts.every !== 0) return;
    out.push({ step: blockStart + offset + n.at, dur: n.dur, deg: chordDeg + n.deg + shift, vel: n.vel * (opts.velMul ?? 1), bell: !!opts.bell, counter: !!opts.counter });
  });
}

/** The melody of one phrase: the motif develops across the Canticle. */
function phraseMelody(song: Song, phrase: number): MelNote[] {
  const out: MelNote[] = [];
  const prog = song.progs[phrase];
  const { motif, answer } = song;
  for (let b = 0; b < 4; b++) {
    const c = prog[b];
    const s = b * BLOCK_STEPS;
    switch (phrase) {
      case 0: // overture: silence, then the motif half-remembered on bells
        if (b === 2) place(out, transform(motif, "augment"), s, 0, c, 0, { bell: true, every: 2, velMul: 0.8 });
        if (b === 3) place(out, answer, s, 0, c, 0, { bell: true, velMul: 0.7 });
        break;
      case 1: // statement
        place(out, motif, s, 0, c, 0);
        if (b % 2 === 1) place(out, answer, s, 32, c, 0, { velMul: 0.85 });
        break;
      case 2: // inversion answers the motif
        place(out, motif, s, 0, c, 0);
        place(out, transform(motif, "invert"), s, 32, c, 0, { velMul: 0.85 });
        break;
      case 3: // retrograde, bells answer
        place(out, motif, s, 0, c, 0);
        place(out, transform(motif, "retro"), s, 32, c, 0, { bell: b % 2 === 1, velMul: 0.8 });
        break;
      case 4: // augmentation: the chant slows and broadens
        place(out, transform(motif, "augment"), s, 0, c, 0);
        break;
      case 5: // countermelody in thirds above
        place(out, motif, s, 0, c, 0);
        place(out, motif, s, 0, c, 2, { counter: true, velMul: 0.6 });
        place(out, answer, s, 32, c, 0, { velMul: 0.85 });
        break;
      case 6: // diminution: urgent, twice as fast
        place(out, transform(motif, "diminish"), s, 0, c, 0);
        place(out, answer, s, 32, c, 0);
        break;
      default: {
        // 7 crescendo: the motif an octave up, doubled, climbing by block
        const climb = b === 3 ? 2 : 0;
        place(out, motif, s, 0, c, 7 + climb, { velMul: 1 });
        place(out, motif, s, 0, c, 2 + climb, { counter: true, velMul: 0.55 });
        place(out, b === 3 ? transform(motif, "diminish") : answer, s, 32, c, b === 3 ? 9 : 7, { velMul: 0.95 });
      }
    }
  }
  out.sort((a, b) => a.step - b.step);
  return out.filter((n) => n.step < PHRASE_STEPS);
}

export function buildSong(spec: TitanSpec): Song {
  const r = rngFor("song", spec.seed);
  const timbre = TIMBRES[spec.archetype];
  const scale = MODES[spec.mode];
  const cands = PROGRESSIONS[spec.mode];
  const ia = r.int(0, cands.length - 1);
  let ib = r.int(0, cands.length - 1);
  if (ib === ia) ib = (ia + 1) % cands.length;
  const A = cands[ia];
  const B = cands[ib];
  // the Canticle's form: A A B A B A' B A''
  const A2 = [A[0], A[1], A[2], A[3] === 0 ? A[1] : A[3]];
  const progs = [A, A, B, A, B, A2, B, A];

  const cellIx = r.pick(timbre.rhythmCells);
  const motif = makeMotif(r, CELLS[cellIx], false);
  const ansCell = CELLS[r.pick(timbre.rhythmCells.filter((c) => c !== cellIx).concat([2]))];
  const answer = makeMotif(r, ansCell.filter(([at]) => at < 32), true);

  // percussion: archetype template, then a seed's own accents and ghosts
  const tpl = TEMPLATES[spec.archetype];
  const perc = {} as Song["perc"];
  for (const v of PERC_VOICES) {
    const st = tpl[v].map((p, stage) => {
      const a = parsePat(p);
      if (stage > 0 && v !== "low") {
        for (let i = 0; i < 16; i++) {
          if (a[i] === 0 && i % 2 === 1 && r.chance(0.1 + stage * 0.06)) a[i] = 0.35;
          else if (a[i] > 0 && i % 4 !== 0 && r.chance(0.08)) a[i] = 0;
        }
      }
      if (stage === 2 && v === "low" && r.chance(0.5)) a[r.pick([3, 7, 11, 15])] = 0.55;
      return a;
    }) as [Float32Array, Float32Array, Float32Array];
    perc[v] = st;
  }
  const fills = {} as Song["fills"];
  for (const v of PERC_VOICES) fills[v] = parsePat(FILLS[v]);

  // bass: Calm = pedal on the bar, Wrath = a walking figure, Ruin = driving eighths
  const bassCalm = parsePat("X---------------");
  const bassWrath = parsePat(r.pick(["X-----x-X-------", "X-------x---x---", "X--x----X--x----", "X-----x-----x---"]));
  const bassRuin = parsePat(r.pick(["X-x-x-x-X-x-x-x-", "X-xxX-x-X-xxX-x-", "X--xX-x-X--xX-xx"]));

  const song: Song = {
    spec,
    scale,
    root: spec.root,
    timbre,
    progs,
    motif,
    answer,
    perc,
    fills,
    bass: [bassCalm, bassWrath, bassRuin],
    melody: [],
    melodyAt: [],
    phraseDrive: [0.62, 0.82, 0.86, 0.9, 0.86, 0.95, 1.0, 1.12],
  };
  for (let p = 0; p < LOOP_PHRASES; p++) {
    const mel = phraseMelody(song, p);
    song.melody.push(mel);
    const at = new Map<number, MelNote[]>();
    for (const n of mel) {
      const l = at.get(n.step);
      if (l) l.push(n);
      else at.set(n.step, [n]);
    }
    song.melodyAt.push(at);
  }
  return song;
}

// --- the titan's attacks, as audio events ------------------------------------------------------

export type AEvType = "cue" | "swell" | "impact" | "echo" | "burst" | "tick" | "sustain";

export interface AEv {
  type: AEvType;
  v: Volley;
  x: number; // arena x for panning
  durBeats: number; // swells and sustains
  k: number; // sub-index (wave/row/echo)
  sig: boolean; // the Ruin signature attack
}

export function volleyX(v: Volley): number {
  const p = v.p;
  if (v.kind === "rain" || v.kind === "cross") return 0;
  return p.tx ?? p.cx ?? p.gapX ?? p.ox ?? 0;
}

/** Every sound the volleys of one phrase make, keyed by sixteenth within the phrase (may be <0 or >=256). */
export function volleyEvents(field: Field, phrase: number, stage: Stage): Map<number, AEv[]> {
  const plan = field.plan(phrase, stage);
  const out = new Map<number, AEv[]>();
  const add = (beat: number, e: AEv) => {
    const s = Math.round(beat * STEPS_PER_BEAT);
    const l = out.get(s);
    if (l) l.push(e);
    else out.set(s, [e]);
  };
  for (const v of plan.volleys) {
    const x = volleyX(v);
    const sig = stage === 2 && v.tele === 3;
    const base = { v, x, durBeats: 0, k: 0, sig };
    add(v.beat - 1, { ...base, type: "cue" });
    if (v.tele >= 2 && (v.heavy || sig)) add(v.beat - v.tele, { ...base, type: "swell", durBeats: v.tele });
    add(v.beat, { ...base, type: "impact" });
    const p = v.p;
    switch (v.kind as Kind) {
      case "ring":
        for (let e = 1; e < (p.echoes ?? 1); e++) add(v.beat + e * 2, { ...base, type: "echo", k: e });
        break;
      case "fan":
        for (let w = 1; w < p.waves; w++) add(v.beat + w * p.gap, { ...base, type: "echo", k: w });
        break;
      case "wall":
        for (let row = 1; row < p.rows; row++) add(v.beat + row * 2, { ...base, type: "echo", k: row, x: p.gapX + p.shift });
        break;
      case "slam":
        for (let k = 1; k < p.rings; k++) add(v.beat + k * 2, { ...base, type: "echo", k });
        break;
      case "cross":
        for (let row = 1; row < p.rows; row++) add(v.beat + row * p.every, { ...base, type: "echo", k: row, x: row % 2 ? 6 : -6 });
        break;
      case "rain": {
        const times = new Set<number>();
        for (let d = 0; d < p.drops; d++) {
          times.add(d * p.every);
          times.add(d * p.every + 0.5);
        }
        let k = 0;
        for (const dt of [...times].sort((a, b) => a - b)) if (dt > 0) add(v.beat + dt, { ...base, type: "tick", k: k++, x: ((k * 5) % 13) - 6 });
        break;
      }
      case "bloom":
        add(v.beat + p.travel, { ...base, type: "burst" });
        break;
      case "beam":
      case "spiral":
        add(v.beat, { ...base, type: "sustain", durBeats: p.dur });
        break;
      case "glyph":
        add(v.beat, { ...base, type: "sustain", durBeats: p.dur });
        break;
    }
  }
  return out;
}

export { PHRASE_BEATS, LOOP_PHRASES };

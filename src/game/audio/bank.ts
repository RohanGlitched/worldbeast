// The sample bank: struck instruments rendered once, offline, by the live synth voices themselves.
// Nothing is loaded from disk; it is the same synthesis, captured so it can be replayed cheaply.

import type { Timbre } from "./score";
import { BANK_BELL_DECAY, BANK_PLUCK_DECAY, BELL_REFS, BOOM_DECAY, BOOM_F, PLUCK_REFS, Synth, TICK_REFS } from "./synth";

interface Item {
  name: string;
  dur: number;
  draw: (sy: Synth, dest: AudioNode, t: number) => void;
}

/** Instruments every titan shares: bells, psaltery, clacks, jingles, ticks, the sub. */
export function commonItems(): Item[] {
  const items: Item[] = [];
  for (const m of BELL_REFS) items.push({ name: "bell" + m, dur: BANK_BELL_DECAY * 1.35, draw: (sy, d, t) => sy.bell(d, t, m, 1, { partials: 8, decay: BANK_BELL_DECAY, prio: 1 }) });
  for (const m of PLUCK_REFS) items.push({ name: "pluck" + m, dur: BANK_PLUCK_DECAY * Math.min(1.6, Math.max(0.5, 1.6 - (m - 60) / 40)), draw: (sy, d, t) => sy.pluck(d, t, m, 1, { decay: BANK_PLUCK_DECAY, bright: 0.65, prio: 1 }) });
  for (const m of TICK_REFS) items.push({ name: "tick" + m, dur: 0.36, draw: (sy, d, t) => sy.tick(d, t, m, 1) });
  items.push({ name: "clack", dur: 0.08, draw: (sy, d, t) => sy.clack(d, t, 1, { pitch: 0.4, prio: 1 }) });
  items.push({ name: "jingleHi", dur: 0.34, draw: (sy, d, t) => sy.jingle(d, t, 1) });
  items.push({ name: "jingleLo", dur: 0.18, draw: (sy, d, t) => sy.jingle(d, t, 0.5) });
  items.push({ name: "jingleLong", dur: 1.3, draw: (sy, d, t) => sy.jingle(d, t, 1, { long: true }) });
  items.push({ name: "boom", dur: BOOM_DECAY + 0.05, draw: (sy, d, t) => sy.boom(d, t, 1, { f: BOOM_F, decay: BOOM_DECAY }) });
  return items;
}

/** Drums tuned to one titan's archetype. */
export function titanItems(tm: Timbre): Item[] {
  return [
    { name: "low", dur: tm.low.decay + 0.05, draw: (sy, d, t) => sy.low(d, t, 1, tm.low, { prio: 1 }) },
    { name: "lowFlam", dur: tm.low.decay + 0.07, draw: (sy, d, t) => sy.low(d, t, 1, tm.low, { flam: true, prio: 1 }) },
    { name: "frame", dur: Math.max(tm.frame.decay, 0.14) + 0.03, draw: (sy, d, t) => sy.frame(d, t, 1, tm.frame, { prio: 1 }) },
    { name: "frameGhost", dur: Math.max(tm.frame.decay, 0.14) + 0.03, draw: (sy, d, t) => sy.frame(d, t, 0.4, tm.frame, { prio: 1 }) },
  ];
}

/** Render items back to back on one mono OfflineAudioContext and slice them into buffers. */
export async function renderBank(sampleRate: number, items: Item[]): Promise<Map<string, AudioBuffer>> {
  const gap = 0.05;
  const at: number[] = [];
  let total = 0.01;
  for (const it of items) {
    at.push(total);
    total += it.dur + gap;
  }
  const off = new OfflineAudioContext(1, Math.ceil(total * sampleRate), sampleRate);
  const sy = new Synth(off);
  items.forEach((it, i) => it.draw(sy, off.destination, at[i]));
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  const out = new Map<string, AudioBuffer>();
  const fade = Math.floor(sampleRate * 0.006);
  items.forEach((it, i) => {
    const s0 = Math.round(at[i] * sampleRate);
    const n = Math.round(it.dur * sampleRate);
    const b = off.createBuffer(1, n, sampleRate);
    const ch = b.getChannelData(0);
    ch.set(data.subarray(s0, s0 + n));
    for (let k = 0; k < fade; k++) ch[n - 1 - k] *= k / fade; // no click at the cut
    out.set(it.name, b);
  });
  return out;
}

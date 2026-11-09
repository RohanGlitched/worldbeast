// Audition bench for the titan's Canticle. Runs its own clock; no game, no network.

import { Field } from "../../core/field";
import { ARCHETYPES, ARCHETYPE_INFO, Archetype, LOOP_PHRASES, makeTitan, PHRASE_BEATS, Stage, STAGE_NAMES, TitanSpec } from "../../core/titan";
import { AudioEngine } from "./AudioEngine";
import { volleyEvents } from "./score";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NOTE = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const engine = new AudioEngine({ debug: true });
let spec: TitanSpec = makeTitan(1, 1);
let field = new Field(spec);
let stage: Stage = 0;
let playing = true;
let danger = 0;
let running = false;
let muted = false;
let quiet = false;
// the local clock: titan time = base + (performance.now() - perf0) / 1000
let base = 0;
let perf0 = performance.now();
const now = () => (running ? base + (performance.now() - perf0) / 1000 : base);

function setSeed(seed: number) {
  const t = now();
  spec = makeTitan(seed >>> 0, 1);
  field = new Field(spec);
  engine.setTitan(spec, field);
  ($("seed") as HTMLInputElement).value = String(seed >>> 0);
  // keep the same phrase position under the new tempo
  const beat = t / (spec.beat || 0.5);
  base = Math.max(0, beat) * spec.beat;
  perf0 = performance.now();
  renderDossier();
}

function jump(phrase: number) {
  base = phrase * PHRASE_BEATS * spec.beat - 0.05;
  if (base < 0) base = 0;
  perf0 = performance.now();
}

async function start() {
  await engine.unlock();
  if (!running) {
    running = true;
    perf0 = performance.now();
  }
  engine.mute(muted);
  engine.setTitan(spec, field);
  $("go").textContent = "Halt";
  $("go").classList.add("on");
}

function stop() {
  if (running) base = now();
  running = false;
  engine.mute(true);
  $("go").textContent = "Begin";
  $("go").classList.remove("on");
}

function renderDossier() {
  const arch = spec.archetype;
  const rootName = NOTE[spec.root % 12] + (Math.floor(spec.root / 12) - 1);
  $("dossier").innerHTML = `<b>${spec.name}</b> <span class="ep">${spec.epithet}</span>
    <div class="kv">
      <span>Archetype</span><span>${ARCHETYPE_INFO[arch].label}: ${ARCHETYPE_INFO[arch].blurb}</span>
      <span>Song</span><span>${spec.bpm} BPM, ${rootName} ${spec.mode}</span>
      <span>Temper</span><span>aggression ${spec.temperament.aggression.toFixed(2)}, trickery ${spec.temperament.trickery.toFixed(2)}</span>
      <span>Cores</span><span>${spec.cores.length}</span>
    </div>`;
  document.querySelectorAll("#archRow button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.a === arch));
}

function seedFor(arch: Archetype, from: number) {
  for (let s = from + 1; s < from + 5000; s++) if (makeTitan(s, 1).archetype === arch) return s;
  return from;
}

// --- controls
for (const a of ARCHETYPES) {
  const b = document.createElement("button");
  b.textContent = ARCHETYPE_INFO[a].label;
  b.dataset.a = a;
  b.onclick = () => setSeed(seedFor(a, spec.seed));
  $("archRow").appendChild(b);
}
for (let s = 0 as Stage; s <= 2; s = (s + 1) as Stage) {
  const b = document.createElement("button");
  b.textContent = STAGE_NAMES[s];
  b.dataset.s = String(s);
  b.onclick = () => {
    stage = Number(b.dataset.s) as Stage;
    document.querySelectorAll("#stageRow button").forEach((x) => x.classList.toggle("on", x === b));
  };
  if (s === 0) b.classList.add("on");
  $("stageRow").appendChild(b);
}
for (let p = 0; p < LOOP_PHRASES; p++) {
  const b = document.createElement("button");
  b.textContent = p === 0 ? "I overture" : p === 7 ? "VIII crescendo" : ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"][p];
  b.onclick = () => jump(p);
  $("phraseRow").appendChild(b);
}
const SFX = ["start", "dash", "graze", "strike", "hurt", "surge", "down", "core-open", "felled", "wake", "revive", "ui", "ui-hover"];
for (const n of SFX) {
  const b = document.createElement("button");
  b.textContent = n;
  b.onclick = async () => {
    await engine.unlock();
    engine.sfx(n, (Math.random() - 0.5) * 12, n === "graze" ? 1 : Math.random());
  };
  if (n === "ui-hover") b.onmouseenter = () => engine.sfx("ui-hover");
  $("sfxRow").appendChild(b);
}
$("go").onclick = () => (running ? stop() : void start());
$("run").onclick = () => {
  playing = !playing;
  $("run").classList.toggle("on", playing);
  $("run").textContent = playing ? "In a run" : "In the lobby";
};
$("mute").onclick = () => {
  muted = !muted;
  engine.mute(muted || !running);
  $("mute").classList.toggle("on", muted);
};
$("quiet").onclick = () => {
  quiet = !quiet;
  engine.setQuiet(quiet);
  $("quiet").classList.toggle("on", quiet);
};
($("danger") as HTMLInputElement).oninput = (e) => (danger = Number((e.target as HTMLInputElement).value));
const vols = () => engine.setVolume(Number(($("vMaster") as HTMLInputElement).value), Number(($("vMusic") as HTMLInputElement).value), Number(($("vSfx") as HTMLInputElement).value));
["vMaster", "vMusic", "vSfx"].forEach((id) => (($(id) as HTMLInputElement).oninput = vols));
($("seed") as HTMLInputElement).onchange = (e) => setSeed(Number((e.target as HTMLInputElement).value) || 1);
$("seedPrev").onclick = () => setSeed(Math.max(1, spec.seed - 1));
$("seedNext").onclick = () => setSeed(spec.seed + 1);
$("seedRand").onclick = () => setSeed(1 + Math.floor(Math.random() * 1e6));
$("grazeRun").onclick = async () => {
  await engine.unlock();
  for (let i = 0; i < 20; i++) setTimeout(() => engine.sfx("graze", -6 + i * 0.6, 1), i * 90);
};
$("render").onclick = async () => {
  const buf = await renderExcerpt(spec.seed, stage, Math.floor(now() / spec.beat / PHRASE_BEATS) % LOOP_PHRASES, 16);
  const blob = new Blob([encodeWav(buf)], { type: "audio/wav" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `canticle-${spec.seed}-stage${stage}.wav`;
  a.click();
};

// --- frame loop
const tl = $("tl") as HTMLCanvasElement;
const g2 = tl.getContext("2d")!;
let notesAt = 0;
let notesPrev = 0;
let lastStat = performance.now();
let rate = 0;

function frame() {
  requestAnimationFrame(frame);
  const t = now();
  if (running) engine.update(t, stage, [0.9, 0.5, 0.2][stage], { playing, nearDanger: danger });
  drawTimeline(t);
  const pn = performance.now();
  if (pn - lastStat > 500) {
    const st = engine.stats();
    notesAt = st.notes;
    rate = ((notesAt - notesPrev) * 1000) / (pn - lastStat);
    notesPrev = notesAt;
    lastStat = pn;
    const beat = t / spec.beat;
    $("stats").textContent =
      `t ${t.toFixed(2)} s   beat ${Math.floor(beat)}   phrase ${Math.floor(beat / PHRASE_BEATS) % LOOP_PHRASES}   ${STAGE_NAMES[stage]}\n` +
      `notes/s ${rate.toFixed(1)}   voices ${st.voices} (peak ${st.peakVoices})   live nodes ${st.live} + ${st.persistent}\n` +
      `offset ${(st.offset * 1000).toFixed(1)} ms   raw-smoothed ${((st.rawOffset - st.offset) * 1000).toFixed(2)} ms   resyncs ${st.resyncs}   late ${st.late}   dropped ${st.dropped}   ${st.state}`;
  }
}

function drawTimeline(t: number) {
  const W = tl.width;
  const H = tl.height;
  g2.clearRect(0, 0, W, H);
  const beatNow = t / spec.beat;
  const span = 8;
  const x = (b: number) => ((b - beatNow + 1) / (span + 1)) * W;
  // beat lines
  for (let b = Math.ceil(beatNow - 1); b <= beatNow + span; b++) {
    g2.strokeStyle = b % 4 === 0 ? "#8a7454" : "#d4c29c";
    g2.lineWidth = b % 4 === 0 ? 1.5 : 1;
    g2.beginPath();
    g2.moveTo(x(b), 10);
    g2.lineTo(x(b), H - 10);
    g2.stroke();
  }
  const pa = Math.floor(beatNow / PHRASE_BEATS);
  for (const p of [pa, pa + 1]) {
    const ev = volleyEvents(field, p % LOOP_PHRASES, stage);
    for (const [step, list] of ev) {
      const b = p * PHRASE_BEATS + step / 4;
      if (b < beatNow - 1 || b > beatNow + span) continue;
      for (const e of list) {
        const lane = 20 + ((e.v.id % 7) * (H - 50)) / 7;
        if (e.type === "cue") {
          g2.fillStyle = "#c8321f";
          g2.fillRect(x(b) - 1.5, lane, 3, 16);
        } else if (e.type === "impact") {
          g2.fillStyle = e.v.heavy ? "#c99a2e" : "#231c17";
          g2.fillRect(x(b) - 3, lane, 6, 22);
          g2.font = "13px EB Garamond, serif";
          g2.fillText(e.v.kind, x(b) + 6, lane + 15);
        } else if (e.type === "swell") {
          g2.fillStyle = "rgba(43,74,139,0.25)";
          g2.fillRect(x(b), lane + 4, x(b + e.durBeats) - x(b), 12);
        }
      }
    }
  }
  // the now line
  g2.strokeStyle = "#2b4a8b";
  g2.lineWidth = 2;
  g2.beginPath();
  g2.moveTo(x(beatNow), 4);
  g2.lineTo(x(beatNow), H - 4);
  g2.stroke();
}

// --- offline rendering, also used by the automated tests
async function renderExcerpt(seed: number, st: Stage, phrase: number, seconds: number, sfx?: Array<{ at: number; name: string; x?: number; strength?: number }>, diag: { solo?: string[]; dry?: boolean; quiet?: boolean; lite?: boolean; playing?: boolean; strip?: Array<"drone" | "notes" | "verb"> } = {}) {
  const s = makeTitan(seed, 1);
  const f = new Field(s);
  return AudioEngine.renderExcerpt(s, f, { t0: phrase * PHRASE_BEATS * s.beat, seconds, stage: st, sfx, ...diag });
}

function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(out);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * ch * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  return out;
}

/** Float32 stereo of a render, base64 encoded (little endian, L then R planes). For tests. */
async function renderFloat(seed: number, st: Stage, phrase: number, seconds: number, sfx?: Array<{ at: number; name: string; x?: number; strength?: number }>, diag: { solo?: string[]; dry?: boolean; quiet?: boolean; lite?: boolean; playing?: boolean; strip?: Array<"drone" | "notes" | "verb"> } = {}) {
  const buf = await renderExcerpt(seed, st, phrase, seconds, sfx, diag);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const all = new Float32Array(L.length * 2);
  all.set(L, 0);
  all.set(R, L.length);
  const bytes = new Uint8Array(all.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const s2 = makeTitan(seed, 1);
  return { timing: AudioEngine.lastRender, b64: btoa(s), sampleRate: buf.sampleRate, length: buf.length, beat: s2.beat, bpm: s2.bpm, archetype: s2.archetype, mode: s2.mode, root: s2.root, t0: phrase * PHRASE_BEATS * s2.beat };
}

(window as any).__wb = {
  engine,
  start,
  stop,
  jump,
  setSeed,
  setStage: (s: Stage) => (stage = s),
  setPlaying: (p: boolean) => (playing = p),
  now,
  clock: () => ({ base, perf0, running }),
  renderFloat,
  spec: () => spec,
};

setSeed(1);
frame();

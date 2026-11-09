// Ghost links: a run packed into a URL (titan seed, the moment it began, the 10 Hz path). Because the fight
// is a pure function of seed and time, anyone opening the link watches the very same attacks the hunter faced.

import { encodePath, decodePath } from "@/net/pathcodec";

const MAX_SAMPLES = 900; // 90 s

export function packReplay({ seed, number, stage, startT, damage, sigil, name, aspect, path }) {
  if (!path || path.length < 20) return null;
  const p = encodePath(path.slice(0, MAX_SAMPLES * 2), MAX_SAMPLES);
  return [seed >>> 0, number | 0, stage | 0, Math.round(startT * 100), Math.round(damage), sigil | 0, aspect || "ember", encodeURIComponent((name || "A hunter").slice(0, 18)), p].join("~");
}

export function unpackReplay(s) {
  try {
    const parts = s.split("~");
    if (parts.length !== 9) return null;
    const [seed, number, stage, startT, damage, sigil, aspect, name, p] = parts;
    const path = decodePath(p, MAX_SAMPLES);
    if (!path || path.length < 4) return null;
    const r = {
      seed: Number(seed) >>> 0,
      number: Number(number) | 0,
      stage: Math.max(0, Math.min(2, Number(stage) | 0)),
      startT: Number(startT) / 100,
      damage: Math.max(0, Number(damage) | 0),
      sigil: Number(sigil) & 15,
      aspect: /^[a-z]{3,8}$/.test(aspect) ? aspect : "ember",
      name: decodeURIComponent(name).slice(0, 18),
      path,
    };
    if (!Number.isFinite(r.startT) || r.startT < 0) return null;
    r.duration = path.length / 2 / 10;
    return r;
  } catch {
    return null;
  }
}

export function replayUrl(r) {
  const packed = packReplay(r);
  return packed ? `${location.origin}/?replay=${packed}` : null;
}

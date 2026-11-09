// Echo paths: 10 Hz samples of (x*20, y*20) integers, packed as int16 start + int8 deltas, then
// base64url. A delta too large for int8 is written as an escape byte (-128) + absolute int16 x, y.
// Shared verbatim with the world actor (no imports, no DOM, no btoa).

export const PATH_HZ = 10;
export const PATH_MAX_SAMPLES = 1800; // 3 minutes
const VERSION = 1;
const ESC = -128;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_REV: Record<string, number> = {};
for (let i = 0; i < 64; i++) B64_REV[B64[i]] = i;

function toB64(bytes: number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (b !== undefined) s += B64[(n >> 6) & 63];
    if (c !== undefined) s += B64[n & 63];
  }
  return s;
}

function fromB64(s: string): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    if (chunk.length === 1) return null;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const v = k < chunk.length ? B64_REV[chunk[k]] : 0;
      if (v === undefined) return null;
      n = (n << 6) | v;
    }
    out.push((n >> 16) & 255);
    if (chunk.length > 2) out.push((n >> 8) & 255);
    if (chunk.length > 3) out.push(n & 255);
  }
  return out;
}

const i16 = (out: number[], v: number) => {
  const u = v & 0xffff;
  out.push(u & 255, u >> 8);
};
const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

/** flat [x0, y0, x1, y1, ...] quantised ints -> compact string ("" for an empty path) */
export function encodePath(flat: ArrayLike<number>, maxSamples = PATH_MAX_SAMPLES): string {
  const n = Math.min(Math.floor(flat.length / 2), maxSamples);
  if (n === 0) return "";
  const out: number[] = [VERSION];
  let px = clampI16(flat[0]), py = clampI16(flat[1]);
  i16(out, px);
  i16(out, py);
  for (let i = 1; i < n; i++) {
    const x = clampI16(flat[i * 2]), y = clampI16(flat[i * 2 + 1]);
    const dx = x - px, dy = y - py;
    if (dx > ESC && dx <= 127 && dy >= -127 && dy <= 127) {
      out.push(dx & 255, dy & 255);
    } else {
      out.push(ESC & 255);
      i16(out, x);
      i16(out, y);
    }
    px = x;
    py = y;
  }
  return toB64(out);
}

/** compact string -> flat quantised ints, or null when malformed */
export function decodePath(s: string, maxSamples = PATH_MAX_SAMPLES): number[] | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const b = fromB64(s);
  if (!b || b.length < 5 || b[0] !== VERSION) return null;
  const s8 = (v: number) => (v > 127 ? v - 256 : v);
  const r16 = (i: number) => {
    const u = b[i] | (b[i + 1] << 8);
    return u > 32767 ? u - 65536 : u;
  };
  let x = r16(1), y = r16(3);
  const out = [x, y];
  let i = 5;
  while (i < b.length) {
    if (out.length / 2 >= maxSamples) return null;
    if (s8(b[i]) === ESC) {
      if (i + 5 > b.length) return null;
      x = r16(i + 1);
      y = r16(i + 3);
      i += 5;
    } else {
      if (i + 2 > b.length) return null;
      x += s8(b[i]);
      y += s8(b[i + 1]);
      i += 2;
    }
    out.push(x, y);
  }
  return out;
}

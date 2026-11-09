import * as THREE from "three";
import { makeTitan } from "@/core/titan";
import { Titan } from "./render/titan/titan";

// Engraved portraits (the cover medallion, the Hall of Titans, share cards), cached as data URLs.
//
// While the hunt is open, portraits are drawn by the game's own renderer: its titan programs are already
// linked, and the titan awake now is already built, so the medallion costs a render and a read-back
// instead of a second WebGL context compiling every program again (that froze the cover for ~0.8 s).
// Pages without the game (the Hall, How it works) fall back to one shared offscreen renderer.

let renderer: THREE.WebGLRenderer | null = null;
const cache = new Map<string, string>();

export interface PortraitHost {
  renderer: THREE.WebGLRenderer;
  /** resolves when the host's titan programs are linked */
  ready(): Promise<void>;
  /** the titan already built for this seed, if any */
  titanFor(seed: number): Titan | null;
}
let host: PortraitHost | null = null;
export function setPortraitHost(h: PortraitHost | null) {
  host = h;
}

type Opts = { crack?: number; w?: number; h?: number };
const keyOf = (seed: number, number: number, o: Opts) => `${seed}:${number}:${o.crack ?? 0}:${o.w ?? 360}x${o.h ?? 300}`;

function frame(w: number, h: number) {
  const aspect = w / h;
  const halfH = 9.2,
    halfW = halfH * aspect;
  const cy = 26.2;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, cy + halfH, cy - halfH, -200, 200);
  cam.position.set(0, 0, 50);
  return { cam, px: (halfW * 2) / w };
}

function pose(titan: Titan, seed: number, crack: number) {
  const spec = titan.spec;
  titan.update(
    {
      t: 3.3 + (seed % 7),
      beat: 7.5,
      player: { x: 0, y: 6 },
      cues: [],
      stage: crack > 0.66 ? 2 : crack > 0.33 ? 1 : 0,
      crack,
      hurt: 0,
      coreOpen: spec.cores.map((_, i) => i % 2 === 0),
      coreHit: spec.cores.map(() => 0),
    },
    0,
  );
}

/** A portrait, synchronously (its own offscreen renderer). */
export function portrait(seed: number, number: number, opts: Opts = {}): string {
  const w = opts.w ?? 360,
    h = opts.h ?? 300;
  const key = keyOf(seed, number, opts);
  const hit = cache.get(key);
  if (hit) return hit;
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  const spec = makeTitan(seed, number);
  const titan = new Titan(spec);
  scene.add(titan.group);
  const { cam, px } = frame(w, h);
  titan.u.uPx.value = px;
  pose(titan, seed, opts.crack ?? 0);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL("image/png");
  titan.dispose();
  cache.set(key, url);
  return url;
}

/**
 * A portrait drawn by the game's renderer once its programs are linked (falls back to `portrait`).
 * The titan awake now is drawn as it stands; any other is built, compiled off the main thread, then drawn.
 */
export async function portraitAsync(seed: number, number: number, opts: Opts = {}): Promise<string> {
  const key = keyOf(seed, number, opts);
  const hit = cache.get(key);
  if (hit) return hit;
  const hst = host;
  if (!hst) return portrait(seed, number, opts);
  await hst.ready();
  if (host !== hst) return portrait(seed, number, opts);
  const r = hst.renderer;
  const w = opts.w ?? 360,
    h = opts.h ?? 300;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // drawn at up to twice the size and scaled down (smooth edges without a multisampled target)
  const ss = Math.max(1, Math.min(2, 1400 / (Math.max(w, h) * dpr)));
  const W = Math.round(w * dpr * ss),
    H = Math.round(h * dpr * ss);
  const { cam, px } = frame(w, h);
  let titan = hst.titanFor(seed);
  const own = !titan;
  let restore: (() => void) | null = null;
  if (titan) {
    // draw the living titan as it stands, fully engraved, unclipped by the open book
    const u = titan.u;
    const was = [u.uReveal.value, u.uPx.value, u.uClipX.value, u.uClipX2.value];
    u.uReveal.value = 3;
    u.uPx.value = px;
    u.uClipX.value = -1e4;
    u.uClipX2.value = 1e4;
    const t = titan;
    restore = () => {
      [t.u.uReveal.value, t.u.uPx.value, t.u.uClipX.value, t.u.uClipX2.value] = was;
    };
  } else {
    titan = new Titan(makeTitan(seed, number));
    titan.u.uPx.value = px;
    pose(titan, seed, opts.crack ?? 0);
    try {
      await r.compileAsync(titan.group, cam);
    } catch {}
  }
  // the same program variants as the screen (sRGB out, no tone mapping): render as an "XR" target, which
  // three treats like the canvas, stored as plain RGBA8 (an sRGB texture would encode the shader's sRGB
  // output a second time and wash it out), then read the bytes back
  const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, colorSpace: THREE.SRGBColorSpace });
  (rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  rt.texture.internalFormat = "RGBA8";
  const prevRT = r.getRenderTarget();
  const prevColor = r.getClearColor(new THREE.Color());
  const prevAlpha = r.getClearAlpha();
  const buf = new Uint8Array(W * H * 4);
  try {
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(titan.group, cam);
  } finally {
    r.setRenderTarget(prevRT);
    r.setClearColor(prevColor, prevAlpha);
    restore?.();
  }
  try {
    // read back without stalling the main thread (a fence, then the copy when the GPU is done)
    await r.readRenderTargetPixelsAsync(rt, 0, 0, W, H, buf);
  } catch {
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  } finally {
    rt.dispose();
    if (own) titan.dispose();
  }
  // rows come bottom-up and premultiplied: flip and un-premultiply into a 2D canvas
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  if (!ctx) return portrait(seed, number, opts);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4,
      dst = y * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      const a = buf[src + x + 3];
      const k = a > 0 && a < 255 ? 255 / a : 1;
      d[dst + x] = Math.min(255, buf[src + x] * k);
      d[dst + x + 1] = Math.min(255, buf[src + x + 1] * k);
      d[dst + x + 2] = Math.min(255, buf[src + x + 2] * k);
      d[dst + x + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  let out = cv;
  if (ss > 1) {
    out = document.createElement("canvas");
    out.width = Math.round(w * dpr);
    out.height = Math.round(h * dpr);
    const o = out.getContext("2d");
    if (o) {
      o.imageSmoothingEnabled = true;
      o.imageSmoothingQuality = "high";
      o.drawImage(cv, 0, 0, out.width, out.height);
    } else out = cv;
  }
  const url = out.toDataURL("image/png");
  cache.set(key, url);
  return url;
}

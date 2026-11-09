import * as THREE from "three";
import { makeTitan } from "@/core/titan";
import { Titan } from "./render/titan/titan";

// Engraved portraits (the cover medallion, the Hall of Titans, share cards), cached as image URLs.
//
// While the hunt is open, portraits are drawn by the game's own renderer: its titan programs are already
// linked, and the titan awake now is already built, so the medallion costs a render and a read-back
// instead of a second WebGL context compiling every program again (that froze the cover for ~0.8 s).
// Pages without the game (the Hall) queue their portraits on one shared offscreen renderer: one portrait
// per idle slot, programs linked off the main thread (compileAsync), the PNG encoded off it (toBlob).
// Every titan shares the same few engraving programs (material.ts), so only the first portrait links any.
// Portraits of fixed seeds (the How-it-works specimens, the Hall's empty plates) are static images in
// public/art/plates, drawn by scripts/render-art.mjs with this same code.

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

/** `view`: the framing in world units (key art); by default the titan's standard plate */
type Opts = { crack?: number; w?: number; h?: number; dpr?: number; view?: { cx?: number; cy?: number; halfH?: number } };
const dprOf = (o: Opts) => o.dpr ?? Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
const keyOf = (seed: number, number: number, o: Opts) => `${seed}:${number}:${o.crack ?? 0}:${o.w ?? 360}x${o.h ?? 300}@${dprOf(o)}`;
const cache = new Map<string, Promise<string>>();

function frame(w: number, h: number, view: Opts["view"] = {}) {
  const aspect = w / h;
  const halfH = view.halfH ?? 9.2,
    halfW = halfH * aspect;
  const cx = view.cx ?? 0,
    cy = view.cy ?? 26.2;
  const cam = new THREE.OrthographicCamera(cx - halfW, cx + halfW, cy + halfH, cy - halfH, -200, 200);
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

// ---------------------------------------------------------------- the shared offscreen renderer

let renderer: THREE.WebGLRenderer | null = null;
/** the last titan drawn stays alive until the next is drawn: its programs stay linked for the next one */
let kept: Titan | null = null;

const inWorker = typeof document === "undefined";

function offscreen() {
  if (!renderer) {
    // in a worker (portraitWorker.ts) the renderer draws into an OffscreenCanvas
    const canvas = inWorker ? (new OffscreenCanvas(1, 1) as unknown as HTMLCanvasElement) : undefined;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    // three would otherwise read every shader's log right after linking: a stall per program
    renderer.debug.checkShaderErrors = !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  }
  return renderer;
}

/** size the shared renderer for this portrait and pose the titan in its frame */
function staged(r: THREE.WebGLRenderer, titan: Titan, seed: number, o: Opts) {
  const w = o.w ?? 360,
    h = o.h ?? 300;
  r.setPixelRatio(dprOf(o));
  r.setSize(w, h, false);
  const scene = new THREE.Scene();
  scene.add(titan.group);
  const { cam, px } = frame(w, h, o.view);
  titan.u.uPx.value = px;
  pose(titan, seed, o.crack ?? 0);
  return { scene, cam };
}

function prepared(seed: number, number: number, o: Opts) {
  const r = offscreen();
  const titan = new Titan(makeTitan(seed, number));
  return { r, titan, ...staged(r, titan, seed, o) };
}

function retire(titan: Titan) {
  if (kept && kept !== titan) kept.dispose();
  kept = titan;
}

/** A portrait, synchronously, as a PNG data URL (tools and tests; pages use `portraitAsync`). */
export function portraitSync(seed: number, number: number, opts: Opts = {}): string {
  const { r, scene, cam, titan } = prepared(seed, number, opts);
  r.render(scene, cam);
  const url = r.domElement.toDataURL("image/png");
  retire(titan);
  return url;
}

/** the next idle slot on the page; in a worker nothing else runs, so just the next task */
const idle = (timeout = 600) =>
  new Promise<void>((res) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric && !inWorker) ric(() => res(), { timeout });
    else setTimeout(res, inWorker ? 0 : 16);
  });

/** a PNG, encoded off the main thread (a data URL string only where neither toBlob nor convertToBlob exists) */
const encode = (cv: HTMLCanvasElement | OffscreenCanvas) =>
  "convertToBlob" in cv
    ? cv.convertToBlob({ type: "image/png" })
    : new Promise<Blob | string>((res) => {
        if (cv.toBlob) cv.toBlob((b) => res(b ?? cv.toDataURL("image/png")), "image/png");
        else res(cv.toDataURL("image/png"));
      });

// one portrait at a time, each step in its own idle slot: (the context,) the anatomy, the programs (linked
// off the main thread), the drawing, then the PNG (encoded off it)
let queue: Promise<unknown> = Promise.resolve();
function drawQueued(seed: number, number: number, o: Opts): Promise<Blob | string> {
  const job = queue.then(async () => {
    await idle();
    if (!renderer) {
      offscreen();
      await idle();
    }
    const titan = new Titan(makeTitan(seed, number));
    await idle();
    const r = offscreen();
    const { scene, cam } = staged(r, titan, seed, o);
    try {
      await r.compileAsync(scene, cam);
    } catch {
      /* drawn anyway: render links what is missing */
    }
    await idle();
    r.render(scene, cam);
    // the canvas keeps its drawing (preserveDrawingBuffer) until the next portrait clears it: encode it now
    const out = await encode(r.domElement as HTMLCanvasElement | OffscreenCanvas);
    retire(titan);
    return out;
  });
  queue = job.catch(() => {});
  return job;
}

const queued = (seed: number, number: number, o: Opts) => drawQueued(seed, number, o).then((b) => (typeof b === "string" ? b : URL.createObjectURL(b)));

/** For portraitWorker.ts: a portrait as PNG bytes, drawn on the worker's own OffscreenCanvas renderer. */
export const portraitBlob = (seed: number, number: number, opts: Opts = {}) =>
  drawQueued(seed, number, opts).then((b) => (typeof b === "string" ? fetch(b).then((r) => r.blob()) : b));

/**
 * A portrait: drawn by the game's renderer once its programs are linked, or queued on the shared offscreen
 * renderer when no game is running. The titan awake now is drawn as it stands; any other is built,
 * compiled off the main thread, then drawn.
 */
export function portraitAsync(seed: number, number: number, opts: Opts = {}): Promise<string> {
  const key = keyOf(seed, number, opts);
  let p = cache.get(key);
  if (!p) {
    p = (host ? viaHost(host, seed, number, opts) : queued(seed, number, opts)).catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, p);
  }
  return p;
}

async function viaHost(hst: PortraitHost, seed: number, number: number, opts: Opts): Promise<string> {
  await hst.ready();
  if (host !== hst) return queued(seed, number, opts);
  const r = hst.renderer;
  const w = opts.w ?? 360,
    h = opts.h ?? 300;
  const dpr = dprOf(opts);
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
  // rows come bottom-up and premultiplied: flip them with whole-row copies, then un-premultiply only the
  // few pixels that are partly transparent (edges, the cores' glow); opaque and empty pixels are already right
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  if (!ctx) return queued(seed, number, opts);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const row = W * 4;
  for (let y = 0; y < H; y++) d.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a === 0 || a === 255) continue;
    const k = 255 / a;
    d[i - 3] = Math.min(255, d[i - 3] * k);
    d[i - 2] = Math.min(255, d[i - 2] * k);
    d[i - 1] = Math.min(255, d[i - 1] * k);
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
  const b = await encode(out);
  return typeof b === "string" ? b : URL.createObjectURL(b);
}

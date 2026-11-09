import * as THREE from "three";
import { ARENA } from "@/core/titan";

// The page: an orthographic view of a manuscript leaf. Arena units map 1:1 to world x/y.
// Page spans x in [-PAGE_W/2, PAGE_W/2], y in [PAGE_Y0, PAGE_Y1]. The titan lives above the arena (y > 20).

export const PAGE = { W: ARENA.W + 1.2, Y0: -0.9, Y1: ARENA.TOP + 14.4 };

export const GUTTER = 0.9;
/** during a run the bestiary leaf folds to a strip this wide (world units) beside the spine */
export const STRIP = 8.6;
/** ...and on very wide screens, where there is room, a wider strip */
export const STRIP_WIDE = 12.6;
/** the run's view in the open book: from just under the arena to the titan's face (heads sit near y 28-30) */
export const PLAY_Y0 = PAGE.Y0 + 0.15;
export const PLAY_TOP = ARENA.TOP + 9.8;
/** a throne titan sits taller: its face is higher on the page */
export const PLAY_TOP_TALL = ARENA.TOP + 11.2;
/** a phone on its side: a shorter screen, so the view stops at the titan's chin and mouth */
export const SIDE_TOP = ARENA.TOP + 7.2;

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** An orthographic camera as a centre and half extents (world units). */
export interface Cam {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
}

/**
 * How the book sits on the screen.
 * - spread: an open codex (bestiary leaf + the hunt). During a run the leaf folds to a strip and the
 *   camera leans in until the page fills the height.
 * - side: a short landscape screen (a phone on its side). The hunt page alone, with the lobby in a side
 *   panel; during a run the camera leans in on the arena.
 * - single: a tall screen. The hunt page alone, kept clear of the bottom band (host badge, HUD).
 */
export type Mode = "spread" | "side" | "single";

export interface View {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** world units per CSS pixel (current camera) */
  unitsPerPx: number;
  /** visible world rect (current camera) */
  rect: Rect;
  portrait: boolean;
  mode: Mode;
  /** wide screens show an open codex: the bestiary leaf on the left, the hunt on the right */
  spread: boolean;
  /** the bestiary leaf, open (lobby) */
  leftLeaf: Rect | null;
  /** the same leaf folded to a strip beside the spine (run) */
  strip: Rect | null;
  /** [the whole book, leaning in on the fight] */
  cams: [Cam, Cam];
  /** CSS pixels kept clear at the bottom of the screen (single mode) */
  reserve: number;
  dpr: number;
  cssW: number;
  cssH: number;
}

export function createView(canvas: HTMLCanvasElement): View {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  // in production, skip the synchronous link-status/info-log queries so KHR_parallel_shader_compile can
  // compile every program off the main thread (the cover stays fluid while the titan's programs link)
  renderer.debug.checkShaderErrors = !!import.meta.env?.DEV;
  renderer.setClearColor(0x1a1410, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 200);
  camera.position.set(0, 0, 50);
  camera.lookAt(0, 0, 0);
  const cam: Cam = { cx: 0, cy: 0, halfW: 10, halfH: 10 };
  return { renderer, scene, camera, unitsPerPx: 0.02, rect: { x0: -10, x1: 10, y0: -10, y1: 10 }, portrait: false, mode: "single", spread: false, leftLeaf: null, strip: null, cams: [cam, { ...cam }], reserve: 0, dpr: 1, cssW: 1, cssH: 1 };
}

/** The backing-store density for a quality step: never below 1 on high-density screens (no pixelated titans). */
export function dprFor(quality: number) {
  const native = window.devicePixelRatio || 1;
  return quality >= 1 ? Math.min(native, 2) : Math.max(native >= 2 ? 1 : 0.75, Math.min(native, 2) * (quality >= 0.75 ? 0.75 : 0.6));
}

/** Size the backing store (only when the canvas or the quality changes, never during a camera move). */
export function sizeView(v: View, cssW: number, cssH: number, quality: number) {
  const dpr = dprFor(quality);
  v.cssW = cssW;
  v.cssH = cssH;
  if (v.dpr !== dpr) {
    v.dpr = dpr;
    v.renderer.setPixelRatio(dpr);
  }
  const c = v.renderer.domElement;
  if (c.width !== Math.floor(cssW * dpr) || c.height !== Math.floor(cssH * dpr)) v.renderer.setSize(cssW, cssH, false);
}

/**
 * Work out the layout for this screen: the mode, the leaves, and both cameras (the whole book, and
 * leaning in on the fight). `reserve` is the CSS height kept clear at the bottom on tall screens.
 */
export function layoutView(v: View, cssW: number, cssH: number, reserve = 0, tall = false) {
  const aspect = cssW / cssH;
  v.mode = aspect >= 1.12 ? (cssH < 520 ? "side" : "spread") : "single";
  v.spread = v.mode === "spread";
  v.portrait = aspect < 0.8;
  v.reserve = v.mode === "single" ? reserve : 0;
  const leafX1 = -PAGE.W / 2 - GUTTER;
  // a very wide screen keeps more of the leaf open beside the fight (the desk is otherwise most of the screen)
  const stripW = aspect > 2.05 ? STRIP_WIDE : STRIP;
  v.leftLeaf = v.spread ? { x0: leafX1 - PAGE.W, x1: leafX1, y0: PAGE.Y0, y1: PAGE.Y1 } : null;
  v.strip = v.spread ? { x0: leafX1 - stripW, x1: leafX1, y0: PAGE.Y0, y1: PAGE.Y1 } : null;

  if (v.mode === "spread") {
    // the open book: both leaves with room above for crowns and halos; tighter margins on very wide screens
    const contentW = PAGE.W * 2 + GUTTER;
    const margin = aspect > 2 ? 1.015 : 1.04;
    const top = PAGE.Y1 + (aspect > 2 ? 1.1 : 1.6);
    const cam0 = fit(aspect, -(PAGE.W + GUTTER) / 2, contentW * margin, PAGE.Y0, top, margin);
    // the run: the strip and the hunt page, as tall as the screen allows, with the titan's face and the foot
    // of its crown in frame (cropping at its shoulders took away the creature you are fighting)
    const x0 = leafX1 - stripW - 0.5,
      x1 = PAGE.W / 2 + 0.5;
    const cam1 = fit(aspect, (x0 + x1) / 2, x1 - x0, PLAY_Y0, tall ? PLAY_TOP_TALL : PLAY_TOP, 1);
    v.cams = [cam0, cam1];
  } else if (v.mode === "side") {
    // a phone on its side: the whole page down the left in the lobby (the side panel takes the right) …
    const top = PAGE.Y1 + 0.3,
      bottom = PAGE.Y0 - 0.25;
    const halfH = (top - bottom) / 2,
      halfW = halfH * aspect;
    const cam0 = { cx: -PAGE.W / 2 - 0.6 + halfW, cy: (top + bottom) / 2, halfW, halfH };
    // … and, during a run, the arena as tall as the screen with the titan's wounds, mouth and face above it
    const cam1 = fit(aspect, 0, PAGE.W + 1, -0.55, SIDE_TOP + (tall ? 1.4 : 0), 1);
    v.cams = [cam0, cam1];
  } else {
    // tall screens: the page fills the width, lifted clear of the bottom band
    const contentW = PAGE.W;
    const availH = Math.max(1, cssH - v.reserve);
    const pageH = PAGE.Y1 - PAGE.Y0;
    // units per CSS px: fit the width, or the height above the band, whichever is tighter
    const upp = Math.max(contentW / cssW, pageH / availH);
    const halfW = (cssW * upp) / 2,
      halfH = (cssH * upp) / 2;
    let cy = PAGE.Y0 - v.reserve * upp + halfH;
    // never crop the titan away entirely
    if (cy + halfH < ARENA.TOP + 6) cy = ARENA.TOP + 6 - halfH;
    const cam = { cx: 0, cy, halfW, halfH };
    v.cams = [cam, { ...cam }];
  }
}

/** Fit a content box (centre cx, width w, from y0 to y1) into the screen: by height, or by width when narrow (cropping the top). */
function fit(aspect: number, cx: number, w: number, y0: number, y1: number, margin: number): Cam {
  const visH = y1 - y0;
  if (aspect >= w / (visH * margin)) {
    const halfH = (visH * margin) / 2;
    return { cx, cy: (y0 + y1) / 2, halfW: halfH * aspect, halfH };
  }
  const halfW = w / 2,
    halfH = halfW / aspect;
  return { cx, cy: y0 - (margin - 1) * visH * 0.5 + halfH, halfW, halfH };
}

/** A camera between the two: the zoom is geometric so the lean-in feels even, the centre glides. */
export function lerpCam(a: Cam, b: Cam, k: number): Cam {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const halfH = a.halfH * Math.pow(b.halfH / a.halfH, k);
  // keep the zoom's pivot steady: centre interpolated by how far the zoom has gone
  const z = Math.abs(b.halfH - a.halfH) > 1e-6 ? (halfH - a.halfH) / (b.halfH - a.halfH) : k;
  return { cx: a.cx + (b.cx - a.cx) * z, cy: a.cy + (b.cy - a.cy) * z, halfW: halfH * (a.halfW / a.halfH), halfH };
}

/** Point the camera (cheap: a projection matrix; the backing store and the baked paper are untouched). */
export function applyCam(v: View, c: Cam) {
  v.camera.left = c.cx - c.halfW;
  v.camera.right = c.cx + c.halfW;
  v.camera.top = c.cy + c.halfH;
  v.camera.bottom = c.cy - c.halfH;
  v.camera.updateProjectionMatrix();
  v.unitsPerPx = (c.halfW * 2) / v.cssW;
  v.rect = { x0: c.cx - c.halfW, x1: c.cx + c.halfW, y0: c.cy - c.halfH, y1: c.cy + c.halfH };
}

export function camRect(c: Cam): Rect {
  return { x0: c.cx - c.halfW, x1: c.cx + c.halfW, y0: c.cy - c.halfH, y1: c.cy + c.halfH };
}

/** CSS pixel -> world */
export function toWorld(v: View, px: number, py: number, cssW: number, cssH: number) {
  return { x: v.rect.x0 + (px / cssW) * (v.rect.x1 - v.rect.x0), y: v.rect.y1 - (py / cssH) * (v.rect.y1 - v.rect.y0) };
}
/** world -> CSS pixel */
export function toScreen(v: View, x: number, y: number, cssW: number, cssH: number) {
  return { x: ((x - v.rect.x0) / (v.rect.x1 - v.rect.x0)) * cssW, y: ((v.rect.y1 - y) / (v.rect.y1 - v.rect.y0)) * cssH };
}

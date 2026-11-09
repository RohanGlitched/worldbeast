import * as THREE from "three";
import { ARENA } from "@/core/titan";

// The page: an orthographic view of a manuscript leaf. Arena units map 1:1 to world x/y.
// Page spans x in [-PAGE_W/2, PAGE_W/2], y in [PAGE_Y0, PAGE_Y1]. The titan lives above the arena (y > 20).

export const PAGE = { W: ARENA.W + 1.2, Y0: -0.9, Y1: ARENA.TOP + 14.4 };

export const GUTTER = 0.9;

export interface View {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** world units per CSS pixel */
  unitsPerPx: number;
  /** visible world rect */
  rect: { x0: number; x1: number; y0: number; y1: number };
  portrait: boolean;
  /** wide screens show an open codex: the bestiary leaf on the left, the hunt on the right */
  spread: boolean;
  leftLeaf: { x0: number; x1: number; y0: number; y1: number } | null;
  dpr: number;
}

export function createView(canvas: HTMLCanvasElement): View {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x1a1410, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 200);
  camera.position.set(0, 0, 50);
  camera.lookAt(0, 0, 0);
  return { renderer, scene, camera, unitsPerPx: 0.02, rect: { x0: -10, x1: 10, y0: -10, y1: 10 }, portrait: false, spread: false, leftLeaf: null, dpr: 1 };
}

/** Fit the page (or the open spread) into the canvas. */
export function resizeView(v: View, cssW: number, cssH: number, quality: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, quality >= 1 ? 2 : 1.25);
  v.dpr = dpr;
  v.renderer.setPixelRatio(dpr);
  v.renderer.setSize(cssW, cssH, false);
  const pageH = PAGE.Y1 - PAGE.Y0;
  const aspect = cssW / cssH;
  v.spread = aspect >= 1.12;
  v.portrait = aspect < 0.8;
  const contentW = v.spread ? PAGE.W * 2 + GUTTER : PAGE.W;
  const cx = v.spread ? -(PAGE.W + GUTTER) / 2 : 0;
  let halfH: number, halfW: number, cy: number;
  const margin = v.spread ? 1.04 : 1.0;
  const headroom = v.spread ? 1.6 : 0; // room above the page for crowns and halos
  if (aspect >= contentW / (pageH + headroom)) {
    halfH = ((pageH + headroom) * margin) / 2;
    halfW = halfH * aspect;
    cy = (PAGE.Y0 + PAGE.Y1 + headroom) / 2;
  } else {
    halfW = (contentW * margin) / 2;
    halfH = halfW / aspect;
    cy = PAGE.Y0 + halfH - (v.spread ? 0.6 : 0);
    if (cy + halfH < ARENA.TOP + 6) cy = ARENA.TOP + 6 - halfH;
  }
  v.camera.left = cx - halfW;
  v.camera.right = cx + halfW;
  v.camera.top = cy + halfH;
  v.camera.bottom = cy - halfH;
  v.camera.updateProjectionMatrix();
  v.unitsPerPx = (halfW * 2) / cssW;
  v.rect = { x0: cx - halfW, x1: cx + halfW, y0: cy - halfH, y1: cy + halfH };
  v.leftLeaf = v.spread ? { x0: -PAGE.W * 1.5 - GUTTER, x1: -PAGE.W / 2 - GUTTER, y0: PAGE.Y0, y1: PAGE.Y1 } : null;
}

/** CSS pixel -> world */
export function toWorld(v: View, px: number, py: number, cssW: number, cssH: number) {
  return { x: v.rect.x0 + (px / cssW) * (v.rect.x1 - v.rect.x0), y: v.rect.y1 - (py / cssH) * (v.rect.y1 - v.rect.y0) };
}
/** world -> CSS pixel */
export function toScreen(v: View, x: number, y: number, cssW: number, cssH: number) {
  return { x: ((x - v.rect.x0) / (v.rect.x1 - v.rect.x0)) * cssW, y: ((v.rect.y1 - y) / (v.rect.y1 - v.rect.y0)) * cssH };
}

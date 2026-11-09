import * as THREE from "three";
import { makeTitan } from "@/core/titan";
import { Titan } from "./render/titan/titan";

// Engraved portraits for the Hall of Titans: one shared offscreen renderer, cached data URLs.

let renderer: THREE.WebGLRenderer | null = null;
const cache = new Map<string, string>();

export function portrait(seed: number, number: number, opts: { crack?: number; w?: number; h?: number } = {}): string {
  const w = opts.w ?? 360,
    h = opts.h ?? 300;
  const key = `${seed}:${number}:${opts.crack ?? 0}:${w}x${h}`;
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
  const aspect = w / h;
  const halfH = 9.2,
    halfW = halfH * aspect;
  const cy = 26.2;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, cy + halfH, cy - halfH, -200, 200);
  cam.position.set(0, 0, 50);
  titan.u.uPx.value = (halfW * 2) / w;
  titan.update(
    {
      t: 3.3 + (seed % 7),
      beat: 7.5,
      player: { x: 0, y: 6 },
      cues: [],
      stage: (opts.crack ?? 0) > 0.66 ? 2 : (opts.crack ?? 0) > 0.33 ? 1 : 0,
      crack: opts.crack ?? 0,
      hurt: 0,
      coreOpen: spec.cores.map((_, i) => i % 2 === 0),
      coreHit: spec.cores.map(() => 0),
    },
    0,
  );
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL("image/png");
  titan.dispose();
  cache.set(key, url);
  return url;
}

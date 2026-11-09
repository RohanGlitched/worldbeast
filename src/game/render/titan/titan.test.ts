import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeTitan } from "@/core/titan";
import { Titan } from "./titan";

// Builds every archetype across many seeds (every ornament set appears) without a GPU, runs a frame,
// and checks the draw budget: meshes (each is one draw call) stay within what the old titans used.

const ctx = (spec: ReturnType<typeof makeTitan>, t: number) => ({
  t,
  beat: t * 2,
  player: { x: 2, y: 6 },
  cues: [{ x: -3, y: 21, lead: 0.8, heavy: true, kind: "slam" }],
  stage: 2,
  crack: 0.8,
  hurt: 0.2,
  coreOpen: spec.cores.map((_, i) => i % 2 === 0),
  coreHit: spec.cores.map(() => 0),
});

// (before the forms: throne ~305, coil 231, strider 151, bloom ~193, swarmheart 209 meshes)
const BUDGET: Record<string, number> = { throne: 230, coil: 200, strider: 200, bloom: 195, swarmheart: 140 };

describe("engraved titans", () => {
  it("every seed builds, animates, and stays within its draw budget", () => {
    const worst: Record<string, number> = {};
    const t0 = performance.now();
    for (let s = 0; s < 100; s++) {
      const spec = makeTitan(s, 1);
      const t = new Titan(spec);
      t.update(ctx(spec, 3), 1 / 60);
      t.update(ctx(spec, 3.5), 1 / 60);
      let draws = 0;
      t.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) draws++;
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g?.attributes.position) {
          const p = g.attributes.position.array as Float32Array;
          for (let i = 0; i < p.length; i += 97) expect(Number.isFinite(p[i])).toBe(true);
        }
      });
      worst[spec.archetype] = Math.max(worst[spec.archetype] ?? 0, draws);
      t.dispose();
    }
    for (const k in worst) expect(worst[k], k).toBeLessThanOrEqual(BUDGET[k]);
    console.log("draws (worst per archetype)", JSON.stringify(worst), "build ms/titan", ((performance.now() - t0) / 100).toFixed(1));
  }, 60_000);
});

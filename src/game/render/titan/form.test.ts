import { describe, expect, it } from "vitest";
import { makeTitan, ARCHETYPES } from "@/core/titan";
import { titanForm } from "./form";

const formOf = (seed: number) => {
  const spec = makeTitan(seed, 1);
  const f = titanForm(spec);
  const own = spec.archetype === "swarmheart" ? f.swarm : f[spec.archetype];
  return { spec, f, own: own as unknown as Record<string, unknown> };
};

describe("titan form (render-only variety)", () => {
  it("is a pure function of the seed", () => {
    for (const s of [1, 14, 33, 5, 2870491872]) expect(titanForm(makeTitan(s, 1))).toEqual(titanForm(makeTitan(s, 9)));
  });

  it("never touches the fight: the spec is identical with or without a form drawn", () => {
    for (const s of [1, 2, 10, 14, 33, 2870491872]) {
      const a = JSON.stringify(makeTitan(s, 3));
      titanForm(makeTitan(s, 3));
      expect(JSON.stringify(makeTitan(s, 3))).toBe(a);
    }
  });

  it("two titans of one archetype usually differ in several ornament choices", () => {
    for (const arch of ARCHETYPES) {
      const seeds: number[] = [];
      for (let s = 0; seeds.length < 12 && s < 400; s++) if (makeTitan(s, 1).archetype === arch) seeds.push(s);
      let pairs = 0,
        diverse = 0;
      for (let i = 0; i < seeds.length; i++)
        for (let j = i + 1; j < seeds.length; j++) {
          const a = formOf(seeds[i]),
            b = formOf(seeds[j]);
          const keys = Object.keys(a.own).filter((k) => typeof a.own[k] === "string");
          const diff = keys.filter((k) => a.own[k] !== b.own[k]).length + (a.f.pigment !== b.f.pigment ? 1 : 0);
          pairs++;
          if (diff >= 2) diverse++;
        }
      expect(diverse / pairs).toBeGreaterThan(0.85);
    }
  });

  it("the sheet seeds differ from their twins", () => {
    const pairs: Array<[number, number]> = [[14, 1], [33, 5], [10, 16], [2, 4], [2870491872, 7]];
    for (const [a, b] of pairs) {
      const A = formOf(a),
        B = formOf(b);
      expect(A.spec.archetype).toBe(B.spec.archetype);
      expect(JSON.stringify(A.own)).not.toBe(JSON.stringify(B.own));
    }
  });
});

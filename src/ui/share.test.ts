import { describe, expect, it } from "vitest";
import { makeTitan } from "@/core/titan";
// @ts-ignore plain js module
import { shareWords } from "./share.js";

const spec = makeTitan(2870491872, 1);

describe("share words are honest about which titan", () => {
  it("the live titan: everyone online fights it", () => {
    const w = shareWords({ spec, summary: { damage: 1234.4 }, kind: "live" });
    expect(w.text).toBe(`I struck 1,234 blows against ${spec.name}, the 1st titan. Everyone online fights it at the same moment. Watch my run:`);
    expect(w.folio).toBe("The 1st Titan");
  });
  it("a rehearsal never claims the live world", () => {
    const w = shareWords({ spec, summary: { damage: 412, felled: true }, kind: "rehearsal" });
    expect(w.text).toContain("a rehearsal against a titan of my own");
    expect(w.text).not.toContain("1st titan");
    expect(w.text).not.toMatch(/Everyone online fights it/);
    expect(w.folio).toBe("A rehearsal titan");
    // its link opens a rehearsal (Hunt.jsx), not a ghost: the words never promise a replay of this run
    expect(w.text).not.toMatch(/Watch my run/);
    expect(w.text).toContain("See one fall yourself in a short rehearsal");
    // (no promise of a length it may not keep)
    expect(w.text).not.toMatch(/30 sec|30-second/);
  });
  it("a titan on your own page says so", () => {
    const w = shareWords({ spec, summary: { damage: 90 }, kind: "own" });
    expect(w.text).toContain("not the live world");
    expect(w.text).not.toMatch(/Everyone online/);
  });
});

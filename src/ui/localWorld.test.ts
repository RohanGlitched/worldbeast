import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTitan } from "@/core/titan";
// @ts-ignore plain js module
import { createLocalWorld, INTERLUDE_MS, LIFT_MS, LOCAL_HP, nextLocalSeed, REHEARSAL_HP, REHEARSAL_LEFT, REHEARSAL_RESONANCE } from "./localWorld.js";

// A stand-in for Game: just what the local world drives.
function fakeGame() {
  const g: any = {
    spec: null,
    phase: "lobby",
    hpFrac: 1,
    falls: 0,
    clock: () => 0,
    setTitan(seed: number, number: number) {
      if (g.spec?.seed === seed) return;
      g.spec = makeTitan(seed, number);
      g.phase = "lobby";
    },
    fell() {
      g.falls++;
      // a run in progress ends as a victory, like Game.fell
      if (g.phase === "playing") {
        g.phase = "down";
        g.onDown?.({ felled: true, damage: 1 });
      }
    },
  };
  return g;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 9, 15));
});
afterEach(() => vi.useRealTimers());

describe("a local titan falls", () => {
  it("?hp=0.08: the last blow fells it, with the felled ceremony from this run alone, then the next titan engraves in", () => {
    const g = fakeGame();
    const felled: any[] = [];
    const w = createLocalWorld(g, { search: "?seed=2870491872&n=1&t=1500&hp=0.08" }, { onFelled: (end: any, next: any) => felled.push({ end, next }) });
    w.start();
    w.identify({ name: "Hale the Small", sigil: 5 });
    const first = g.spec;
    expect(first.number).toBe(1);
    expect(w.state.hp).toBe(800);
    g.phase = "playing";
    const downs: any[] = [];
    g.onDown = (s: any) => downs.push(s);
    w.addHit(0, 500, 0);
    expect(felled).toHaveLength(0);
    w.addHit(0, 500, 0); // overkill counts only what was left
    expect(w.state.hp).toBe(0);
    w.addHit(0, 50, 0); // more blows in the same frame change nothing
    expect(g.falls).toBe(0); // the fall lands after the frame that dealt the blow
    vi.advanceTimersByTime(1);
    expect(g.falls).toBe(1);
    expect(downs).toEqual([expect.objectContaining({ felled: true })]);
    const { end, next } = felled[0];
    expect(end).toMatchObject({ status: "felled", number: 1, blow: { name: "Hale the Small", sigil: 5 }, top: [{ name: "Hale the Small", sigil: 5, damage: 800 }], damageTotal: 800, hunterCount: 1, local: true });
    expect(next).toMatchObject({ number: 2, wokeAt: end.endedAt + INTERLUDE_MS });
    expect(w.state.feed.at(-1).html).toContain("was felled</b>; the final blow was <b>Hale the Small</b>'s.");
    // blows during the fall do nothing
    w.addHit(0, 100, 0);
    expect(g.falls).toBe(1);

    // the fallen engraving lifts away, then the next titan is engraved in, asleep through the interlude
    vi.advanceTimersByTime(LIFT_MS - 10);
    expect(g.spec).toBe(first);
    vi.advanceTimersByTime(20);
    expect(g.spec.seed).toBe(next.seed);
    expect(g.spec.number).toBe(2);
    expect(g.spec.archetype).not.toBe(first.archetype); // never the same body twice in a row
    expect(w.state.spec).toBe(g.spec);
    expect(w.state.hp).toBe(w.state.hpMax);
    expect(g.hpFrac).toBe(1);
    expect(w.state.interlude).toBeGreaterThan(14);
    expect(g.clock()).toBeLessThan(0);
    w.addHit(0, 100, 0); // asleep: no wound
    expect(w.state.hp).toBe(w.state.hpMax);
    vi.advanceTimersByTime(INTERLUDE_MS);
    expect(w.state.interlude).toBe(0);
    expect(g.clock()).toBeGreaterThan(0);
    expect(w.state.feed.at(-1).html).toContain("woke and began to sing");
    w.addHit(0, 100, 0);
    expect(w.state.hp).toBe(w.state.hpMax - 100);
    w.stop();
  });

  it("a pinned titan and a replayed one are sized like the live floor (10,000), not 400,000", () => {
    const w = createLocalWorld(fakeGame(), { search: "?seed=2870491872&n=1&t=60" });
    w.start();
    expect(w.state).toMatchObject({ hpMax: LOCAL_HP, hp: 10_000, pinned: true, counts: false });
    expect(LOCAL_HP).toBe(10_000);
    const r = createLocalWorld(fakeGame(), { seed: 10, number: 10, replay: { name: "Ana", sigil: 1, damage: 900, duration: 20 }, search: "" });
    r.start();
    expect(r.state).toMatchObject({ hpMax: 10_000, counts: false });
    w.stop();
    r.stop();
  });

  it("the next titan is never the same archetype, nor the same epithet, as the one just felled, for any seed", () => {
    for (let s = 1; s < 400; s++) {
      const [a, b] = [makeTitan(s, 1), makeTitan(nextLocalSeed(s), 2)];
      expect(b.archetype).not.toBe(a.archetype);
      expect(b.epithet).not.toBe(a.epithet);
    }
    expect(nextLocalSeed(77)).toBe(nextLocalSeed(77)); // deterministic
  });

  it("a rehearsal: a titan of your own near death, labelled, sized like the live world's quietest", () => {
    const g = fakeGame();
    const w = createLocalWorld(g, { rehearsal: true, search: "?rehearse=1" });
    w.start();
    expect(w.state).toMatchObject({ rehearsal: true, nearDeath: true, local: true, hpMax: REHEARSAL_HP, hp: Math.round(REHEARSAL_HP * REHEARSAL_LEFT), counts: false, huntOpts: { forgiving: true, resonance: REHEARSAL_RESONANCE } });
    // 600-800 blows from falling (a 10-15 s fight with one Surge), and it fights in Wrath (its wounds alone would say Ruin)
    expect(w.state.hp).toBeGreaterThanOrEqual(600);
    expect(w.state.hp).toBeLessThanOrEqual(800);
    expect(REHEARSAL_RESONANCE).toBeGreaterThanOrEqual(65);
    expect(g.stageFn()).toBe(1);
    w.stop();
    expect(g.stageFn).toBeNull();
    w.start();
    expect(w.state.feed[0].html).toMatch(/^A rehearsal: .*a titan of your own.*nothing here is written in the Hall/);
    expect(w.shareOf(100)).toBeNull();
    const felled: any[] = [];
    const w2 = createLocalWorld(fakeGame(), { rehearsal: true, search: "" }, { onFelled: (e: any) => felled.push(e) });
    w2.start();
    w2.addHit(0, 10_000, 0); // no name given: the fall still happens, credited to no one
    vi.advanceTimersByTime(1);
    expect(felled[0]).toMatchObject({ rehearsal: true, blow: null, top: [] });
    // the titan after a rehearsal's fall is a whole one: not "woken near death", and its light starts plain
    vi.advanceTimersByTime(LIFT_MS + 10);
    expect(w2.state).toMatchObject({ rehearsal: true, nearDeath: false, hp: REHEARSAL_HP, huntOpts: { forgiving: true } });
    expect(w2.state.huntOpts.resonance).toBeUndefined();
    w.stop();
    w2.stop();
  });
});

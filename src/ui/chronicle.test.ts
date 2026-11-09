import { describe, expect, it } from "vitest";
import { makeTitan } from "@/core/titan";
// @ts-ignore plain js module
import { fmtAgo, historyItems, liveItems, loadHistory, mergeChronicle, presence } from "./chronicle.js";

const NOW = Date.UTC(2026, 10, 9, 18);
const MIN = 60_000;
const titan1 = { number: 1, seed: 2870491872, wokeAt: NOW - 120 * MIN, status: "awake", hpMax: 10_000, hp: 9_000 };
const name1 = makeTitan(titan1.seed, 1).name;

describe("chronicle on arrival", () => {
  it("writes the latest real runs and titans, newest last, with times", () => {
    const runs = [
      { name: "Hale the Small", damage: 1204, titanNumber: 1, createdAt: NOW - 12 * MIN },
      { name: "Wren", damage: 0, titanNumber: 1, createdAt: NOW - 5 * MIN }, // struck nothing: not a line
      { name: "Ana", damage: 880, titanNumber: 1, created_date: new Date(NOW - 30 * MIN).toISOString() },
    ];
    const items = mergeChronicle(historyItems({ runs, titans: [titan1], now: NOW }), []);
    expect(items.map((i: any) => i.html)).toEqual([
      `<b>${name1}</b>, the 1st titan, woke.`,
      `<b>Ana</b> struck <span class="gold">880</span> blows against ${name1}.`,
      `<b>Hale the Small</b> struck <span class="gold">1,204</span> blows against ${name1}.`,
    ]);
    expect(fmtAgo(NOW - items[2].n)).toBe("12 min ago");
    expect(fmtAgo(NOW - items[0].n)).toBe("2 h ago");
    expect(fmtAgo(20_000)).toBe("moments ago");
  });

  it("tells of felled and escaped titans from their records", () => {
    const t0 = { number: 0, seed: 7, wokeAt: NOW - 600 * MIN, status: "felled", felledAt: NOW - 200 * MIN, finalBlowName: "Bo<script>" };
    const t2 = { number: 2, seed: 9, wokeAt: NOW - 100 * MIN, status: "escaped", felledAt: NOW - 50 * MIN };
    const html = mergeChronicle(historyItems({ titans: [t0, t2], now: NOW }), []).map((i: any) => i.html).join("\n");
    expect(html).toContain("was felled</b>; the final blow was <b>Bo&lt;script&gt;</b>'s.");
    expect(html).toContain("slipped away unfelled.");
    expect(html).not.toContain("<script>");
  });

  it("never invents: no records and no feed is an empty chronicle; a titan not yet awake is not written", () => {
    expect(mergeChronicle(historyItems({ runs: [], titans: [], now: NOW }), [])).toEqual([]);
    expect(historyItems({ titans: [{ ...titan1, wokeAt: NOW + 5000 }], now: NOW })).toEqual([]);
  });

  it("dedupes a run or a waking told by both the records and the live feed", () => {
    const runs = [{ name: "Hale", damage: 1204, titanNumber: 1, createdAt: NOW - 2 * MIN }];
    const feed = [
      { k: "wake", name: name1, sigil: 0, v: 1, n: titan1.wokeAt + 900 },
      { k: "join", name: "Hale", sigil: 2, n: NOW - 3 * MIN },
      { k: "join", name: "Hale", sigil: 2, n: NOW - 2.5 * MIN },
      { k: "run", name: "Hale", sigil: 2, v: 1204, n: NOW - 2 * MIN + 40 },
    ];
    const items = mergeChronicle(historyItems({ runs, titans: [titan1], now: NOW }), liveItems(feed, makeTitan(titan1.seed, 1)));
    expect(items).toHaveLength(3);
    expect(items.map((i: any) => i.html)).toEqual(["The 1st titan woke.", "<b>Hale</b> joined the hunt.", `<b>Hale</b> struck <span class="gold">1,204</span> blows.`]);
  });

  it("reads nothing when the database is out of reach", async () => {
    expect(await loadHistory(null)).toEqual({ runs: [], titans: [] });
    const broken = { Run: { list: async () => { throw new Error("down"); } }, Titan: { list: async () => [titan1] } };
    expect(await loadHistory(broken)).toEqual({ runs: [], titans: [titan1] });
  });
});

describe("honest head-counts", () => {
  it("alone: you are the first hunter here", () => {
    const p = presence({ online: 1, hunters: [], watching: 1 });
    expect(p.join).toBe("You are the first hunter here right now — your echo will fly for the next");
    expect(p.header).toBe("No one is hunting this minute · 1 watching");
    expect(p.cover).toBe("A living bestiary");
    expect(p.topbar).toBe("only you here");
  });
  it("watchers are never counted as hunters", () => {
    // the R3 judges' case: 5 browsers connected, nobody has joined
    const p = presence({ online: 5, hunters: [], watching: 5 });
    expect(p.header).toBe("No one is hunting this minute · 5 watching");
    expect(p.cover).toBe("4 others reading the codex · no one hunting this minute");
    expect(p.join).toMatch(/^You are the first hunter here/);
    expect(p.topbar).toBe("5 watching");
  });
  it("counts real hunters, you among them once you join", () => {
    const hunters = [{ me: false }, { me: true }];
    const p = presence({ online: 4, hunters, watching: 2, echoes: 3 });
    expect(p.header).toBe("2 hunters in the hunt · 2 watching · 3 echoes");
    expect(p.join).toBe("1 other hunter is in the hunt now · 2 watching");
    expect(p.topbar).toBe("2 hunting");
    expect(presence({ online: 3, hunters: [{ me: false }], watching: 2 }).cover).toBe("1 hunting right now · 1 reading the codex");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash32 } from "@/core/rng";
import { Q } from "./types";

vi.mock("@/api/base44Client", () => ({ base44: null }));
const { World } = await import("./world");

// A fake actor socket: records what the client sends, lets the test play the server.
function fakeClient() {
  const sent: any[] = [];
  let listener: ((m: any) => void) | null = null;
  let opens = 0;
  const client = {
    actors: {
      world: () => ({
        connect: () => {
          opens++;
          return { subscribe: (fn: (m: any) => void) => ((listener = fn), { unsubscribe() {} }), send: (m: any) => sent.push(m), close() {} };
        },
      }),
    },
    entities: { Echo: { filter: async () => [] } },
  };
  return { client, sent, push: (m: any) => listener?.(m), opens: () => opens };
}

const titan = { number: 7, seed: 4242, wokeAt: 1_000_000, hpMax: 200_000, status: "awake" as const };
const welcome = (n: number, extra: object = {}) => ({ t: "welcome", n, you: 1, titan, hp: 150_000, stage: 0, stageAt: [], online: 2, feed: [], roster: [[2, "Bo", 9, "ember"]], h: [], sparks: [], last: null, ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 9, 12));
});
afterEach(() => vi.useRealTimers());

describe("World client", () => {
  it("falls back to a local titan after 4 s and switches to the world when it answers", () => {
    const f = fakeClient();
    const w = new World({ client: f.client as any });
    const titans: number[] = [];
    w.events.onTitan = (t) => titans.push(t.number);
    w.connect();
    w.setIdentity({ name: "Ana", sigil: 3, aspect: "ember" });
    vi.advanceTimersByTime(4100);
    expect(w.mode).toBe("offline");
    expect(w.titanSeed).toBe(hash32("local", Math.floor(Date.now() / (3 * 3600_000))));
    expect(w.titanTime()).toBeGreaterThanOrEqual(0);
    w.addHit(0, 500, 1);
    expect(w.hp).toBe(40_000 - 500);

    f.push(welcome(performance.now() + 5000));
    expect(w.mode).toBe("online");
    expect(titans).toEqual([0, 7]);
    expect(f.sent.find((m) => m.t === "hello")).toMatchObject({ name: "Ana", sigil: 3, key: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(w.hunters[0]).toMatchObject({ name: "Bo" });
    w.close();
  });

  it("estimates the clock from pings, ignoring queued (slow) samples", () => {
    const f = fakeClient();
    const w = new World({ client: f.client as any });
    w.connect();
    const OFFSET = 123_456;
    f.push(welcome(performance.now() + OFFSET + 40)); // crude first guess
    for (let i = 0; i < 8; i++) {
      const c = performance.now();
      // one reply sat 330 ms in a queue on the way back: its naive offset is 165 ms off
      const [rtt, upLeg] = i === 3 ? [400, 35] : [70 + (i % 3), 35];
      vi.advanceTimersByTime(rtt);
      f.push({ t: "pong", n: c + OFFSET + upLeg, c });
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(300);
    expect(Math.abs(w.clockOffset - OFFSET)).toBeLessThan(2);
    expect(w.rtt).toBeLessThan(100);
    expect(Math.abs(w.serverNow() - (performance.now() + OFFSET))).toBeLessThan(2);
    w.close();
  });

  it("interpolates other hunters ~120 ms in the past and drops ones that vanish", () => {
    const f = fakeClient();
    const w = new World({ client: f.client as any });
    w.connect();
    const n0 = performance.now(); // server clock == performance clock here
    f.push(welcome(n0));
    f.push({ t: "s", n: n0 + 100, hp: 1, c: 2, h: [[2, 0, 0, 9, 0], [1, 5, 5, 3, 0]] });
    f.push({ t: "s", n: n0 + 200, hp: 1, c: 2, h: [[2, 2 * Q, 0, 9, 0], [1, 5, 5, 3, 0]] });
    vi.advanceTimersByTime(270); // render time = n0 + 150
    const [h] = w.remoteHunters();
    expect(h.id).toBe(2);
    expect(h.x).toBeCloseTo(1, 1);
    expect(w.remoteHunters()).toHaveLength(1); // never yourself
    f.push({ t: "s", n: n0 + 300, hp: 1, c: 1, h: [] });
    expect(w.remoteHunters()).toHaveLength(0);
    w.close();
  });

  it("batches hits at 4 Hz, throttles positions to 10 Hz, keeps a down from being undone", () => {
    const f = fakeClient();
    const w = new World({ client: f.client as any });
    w.connect();
    f.push(welcome(performance.now()));
    w.setIdentity({ name: "Ana", sigil: 3, aspect: "ember" });
    for (let i = 0; i < 30; i++) {
      w.sendPos(i * 0.1, 3, true, 0);
      if (i % 3 === 0) w.addHit(1, 10, 100 + i * 0.01, i === 0 ? 1 : 0);
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(250);
    const pos = f.sent.filter((m) => m.t === "pos");
    const hits = f.sent.filter((m) => m.t === "hit");
    expect(pos.length).toBeGreaterThanOrEqual(4);
    expect(pos.length).toBeLessThanOrEqual(6);
    expect(hits.flatMap((m) => m.hits)).toHaveLength(10);
    expect(hits[0].hits[0]).toEqual([1, 10, 100, 1]);
    expect(hits.length).toBeLessThanOrEqual(3);
    w.sendDown(2, 3);
    vi.advanceTimersByTime(200);
    const after = f.sent.slice(f.sent.findIndex((m) => m.t === "down"));
    expect(after.filter((m) => m.t === "pos").every((m) => m.alive === false)).toBe(true);
    w.close();
  });

  it("reports felled and wake, and resolves runs from the ack", async () => {
    const f = fakeClient();
    const w = new World({ client: f.client as any });
    const seen: string[] = [];
    w.events.onFelled = (end, next) => seen.push(`felled ${end.number} next ${next.number}`);
    w.events.onWake = (t) => seen.push(`wake ${t.number}`);
    w.connect();
    const n = performance.now();
    f.push(welcome(n, { titan: { ...titan, wokeAt: n - 60_000 } }));
    const next = { number: 8, seed: 99, wokeAt: n + 20_000, hpMax: 150_000, status: "awake" };
    f.push({ t: "felled", n, end: { ...titan, status: "felled", endedAt: n, blow: { name: "Bo", sigil: 9 }, top: [], damageTotal: 200_000, hunterCount: 2 }, next });
    expect(w.titanTime()).toBeCloseTo(-20, 0);
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(1900);
      f.push({ t: "s", n: performance.now(), hp: 150_000, c: 2, h: [] });
    }
    expect(seen).toEqual(["felled 7 next 8", "wake 8"]);
    const p = w.sendRun({ damage: 900, time: 30, grazes: 3, bestCombo: 2, surges: 0, aspect: "ember", startT: 5, stage: 0, path: [0, 60, 2, 61] });
    expect(f.sent.at(-1)).toMatchObject({ t: "run", titan: 8, damage: 900, path: expect.any(String) });
    f.push({ t: "runAck", n, damage: 850, echo: false, clamped: true });
    await expect(p).resolves.toEqual({ damage: 850, echo: false, clamped: true });
    w.close();
  });
});

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
    expect(w.hp).toBe(10_000 - 500);

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

// Several sockets at once: each connect() is its own connection (as the SDK gives a fresh ref per call).
function multiClient() {
  const conns: Array<{ id: string; sent: any[]; fn: ((m: any) => void) | null; closed: boolean; push(m: any): void }> = [];
  const client = {
    actors: {
      world: () => ({
        connect: (o: { id: string }) => {
          const c = { id: o.id, sent: [] as any[], fn: null as ((m: any) => void) | null, closed: false, push: (m: any) => c.fn?.(m) };
          conns.push(c);
          return { subscribe: (fn: (m: any) => void) => ((c.fn = fn), { unsubscribe() {} }), send: (m: any) => !c.closed && c.sent.push(m), close: () => (c.closed = true) };
        },
      }),
    },
    entities: { Echo: { filter: async () => [] } },
  };
  return { client, conns };
}

/** for `ms` of time, answer every ping sent on `c` exactly `rtt` ms after it left (server clock = performance clock) */
function pongs(c: { sent: any[]; push(m: any): void }, rtt: number, ms = 2000) {
  const answered = new Set<any>();
  for (let t = 0; t < ms; t += 10) {
    vi.advanceTimersByTime(10);
    for (const p of c.sent) if (p.t === "ping" && !answered.has(p) && performance.now() - p.c >= rtt) {
      answered.add(p);
      c.push({ t: "pong", n: p.c + rtt / 2, c: p.c });
    }
  }
}

describe("World client: one socket at a time", () => {
  it("probes a slow route make-before-break: the socket in use stays until a faster one is welcomed, the old one says bye", () => {
    const { client, conns } = multiClient();
    const w = new World({ client: client as any });
    w.connect();
    w.setIdentity({ name: "Ana", sigil: 3, aspect: "ember" });
    const [A] = conns;
    A.push(welcome(performance.now()));
    pongs(A, 300); // a slow route
    expect(conns).toHaveLength(2); // a candidate is tried...
    const B = conns[1];
    expect(B.id).not.toBe(A.id);
    expect(A.closed).toBe(false); // ...while the old socket stays in use
    expect(w.clockSettled).toBe(false);
    B.push(welcome(performance.now(), { you: 4 }));
    B.push({ t: "s", n: performance.now(), hp: 149_000, c: 3, h: [] }); // news while it proves itself
    pongs(B, 80);
    expect(A.sent.at(-1)).toEqual({ t: "bye" });
    expect(A.closed).toBe(true);
    expect(w.you).toBe(4);
    expect(w.hp).toBe(149_000); // the candidate's buffered news was applied
    expect(B.sent.find((m) => m.t === "hello")).toMatchObject({ name: "Ana" });
    // what the world sends on the new socket now counts
    B.push({ t: "s", n: performance.now(), hp: 148_000, c: 3, h: [] });
    expect(w.hp).toBe(148_000);
    w.close();
    expect(B.sent.at(-1)).toEqual({ t: "bye" });
  });

  it("keeps the socket in use when the candidate is no faster, and the candidate says bye", () => {
    const { client, conns } = multiClient();
    const w = new World({ client: client as any });
    w.connect();
    const [A] = conns;
    A.push(welcome(performance.now()));
    pongs(A, 300);
    const B = conns[1];
    B.push(welcome(performance.now(), { you: 4 }));
    pongs(B, 290);
    expect(B.sent.at(-1)).toEqual({ t: "bye" });
    expect(B.closed).toBe(true);
    expect(A.closed).toBe(false);
    expect(w.you).toBe(1);
    // the route was no faster: the distance is the network's, so there is no second probe
    pongs(A, 300, 4000);
    expect(conns).toHaveLength(2);
    expect(w.clockSettled).toBe(true);
    // a candidate that never answers is dropped too
    const before = conns.length;
    w.close();
    expect(conns.length).toBe(before);
  });

  it("a network blip keeps the last live titan (seed, number, wounds, wake time) until the world answers again; the bell titan only on a cold offline start", () => {
    const { client, conns } = multiClient();
    const w = new World({ client: client as any });
    const titans: Array<[number, number]> = [];
    const modes: string[] = [];
    w.events.onTitan = (t) => titans.push([t.number, t.seed]);
    w.events.onStatus = (m) => modes.push(m);
    w.connect();
    w.setIdentity({ name: "Ana", sigil: 3, aspect: "ember" });
    const [A] = conns;
    const n0 = performance.now();
    const live = { ...titan, wokeAt: n0 - 600_000 }; // awake ten minutes
    A.push(welcome(n0, { titan: live, hp: 140_000, stageAt: [12.5] }));
    pongs(A, 60, 1000);
    expect(titans).toEqual([[7, 4242]]);
    const clock = w.titanTime();
    const stage = w.stage;
    // the network drops: nothing arrives for a while (the lobby, not a run)
    vi.advanceTimersByTime(6000);
    expect(w.mode).toBe("offline");
    expect(w.isLocal).toBe(true);
    expect(w.holdingLive).toBe(true);
    expect(titans).toEqual([[7, 4242]]); // never swapped for a titan of the 3-hour block
    expect(w.titan).toMatchObject({ number: 7, seed: 4242, wokeAt: live.wokeAt, hpMax: 200_000 });
    expect(w.hp).toBe(140_000);
    expect(w.stage).toBe(stage);
    expect(Math.abs(w.titanTime() - (clock + 6))).toBeLessThan(0.3); // the same clock, running on
    // blows in the meantime show on its wounds, but the world's titan cannot be felled from here
    w.addHit(0, 500, 1);
    expect(w.hp).toBe(139_500);
    w.addHit(0, 1e9, 1);
    expect(w.hp).toBe(1);
    expect(titans).toHaveLength(1);
    // the world answers again on a fresh socket: the same titan, so nothing is rebuilt
    vi.advanceTimersByTime(3000);
    const B = conns.at(-1)!;
    expect(B).not.toBe(A);
    B.push(welcome(performance.now(), { titan: live, hp: 139_000, stageAt: [12.5] }));
    expect(w.mode).toBe("online");
    expect(w.holdingLive).toBe(false);
    expect(titans).toEqual([[7, 4242]]);
    expect(w.hp).toBe(139_000);
    expect(modes).toContain("offline");
    expect(B.sent.find((m) => m.t === "hello")).toMatchObject({ name: "Ana" });
    w.close();

    // a page that never reached the world: the titan of the 3-hour block
    const cold = multiClient();
    const c = new World({ client: cold.client as any });
    const coldTitans: number[] = [];
    c.events.onTitan = (t) => coldTitans.push(t.number);
    c.connect();
    vi.advanceTimersByTime(4100);
    expect(c.mode).toBe("offline");
    expect(c.holdingLive).toBe(false);
    expect(coldTitans).toEqual([0]);
    expect(c.titanSeed).toBe(hash32("local", Math.floor(Date.now() / (3 * 3600_000))));
    c.close();
  });

  it("sends a hit batch again, once, when the actor refused it for a missing hello (a redialled socket)", () => {
    const { client, conns } = multiClient();
    const w = new World({ client: client as any });
    w.connect();
    const [A] = conns;
    A.push(welcome(performance.now()));
    w.setIdentity({ name: "Ana", sigil: 3, aspect: "ember" });
    w.addHit(1, 10, 100);
    vi.advanceTimersByTime(260);
    const sent = A.sent.filter((m) => m.t === "hit");
    expect(sent).toHaveLength(1);
    expect(sent[0].q).toBeGreaterThan(0);
    // the socket redialled: a fresh welcome, and the queued batch was refused before the hello landed
    A.push(welcome(performance.now()));
    A.push({ t: "ack", n: performance.now(), ok: 0, bad: 1, why: "noHello", hp: 150_000, q: sent[0].q });
    vi.advanceTimersByTime(260);
    const again = A.sent.filter((m) => m.t === "hit");
    expect(again).toHaveLength(2);
    expect(again[1].hits).toEqual(sent[0].hits);
    const helloAt = A.sent.lastIndexOf(A.sent.filter((m) => m.t === "hello").at(-1));
    expect(A.sent.indexOf(again[1])).toBeGreaterThan(helloAt);
    // refused again: not sent a third time
    A.push({ t: "ack", n: performance.now(), ok: 0, bad: 1, why: "noHello", hp: 150_000, q: again[1].q });
    vi.advanceTimersByTime(260);
    expect(A.sent.filter((m) => m.t === "hit")).toHaveLength(2);
    w.close();
  });
});

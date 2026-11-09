import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import World from "../../base44/actors/world/entry";
import { MockConn } from "./__mocks__/actor-runtime";
import { coreOpen, makeTitan, TitanSpec } from "@/core/titan";
import { encodePath } from "./pathcodec";

// Drives the real actor class in-process against the mock runtime (see vitest.config.ts alias).

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
type W = any;

const settle = async (w: W) => {
  for (let i = 0; i < 6; i++) {
    await Promise.all(w.lanes);
    await new Promise((r) => setImmediate(r));
  }
};
const connect = async (w: W, id: string) => {
  const c = new MockConn(id);
  w.conns.push(c);
  await w.handleConnect(c);
  return c;
};
const send = (w: W, c: MockConn, m: unknown) => w.handleMessage(c, m);
const key = (ch: string) => ch.repeat(32);

function openBeat(spec: TitanSpec, from: number): [number, number] {
  for (let b = from; b < from + 600; b += 0.25)
    for (const c of spec.cores) if (coreOpen(c, b, 0) && coreOpen(c, b + 1, 0)) return [c.id, b + 0.25];
  throw new Error("no open core");
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterAll(() => vi.useRealTimers());

describe("world actor (in-process)", () => {
  let w: W, A: MockConn, B: MockConn, spec: TitanSpec;
  const at = (beat: number) => vi.setSystemTime(w.titan.wokeAt + beat * spec.beat * 1000);

  it("wakes titan #1 on first start and records it", async () => {
    w = new (World as any)();
    await w.handleStart();
    await settle(w);
    expect(w.titan).toMatchObject({ number: 1, hp: 40_000, hpMax: 40_000, status: "awake", wokeAt: T0 });
    spec = makeTitan(w.titan.seed, 1);
    expect(w.mockDb.Titan.rows).toHaveLength(1);
    expect(w.mockDb.Titan.rows[0]).toMatchObject({ number: 1, seed: w.titan.seed, status: "awake" });
    expect(w.schedules.get("escape")).toBe(T0 + 8 * 3600_000);
    expect(w.titan.recordId).toBe(w.mockDb.Titan.rows[0].id);
  });

  it("welcomes, relays hunters and keeps one hp for everyone", async () => {
    A = await connect(w, "a");
    B = await connect(w, "b");
    expect(A.last("welcome")).toMatchObject({ titan: { number: 1 }, hp: 40_000, stage: 0 });
    await send(w, A, { t: "hello", key: key("a"), name: "Ana http://spam.com", sigil: 3, aspect: "lance" });
    await send(w, B, { t: "hello", key: key("b"), name: "Bo", sigil: 9, aspect: "ember" });
    expect(B.inbox.find((m) => m.t === "join" && m.r[0] === 1).r.slice(1)).toEqual([expect.not.stringMatching(/spam|http/), 3, "lance"]);
    const [core, beat] = openBeat(spec, 40);
    at(beat);
    await send(w, A, { t: "pos", x: 1, y: 4, alive: true, flags: 1 });
    await send(w, B, { t: "pos", x: -2, y: 6, alive: true, flags: 0 });
    await w.handleTick();
    expect(A.last("s").h).toEqual(expect.arrayContaining([[1, 20, 80, 3, 1], [2, -40, 120, 9, 0]]));

    await send(w, A, { t: "hit", hits: [[core, 50, beat], [core, 60, beat - 0.2, 1]] });
    expect(A.last("ack")).toMatchObject({ ok: 110, bad: 0, hp: 39_890 });
    await send(w, A, { t: "hit", hits: [[core, 50, beat + 5], [core, 9999, beat], [core, 50, beat]] });
    expect(A.last("ack")).toMatchObject({ ok: 50, bad: 2 });
    await w.handleTick();
    expect(B.last("s").hp).toBe(39_840);
    expect(B.last("s").f?.some((f: any) => f.k === "surge")).toBe(true);
  });

  it("rejects hits from hunters who never said hello", async () => {
    const C = await connect(w, "c");
    const [core, beat] = openBeat(spec, 40);
    await send(w, C, { t: "hit", hits: [[core, 10, beat]] });
    expect(C.last("ack")).toMatchObject({ ok: 0, why: "noHello" });
    w.conns.pop();
    await w.handleClose(C);
  });

  it("revives a downed hunter when a live one flies through the spark", async () => {
    await send(w, A, { t: "down", x: 0, y: 5 });
    expect(B.last("down")).toMatchObject({ id: 1, x: 0, y: 100 });
    // a stale "alive" sample right after the down must not clear the spark
    await send(w, A, { t: "pos", x: 0, y: 5, alive: true, flags: 0 });
    expect(w.sparks.has("a")).toBe(true);
    vi.setSystemTime(Date.now() + 100);
    await send(w, B, { t: "pos", x: -1.5, y: 5.3, alive: true, flags: 0 });
    vi.setSystemTime(Date.now() + 100);
    await send(w, B, { t: "pos", x: 1.5, y: 5.3, alive: true, flags: 0 });
    expect(A.last("revive")).toMatchObject({ who: 1, by: 2, byName: "Bo" });
  });

  it("records runs bounded by accepted damage, upserts the hunter, stores the echo", async () => {
    const startT = (Date.now() - w.titan.wokeAt) / 1000 - 2;
    vi.setSystemTime(Date.now() + 12_000);
    const path = encodePath(Array.from({ length: 100 }, (_, i) => [Math.round(Math.cos(i / 9) * 40), 80 + Math.round(Math.sin(i / 9) * 30)]).flat());
    await send(w, A, { t: "run", titan: 1, damage: 5000, time: 10, grazes: 4, bestCombo: 3, surges: 1, aspect: "lance", startT, stage: 0, path });
    expect(A.last("runAck")).toEqual(expect.objectContaining({ damage: 160, clamped: true, echo: true }));
    await settle(w);
    expect(w.mockDb.Run.rows).toHaveLength(1);
    expect(w.mockDb.Run.rows[0]).toMatchObject({ titanNumber: 1, damage: 160, time: 10, aspect: "lance", name: expect.any(String) });
    expect(w.mockDb.Run.rows[0].hunterKey).toMatch(/^[0-9a-f]{16}$/);
    expect(w.mockDb.Run.rows[0].hunterKey).not.toContain("aaaa");
    expect(w.mockDb.Hunter.rows).toHaveLength(1);
    expect(w.mockDb.Hunter.rows[0]).toMatchObject({ damageTotal: 160, runs: 1, bestRun: 160 });
    expect(w.mockDb.Echo.rows).toHaveLength(1);
    expect(w.mockDb.Echo.rows[0]).toMatchObject({ titanSeed: spec.seed, stage: 0, duration: 10, damage: 160 });
    // the same run again changes nothing; a "fresh" run with no new accepted blows adds a run but no damage (no replays)
    await send(w, A, { t: "run", titan: 1, damage: 10, time: 10, grazes: 0, bestCombo: 0, surges: 0, aspect: "lance", startT, stage: 0, path });
    vi.setSystemTime(Date.now() + 6000);
    await send(w, A, { t: "run", titan: 1, damage: 10, time: 3, grazes: 0, bestCombo: 0, surges: 0, aspect: "lance", startT: startT + 1, stage: 0, path: "" });
    await settle(w);
    expect(w.mockDb.Run.rows).toHaveLength(2);
    expect(w.mockDb.Hunter.rows).toHaveLength(1);
    expect(w.mockDb.Hunter.rows[0]).toMatchObject({ damageTotal: 160, runs: 2, bestRun: 160 });
  });

  it("persists hp (throttled) and restores everything after the session idles", async () => {
    vi.setSystemTime(Date.now() + 3000);
    await w.handleTick();
    expect(w.storage.map.get("hp")).toBe(39_840);
    w.conns.splice(w.conns.indexOf(B), 1);
    await w.handleClose(B);
    w.conns.length = 0;
    await w.handleClose(A); // last one out flushes storage
    const w2: W = new (World as any)();
    w2.storage = w.storage;
    w2.mockDb = w.mockDb;
    w2.client = w.client;
    await w2.handleStart();
    expect(w2.titan).toMatchObject({ number: 1, hp: 39_840, seed: w.titan.seed, recordId: w.titan.recordId });
    expect([...w2.credits.values()][0]).toMatchObject({ dmg: 160 });
    w = w2;
    A = await connect(w, "a");
    B = await connect(w, "b");
    await send(w, A, { t: "hello", key: key("a"), name: "Ana", sigil: 3, aspect: "lance" });
    await send(w, B, { t: "hello", key: key("b"), name: "Bo", sigil: 9, aspect: "ember" });
  });

  it("fells the titan on the final blow, writes the hall record, wakes the next after 20 s", async () => {
    w.titan.hp = 30;
    const [core, beat] = openBeat(spec, (Date.now() - w.titan.wokeAt) / 1000 / spec.beat + 1);
    at(beat);
    await send(w, B, { t: "pos", x: 0, y: 4, alive: true, flags: 0 });
    await send(w, B, { t: "hit", hits: [[core, 50, beat]] });
    await settle(w);
    const felled = A.last("felled");
    expect(felled.end).toMatchObject({ number: 1, status: "felled", blow: { name: "Bo", sigil: 9 }, damageTotal: 40_000 });
    expect(felled.next).toMatchObject({ number: 2, wokeAt: felled.n + 20_000, status: "awake" });
    expect(B.last("ack")).toMatchObject({ ok: 30, hp: 0 });
    const t1 = w.mockDb.Titan.rows.find((r: any) => r.number === 1);
    expect(t1).toMatchObject({ status: "felled", finalBlowName: "Bo", finalBlowSigil: 9, hp: 0 });
    expect(t1.topHunters[0]).toMatchObject({ name: "Ana", damage: 160 });
    expect(w.mockDb.Titan.rows.find((r: any) => r.number === 2)).toMatchObject({ status: "awake", wokeAt: felled.next.wokeAt });
    expect(w.mockDb.Hunter.rows.find((r: any) => r.name === "Bo")).toMatchObject({ titansFelled: 1 });
    expect(w.schedules.get("wake")).toBe(felled.next.wokeAt);

    await send(w, A, { t: "hit", hits: [[core, 10, beat]] });
    expect(A.last("ack")).toMatchObject({ ok: 0, why: "asleep" });
    const w2 = await connect(w, "late");
    expect(w2.last("welcome")).toMatchObject({ titan: { number: 2 }, last: { number: 1, blow: { name: "Bo" } } });
    w.conns.pop();

    vi.setSystemTime(felled.next.wokeAt + 5);
    await w.handleWake("wake");
    expect(A.last("wake")).toMatchObject({ titan: { number: 2 }, hp: felled.next.hpMax });
  });

  it("lets an unfought titan escape after 8 hours", async () => {
    vi.setSystemTime(w.titan.wokeAt + 8 * 3600_000 + 10);
    await w.handleWake("escape");
    await settle(w);
    expect(A.last("felled").end).toMatchObject({ number: 2, status: "escaped", blow: null });
    expect(w.mockDb.Titan.rows.find((r: any) => r.number === 2)).toMatchObject({ status: "escaped" });
    expect(w.titan.number).toBe(3);
  });

  it("writes only echoes from test sessions", async () => {
    const t: W = new (World as any)();
    t.instanceId = "world-check";
    await t.handleStart();
    await settle(t);
    expect(t.titan.number).toBe(1);
    expect(t.mockDb.Titan.rows).toHaveLength(0);
  });
});

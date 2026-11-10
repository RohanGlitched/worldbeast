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
    expect(w.titan).toMatchObject({ number: 1, hp: 10_000, hpMax: 10_000, status: "awake", wokeAt: T0 });
    spec = makeTitan(w.titan.seed, 1);
    expect(w.mockDb.Titan.rows).toHaveLength(1);
    expect(w.mockDb.Titan.rows[0]).toMatchObject({ number: 1, seed: w.titan.seed, status: "awake" });
    expect(w.schedules.get("escape")).toBe(T0 + 8 * 3600_000);
    expect(w.titan.recordId).toBe(w.mockDb.Titan.rows[0].id);
  });

  it("welcomes, relays hunters and keeps one hp for everyone", async () => {
    A = await connect(w, "a");
    B = await connect(w, "b");
    expect(A.last("welcome")).toMatchObject({ titan: { number: 1 }, hp: 10_000, stage: 0 });
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
    expect(A.last("ack")).toMatchObject({ ok: 110, bad: 0, hp: 9_890 });
    await send(w, A, { t: "hit", hits: [[core, 50, beat + 5], [core, 9999, beat], [core, 50, beat]] });
    expect(A.last("ack")).toMatchObject({ ok: 50, bad: 2 });
    await w.handleTick();
    expect(B.last("s").hp).toBe(9_840);
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
    // the run gets one chronicle line, with the blows the world recorded (not the 5,000 claimed)
    await w.handleTick();
    expect(w.feed.filter((f: any) => f.k === "run")).toEqual([expect.objectContaining({ k: "run", v: 160, sigil: 3 })]);
    expect(B.inbox.some((m) => m.t === "s" && m.f?.some((f: any) => f.k === "run" && f.v === 160))).toBe(true);
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
    expect(w.storage.map.get("hp")).toBe(9_840);
    w.conns.splice(w.conns.indexOf(B), 1);
    await w.handleClose(B);
    w.conns.length = 0;
    await w.handleClose(A); // last one out flushes storage
    const w2: W = new (World as any)();
    w2.storage = w.storage;
    w2.mockDb = w.mockDb;
    w2.client = w.client;
    await w2.handleStart();
    expect(w2.titan).toMatchObject({ number: 1, hp: 9_840, seed: w.titan.seed, recordId: w.titan.recordId });
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
    expect(felled.end).toMatchObject({ number: 1, status: "felled", blow: { name: "Bo", sigil: 9 }, damageTotal: 10_000 });
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

  it("keeps an unwounded titan awake past 8 hours: nobody struck it, so it cannot escape", async () => {
    const n = w.titan.number;
    vi.setSystemTime(w.titan.wokeAt + 9 * 3600_000);
    await w.handleWake("escape");
    await settle(w);
    expect(w.titan.number).toBe(n);
    expect(w.titan.status).toBe("awake");
  });

  it("starts the escape clock at the first wound: a 9-hour sleeper struck now stays awake", async () => {
    const n = w.titan.number;
    vi.setSystemTime(w.titan.wokeAt + 9 * 3600_000);
    w.titan.hp = w.titan.hpMax - 500; // the first blow lands now
    await w.handleWake("escape");
    await settle(w);
    expect(w.titan.number).toBe(n);
    expect(w.titan.status).toBe("awake");
    expect(w.titan.lastWoundAt).toBeGreaterThan(0);
  });

  it("keeps a titan the world is still wounding: no escape while blows keep landing", async () => {
    const n = w.titan.number;
    w.titan.hp = w.titan.hpMax - 500;
    w.titan.firstWoundAt = w.titan.wokeAt + 1000;
    w.titan.lastWoundAt = w.titan.wokeAt + 7 * 3600_000;
    vi.setSystemTime(w.titan.wokeAt + 9 * 3600_000);
    await w.handleWake("escape");
    await settle(w);
    expect(w.titan.number).toBe(n);
  });

  it("lets a wounded titan escape after 8 hours with no new wound", async () => {
    w.titan.hp = w.titan.hpMax - 500;
    w.titan.firstWoundAt = w.titan.wokeAt + 1000;
    w.titan.lastWoundAt = w.titan.wokeAt + 1000;
    vi.setSystemTime(w.titan.lastWoundAt + 8 * 3600_000 + 10);
    await w.handleWake("escape");
    await settle(w);
    expect(A.last("felled").end).toMatchObject({ number: 2, status: "escaped", blow: null });
    expect(w.mockDb.Titan.rows.find((r: any) => r.number === 2)).toMatchObject({ status: "escaped" });
    expect(w.titan.number).toBe(3);
  });

  it("re-sizes a titan woken under the old rule once, keeping every blow, and tells everyone", async () => {
    // a saved world from before the rule: titan #1 at the old 40,000 floor with 2,000 blows struck
    const old: W = new (World as any)();
    await old.handleStart();
    await settle(old);
    old.storage.map.delete("hpRule");
    old.storage.map.set("titan", { ...old.storage.map.get("titan"), hpMax: 40_000, hp: 38_000 });
    old.storage.map.set("hp", 38_000);
    old.mockDb.Titan.rows[0].hpMax = 40_000;
    const w2: W = new (World as any)();
    w2.storage = old.storage;
    w2.mockDb = old.mockDb;
    w2.client = old.client;
    const C = new MockConn("c");
    w2.conns.push(C);
    await w2.handleStart();
    await settle(w2);
    expect(w2.titan).toMatchObject({ number: 1, hpMax: 10_000, hp: 8_000 });
    expect(w2.storage.map.get("hp")).toBe(8_000);
    expect(w2.mockDb.Titan.rows[0]).toMatchObject({ hpMax: 10_000, hp: 8_000, damageTotal: 2_000 });
    expect(C.last("wake")).toMatchObject({ titan: { number: 1, hpMax: 10_000 }, hp: 8_000 });
    // only once: a later restore leaves the titan's size alone even when the rule would now give a smaller one
    const w3: W = new (World as any)();
    w3.storage = w2.storage;
    w3.mockDb = w2.mockDb;
    w3.client = w2.client;
    w3.storage.map.set("titan", { ...w3.storage.map.get("titan"), hpMax: 30_000 });
    w3.storage.map.set("hp", 30_000);
    await w3.handleStart();
    expect(w3.titan).toMatchObject({ hpMax: 30_000, hp: 30_000 });
  });

  it("writes only echoes from test sessions", async () => {
    const t: W = new (World as any)();
    t.instanceId = "world-check";
    await t.handleStart();
    await settle(t);
    expect(t.titan.number).toBe(1);
    expect(t.mockDb.Titan.rows).toHaveLength(0);
  });

  it("a lone hunter in a quiet world is credited in full, past 40% of the titan's life (R5: they were capped and scolded)", async () => {
    const t: W = new (World as any)();
    await t.handleStart();
    await settle(t);
    const s = makeTitan(t.titan.seed, 1);
    const C = new MockConn("solo");
    t.conns.push(C);
    await t.handleConnect(C);
    await send(t, C, { t: "hello", key: key("c"), name: "Cy", sigil: 2, aspect: "lance" });
    const hk = t.hunters.get("solo").key;
    t.credits.set(hk, { name: "Cy", sigil: 2, dmg: 6_000 }); // well past 40% of a 10,000 titan, alone
    const [core, beat] = openBeat(s, 4);
    vi.setSystemTime(t.titan.wokeAt + beat * s.beat * 1000);
    await send(t, C, { t: "pos", x: 0, y: 4, alive: true, flags: 0 });
    const hp0 = t.titan.hp;
    await send(t, C, { t: "hit", hits: [[core, 50, beat]], q: 7 });
    expect(C.last("ack")).toMatchObject({ ok: 50, q: 7 });
    expect(C.last("ack").rs).toBeUndefined();
    expect(hp0 - t.titan.hp).toBe(50);
  });

  it("while others share the titan, past 40% of its life one hunter's blows land at a quarter; runs still count them", async () => {
    const t: W = new (World as any)();
    await t.handleStart();
    await settle(t);
    const s = makeTitan(t.titan.seed, 1);
    const [C, D] = [new MockConn("solo"), new MockConn("two")];
    for (const [c, ch, nm] of [[C, "c", "Cy"], [D, "d", "Di"]] as const) {
      t.conns.push(c);
      await t.handleConnect(c);
      await send(t, c, { t: "hello", key: key(ch), name: nm, sigil: 2, aspect: "lance" });
    }
    const hk = t.hunters.get("solo").key;
    const [core, beat] = openBeat(s, 4);
    vi.setSystemTime(t.titan.wokeAt + beat * s.beat * 1000);
    await send(t, C, { t: "pos", x: 0, y: 4, alive: true, flags: 0 });
    await send(t, D, { t: "pos", x: 1, y: 4, alive: true, flags: 0 });
    // Di strikes first (within the last 2 hours), so the titan is shared
    await send(t, D, { t: "hit", hits: [[core, 50, beat]] });
    expect(D.last("ack")).toMatchObject({ ok: 50 });
    t.credits.set(hk, { name: "Cy", sigil: 2, dmg: 3_990 }); // 10 short of 40% of a 10,000 titan
    const hp0 = t.titan.hp;
    await send(t, C, { t: "hit", hits: [[core, 50, beat]] });
    expect(C.last("ack")).toMatchObject({ ok: 20, rs: 30 }); // 10 at full strength, 40 at a quarter
    expect(hp0 - t.titan.hp).toBe(20);
    expect(t.credits.get(hk).dmg).toBe(4_010);
    expect(t.hunters.get("solo").acc).toBe(50); // the run is bounded by what they landed, not what wounded it
    // Di, under 40%, is struck at full strength
    await send(t, D, { t: "hit", hits: [[core, 50, beat]] });
    expect(D.last("ack")).toMatchObject({ ok: 50 });
    expect(D.last("ack").rs).toBeUndefined();
    // two hours after Di's last blow the world is quiet again: Cy is credited in full
    t.strikes.set(t.hunters.get("two").key, Date.now() - 2 * 3600_000 - 1);
    await send(t, C, { t: "hit", hits: [[core, 40, beat]] });
    expect(C.last("ack")).toMatchObject({ ok: 40 });
    expect(C.last("ack").rs).toBeUndefined();
    // and who struck lately survives the session idling
    await t.flush(true);
    expect(new Map(t.storage.map.get("strikes")).has(hk)).toBe(true);
    expect(new Map(t.storage.map.get("strikes")).has(t.hunters.get("two").key)).toBe(false);
  });

  it("a dropped socket that redials on the same id keeps its hunter: queued hits count, the run ledger survives", async () => {
    const t: W = new (World as any)();
    await t.handleStart();
    await settle(t);
    const s = makeTitan(t.titan.seed, 1);
    let C = new MockConn("re");
    t.conns.push(C);
    await t.handleConnect(C);
    await send(t, C, { t: "hello", key: key("e"), name: "Eo", sigil: 5, aspect: "ember" });
    const [core, beat] = openBeat(s, 4);
    vi.setSystemTime(t.titan.wokeAt + beat * s.beat * 1000);
    await send(t, C, { t: "pos", x: 0, y: 4, alive: true, flags: 0 });
    await send(t, C, { t: "hit", hits: [[core, 30, beat]] });
    const num = t.hunters.get("re").num;
    // the socket drops; the SDK redials on the same id and flushes the hits it queued before the hello goes out
    t.conns.splice(t.conns.indexOf(C), 1);
    await t.handleClose(C);
    C = new MockConn("re");
    t.conns.push(C);
    await t.handleConnect(C);
    expect(C.last("welcome").you).toBe(num);
    await send(t, C, { t: "hit", hits: [[core, 20, beat]], q: 3 });
    expect(C.last("ack")).toMatchObject({ ok: 20, q: 3 });
    expect(t.hunters.get("re").acc).toBe(50);
    // the new socket arrived before the old one's close: the close must not take the hunter away
    const C2 = new MockConn("re");
    t.conns.push(C2);
    await t.handleConnect(C2);
    t.conns.splice(t.conns.indexOf(C), 1);
    await t.handleClose(C);
    expect(t.hunters.get("re")?.key).toBeTruthy();
  });

  it("a connection that says bye leaves the world at once, even while its socket lingers", async () => {
    const t: W = new (World as any)();
    await t.handleStart();
    await settle(t);
    const [A1, A2, B1] = [new MockConn("a1"), new MockConn("a2"), new MockConn("b1")];
    for (const c of [A1, A2, B1]) {
      t.conns.push(c);
      await t.handleConnect(c);
    }
    await send(t, A1, { t: "hello", key: key("a"), name: "Ana", sigil: 1, aspect: "ember" });
    expect(B1.last("welcome").online).toBe(3);
    const numA1 = t.hunters.get("a1").num;
    await send(t, A1, { t: "bye" });
    expect(B1.last("leave")).toMatchObject({ id: numA1 });
    expect(t.hunters.has("a1")).toBe(false);
    await send(t, A1, { t: "hello", key: key("a"), name: "Ana", sigil: 1, aspect: "ember" }); // ignored
    expect(t.hunters.has("a1")).toBe(false);
    vi.setSystemTime(Date.now() + 200);
    t.dirty = true;
    await t.handleTick();
    expect(B1.last("s").c).toBe(2);
  });

  it("the next titan never has the body of the one just felled", async () => {
    const t: W = new (World as any)();
    await t.handleStart();
    await settle(t);
    for (let k = 0; k < 6; k++) {
      const before = makeTitan(t.titan.seed, t.titan.number).archetype;
      t.titan.hp = 0.5;
      await t.endTitan("felled", Date.now(), null);
      await settle(t);
      expect(makeTitan(t.titan.seed, t.titan.number).archetype).not.toBe(before);
    }
  });
});

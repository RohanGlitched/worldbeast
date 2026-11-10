import { Actor } from "base44:runtime/actors";
import { hash32 } from "./core/rng.ts";
import { makeTitan, PHRASE_BEATS, Stage, stageFor, TitanSpec } from "./core/titan.ts";
import {
  addDamage, breakThreshold, Bucket, checkHit, checkRun, clampPos, creditBlow, DmgBuckets, echoEviction, ESCAPE_MS, hashKey, HourCap, hpMaxFor,
  INTERLUDE_MS, HP_RULE, LIMITS, loopKey, MAX_HITS_PER_MSG, othersStriking, prepareEcho, AspectRate, RESUME_MS, REVIVE_R,
  sanitizeAspect, sanitizeName, resizeTitan, sanitizeSigil, segDist, SHARED_MS, shareId, SPARK_MS, titanSeed, titanT, topHunters,
  validKey,
} from "./logic.ts";
import type { FeedItem, HitWhy, HunterRow, RosterRow, RunMsg, SparkRow, TitanEnd, TitanInfo, ToClient, ToServer } from "./shared/types.ts";
import { F_DOWN, HIT_SURGE, Q, WORLD_SESSION } from "./shared/types.ts";

// The world: one titan at a time, every hunter in one session. The fight itself is closed form
// (core/field.ts), so this only keeps the clock, the global HP, the titan lifecycle and the relay.

interface Conn {
  id: string;
  identity: { type: string; userId?: string; anonymousId?: string };
  send(m: ToClient): void;
}

interface TitanState extends TitanInfo {
  hp: number;
  stageAt: number[]; // titan seconds when stage 1 and 2 began
  recordId?: string;
  endedAt?: number;
  /** when the world first wounded it (kept for the record) */
  firstWoundAt?: number;
  /** when it was last wounded: it escapes only after ESCAPE_MS with no new wound (a sleeper never escapes) */
  lastWoundAt?: number;
}

interface Hunter {
  num: number;
  key?: string; // hashed
  /** who this hunter is for the sharing rule (logic.ts shareId): their account if signed in, else `key` */
  who?: string;
  name: string;
  sigil: number;
  aspect: string;
  x: number;
  y: number;
  qx: number;
  qy: number;
  flags: number;
  alive: boolean;
  posAt: number; // ms of last pos
  movedAt: number;
  downAt: number;
  buckets: Record<string, Bucket>;
  acc: number; // damage accepted from this connection, all time
  accLog: Array<[number, number, number]>; // [titanNumber, titanT, acc before that batch]
  lastSurgeAt: number;
  lastRunStart: number;
  lastRunDamage?: number;
  lastRunId?: string;
  claimedAcc?: number; // accepted damage already credited to the hunter's totals
  dropped: number;
}

interface Credit {
  name: string;
  sigil: number;
  dmg: number;
}

const TICK_MS = 100;
const SHOW_MAX = 40;
const IDLE_POS_MS = 5_000;
const FEED_MAX = 12;
const HP_SAVE_MS = 2_000;
const BULK_SAVE_MS = 10_000;
const TITAN_RECORD_MS = 60_000;
const CREDITS_KEEP = 300;
const LANES = 4;

/** a hit message's sequence number, echoed in its ack (types.ts) */
const seq = (q: unknown): { q?: number } => (typeof q === "number" && Number.isInteger(q) && q >= 0 && q < 2 ** 31 ? { q } : {});

export default class World extends Actor<ToServer, ToClient> {
  tickIntervalMs = TICK_MS;

  private ready: Promise<void> | null = null;
  private salt = "";
  private titan!: TitanState;
  private spec!: TitanSpec;
  private last: TitanEnd | null = null; // the titan that ended most recently
  private lastSpec: TitanSpec | null = null;
  private lastStageAt: number[] = [];
  private dmg24: DmgBuckets = [];
  /** distinct hunters who struck in the current hour (sizes the next titan; lost on idle, which only undercounts) */
  private hourKeys = new Set<string>();
  private hourKeysAt = -1;
  private credits = new Map<string, Credit>();
  /** the awake titan's strikers (logic.ts shareId -> ms of their last wound): is it shared right now? */
  private strikes = new Map<string, number>();
  /** blows credited per sharing identity (a signed-in hunter's keys together; else the same as `credits`) */
  private shareCredit = new Map<string, number>();
  private feed: FeedItem[] = [];
  private hunters = new Map<string, Hunter>();
  /** hunters whose connection just dropped, kept for a reconnect on the same connection id (RESUME_MS) */
  private parked = new Map<string, { h: Hunter; at: number }>();
  /** connections that said "bye" (abandoned for a better route): out of the world even while their socket lingers */
  private gone = new Set<string>();
  private rates = new Map<string, AspectRate>();
  /** blows credited per hunter key this hour (logic.ts HOUR_CAP, anti-farm) */
  private hourly = new Map<string, HourCap>();
  private sparks = new Map<string, { x: number; y: number; until: number }>();
  private hunterCache = new Map<string, { id: string; damageTotal: number; runs: number; bestRun: number; titansFelled: number }>();
  private nextNum = 1;
  private dirty = true;
  private pendingFeed: FeedItem[] = [];
  private hpDirtyAt = 0;
  private bulkDirtyAt = 0;
  private lastHpSave = 0;
  private lastBulkSave = 0;
  private lastRecordSave = 0;
  private announcedWake = 0;
  private corePhrase = -1;
  private coreDmg: number[] = [];
  private lanes: Promise<void>[] = Array.from({ length: LANES }, () => Promise.resolve());
  private pending = 0;
  private stats = { accepted: 0, rejected: 0, dropped: 0 };

  // ---------------------------------------------------------------- lifecycle

  async handleStart() {
    this.ready = this.restore().catch((e) => this.log("restore", e));
    await this.ready;
  }

  private async wipeRecords() {
    for (const name of ["Echo", "Run", "Hunter", "Titan"] as const) {
      try {
        for (let round = 0; round < 20; round++) {
          const rows = await this.db[name].list("-created_date", 500, 0, ["id"]);
          if (!rows.length) break;
          for (const r of rows) await this.db[name].delete(r.id).catch(() => {});
        }
      } catch (e) {
        this.log("wipe " + name, e);
      }
    }
  }

  /**
   * One time per HP_RULE: the titan already awake takes the size the current rule gives it (from the actor's
   * own record of recent hunting). Every blow already struck still counts; nothing is invented or erased.
   */
  private async migrateHpRule(now: number) {
    const st = this.storage;
    if ((await st.get<number>("hpRule")) === HP_RULE) return;
    await st.put("hpRule", HP_RULE);
    const t = this.titan;
    if (!t || t.status !== "awake") return;
    const r = resizeTitan(t, hpMaxFor(this.dmg24, now));
    if (!r) return;
    this.log("hp rule", new Error(`titan ${t.number}: ${t.hpMax} -> ${r.hpMax} (${t.hpMax - t.hp} blows kept)`));
    t.hpMax = r.hpMax;
    t.hp = r.hp;
    await st.put("titan", t);
    await st.put("hp", t.hp);
    const stg = stageFor(t.hp / t.hpMax);
    if (stg > t.stageAt.length && now >= t.wokeAt) this.enterStage(stg, now);
    if (t.recordId) {
      const id = t.recordId;
      const rec = { hpMax: t.hpMax, hp: Math.round(t.hp), damageTotal: Math.round(t.hpMax - t.hp) };
      this.write("titan", () => this.db.Titan.update(id, rec));
    }
    this.broadcast({ t: "wake", n: now, titan: this.info(), hp: Math.round(t.hp) });
  }

  private async restore() {
    const st = this.storage;
    let salt = await st.get<string>("salt");
    if (!salt) {
      salt = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()) + Date.now();
      await st.put("salt", salt);
    }
    this.salt = salt;
    this.dmg24 = (await st.get<DmgBuckets>("dmg24")) ?? [];
    this.feed = (await st.get<FeedItem[]>("feed")) ?? [];
    this.last = (await st.get<TitanEnd>("last")) ?? null;
    this.lastStageAt = (await st.get<number[]>("lastStageAt")) ?? [];
    const credits = (await st.get<Array<[string, string, number, number]>>("credits")) ?? [];
    this.credits = new Map(credits.map(([k, name, sigil, dmg]) => [k, { name, sigil, dmg }]));
    this.strikes = new Map((await st.get<Array<[string, number]>>("strikes")) ?? []);
    const titan = await st.get<TitanState>("titan");
    const now = Date.now();
    if (!titan) {
      // launch: the real world starts clean (one time, only in the live session): every record the
      // test world wrote (titans, hunters, runs, echoes) is removed before titan #1 wakes
      if (this.instanceId === WORLD_SESSION && !(await st.get<boolean>("wiped-v1"))) {
        await this.wipeRecords();
        await st.put("wiped-v1", true);
      }
      await this.wakeTitan(1, now);
    } else {
      this.titan = titan;
      const hp = await st.get<number>("hp");
      if (typeof hp === "number") this.titan.hp = hp;
      this.spec = makeTitan(titan.seed, titan.number);
      await this.migrateHpRule(now);
      if (this.last) this.lastSpec = makeTitan(this.last.seed, this.last.number);
      this.announcedWake = now >= titan.wokeAt ? titan.number : 0;
    }
    // connections that stayed open through an idle period lost their in-memory state
    for (const c of this.getConnections() as Conn[]) if (!this.hunters.has(c.id)) this.welcome(c, now);
    await this.checkTimers(now);
  }

  private async ensureReady() {
    if (!this.ready) this.ready = this.restore().catch((e) => this.log("restore", e));
    await this.ready;
  }

  shouldTick() {
    return this.getConnections().length > 0;
  }

  async handleConnect(conn: Conn) {
    try {
      await this.ensureReady();
      const now = Date.now();
      // a dropped connection coming back on the same id (the SDK's socket redials with it) is the same hunter:
      // same key, number and run ledger, so hits it queued while the socket was down still count
      const p = this.parked.get(conn.id);
      this.parked.delete(conn.id);
      if (p && now - p.at < RESUME_MS && !this.hunters.has(conn.id)) {
        this.hunters.set(conn.id, p.h);
        if (p.h.key) this.broadcast({ t: "join", n: now, r: [p.h.num, p.h.name, p.h.sigil, p.h.aspect] });
      }
      this.welcome(conn, now);
    } catch (e) {
      this.log("connect", e);
    }
  }

  async handleClose(conn: Conn) {
    try {
      const now = Date.now();
      this.gone.delete(conn.id);
      // the SDK redials a dropped socket on the same id; if the new socket is already in, this close is the old
      // one's and the hunter is still here
      if ((this.getConnections() as Conn[]).some((c) => c !== conn && c.id === conn.id)) return;
      const h = this.hunters.get(conn.id);
      this.hunters.delete(conn.id);
      this.sparks.delete(conn.id);
      if (h) {
        if (h.key) {
          for (const [id, q] of this.parked) if (now - q.at >= RESUME_MS) this.parked.delete(id);
          if (this.parked.size < 2000) this.parked.set(conn.id, { h, at: now });
        }
        this.broadcast({ t: "leave", n: now, id: h.num });
        this.dirty = true;
      }
      if (this.getConnections().length === 0) {
        await this.flush(true);
        await Promise.all(this.lanes); // let entity writes finish before the session can idle
      }
    } catch (e) {
      this.log("close", e);
    }
  }

  async handleWake(key: string) {
    try {
      await this.ensureReady();
      await this.checkTimers(Date.now());
      await Promise.all(this.lanes);
    } catch (e) {
      this.log("wake:" + key, e);
    }
  }

  async handleTick() {
    try {
      const now = Date.now();
      await this.checkTimers(now);
      for (const [id, s] of this.sparks) if (s.until <= now) this.sparks.delete(id);
      if (this.dirty || this.pendingFeed.length) this.broadcastState(now);
      await this.flush(false);
    } catch (e) {
      this.log("tick", e);
    }
  }

  async handleMessage(conn: Conn, msg: ToServer) {
    try {
      if (!msg || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") return;
      if (this.gone.has(conn.id)) return;
      await this.ensureReady();
      const now = Date.now();
      if (msg.t === "bye") return this.onBye(conn, now);
      let h = this.hunters.get(conn.id);
      if (!h) h = this.addHunter(conn.id, now);
      if (!Object.prototype.hasOwnProperty.call(LIMITS, msg.t)) return;
      const lim = LIMITS[msg.t];
      const b = (h.buckets[msg.t] ??= new Bucket(lim[0], lim[1]));
      if (!b.take(now)) {
        if (msg.t === "hit") conn.send({ t: "ack", n: now, ok: 0, bad: Array.isArray(msg.hits) ? msg.hits.length : 0, why: "rate", hp: this.titan.hp, ...seq(msg.q) });
        return;
      }
      switch (msg.t) {
        case "ping":
          if (typeof msg.c === "number" && Number.isFinite(msg.c)) conn.send({ t: "pong", n: Date.now(), c: msg.c });
          return;
        case "hello":
          return this.onHello(conn, h, msg, now);
        case "pos":
          return this.onPos(conn.id, h, msg, now);
        case "hit":
          return this.onHits(conn, h, msg.hits, now, seq(msg.q));
        case "down":
          return this.onDown(conn.id, h, msg, now);
        case "run":
          return this.onRun(conn, h, msg, now);
      }
    } catch (e) {
      this.log("message", e);
    }
  }

  // ---------------------------------------------------------------- hunters

  /**
   * The browser is abandoning this connection for another (a better route). The gateway may keep the socket
   * half-closed for up to a minute, so it leaves the world now: no ghost watcher in the head-count, no ghost
   * hunter in the roster, and nothing more is read from it.
   */
  private onBye(conn: Conn, now: number) {
    // a stale socket saying goodbye while its id has already redialled on a fresh socket: the hunter stays
    if ((this.getConnections() as Conn[]).some((c) => c !== conn && c.id === conn.id)) return;
    if (this.gone.size > 5000) this.gone.clear();
    this.gone.add(conn.id);
    const h = this.hunters.get(conn.id);
    this.hunters.delete(conn.id);
    this.sparks.delete(conn.id);
    this.parked.delete(conn.id);
    if (h) this.broadcast({ t: "leave", n: now, id: h.num });
    this.dirty = true;
  }

  /**
   * connected browsers, without the ones that said bye. Counted by connection id: a browser whose socket dropped
   * redials on the same id, and the gateway can hold the dead socket half-open for a minute (R6: one watcher
   * read as "2 watching" for ~60 s after a network blip)
   */
  private onlineCount(): number {
    const ids = new Set<string>();
    for (const c of this.getConnections() as Conn[]) if (!this.gone.has(c.id)) ids.add(c.id);
    return ids.size;
  }

  private addHunter(id: string, now: number): Hunter {
    const h: Hunter = {
      num: this.nextNum++, name: "Hunter", sigil: 0, aspect: "ember", x: 0, y: 3, qx: 0, qy: 60, flags: 0, alive: true,
      posAt: 0, movedAt: 0, downAt: 0, buckets: {}, acc: 0, accLog: [], lastSurgeAt: 0, lastRunStart: NaN, dropped: 0,
    };
    this.hunters.set(id, h);
    return h;
  }

  private welcome(conn: Conn, now: number) {
    const h = this.hunters.get(conn.id) ?? this.addHunter(conn.id, now);
    const roster: RosterRow[] = [];
    for (const o of this.hunters.values()) if (o.key) roster.push([o.num, o.name, o.sigil, o.aspect]);
    conn.send({
      t: "welcome",
      n: now,
      you: h.num,
      titan: this.info(),
      hp: Math.max(0, Math.round(this.titan.hp)),
      stage: this.stage(),
      stageAt: this.titan.stageAt,
      online: this.onlineCount(),
      feed: this.feed,
      roster,
      h: this.rows(now, null),
      sparks: this.sparkRows(),
      last: now < this.titan.wokeAt ? this.last : null,
    });
    this.dirty = true;
  }

  private onHello(conn: Conn, h: Hunter, m: Extract<ToServer, { t: "hello" }>, now: number) {
    if (!validKey(m.key)) return;
    const first = !h.key;
    const key = hashKey(m.key, this.salt);
    // one identity per connection: a second key cannot reset this connection's damage budget
    if (h.key && h.key !== key) return;
    h.key = key;
    h.who = shareId(key, conn.identity?.userId);
    h.name = sanitizeName(m.name);
    h.sigil = sanitizeSigil(m.sigil);
    h.aspect = sanitizeAspect(m.aspect);
    this.broadcast({ t: "join", n: now, r: [h.num, h.name, h.sigil, h.aspect] });
    if (first) this.pushFeed({ k: "join", name: h.name, sigil: h.sigil, n: now }, false);
  }

  private onPos(id: string, h: Hunter, m: Extract<ToServer, { t: "pos" }>, now: number) {
    const p = clampPos(m.x, m.y);
    if (!p) return;
    const [ox, oy] = [h.x, h.y];
    const wasAlive = h.alive;
    h.x = p[0];
    h.y = p[1];
    // a sample queued before the down can arrive after it; only a revive or a new run brings you back
    h.alive = m.alive !== false && !(this.sparks.has(id) && now - h.downAt < 1000);
    h.flags = (Number.isInteger(m.flags) ? m.flags & 0x7f : 0) | (h.alive ? 0 : F_DOWN);
    const qx = Math.round(h.x * Q), qy = Math.round(h.y * Q);
    if (qx !== h.qx || qy !== h.qy || !h.posAt) h.movedAt = now;
    if (qx !== h.qx || qy !== h.qy || wasAlive !== h.alive) this.dirty = true;
    h.qx = qx;
    h.qy = qy;
    const fresh = now - h.posAt < 500; // only sweep a segment for consecutive samples
    h.posAt = now;
    if (h.alive) {
      this.sparks.delete(id);
      if (wasAlive && h.key) this.sweepSparks(id, h, fresh ? ox : h.x, fresh ? oy : h.y, now);
    }
  }

  private sweepSparks(selfId: string, h: Hunter, ax: number, ay: number, now: number) {
    for (const [id, s] of this.sparks) {
      if (id === selfId || s.until <= now) continue;
      if (segDist(s.x, s.y, ax, ay, h.x, h.y) > REVIVE_R) continue;
      const who = this.hunters.get(id);
      this.sparks.delete(id);
      if (!who) continue;
      who.alive = true;
      who.flags &= ~F_DOWN;
      this.broadcast({ t: "revive", n: now, who: who.num, by: h.num, byName: h.name });
      this.pushFeed({ k: "revive", name: h.name, sigil: h.sigil, n: now }, false);
      this.dirty = true;
    }
  }

  private onDown(id: string, h: Hunter, m: Extract<ToServer, { t: "down" }>, now: number) {
    const p = clampPos(m.x, m.y) ?? [h.x, h.y];
    h.alive = false;
    h.downAt = now;
    h.flags |= F_DOWN;
    h.x = p[0];
    h.y = p[1];
    const until = now + SPARK_MS;
    this.sparks.set(id, { x: p[0], y: p[1], until });
    this.broadcast({ t: "down", n: now, id: h.num, x: Math.round(p[0] * Q), y: Math.round(p[1] * Q), until });
    this.dirty = true;
  }

  // ---------------------------------------------------------------- damage

  private onHits(conn: Conn, h: Hunter, hits: unknown, now: number, q: { q?: number }) {
    const n = Array.isArray(hits) ? hits.length : 0;
    let why: HitWhy | undefined;
    if (!Array.isArray(hits) || n === 0 || n > MAX_HITS_PER_MSG) why = "bad";
    else if (!h.key) why = "noHello";
    else if (this.titan.status !== "awake" || now < this.titan.wokeAt) why = "asleep";
    else if (!h.alive && now - h.downAt > 1500) why = "down";
    if (why) {
      this.stats.rejected += n;
      conn.send({ t: "ack", n: now, ok: 0, bad: n, why, hp: Math.round(this.titan.hp), ...q });
      return;
    }
    const key = h.key!;
    if (this.rates.size > 4000) this.rates.clear();
    // the budget follows the identity (across reconnects) and is never looser than the aspect allows
    let rate = this.rates.get(key);
    if (!rate) rate = new AspectRate(h.aspect);
    // (an existing window is never replaced: switching light cannot reset it)
    this.rates.set(key, rate);
    // (kept per key across reconnects and titans; dropped wholesale only if the map grows huge, like rates)
    if (this.hourly.size > 20_000) this.hourly.clear();
    const hourly = this.hourly.get(key) ?? new HourCap();
    this.hourly.set(key, hourly);
    const stage = this.stage();
    const ctx = { spec: this.spec, stage, nowMs: now, wokeAt: this.titan.wokeAt };
    const accBefore = h.acc;
    // ok: what wounded the titan; raw: what this hunter landed (their runs are bounded by it). While others are
    // striking this titan too (within SHARED_MS), past SOLO_SHARE of its life one hunter's blows wound it only at
    // SOLO_RESIST; in a quiet world every blow counts in full (logic.ts creditBlow)
    let ok = 0, raw = 0, resisted = 0, bad = 0, surge = false;
    const who = h.who ?? key;
    const shared = othersStriking(this.strikes, who, now);
    let credited = Math.max(this.credits.get(key)?.dmg ?? 0, this.shareCredit.get(who) ?? 0);
    for (const row of hits as unknown[]) {
      if (this.titan.hp <= 0) break;
      const c = checkHit(row, ctx);
      if (!c.ok) {
        bad++;
        why = c.why;
        continue;
      }
      if (!rate.take(now, c.dmg)) {
        bad++;
        h.dropped++;
        this.stats.dropped++;
        why = "rate";
        continue;
      }
      const wound = creditBlow(c.dmg, credited, this.titan.hpMax, shared);
      const dmg = Math.min(wound, this.titan.hp);
      // anti-farm: past HOUR_CAP credited blows in an hour, one key's blows wound nothing (real play never gets here)
      if (dmg > 0 && !hourly.take(now, dmg)) {
        bad++;
        why = "hour";
        continue;
      }
      resisted += c.dmg - wound;
      credited += dmg;
      ok += dmg;
      raw += c.dmg;
      if (c.flags & HIT_SURGE) surge = true;
      this.titan.hp -= dmg;
      if (dmg > 0) {
        const t = this.titan;
        if (!t.firstWoundAt) t.firstWoundAt = now;
        // the escape clock restarts with every wound; persist and reschedule at most once a minute
        if (!t.lastWoundAt || now - t.lastWoundAt > 60_000) {
          t.lastWoundAt = now;
          void this.saveTitan();
          this.schedule("escape", now + ESCAPE_MS).catch((e) => this.log("schedule escape", e));
        } else t.lastWoundAt = now;
      }
      this.trackCore(h, c.core, c.beat, dmg, now);
      if (this.titan.hp <= 0) break;
    }
    this.stats.accepted += ok;
    this.stats.rejected += bad;
    if (ok > 0) {
      h.acc += raw;
      h.accLog.push([this.titan.number, titanT(now, this.titan.wokeAt), accBefore]);
      if (h.accLog.length > 2400) h.accLog.splice(0, 400);
      const cr = this.credits.get(key) ?? { name: h.name, sigil: h.sigil, dmg: 0 };
      cr.name = h.name;
      cr.sigil = h.sigil;
      cr.dmg += ok;
      this.credits.set(key, cr);
      if (who !== key) this.shareCredit.set(who, (this.shareCredit.get(who) ?? 0) + ok);
      if (this.strikes.size > 5000) for (const [k, at] of this.strikes) if (now - at >= SHARED_MS) this.strikes.delete(k);
      this.strikes.set(who, now);
      const hour = Math.floor(now / 3_600_000);
      if (hour !== this.hourKeysAt) {
        this.hourKeysAt = hour;
        this.hourKeys.clear();
      }
      if (this.hourKeys.size < 10_000) this.hourKeys.add(key);
      addDamage(this.dmg24, now, ok, this.hourKeys.size);
      if (surge && now - h.lastSurgeAt > 4000) this.pushFeed({ k: "surge", name: h.name, sigil: h.sigil, n: now }, false);
      if (surge) h.lastSurgeAt = now;
      this.hpDirtyAt ||= now;
      this.bulkDirtyAt ||= now;
      this.dirty = true;
      const st = stageFor(this.titan.hp / this.titan.hpMax);
      if (st > this.titan.stageAt.length && this.titan.hp > 0) this.enterStage(st, now);
    }
    const rs = Math.round(resisted);
    conn.send({ t: "ack", n: now, ok: Math.round(ok * 100) / 100, bad, why: bad ? why : undefined, hp: Math.max(0, Math.round(this.titan.hp)), ...(rs > 0 ? { rs } : {}), ...q });
    if (this.titan.hp <= 0 && this.titan.status === "awake") void this.endTitan("felled", now, h);
  }

  private trackCore(h: Hunter, core: number, beat: number, dmg: number, now: number) {
    const phrase = Math.floor(beat / PHRASE_BEATS);
    if (phrase !== this.corePhrase) {
      this.corePhrase = phrase;
      this.coreDmg = [];
    }
    const before = this.coreDmg[core] ?? 0;
    const after = before + dmg;
    this.coreDmg[core] = after;
    const th = breakThreshold(this.titan.hpMax);
    if (before < th && after >= th) this.pushFeed({ k: "break", name: h.name, sigil: h.sigil, v: core, n: now }, false);
  }

  private enterStage(st: Stage, now: number) {
    const t = titanT(now, this.titan.wokeAt);
    while (this.titan.stageAt.length < st) this.titan.stageAt.push(t);
    this.broadcast({ t: "stage", n: now, stage: st, hp: Math.round(this.titan.hp), at: t });
    this.pushFeed({ k: "stage", name: this.spec.name, sigil: 0, v: st, n: now }, true);
    void this.saveTitan();
  }

  private stage(): Stage {
    return Math.min(2, this.titan.stageAt.length) as Stage;
  }

  // ---------------------------------------------------------------- titan lifecycle

  private info(): TitanInfo {
    const { number, seed, wokeAt, hpMax, status } = this.titan;
    return { number, seed, wokeAt, hpMax, status };
  }

  private async wakeTitan(number: number, wokeAt: number) {
    const now = Date.now();
    const hpMax = hpMaxFor(this.dmg24, now);
    // never the same body or the same epithet twice in a row: the titan that just ended (if any) is avoided
    const prev = number > 1 ? this.lastSpec : null;
    const seed = titanSeed(number, this.salt, prev?.archetype, prev?.epithet);
    this.titan = { number, seed, wokeAt, hpMax, hp: hpMax, status: "awake", stageAt: [] };
    this.spec = makeTitan(seed, number);
    this.credits = new Map();
    this.strikes = new Map();
    this.shareCredit = new Map();
    this.coreDmg = [];
    this.corePhrase = -1;
    this.hpDirtyAt = this.bulkDirtyAt = now;
    await this.saveTitan();
    await this.storage.put("hp", hpMax);
    await this.storage.put("credits", []);
    await this.storage.put("strikes", []);
    await this.storage.put("hpRule", HP_RULE); // sized under the current rule: no migration needed later
    await this.schedule("wake", wokeAt).catch((e) => this.log("schedule wake", e));
    await this.schedule("escape", wokeAt + ESCAPE_MS).catch((e) => this.log("schedule escape", e));
    const rec = { number, seed, wokeAt, hpMax, hp: hpMax, status: "awake", hunterCount: 0, damageTotal: 0, topHunters: [] };
    this.write("titan", async () => {
      const [existing] = await this.db.Titan.filter({ number }, "-created_date", 1);
      const r = existing ? await this.db.Titan.update(existing.id, rec) : await this.db.Titan.create(rec);
      if (this.titan.number === number) {
        this.titan.recordId = r.id;
        await this.saveTitan();
      }
    });
    if (number > 24) this.write("prune", () => this.db.Echo.deleteMany({ titanNumber: number - 24 }));
  }

  /** timers: run from ticks, wakes and starts, so a missed schedule only delays, never loses, an event */
  private async checkTimers(now: number) {
    const t = this.titan;
    if (!t) return;
    // a titan escapes only if the world wounded it and could not finish it; one nobody has struck sleeps on
    // a titan escapes eight hours after the world first wounded it if the world could not finish it;
    // one nobody has struck sleeps on (a titan wounded before this rule counts from now)
    if (t.status === "awake" && t.hp < t.hpMax - 0.5) {
      // a titan wounded before this rule counts its quiet from now
      if (!t.lastWoundAt) t.lastWoundAt = now;
      else if (now >= t.lastWoundAt + ESCAPE_MS) await this.endTitan("escaped", now, null);
    }
    if (now >= this.titan.wokeAt && this.announcedWake !== this.titan.number) {
      this.announcedWake = this.titan.number;
      this.broadcast({ t: "wake", n: now, titan: this.info(), hp: Math.round(this.titan.hp) });
      this.pushFeed({ k: "wake", name: this.spec.name, sigil: 0, v: this.titan.number, n: now }, true);
    }
  }

  private async endTitan(status: "felled" | "escaped", now: number, blow: Hunter | null) {
    const t = this.titan;
    if (t.status !== "awake") return;
    t.status = status;
    t.endedAt = now;
    if (status === "felled") t.hp = 0;
    const top = topHunters(this.credits, 5);
    const end: TitanEnd = {
      number: t.number, seed: t.seed, wokeAt: t.wokeAt, hpMax: t.hpMax, status, endedAt: now,
      blow: blow ? { name: blow.name, sigil: blow.sigil } : null,
      top,
      damageTotal: Math.round(t.hpMax - Math.max(0, t.hp)),
      hunterCount: this.credits.size,
    };
    this.last = end;
    this.lastSpec = this.spec;
    this.lastStageAt = t.stageAt.slice();
    const recordId = t.recordId;
    const number = t.number;
    const rec = {
      status, hp: Math.max(0, Math.round(t.hp)), felledAt: now, topHunters: top, hunterCount: end.hunterCount, damageTotal: end.damageTotal,
      ...(blow ? { finalBlowName: blow.name, finalBlowSigil: blow.sigil } : {}),
    };
    const spec = this.spec;
    this.write("titan", async () => {
      const id = recordId ?? (await this.db.Titan.filter({ number }, "-created_date", 1))[0]?.id;
      if (!id) return;
      await this.db.Titan.update(id, rec);
      // an epitaph for the Hall: Base44's own LLM, a few times a day at most; a template otherwise
      const epitaph = await this.epitaph(spec, end, now);
      if (epitaph) await this.db.Titan.update(id, { epitaph });
    });
    if (blow?.key) {
      const key = blow.key;
      this.write(key, () => this.upsertHunter(key, blow.name, blow.sigil, 0, false, 1));
    }
    this.pushFeed({ k: status, name: status === "felled" && blow ? blow.name : this.spec.name, sigil: blow?.sigil ?? 0, v: end.damageTotal, n: now }, true);
    await this.storage.put("last", end);
    await this.storage.put("lastStageAt", this.lastStageAt);
    this.rates.clear();
    this.sparks.clear();
    await this.wakeTitan(number + 1, now + INTERLUDE_MS);
    this.broadcast({ t: "felled", n: now, end, next: this.info() });
    this.dirty = true;
  }

  private async epitaph(spec: { name: string; epithet: string; archetype: string; plate: { name: string } }, end: TitanEnd, now: number): Promise<string> {
    const lived = Math.max(1, Math.round((end.endedAt - end.wokeAt) / 60000));
    const top = end.top[0];
    const fallback =
      end.status === "felled"
        ? `Here lies ${spec.name}, ${spec.epithet}. It sang for ${lived} minutes against ${end.hunterCount} hunters${end.blow ? `, and fell to ${end.blow.name}` : ""}.`
        : `${spec.name}, ${spec.epithet}, slipped away after ${lived} minutes, its wounds unhealed.`;
    try {
      const day = new Date(now).toISOString().slice(0, 10);
      const used = ((await this.storage.get<{ day: string; n: number }>("epitaphs")) ?? { day, n: 0 });
      const count = used.day === day ? used.n : 0;
      if (count >= 3) return fallback;
      await this.storage.put("epitaphs", { day, n: count + 1 });
      const integrations = (this.client as unknown as { asServiceRole: { integrations?: { Core?: { InvokeLLM?: (p: object) => Promise<unknown> } } } }).asServiceRole.integrations;
      const llm = integrations?.Core?.InvokeLLM;
      if (!llm) return fallback;
      const facts = [
        `name: ${spec.name}`,
        `epithet: ${spec.epithet}`,
        `anatomy: ${spec.archetype}`,
        `inks: ${spec.plate.name}`,
        `outcome: ${end.status}`,
        `lived: ${lived} minutes`,
        `hunters: ${end.hunterCount}`,
        end.blow ? `final blow: ${end.blow.name}` : "",
        top ? `greatest hunter: ${top.name} (${top.damage} blows)` : "",
      ].filter(Boolean).join("; ");
      const out = await llm({
        prompt: `You are the scribe of a medieval bestiary. Write an epitaph of exactly three short lines (under 140 characters in total per line) for a titan the whole world hunted together. Plain, grave, a little strange; no rhyme, no hashtags, no modern words, no invented facts beyond these: ${facts}. Use only the names given. Return only the three lines.`,
      });
      const text = String(typeof out === "string" ? out : (out as { response?: string })?.response ?? "").replace(/[<>]/g, "").trim();
      return text && text.length < 400 ? text : fallback;
    } catch {
      return fallback;
    }
  }

  // ---------------------------------------------------------------- runs, hunters, echoes

  private onRun(conn: Conn, h: Hunter, m: RunMsg, now: number) {
    if (!h.key || typeof m.startT !== "number") return;
    // a later report of the same run (sent after a tab switch, say) updates it rather than being dropped
    const sameRun = m.startT === h.lastRunStart;
    // which titan the run belongs to: the current one, or the one that just ended (run sent in the interlude)
    let number = this.titan.number, wokeAt = this.titan.wokeAt, spec = this.spec, stageAt = this.titan.stageAt;
    let nowT = titanT(now, wokeAt);
    const forLast = m.titan != null ? m.titan === this.last?.number : nowT < 0;
    if (forLast && this.last && this.lastSpec) {
      number = this.last.number;
      wokeAt = this.last.wokeAt;
      spec = this.lastSpec;
      stageAt = this.lastStageAt;
      nowT = titanT(this.last.endedAt, wokeAt) + 30;
    }
    let accepted = 0;
    const startT = m.startT;
    const first = h.accLog.find((e) => e[0] === number && e[1] >= startT - 1);
    if (first) accepted = h.acc - first[2];
    const r = checkRun(m, accepted, nowT);
    if (!r.ok) {
      conn.send({ t: "runAck", n: now, damage: 0, echo: false, clamped: false });
      return;
    }
    // only damage the actor accepted and has not already credited to this hunter counts toward their totals,
    // so replaying a report (or shifting its start time) cannot claim the same blows twice
    const claimable = Math.max(0, h.acc - (h.claimedAcc ?? 0));
    if (sameRun && r.damage <= (h.lastRunDamage ?? 0)) {
      conn.send({ t: "runAck", n: now, damage: h.lastRunDamage ?? 0, echo: false, clamped: r.clamped });
      return;
    }
    const credit = Math.min(claimable, sameRun ? r.damage - (h.lastRunDamage ?? 0) : r.damage);
    h.claimedAcc = (h.claimedAcc ?? 0) + Math.max(0, credit);
    h.lastRunStart = startT;
    const prevRunId = sameRun ? h.lastRunId : undefined;
    h.lastRunDamage = r.damage;
    const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
    const key = h.key, name = h.name, sigil = h.sigil;
    const aspect = sanitizeAspect(m.aspect);
    const echo = this.pending < 300 ? prepareEcho(m.path, r.time, startT, stageAt) : null;
    const runRec = {
      titanNumber: number, hunterKey: key, name, sigil, aspect, damage: r.damage, time: r.time, grazes: num(m.grazes, 1e6),
      bestCombo: num(m.bestCombo, 1e5), surges: num(m.surges, 1e4), startT: Math.round(startT * 100) / 100,
      stage: Math.min(2, Math.max(0, Math.round(Number(m.stage) || 0))), createdAt: now,
    };
    this.write(key, async () => {
      if (sameRun && prevRunId) {
        await this.db.Run.update(prevRunId, runRec);
      } else {
        const rec = await this.db.Run.create(runRec);
        h.lastRunId = (rec as { id?: string } | undefined)?.id;
      }
      await this.upsertHunter(key, name, sigil, Math.max(0, credit), !sameRun, 0);
    });
    if (echo) {
      const { loopBeat, phrase } = loopKey(startT, spec.beat);
      const rec = { titanSeed: spec.seed, titanNumber: number, phrase, loopBeat, stage: echo.stage, aspect, name, sigil, path: echo.path, duration: echo.duration, damage: r.damage };
      this.write("echo:" + phrase, async () => {
        const existing = await this.db.Echo.filter({ titanSeed: spec.seed, stage: echo.stage, phrase }, "-created_date", 40, 0, ["id", "damage", "duration"]);
        const ev = echoEviction(existing, rec);
        if (ev === "skip") return;
        if (ev) await this.db.Echo.delete(ev);
        await this.db.Echo.create(rec);
      }, true);
    }
    // every finished run that struck the titan gets a line in the chronicle (the damage the world recorded)
    if (!sameRun && r.damage > 0) this.pushFeed({ k: "run", name, sigil, v: r.damage, n: now }, false);
    conn.send({ t: "runAck", n: now, damage: r.damage, echo: !!echo, clamped: r.clamped });
  }

  private async upsertHunter(key: string, name: string, sigil: number, damage: number, isRun: boolean, felled: number) {
    let c = this.hunterCache.get(key);
    if (!c) {
      const [r] = await this.db.Hunter.filter({ hunterKey: key }, "-created_date", 1);
      if (r) c = { id: r.id, damageTotal: r.damageTotal ?? 0, runs: r.runs ?? 0, bestRun: r.bestRun ?? 0, titansFelled: r.titansFelled ?? 0 };
    }
    const next = {
      damageTotal: (c?.damageTotal ?? 0) + damage,
      runs: (c?.runs ?? 0) + (isRun ? 1 : 0),
      bestRun: Math.max(c?.bestRun ?? 0, damage),
      titansFelled: (c?.titansFelled ?? 0) + felled,
    };
    const rec = { hunterKey: key, name, sigil, ...next, lastSeen: Date.now() };
    const id = c ? (await this.db.Hunter.update(c.id, rec)).id ?? c.id : (await this.db.Hunter.create(rec)).id;
    if (this.hunterCache.size > 5000) this.hunterCache.clear();
    this.hunterCache.set(key, { id, ...next });
  }

  // ---------------------------------------------------------------- broadcast

  private rows(now: number, near: Hunter | null): HunterRow[] {
    const live: Hunter[] = [];
    for (const h of this.hunters.values()) if (h.key && now - h.posAt < IDLE_POS_MS) live.push(h);
    let pick = live;
    if (live.length > SHOW_MAX) {
      // most recently active, then the nearest of those to the viewer
      pick = live.sort((a, b) => b.movedAt - a.movedAt).slice(0, SHOW_MAX * 3);
      if (near) pick.sort((a, b) => Math.hypot(a.x - near.x, a.y - near.y) - Math.hypot(b.x - near.x, b.y - near.y));
      pick = pick.slice(0, SHOW_MAX);
    }
    return pick.map((h) => [h.num, h.qx, h.qy, h.sigil, h.flags]);
  }

  private sparkRows(): SparkRow[] {
    const out: SparkRow[] = [];
    for (const [id, s] of this.sparks) {
      const h = this.hunters.get(id);
      if (h) out.push([h.num, Math.round(s.x * Q), Math.round(s.y * Q), s.until]);
    }
    return out;
  }

  private broadcastState(now: number) {
    this.dirty = false;
    const f = this.pendingFeed.length ? this.pendingFeed : undefined;
    this.pendingFeed = [];
    const hp = Math.max(0, Math.round(this.titan.hp));
    const c = this.onlineCount();
    let live = 0;
    for (const h of this.hunters.values()) if (h.key && now - h.posAt < IDLE_POS_MS) live++;
    if (live <= SHOW_MAX) {
      this.broadcast({ t: "s", n: now, hp, c, h: this.rows(now, null), ...(f ? { f } : {}) });
      return;
    }
    for (const conn of this.getConnections() as Conn[]) {
      const me = this.hunters.get(conn.id) ?? null;
      conn.send({ t: "s", n: now, hp, c, h: this.rows(now, me), ...(f ? { f } : {}) });
    }
  }

  private pushFeed(item: FeedItem, persist: boolean) {
    this.feed.push(item);
    if (this.feed.length > FEED_MAX) this.feed.splice(0, this.feed.length - FEED_MAX);
    this.pendingFeed.push(item);
    this.bulkDirtyAt ||= item.n;
    if (persist) this.lastBulkSave = 0;
  }

  // ---------------------------------------------------------------- persistence

  private async saveTitan() {
    await this.storage.put("titan", this.titan);
  }

  /** hp every 2 s, the heavier state every 10 s, the Titan record every minute; all only when changed */
  private async flush(force: boolean) {
    const now = Date.now();
    if (this.hpDirtyAt && (force || now - this.lastHpSave >= HP_SAVE_MS)) {
      this.hpDirtyAt = 0;
      this.lastHpSave = now;
      await this.storage.put("hp", Math.max(0, Math.round(this.titan.hp)));
    }
    if (this.bulkDirtyAt && (force || now - this.lastBulkSave >= BULK_SAVE_MS)) {
      this.bulkDirtyAt = 0;
      this.lastBulkSave = now;
      const credits = [...this.credits.entries()]
        .sort((a, b) => b[1].dmg - a[1].dmg)
        .slice(0, CREDITS_KEEP)
        .map(([k, c]) => [k, c.name, c.sigil, Math.round(c.dmg)]);
      await this.storage.put("credits", credits);
      // who struck the awake titan lately (is it shared?): only the last SHARED_MS matters
      await this.storage.put("strikes", [...this.strikes.entries()].filter(([, at]) => now - at < SHARED_MS).slice(-CREDITS_KEEP));
      await this.storage.put("dmg24", this.dmg24);
      await this.storage.put("feed", this.feed);
    }
    if (this.titan.status === "awake" && this.titan.recordId && (force || now - this.lastRecordSave >= TITAN_RECORD_MS) && now >= this.titan.wokeAt) {
      this.lastRecordSave = now;
      const id = this.titan.recordId;
      const rec = { hp: Math.max(0, Math.round(this.titan.hp)), hunterCount: this.credits.size, damageTotal: Math.round(this.titan.hpMax - this.titan.hp), topHunters: topHunters(this.credits, 5) };
      this.write("titan", () => this.db.Titan.update(id, rec));
    }
  }

  // ---------------------------------------------------------------- entity writes

  private get db() {
    return this.client.asServiceRole.entities;
  }

  /**
   * Serialised per key (one of LANES chains), never throws, never blocks the caller. Test sessions
   * (any session but world-1) only write echoes, which are keyed by their own titan seeds.
   */
  private write(key: string, fn: () => Promise<unknown>, testOk = false) {
    if (!testOk && this.instanceId !== WORLD_SESSION) return;
    const i = hash32("lane", key) % LANES;
    this.pending++;
    this.lanes[i] = this.lanes[i]
      .then(fn)
      .then(() => undefined, (e) => this.log("write " + key.slice(0, 12), e))
      .finally(() => {
        this.pending--;
      });
  }

  private log(where: string, e: unknown) {
    try {
      console.log(`[world] ${where}: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      /* ignore */
    }
  }
}

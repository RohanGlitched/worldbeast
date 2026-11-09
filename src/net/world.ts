import { base44 as defaultClient } from "@/api/base44Client";
import { hash32 } from "@/core/rng";
import { makeTitan, Stage, stageFor, TitanSpec } from "@/core/titan";
import { EchoBank, echoesAt, EchoPos } from "./echoes";
import { encodePath } from "./pathcodec";
import {
  F_DASH, F_DOWN, F_INVULN, F_SURGE, FeedItem, HitRow, HitWhy, Q, RosterRow, TitanEnd, TitanInfo, ToClient, ToServer,
  WORLD_ACTOR, WORLD_SESSION,
} from "./types";

// The browser side of the world: one socket to the `world` actor, a server clock, the live titan,
// everyone else's sparks (interpolated), batched hits, and a local titan when the actor is out of reach.

export type WorldMode = "connecting" | "online" | "offline";

/** structurally identical to render/hunters.ts HunterDraw, so `world.others` plugs straight into Game.others */
export interface DrawHunter {
  x: number;
  y: number;
  kind: 0 | 1 | 2 | 3; // 1 live hunter, 2 echo, 3 downed spark
  hue: number;
  inv: number;
  dash: number;
  surge: number;
  seed: number;
}

export interface RemoteHunter {
  id: number;
  name: string;
  sigil: number;
  aspect: string;
  x: number;
  y: number;
  flags: number;
}

export interface RosterEntry {
  id: number;
  name: string;
  sigil: number;
  aspect: string;
}

export interface Spark {
  id: number;
  x: number;
  y: number;
  until: number; // server ms
}

export interface RunReport {
  damage: number;
  time: number;
  grazes: number;
  bestCombo: number;
  surges: number;
  aspect: string;
  startT: number;
  stage: number;
  path: number[] | string; // flat quantised x*20, y*20 at 10 Hz, or already encoded
}

export interface RunResult {
  damage: number; // what the world recorded
  echo: boolean; // stored as an echo
  clamped: boolean; // claimed more than the world saw land
}

export interface WorldEvents {
  onStatus?(mode: WorldMode): void;
  onWelcome?(w: World): void;
  /** the titan (or the next titan during an interlude) changed: rebuild the fight */
  onTitan?(titan: TitanInfo, spec: TitanSpec): void;
  onStage?(stage: Stage): void;
  onFelled?(end: TitanEnd, next: TitanInfo): void;
  onWake?(titan: TitanInfo): void;
  onDown?(e: { id: number; name: string; x: number; y: number }): void;
  onRevive?(e: { who: number; by: number; byName: string; me: boolean }): void;
  onFeed?(items: FeedItem[], all: FeedItem[]): void;
  onHunters?(roster: RosterEntry[]): void;
  onAck?(ok: number, bad: number, why: HitWhy | undefined): void;
}

export interface WorldOptions {
  client?: { actors: Record<string, (id: string) => { connect(o?: { id?: string }): ActorConn }>; entities: Record<string, any> };
  session?: string;
  offlineAfterMs?: number;
  interpMs?: number;
}

interface ActorConn {
  subscribe(fn: (m: any) => void): { unsubscribe(): void };
  send(m: unknown): void;
  close(): void;
}

const LOCAL_BLOCK_MS = 3 * 3_600_000;
const LOCAL_HP = 150_000;
const INTERLUDE_MS = 20_000;
const SILENT_MS = 8_000;
const PING_EVERY_MS = 2_000;
const KEY_STORE = "worldbeast.hunterKey";

export class World {
  mode: WorldMode = "connecting";
  events: WorldEvents = {};

  /** best estimate of serverNow - performance.now(), ms (median of the last 8 good pings) */
  clockOffset = 0;
  /** median round trip, ms */
  rtt = 0;
  you = 0;
  titan: TitanInfo | null = null;
  spec: TitanSpec | null = null;
  hp = 0;
  stageAt: number[] = [];
  online = 0;
  feed: FeedItem[] = [];
  last: TitanEnd | null = null;
  roster = new Map<number, RosterEntry>();
  sparks = new Map<number, Spark>();
  stats = { hitsSent: 0, ok: 0, bad: 0, lastWhy: undefined as HitWhy | undefined };

  private client: NonNullable<WorldOptions["client"]>;
  private session: string;
  private offlineAfterMs: number;
  private interpMs: number;
  private conn: ActorConn | null = null;
  private connId = "wb-" + randomHex(8);
  private timers: ReturnType<typeof setInterval>[] = [];
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private lastMsgAt = 0;
  private openedAt = 0;
  private smoothOffset = NaN;
  private pings: Array<{ off: number; rtt: number }> = [];
  private lastPingAt = 0;
  private identity: { key: string; name: string; sigil: number; aspect: string } | null = null;
  private pos: { x: number; y: number; alive: boolean; flags: number; at: number } | null = null;
  private posSentAt = 0;
  private posSent = "";
  private hits: HitRow[] = [];
  private remote = new Map<number, { s: Array<[number, number, number, number]>; sigil: number; seen: number }>();
  private remoteSeen = 0;
  private wokeFired = -1;
  private runWaiters: Array<(r: RunResult | null) => void> = [];
  private echoes: EchoBank;
  private echoOut: EchoPos[] = [];
  private drawOut: DrawHunter[] = [];

  constructor(opts: WorldOptions = {}) {
    this.client = opts.client ?? (defaultClient as unknown as NonNullable<WorldOptions["client"]>);
    this.session = opts.session ?? WORLD_SESSION;
    this.offlineAfterMs = opts.offlineAfterMs ?? 4000;
    this.interpMs = opts.interpMs ?? 120;
    this.echoes = new EchoBank(() => this.client.entities?.Echo ?? null);
  }

  // ------------------------------------------------------------ connection

  connect(): void {
    if (this.timers.length) return;
    this.open();
    this.timers.push(setInterval(() => this.flushPos(), 100));
    this.timers.push(setInterval(() => this.flushHits(), 250));
    this.timers.push(setInterval(() => this.housekeep(), 250));
    this.offlineTimer = setTimeout(() => {
      if (this.mode !== "online") this.startLocal();
    }, this.offlineAfterMs);
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.conn?.close();
    this.conn = null;
  }

  private open() {
    try {
      this.conn = this.client.actors[WORLD_ACTOR](this.session).connect({ id: this.connId });
      this.conn.subscribe((m) => this.onMessage(m as ToClient));
      this.openedAt = performance.now();
    } catch {
      this.conn = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.conn?.close();
    this.conn = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoff * (0.75 + Math.random() * 0.5));
    this.backoff = Math.min(30_000, this.backoff * 2);
  }

  private send(m: ToServer) {
    if (this.mode === "online" && this.conn) this.conn.send(m);
  }

  /** for tests and tools: send any message as-is */
  debugSend(m: unknown) {
    this.conn?.send(m);
  }

  private housekeep() {
    const now = performance.now();
    // smooth the clock so titanTime() never jumps on a new ping sample
    if (Number.isNaN(this.smoothOffset) || Math.abs(this.clockOffset - this.smoothOffset) > 250) this.smoothOffset = this.clockOffset;
    else this.smoothOffset += Math.max(-4, Math.min(4, this.clockOffset - this.smoothOffset));
    if (this.mode === "online" && now - this.lastPingAt > PING_EVERY_MS) this.ping();
    const silentSince = Math.max(this.lastMsgAt, this.openedAt);
    if (!this.reconnectTimer && this.conn && now - silentSince > SILENT_MS) {
      if (this.mode === "online") this.setMode(this.local ? "offline" : "connecting");
      if (this.mode === "connecting" && !this.local) this.startLocal();
      this.scheduleReconnect();
    }
    if (this.titan && this.serverNow() >= this.titan.wokeAt && this.wokeFired !== this.titan.number) {
      this.wokeFired = this.titan.number;
      this.events.onWake?.(this.titan);
    }
    for (const [id, s] of this.sparks) if (s.until < this.serverNow()) this.sparks.delete(id);
  }

  private setMode(m: WorldMode) {
    if (this.mode === m) return;
    this.mode = m;
    this.events.onStatus?.(m);
  }

  // ------------------------------------------------------------ clock

  /** server ms now, as best this browser knows */
  serverNow(): number {
    return performance.now() + (Number.isNaN(this.smoothOffset) ? this.clockOffset : this.smoothOffset);
  }

  /** seconds since the current titan woke (negative while the next one stirs) */
  titanTime(): number {
    return this.titan ? (this.serverNow() - this.titan.wokeAt) / 1000 : 0;
  }

  private ping() {
    this.lastPingAt = performance.now();
    this.conn?.send({ t: "ping", c: this.lastPingAt });
  }

  private onPong(c: number, n: number) {
    const now = performance.now();
    const rtt = now - c;
    if (rtt < 0 || rtt > 10_000) return;
    this.pings.push({ off: n + rtt / 2 - now, rtt });
    if (this.pings.length > 8) this.pings.shift();
    const minRtt = Math.min(...this.pings.map((p) => p.rtt));
    const good = this.pings.filter((p) => p.rtt <= minRtt * 1.5 + 10); // queueing delay makes the rest lopsided
    this.clockOffset = median(good.map((p) => p.off));
    this.rtt = median(this.pings.map((p) => p.rtt));
    this.hadClock = true;
    // Some sockets get a return path ~180 ms slower than the way in, which skews the clock by
    // half of that. Before the hunter starts playing, try up to two fresh sockets for a better route.
    const playing = performance.now() - (this.pos?.at ?? -1e9) < 2000;
    if (this.pings.length >= 6 && this.rtt > SLOW_RTT_MS && this.probes < MAX_PROBES && !playing && this.mode === "online") {
      this.probes++;
      this.reroute();
    }
  }

  /** the clock has had its pings (and any route probing is done) */
  get clockSettled(): boolean {
    return this.mode !== "online" || (this.pings.length >= 6 && (this.rtt <= SLOW_RTT_MS || this.probes >= MAX_PROBES));
  }

  private reroute() {
    this.conn?.close();
    this.conn = null;
    this.connId = "wb-" + randomHex(8);
    this.open();
  }

  // ------------------------------------------------------------ state

  get hpMax() {
    return this.titan?.hpMax ?? 1;
  }
  get hpFrac() {
    return this.titan ? Math.max(0, Math.min(1, this.hp / this.titan.hpMax)) : 1;
  }
  get stage(): Stage {
    return this.local ? stageFor(this.hpFrac) : (Math.min(2, this.stageAt.length) as Stage);
  }
  get titanNumber() {
    return this.titan?.number ?? 0;
  }
  get titanSeed() {
    return this.titan?.seed ?? 0;
  }
  /** connected browsers (watching or hunting) */
  get onlineCount() {
    return this.online;
  }
  get hunters(): RosterEntry[] {
    return [...this.roster.values()];
  }
  get isLocal() {
    return !!this.local;
  }

  // ------------------------------------------------------------ messages

  private onMessage(m: ToClient) {
    if (!m || typeof m !== "object") return;
    this.lastMsgAt = performance.now();
    try {
      switch (m.t) {
        case "welcome":
          return this.onWelcome(m);
        case "s":
          this.hp = m.hp;
          this.online = m.c;
          this.ingestRows(m.n, m.h);
          if (m.f?.length) this.addFeed(m.f);
          return;
        case "join":
          this.roster.set(m.r[0], rosterEntry(m.r));
          this.events.onHunters?.(this.hunters);
          return;
        case "leave":
          this.roster.delete(m.id);
          this.remote.delete(m.id);
          this.sparks.delete(m.id);
          this.events.onHunters?.(this.hunters);
          return;
        case "stage":
          this.hp = m.hp;
          while (this.stageAt.length < m.stage) this.stageAt.push(m.at);
          this.events.onStage?.(m.stage as Stage);
          return;
        case "felled":
          this.last = m.end;
          this.setTitan(m.next, m.next.hpMax, []);
          this.events.onFelled?.(m.end, m.next);
          return;
        case "wake":
          this.hp = m.hp;
          if (!this.titan || this.titan.number !== m.titan.number) this.setTitan(m.titan, m.hp, []);
          if (this.wokeFired !== m.titan.number) {
            this.wokeFired = m.titan.number;
            this.events.onWake?.(m.titan);
          }
          return;
        case "down":
          this.sparks.set(m.id, { id: m.id, x: m.x / Q, y: m.y / Q, until: m.until });
          this.events.onDown?.({ id: m.id, name: this.roster.get(m.id)?.name ?? "Hunter", x: m.x / Q, y: m.y / Q });
          return;
        case "revive":
          this.sparks.delete(m.who);
          this.events.onRevive?.({ who: m.who, by: m.by, byName: m.byName, me: m.who === this.you });
          return;
        case "ack":
          if (!this.local) this.hp = Math.min(this.hp, m.hp);
          this.stats.ok += m.ok;
          this.stats.bad += m.bad;
          if (m.why) this.stats.lastWhy = m.why;
          this.events.onAck?.(m.ok, m.bad, m.why);
          return;
        case "runAck":
          this.runWaiters.shift()?.({ damage: m.damage, echo: m.echo, clamped: m.clamped });
          return;
        case "pong":
          return this.onPong(m.c, m.n);
      }
    } catch (e) {
      console.warn("[world] bad message", e);
    }
  }

  private onWelcome(m: Extract<ToClient, { t: "welcome" }>) {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.backoff = 1000;
    const wasLocal = !!this.local;
    this.local = null;
    if (!this.pings.length) this.clockOffset = m.n - performance.now(); // refined by pings below
    this.you = m.you;
    this.online = m.online;
    this.feed = m.feed.slice();
    this.last = m.last;
    this.roster.clear();
    for (const r of m.roster) this.roster.set(r[0], rosterEntry(r));
    this.sparks.clear();
    for (const [id, x, y, until] of m.sparks) this.sparks.set(id, { id, x: x / Q, y: y / Q, until });
    this.remote.clear();
    this.ingestRows(m.n, m.h);
    const changed = wasLocal || !this.titan || this.titan.seed !== m.titan.seed || this.titan.number !== m.titan.number;
    if (changed) this.setTitan(m.titan, m.hp, m.stageAt.slice());
    else {
      this.titan = m.titan;
      this.hp = m.hp;
      this.stageAt = m.stageAt.slice();
    }
    this.setMode("online");
    if (this.identity) this.conn?.send({ t: "hello", ...this.identity });
    for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 150);
    this.events.onWelcome?.(this);
    this.events.onHunters?.(this.hunters);
  }

  private setTitan(t: TitanInfo, hp: number, stageAt: number[]) {
    this.titan = t;
    this.hp = hp;
    this.stageAt = stageAt;
    this.spec = makeTitan(t.seed, t.number);
    if (this.serverNow() >= t.wokeAt) this.wokeFired = t.number;
    this.events.onTitan?.(t, this.spec);
  }

  private addFeed(items: FeedItem[]) {
    this.feed.push(...items);
    if (this.feed.length > 12) this.feed.splice(0, this.feed.length - 12);
    this.events.onFeed?.(items, this.feed);
  }

  private ingestRows(n: number, rows: Array<[number, number, number, number, number]>) {
    const seen = ++this.remoteSeen;
    for (const [id, x, y, sigil, flags] of rows) {
      if (id === this.you) continue;
      let r = this.remote.get(id);
      if (!r) this.remote.set(id, (r = { s: [], sigil, seen }));
      r.sigil = sigil;
      const last = r.s[r.s.length - 1];
      if (!last || n > last[0]) r.s.push([n, x, y, flags]);
      if (r.s.length > 16) r.s.shift();
      r.seen = seen;
    }
    // a hunter missing from a state message is idle or out of view
    for (const [id, r] of this.remote) if (r.seen !== seen) this.remote.delete(id);
  }

  /** remote hunters, interpolated ~interpMs in the past for smooth motion */
  remoteHunters(out: RemoteHunter[] = []): RemoteHunter[] {
    out.length = 0;
    const at = this.serverNow() - this.interpMs;
    for (const [id, r] of this.remote) {
      const s = r.s;
      let a = s[0], b = s[0];
      for (let i = 1; i < s.length; i++) {
        if (s[i][0] <= at) a = s[i];
        b = s[i];
        if (s[i][0] >= at) break;
      }
      if (a[0] > at) b = a;
      const k = b[0] > a[0] ? Math.max(0, Math.min(1, (at - a[0]) / (b[0] - a[0]))) : 1;
      const ro = this.roster.get(id);
      out.push({
        id,
        name: ro?.name ?? "Hunter",
        sigil: r.sigil,
        aspect: ro?.aspect ?? "ember",
        x: (a[1] + (b[1] - a[1]) * k) / Q,
        y: (a[2] + (b[2] - a[2]) * k) / Q,
        flags: k < 0.5 ? a[3] : b[3],
      });
    }
    return out;
  }

  /** echoes flying at titan time t (defaults to now); loads the right set on demand */
  echoesAt(t = this.titanTime()): EchoPos[] {
    if (!this.titan || !this.spec) return (this.echoOut.length = 0), this.echoOut;
    this.echoes.ensure(this.titan.seed, this.stage);
    return echoesAt(this.echoes.list, t, this.spec.beat, this.echoOut);
  }

  /** drop-in for Game.others: live hunters (1), echoes (2), downed sparks (3) */
  readonly others = {
    list: (t: number): DrawHunter[] => {
      const out = this.drawOut;
      out.length = 0;
      for (const h of this.remoteHunters()) {
        if (h.flags & F_DOWN) continue;
        out.push({ x: h.x, y: h.y, kind: 1, hue: h.sigil / 16, inv: h.flags & F_INVULN ? 1 : 0, dash: h.flags & F_DASH ? 1 : 0, surge: h.flags & F_SURGE ? 1 : 0, seed: h.id });
      }
      for (const s of this.sparks.values()) out.push({ x: s.x, y: s.y, kind: 3, hue: (this.roster.get(s.id)?.sigil ?? 0) / 16, inv: 0, dash: 0, surge: 0, seed: s.id });
      for (const e of this.echoesAt(t)) out.push({ x: e.x, y: e.y, kind: 2, hue: e.sigil / 16, inv: 0, dash: 0, surge: 0, seed: hash32(e.id) });
      return out;
    },
  };

  // ------------------------------------------------------------ outgoing

  /** a stable random 128-bit id for this browser (no login) */
  static hunterKey(): string {
    try {
      let k = localStorage.getItem(KEY_STORE);
      if (!k || !/^[0-9a-f]{32}$/.test(k)) {
        k = randomHex(16);
        localStorage.setItem(KEY_STORE, k);
      }
      return k;
    } catch {
      return randomHex(16);
    }
  }

  /** who you are; sent now and again after every reconnect */
  setIdentity(id: { name: string; sigil: number; aspect: string }) {
    this.identity = { key: World.hunterKey(), name: id.name.slice(0, 18), sigil: id.sigil | 0, aspect: id.aspect };
    this.send({ t: "hello", ...this.identity });
  }

  /** call every frame while playing; sent at 10 Hz when it changes (1 Hz keepalive otherwise) */
  sendPos(x: number, y: number, alive: boolean, flags = 0) {
    this.pos = { x, y, alive, flags, at: performance.now() };
  }

  private flushPos() {
    const p = this.pos;
    if (!p || this.mode !== "online" || !this.identity) return;
    const now = performance.now();
    if (now - p.at > 1000) return; // not playing
    const x = Math.round(p.x * Q) / Q, y = Math.round(p.y * Q) / Q;
    const sig = `${x},${y},${p.alive},${p.flags}`;
    if (sig === this.posSent && now - this.posSentAt < 1000) return;
    this.posSent = sig;
    this.posSentAt = now;
    this.send({ t: "pos", x, y, alive: p.alive, flags: p.flags });
  }

  /** a dart landed: queued and sent in batches 4 times a second */
  addHit(core: number, dmg: number, beat: number, flags = 0) {
    if (this.local) {
      this.localHit(dmg);
      return;
    }
    if (this.hits.length >= 64) return;
    this.hits.push(flags ? [core, Math.round(dmg), Math.round(beat * 1000) / 1000, flags] : [core, Math.round(dmg), Math.round(beat * 1000) / 1000]);
  }

  flushHits() {
    if (!this.hits.length) return;
    if (this.mode !== "online") {
      this.hits.length = 0;
      return;
    }
    this.stats.hitsSent += this.hits.length;
    this.send({ t: "hit", hits: this.hits });
    this.hits = [];
  }

  sendDown(x: number, y: number) {
    this.send({ t: "down", x, y });
  }

  /** report a finished run; resolves with what the world recorded (null offline or on timeout) */
  sendRun(r: RunReport, titanNumber?: number): Promise<RunResult | null> {
    if (this.mode !== "online" || this.local) return Promise.resolve(null);
    this.flushHits();
    const path = typeof r.path === "string" ? r.path : encodePath(r.path);
    const titan = titanNumber ?? (this.titan && this.serverNow() < this.titan.wokeAt && this.last ? this.last.number : this.titanNumber);
    this.send({
      t: "run", titan, damage: Math.round(r.damage), time: r.time, grazes: r.grazes, bestCombo: r.bestCombo, surges: r.surges,
      aspect: r.aspect, startT: r.startT, stage: r.stage, path,
    });
    return new Promise((resolve) => {
      const done = (v: RunResult | null) => {
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        const i = this.runWaiters.indexOf(done);
        if (i >= 0) this.runWaiters.splice(i, 1);
        resolve(null);
      }, 6000);
      this.runWaiters.push(done);
    });
  }

  // ------------------------------------------------------------ local fallback

  private local: { hp: number } | null = null;

  /** the actor is out of reach: a titan from the current 3-hour UTC block, so offline friends still match */
  private startLocal() {
    if (this.local) return;
    const block = Math.floor(Date.now() / LOCAL_BLOCK_MS);
    this.local = { hp: LOCAL_HP };
    this.clockOffset = Date.now() - performance.now();
    this.smoothOffset = this.clockOffset;
    this.remote.clear();
    this.roster.clear();
    this.sparks.clear();
    this.setTitan({ number: 0, seed: hash32("local", block), wokeAt: block * LOCAL_BLOCK_MS, hpMax: LOCAL_HP, status: "awake" }, LOCAL_HP, []);
    this.setMode("offline");
  }

  private localHit(dmg: number) {
    const L = this.local!;
    if (!this.titan || this.serverNow() < this.titan.wokeAt || L.hp <= 0) return;
    L.hp = Math.max(0, L.hp - dmg);
    this.hp = L.hp;
    if (L.hp > 0) return;
    const now = this.serverNow();
    const t = this.titan;
    const end: TitanEnd = { ...t, status: "felled", endedAt: now, blow: this.identity ? { name: this.identity.name, sigil: this.identity.sigil } : null, top: [], damageTotal: t.hpMax, hunterCount: 1 };
    this.last = end;
    L.hp = LOCAL_HP;
    const next: TitanInfo = { number: 0, seed: hash32(t.seed, "next"), wokeAt: now + INTERLUDE_MS, hpMax: LOCAL_HP, status: "awake" };
    this.setTitan(next, LOCAL_HP, []);
    this.events.onFelled?.(end, next);
  }
}

function rosterEntry(r: RosterRow): RosterEntry {
  return { id: r[0], name: r[1], sigil: r[2], aspect: r[3] };
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}

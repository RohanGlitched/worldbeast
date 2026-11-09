// Stand-in for "base44:runtime/actors" so vitest can drive the world actor in-process:
// in-memory storage, schedules, connections and entity tables.

export type Row = Record<string, any> & { id: string };

export class Table {
  rows: Row[] = [];
  private seq = 0;
  constructor(readonly name: string) {}
  async create(d: Record<string, any>) {
    const r = { ...structuredClone(d), id: `${this.name}-${++this.seq}`, created_date: new Date(Date.now() + this.seq).toISOString() };
    this.rows.push(r);
    return structuredClone(r);
  }
  async update(id: string, d: Record<string, any>) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error(`${this.name} ${id} not found`);
    Object.assign(r, structuredClone(d));
    return structuredClone(r);
  }
  async delete(id: string) {
    this.rows = this.rows.filter((x) => x.id !== id);
    return { success: true };
  }
  async deleteMany(q: Record<string, any>) {
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => !Object.entries(q).every(([k, v]) => x[k] === v));
    return { deleted: before - this.rows.length };
  }
  async filter(q: Record<string, any>, sort?: string, limit = 5000, _skip = 0, fields?: string[]) {
    let out = this.rows.filter((x) => Object.entries(q).every(([k, v]) => x[k] === v));
    if (sort) {
      const desc = sort.startsWith("-");
      const k = sort.replace(/^-/, "");
      out = out.slice().sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (desc ? -1 : 1));
    }
    return out.slice(0, limit).map((r) => (fields ? Object.fromEntries(fields.map((f) => [f, r[f]])) : structuredClone(r)));
  }
}

export class MockConn {
  inbox: any[] = [];
  identity = { type: "anonymous", anonymousId: "anon" };
  constructor(readonly id: string) {}
  send(m: any) {
    this.inbox.push(structuredClone(m));
  }
  last(t: string) {
    for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].t === t) return this.inbox[i];
    return undefined;
  }
}

export class MockStorage {
  map = new Map<string, unknown>();
  puts = 0;
  async get<T>(k: string): Promise<T | undefined> {
    return this.map.has(k) ? (structuredClone(this.map.get(k)) as T) : undefined;
  }
  async put(k: string, v: unknown) {
    this.puts++;
    this.map.set(k, structuredClone(v));
  }
  async delete(k: string) {
    return this.map.delete(k);
  }
  async deleteAll() {
    this.map.clear();
  }
}

export const tables = () => ({ Titan: new Table("Titan"), Hunter: new Table("Hunter"), Run: new Table("Run"), Echo: new Table("Echo") });

export class Actor<I, O> {
  tickIntervalMs = 100;
  instanceId = "world-1";
  conns: MockConn[] = [];
  storage = new MockStorage();
  schedules = new Map<string, number>();
  mockDb = tables();
  client = { asServiceRole: { entities: this.mockDb } };
  broadcast(m: O) {
    for (const c of this.conns) c.send(m);
  }
  getConnections() {
    return this.conns;
  }
  async schedule(key: string, at: number | Date) {
    this.schedules.set(key, +at);
  }
  async cancelSchedule(key: string) {
    this.schedules.delete(key);
  }
  declare _types?: [I, O];
}

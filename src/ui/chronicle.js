// The chronicle and the head-counts on the leaf: built only from real things. Live feed items come from the
// world actor; history lines come from the Run and Titan records the actor wrote. Nothing here is invented.

import { makeTitan } from "@/core/titan";

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
const STAGE = ["Calm", "Wrath", "Ruin"];
export const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const SEAL = ["first", "second", "third", "fourth", "fifth", "sixth"];

/** "moments ago", "12 min ago", "2 h ago", "3 days ago" */
export function fmtAgo(ms) {
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "moments ago";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** one line of the live feed (src/net/types.ts FeedItem) as chronicle html */
export function feedHtml(f, spec) {
  const who = `<b>${esc(f.name || "A hunter")}</b>`;
  const titan = spec ? esc(spec.name) : "The titan";
  switch (f.k) {
    case "join":
      return `${who} joined the hunt.`;
    case "surge":
      return `${who} <span class="gold">surged</span>.`;
    case "break":
      return `${who} struck the wound beneath the ${SEAL[f.v ?? 0] ?? "hidden"} seal.`;
    case "down":
      return `${who}'s light went out.`;
    case "revive":
      return `${who} was rekindled.`;
    case "stage":
      return `${titan} passed into <b>${STAGE[f.v ?? 0]}</b>.`;
    case "felled":
      return `<b class="gold">${titan} was felled</b>${f.name ? `; the final blow was ${who}'s` : ""}.`;
    case "escaped":
      return `The titan slipped away unfelled.`;
    case "wake":
      return `The ${f.v ? ORD(f.v) : "next"} titan woke.`;
    case "run":
      return `${who} struck <span class="gold">${fmt(f.v)}</span> blows.`;
    default:
      return esc(f.k);
  }
}

const titanName = (t) => {
  try {
    return makeTitan(t.seed >>> 0, t.number | 0).name;
  } catch {
    return null;
  }
};

/**
 * Chronicle lines from the records: the most recent runs and the titans' wakings and endings.
 * runs: Run records ({ name, damage, titanNumber, createdAt | created_date }); titans: Titan records.
 */
export function historyItems({ runs = [], titans = [], now = Date.now() }) {
  const names = new Map();
  for (const t of titans) if (t && Number.isFinite(t.number) && Number.isFinite(t.seed)) names.set(t.number, titanName(t));
  const out = [];
  for (const t of titans) {
    if (!t || !Number.isFinite(t.number)) continue;
    const name = names.get(t.number);
    const n = esc(name ?? `The ${ORD(t.number)} titan`);
    if (Number.isFinite(t.wokeAt) && t.wokeAt <= now) out.push({ k: "wake", key: "wake:" + t.number, n: t.wokeAt, name: "", html: `<b>${n}</b>, the ${ORD(t.number)} titan, woke.` });
    const endedAt = t.felledAt;
    if (t.status === "felled" && Number.isFinite(endedAt))
      out.push({ k: "felled", key: "end:" + t.number, n: endedAt, name: t.finalBlowName || "", html: `<b class="gold">${n} was felled</b>${t.finalBlowName ? `; the final blow was <b>${esc(t.finalBlowName)}</b>'s` : ""}.` });
    if (t.status === "escaped" && Number.isFinite(endedAt)) out.push({ k: "escaped", key: "end:" + t.number, n: endedAt, name: "", html: `<b>${n}</b> slipped away unfelled.` });
  }
  for (const r of runs) {
    if (!r || !(r.damage > 0)) continue;
    const n = Number.isFinite(r.createdAt) ? r.createdAt : Date.parse(r.created_date || "");
    if (!Number.isFinite(n)) continue;
    const against = names.get(r.titanNumber);
    out.push({
      k: "run",
      key: `run:${r.name || ""}:${Math.round(r.damage)}`,
      n,
      name: r.name || "",
      html: `<b>${esc(r.name || "A hunter")}</b> struck <span class="gold">${fmt(r.damage)}</span> blows${against ? ` against ${esc(against)}` : ""}.`,
    });
  }
  return out;
}

/** the live feed as chronicle items (same shape as historyItems) */
export function liveItems(feed = [], spec = null) {
  // a hunter who joins again and again is written once (the latest)
  const seenJoin = new Set();
  const list = feed
    .slice(-40)
    .reverse()
    .filter((f) => (f.k === "join" ? !seenJoin.has(f.name) && seenJoin.add(f.name) : true))
    .reverse();
  return list.map((f) => ({
    k: f.k,
    key: f.k === "wake" && f.v ? "wake:" + f.v : f.k === "run" ? `run:${f.name || ""}:${Math.round(f.v || 0)}` : null,
    n: f.n,
    name: f.name || "",
    html: feedHtml(f, spec),
  }));
}

const SAME_MS = 30_000;
const same = (a, b) => a.k === b.k && ((a.key && a.key === b.key) || ((a.k === "felled" || a.k === "escaped" || a.k === "run") && a.name === b.name && Math.abs(a.n - b.n) <= SAME_MS));

/** history and live lines in time order, the live copy kept where both tell of the same thing */
export function mergeChronicle(history = [], live = [], max = 30) {
  const kept = history.filter((h) => !live.some((l) => same(h, l)));
  const all = [...kept, ...live].sort((a, b) => a.n - b.n);
  const out = [];
  for (const it of all) if (!out.some((o) => same(o, it))) out.push(it);
  return out.slice(-max).map((it, i) => ({ id: `${it.n}:${it.k}:${it.name}:${i}`, html: it.html, n: it.n }));
}

const safe = async (fn) => {
  try {
    const v = await fn();
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** the most recent finished runs (newest first); [] when the database can't be read */
export const recentRuns = (entities, limit = 8) => (entities ? safe(() => entities.Run.list("-created_date", limit)) : Promise.resolve([]));

/** the latest real records, for the chronicle on arrival; [] when the database can't be read */
export async function loadHistory(entities, { runs = 12, titans = 6 } = {}) {
  if (!entities) return { runs: [], titans: [] };
  const [r, t] = await Promise.all([
    safe(() => entities.Run.list("-created_date", runs)),
    safe(() => entities.Titan.list("-number", titans)),
  ]);
  return { runs: r, titans: t };
}

/**
 * Honest head-counts. `hunters` are those who joined the hunt (said hello) on a connection that is still open,
 * each { me, flying }; `watching` counts connected browsers that have not joined (you, until you join).
 */
export function presence({ online = 1, hunters = [], watching = 0, echoes = 0 }) {
  const H = hunters.length;
  const W = Math.max(0, watching);
  const meIn = hunters.some((h) => h.me);
  const others = H - (meIn ? 1 : 0);
  const othersWatching = Math.max(0, W - (meIn ? 0 : 1));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const header = [H ? `${plural(H, "hunter", "hunters")} in the hunt` : "No one is hunting this minute", W ? `${W} watching` : null, echoes ? plural(echoes, "echo", "echoes") : null].filter(Boolean).join(" · ");
  const join = others > 0 ? `${plural(others, "other hunter is", "other hunters are")} in the hunt now${othersWatching ? ` · ${othersWatching} watching` : ""}` : "You are the first hunter here right now — your echo will fly for the next hunter to arrive";
  const cover = H > 0 ? `${H} hunting right now${othersWatching ? ` · ${othersWatching} reading the codex` : ""}` : othersWatching > 0 ? `${plural(othersWatching, "other", "others")} reading the codex · no one hunting this minute` : "A living bestiary";
  const topbar = H > 0 ? `${H} hunting` : Math.max(1, online) > 1 ? `${W} watching` : "only you here";
  return { header, join, cover, topbar, others, othersWatching, alone: others === 0 };
}

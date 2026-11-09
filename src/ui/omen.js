import { hash32 } from "@/core/rng";

// The day's omen: one feat, the same for every hunter on Earth, chosen from the UTC date.
// Fulfil it on consecutive days to keep a streak. Kept in this browser with the profile.

const DAY = 86_400_000;
export const dayIndex = (now = Date.now()) => Math.floor(now / DAY);

const ASPECT_NAMES = { ember: "Ember", lance: "Lance", bloom: "Bloom", mirror: "Mirror" };
const fmt = (n) => n.toLocaleString("en-US");

// Thresholds from measured runs (Nov 9, human-model harness: skilled + novice players, non-first hunts, Calm and
// Wrath, the live Strider and four other titans): each tier is met by roughly 40-85% of single hunts, so a decent
// hunter fulfils any omen within 1-5 tries. The old ones (45 s clean, 80 s alight, 16-graze chains) were met by
// almost no one: R4's longest clean stretch in a non-first run was 20.5 s.
const POOL = [
  { id: "graze", ns: [12, 16, 20], text: (n) => `Graze ${n} attacks in one hunt`, test: (s, n) => s.grazes >= n },
  { id: "time", ns: [25, 35, 45], text: (n) => `Stay alight for ${n} seconds`, test: (s, n) => s.time >= n },
  { id: "blows", ns: [1000, 1500, 2000], text: (n) => `Strike ${fmt(n)} blows in one hunt`, test: (s, n) => s.damage >= n },
  { id: "surge", ns: [1, 2], text: (n) => (n === 1 ? "Surge in a hunt" : `Surge ${n} times in one hunt`), test: (s, n) => s.surges >= n },
  { id: "clean", ns: [12, 16, 20], text: (n) => `Go ${n} seconds without being struck`, test: (s, n) => s.cleanTime >= n },
  { id: "chain", ns: [4, 6, 7], text: (n) => `Chain ${n} grazes in a row`, test: (s, n) => s.bestCombo >= n },
];
/** every omen's tiers, for tests and the How page */
export const OMEN_POOL = POOL.map(({ id, ns }) => ({ id, ns: ns.slice() }));

export function omenFor(day = dayIndex()) {
  const h = hash32("omen", day);
  const k = POOL[h % POOL.length];
  const n = k.ns[(h >>> 8) % k.ns.length];
  // one day in three, the omen asks for a particular light
  const aspect = (h >>> 16) % 3 === 0 ? Object.keys(ASPECT_NAMES)[(h >>> 20) % 4] : null;
  const text = k.text(n) + (aspect ? `, bearing ${ASPECT_NAMES[aspect]}` : "") + ".";
  return { day, id: k.id, n, aspect, text, test: (s) => k.test(s, n) && (!aspect || s.aspect === aspect) };
}

/** hours and minutes until the next omen (UTC midnight) */
export function untilNext(now = Date.now()) {
  const ms = (dayIndex(now) + 1) * DAY - now;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** the streak as it stands today: it lapses if yesterday's omen was missed */
export function liveStreak(p, day = dayIndex()) {
  if (!p.omenDay) return 0;
  return p.omenDay >= day - 1 ? p.omenStreak || 0 : 0;
}

/** after a run: returns the profile patch when this run fulfils today's omen for the first time */
export function judgeOmen(p, s, now = Date.now()) {
  const day = dayIndex(now);
  if (p.omenDay === day) return null;
  if (!omenFor(day).test(s)) return null;
  const streak = p.omenDay === day - 1 ? (p.omenStreak || 0) + 1 : 1;
  return { omenDay: day, omenStreak: streak, omenBest: Math.max(p.omenBest || 0, streak) };
}

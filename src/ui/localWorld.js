// A world of your own, in this browser only: a pinned titan (?seed=, for tests and tools), a rehearsal
// against a near-dead titan (?rehearse), or the titan of a ghost link (?replay=). Only your own blows wound
// it and nothing is sent to the live world. When its wounds run out it falls with the same ceremony as the
// live world's titans (FELLED, the final blow, the top hunters: here only you), and the next one wakes.

import { makeTitan } from "@/core/titan";
import { hash32 } from "@/core/rng";

const BLOCK = 3 * 3600 * 1000;
/** the next titan wakes this long after a fall (as in the live world: base44/actors/world/logic.ts) */
export const INTERLUDE_MS = 20_000;
/** the fallen engraving lifts off the page (Game.fell) before the next titan is engraved in */
export const LIFT_MS = 3_800;
/** a rehearsal titan is sized like the live world's quietest titan (logic.ts HP_FLOOR)... */
export const REHEARSAL_HP = 10_000;
/** ...and wakes near death: a few seconds of good blows bring it down */
export const REHEARSAL_LEFT = 0.04;
const LOCAL_HP = 400_000;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");

export function createLocalWorld(game, opts = {}, hooks = {}) {
  const q = new URLSearchParams(opts.search ?? (typeof location !== "undefined" ? location.search : ""));
  const rehearsal = !!opts.rehearsal;
  const replay = opts.replay ?? null;
  const now = Date.now();
  const block = Math.floor(now / BLOCK);
  let seed = opts.seed ?? (q.get("seed") ? Number(q.get("seed")) : rehearsal ? hash32("rehearsal", now) : hash32("local", block));
  let wokeAt = q.get("t") ? now - Number(q.get("t")) * 1000 : rehearsal ? now - 40_000 : block * BLOCK;
  let number = opts.number ?? (q.get("n") ? Number(q.get("n")) : rehearsal ? 1 : (block % 900) + 1);
  const hpMax = rehearsal ? REHEARSAL_HP : LOCAL_HP;
  const left = q.has("hp") ? Number(q.get("hp")) : rehearsal ? REHEARSAL_LEFT : 1;
  const st = {
    spec: makeTitan(seed, number),
    hp: Math.max(1, Math.round(hpMax * (Number.isFinite(left) ? Math.max(0, Math.min(1, left)) : 1))),
    hpMax,
    online: 1,
    watching: 0,
    echoes: 0,
    hunters: [],
    feed: [],
    wokeAgo: "",
    local: true,
    /** a rehearsal against a titan of your own: nothing here is written in the Hall */
    rehearsal,
    /** a ghost link's recorded run is playing, not a live fight */
    replay: replay ? { name: replay.name, sigil: replay.sigil, damage: replay.damage, duration: replay.duration } : null,
    /** a titan pinned to this page with ?seed= (tests, tools, film) */
    pinned: !rehearsal && !replay,
    interlude: 0,
    last: null,
  };
  let feedId = 0;
  let me = null; // who you are (set when you join)
  let mine = 0; // your blows against this titan
  let falling = false;
  let woke = Date.now() >= wokeAt;
  let liftTimer = null;
  const w = {
    state: st,
    onChange: null,
    start() {
      game.setTitan(seed, number);
      game.clock = () => (Date.now() - wokeAt) / 1000;
      game.hpFrac = st.hp / st.hpMax;
      st.spec = game.spec;
      if (replay) w.push(`A recorded run: <b>${esc(replay.name || "A hunter")}</b>'s light against <b>${esc(st.spec.name)}</b>, replayed from the titan's seed. Nothing here is live.`);
      else if (rehearsal)
        w.push(`A rehearsal: <b>${esc(st.spec.name)}</b>, a titan of your own, woke near death. Only your blows wound it, and nothing here is written in the Hall.`);
      else w.push(`<b>${esc(st.spec.name)}</b> woke and began to sing.`);
      w.tick = setInterval(() => w.update(), 250);
      w.update();
    },
    update() {
      const t = Date.now();
      st.interlude = t < wokeAt ? Math.ceil((wokeAt - t) / 1000) : 0;
      if (!woke && t >= wokeAt) {
        woke = true;
        opts.audio?.sfx?.("wake");
        w.push(`<b>${esc(st.spec.name)}</b>, the next titan, woke and began to sing.${rehearsal ? " Still a rehearsal: only your blows count." : ""}`);
      }
      const mins = Math.floor(Math.max(0, t - wokeAt) / 60000);
      st.wokeAgo = t < wokeAt + 60000 ? "moments ago" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"} ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
      w.onChange?.(st);
    },
    stop() {
      clearInterval(w.tick);
      clearTimeout(liftTimer);
    },
    push(html) {
      st.feed.push({ id: ++feedId, html, n: Date.now() });
      if (st.feed.length > 30) st.feed.shift();
      w.onChange?.(st);
    },
    identify(profile) {
      me = { name: profile.name || "Nameless", sigil: profile.sigil | 0 };
    },
    addHit(core, dmg) {
      if (falling || st.hp <= 0 || Date.now() < wokeAt || !(dmg > 0)) return;
      const d = Math.min(dmg, st.hp);
      mine += d;
      st.hp -= d;
      game.hpFrac = st.hp / st.hpMax;
      if (st.hp > 0) return;
      // like the live world's news, the fall lands after this frame's blows (Game.fell inside the frame that
      // dealt the blow would end the run twice)
      falling = true;
      setTimeout(() => w.fall(), 0);
    },
    /** the wounds ran out: the same ceremony as the live world, from this browser's own record */
    fall() {
      if (st.last && st.last.seed === seed) return;
      falling = true;
      const t = Date.now();
      const spec = st.spec;
      const end = {
        number, seed, wokeAt, hpMax: st.hpMax, status: "felled", endedAt: t,
        blow: me ? { name: me.name, sigil: me.sigil } : null,
        top: me && mine > 0 ? [{ name: me.name, sigil: me.sigil, damage: Math.round(mine) }] : [],
        damageTotal: Math.round(mine),
        hunterCount: 1,
        local: true,
        rehearsal,
      };
      const next = { number: number + 1, seed: hash32(seed, "next"), wokeAt: t + INTERLUDE_MS, hpMax: st.hpMax, status: "awake" };
      st.last = end;
      w.push(`<b class="gold">${esc(spec.name)} was felled</b>${me ? `; the final blow was <b>${esc(me.name)}</b>'s` : ""}.${rehearsal ? " A rehearsal: it is not written in the Hall." : ""}`);
      // ends your run as a victory (Hunt shows "The titan is felled!") and lifts the engraving away
      game.fell();
      hooks.onFelled?.(end, next);
      liftTimer = setTimeout(() => {
        seed = next.seed;
        number = next.number;
        wokeAt = next.wokeAt;
        woke = false;
        mine = 0;
        st.hp = st.hpMax;
        game.setTitan(seed, number);
        game.clock = () => (Date.now() - wokeAt) / 1000;
        game.hpFrac = 1;
        st.spec = game.spec;
        falling = false;
        w.push(`A new titan stirs on the page: <b>${esc(st.spec.name)}</b>, ${esc(st.spec.epithet)}.`);
        w.update();
      }, LIFT_MS);
      w.update();
    },
    /** your share of the wounds: only meaningful in the shared world */
    shareOf() {
      return null;
    },
    sendRun(s) {
      if (s.felled || replay) return;
      w.push(`Your light went out after <span class="gold">${fmt(s.damage)}</span> blows.`);
    },
  };
  return w;
}

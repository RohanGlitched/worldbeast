// A world of your own, in this browser only: a pinned titan (?seed=, for tests and tools), a rehearsal
// against a near-dead titan (?rehearse), or the titan of a ghost link (?replay=). Only your own blows wound
// it and nothing is sent to the live world. When its wounds run out it falls with the same ceremony as the
// live world's titans (FELLED, the final blow, the top hunters: here only you), and the next one wakes.

import { makeTitan, seedUnlike, stageFor } from "@/core/titan";
import { hash32 } from "@/core/rng";

const BLOCK = 3 * 3600 * 1000;
/** the next titan wakes this long after a fall (as in the live world: base44/actors/world/logic.ts) */
export const INTERLUDE_MS = 20_000;
/** the fallen engraving lifts off the page (Game.fell) before the next titan is engraved in */
export const LIFT_MS = 3_800;
/** every titan of your own (pinned, replayed, rehearsed) is sized like the live world's quietest (logic.ts HP_FLOOR) */
export const LOCAL_HP = 10_000;
export const REHEARSAL_HP = LOCAL_HP;
/**
 * A rehearsal titan wakes near death, ~1,200 blows from falling, and fights it out in Wrath, not Ruin (R4's
 * rehearsal woke in Ruin at 400 and a novice died before it fell). R6's 700 fell in ~4 s to a player who never
 * touched a key, with the Surge on top of the fall. At 1,200 (a still light strikes at core/hunt.ts STILL_MUL),
 * harness Nov 10, 16 seeds x 2 wake times: no input fells it in 15.9-45.7 s (median 30 s); a look-ahead player
 * with a human reaction delay in 6.4-34 s (median 12.9 s novice, 13.0 s skilled), and its one Surge (the light
 * enters full: REHEARSAL_RESONANCE) is over more than a second before the fall in 58/64.
 */
export const REHEARSAL_LEFT = 0.12;
export const REHEARSAL_STAGE = 1;
/**
 * A rehearsal's light enters full of Resonance, so its Surge comes as soon as the spawn grace is over and a wound
 * is open (~3 s in), well before the fall (core/hunt.ts: never a Surge inside the spawn grace).
 */
export const REHEARSAL_RESONANCE = 100;
/** a rehearsal's near-death titan woke this long before the page opened (it is awake and singing at once) */
const REHEARSAL_AWAKE_MS = 40_000;
/** hunt options for a rehearsal's near-death titan (see state.huntOpts) */
const rehearsalOpts = () => ({ forgiving: true, resonance: REHEARSAL_RESONANCE, gentle: false });

/**
 * The seed of the titan after `seed`: never the same body or the same epithet as the one just felled (as in the
 * live world). Deterministic.
 */
export function nextLocalSeed(seed) {
  const spec = makeTitan(seed, 1);
  return seedUnlike((k) => (k === 0 ? hash32(seed, "next") : hash32(seed, "next", k)), spec.archetype, spec.epithet);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");

export function createLocalWorld(game, opts = {}, hooks = {}) {
  const q = new URLSearchParams(opts.search ?? (typeof location !== "undefined" ? location.search : ""));
  const rehearsal = !!opts.rehearsal;
  const replay = opts.replay ?? null;
  const now = Date.now();
  const block = Math.floor(now / BLOCK);
  let seed = opts.seed ?? (q.get("seed") ? Number(q.get("seed")) : rehearsal ? hash32("rehearsal", now) : hash32("local", block));
  let wokeAt = q.get("t") ? now - Number(q.get("t")) * 1000 : rehearsal ? now - REHEARSAL_AWAKE_MS : block * BLOCK;
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
    /**
     * Hunt options for runs here: in a rehearsal a hit costs Resonance, not a light (core/hunt.ts forgiving),
     * so the light cannot go out before the titan falls, and the light starts with REHEARSAL_RESONANCE so one
     * Surge comes before the fall. Wiring: Game.start(aspect, { ...opts, ...state.huntOpts }).
     */
    // (never `gentle`: a rehearsal cannot be lost anyway, and it is there to show Wrath's whole page)
    // Only a near-death titan is forgiving: the whole titan that wakes after a rehearsal's fall is fought by the
    // ordinary rules (R6: "Hunt again" after a fall opened a 10,000-blow titan that could not be lost).
    huntOpts: rehearsal ? rehearsalOpts() : {},
    /**
     * The titan on the page woke near death (a rehearsal's first titan, or one woken by rehearseAgain). The
     * titan that wakes after a rehearsal's fall is a whole 10,000-blow titan: lore that says "woken near death"
     * must check this, not `rehearsal`.
     */
    nearDeath: rehearsal && !q.has("hp"),
    /**
     * Whether runs here count toward the profile (seals, personal best, the day's omen). A world of your own
     * (pinned, rehearsal, ghost replay) never does: Hunt.jsx onDown should skip judgeSeals/judgeOmen/best/total
     * when this is false.
     */
    counts: false,
    interlude: 0,
    last: null,
  };
  let feedId = 0;
  let me = null; // who you are (set when you join)
  let mine = 0; // your blows against this titan
  let falling = false;
  let woke = Date.now() >= wokeAt;
  let liftTimer = null;
  /** the seed of the near-death titan on the page (it fights in Wrath to its fall), else null */
  let nearSeed = rehearsal && !q.has("hp") ? seed : null;
  /** rehearseAgain() was asked for while the fallen titan was still lifting off the page */
  let again = false;
  /** wake a fresh near-death titan in place of the current one (a rehearsal only) */
  const wakeNearDeath = () => {
    seed = nextLocalSeed(seed);
    number += 1;
    wokeAt = Date.now() - REHEARSAL_AWAKE_MS;
    woke = true;
    mine = 0;
    falling = false;
    nearSeed = seed;
    st.hp = Math.max(1, Math.round(st.hpMax * REHEARSAL_LEFT));
    game.setTitan(seed, number);
    game.clock = () => (Date.now() - wokeAt) / 1000;
    game.hpFrac = st.hp / st.hpMax;
    game.stageFn = () => (seed === nearSeed ? REHEARSAL_STAGE : stageFor(game.hpFrac));
    st.spec = game.spec;
    st.nearDeath = true;
    st.huntOpts = rehearsalOpts();
    w.push(`Another rehearsal: <b>${esc(st.spec.name)}</b>, ${esc(st.spec.epithet)}, woke near death. Only your blows wound it.`);
    w.update();
  };
  const w = {
    state: st,
    onChange: null,
    start() {
      game.setTitan(seed, number);
      game.clock = () => (Date.now() - wokeAt) / 1000;
      game.hpFrac = st.hp / st.hpMax;
      st.spec = game.spec;
      // the rehearsal titan fights in Wrath to its fall (its wounds alone would say Ruin); the next one follows its wounds
      if (nearSeed !== null) game.stageFn = () => (seed === nearSeed ? REHEARSAL_STAGE : stageFor(game.hpFrac));
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
        w.push(`<b>${esc(st.spec.name)}</b>, the next titan, woke and began to sing.${rehearsal ? " A whole titan of your own: only your blows count, and a light lost here is lost." : ""}`);
      }
      const mins = Math.floor(Math.max(0, t - wokeAt) / 60000);
      st.wokeAgo = t < wokeAt + 60000 ? "moments ago" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"} ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
      w.onChange?.(st);
    },
    stop() {
      clearInterval(w.tick);
      clearTimeout(liftTimer);
      if (rehearsal && !replay) game.stageFn = null;
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
      const next = { number: number + 1, seed: nextLocalSeed(seed), wokeAt: t + INTERLUDE_MS, hpMax: st.hpMax, status: "awake" };
      st.last = end;
      w.push(`<b class="gold">${esc(spec.name)} was felled</b>${me ? `; the final blow was <b>${esc(me.name)}</b>'s` : ""}.${rehearsal ? " A rehearsal: it is not written in the Hall." : ""}`);
      // ends your run as a victory (Hunt shows "The titan is felled!") and lifts the engraving away
      game.fell();
      hooks.onFelled?.(end, next);
      liftTimer = setTimeout(() => {
        liftTimer = null;
        if (again) {
          // "Rehearse another fall", asked for while this one was lifting: a fresh near-death titan, awake now
          again = false;
          wakeNearDeath();
          return;
        }
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
        // the next titan is a whole one (its lore must not say "woken near death"), fought by the ordinary rules:
        // never forgiving, and its light starts plain
        st.nearDeath = false;
        nearSeed = null;
        st.huntOpts = {};
        w.push(`A new titan stirs on the page: <b>${esc(st.spec.name)}</b>, ${esc(st.spec.epithet)}.`);
        w.update();
      }, LIFT_MS);
      w.update();
    },
    /**
     * "Rehearse another fall" (a rehearsal only): the next titan is a fresh near-death one, awake at once and
     * forgiving, instead of the whole 10,000-blow titan that otherwise wakes after a fall. Call it from the
     * button, then begin() as usual: while the fallen titan is still lifting off the page the new one is engraved
     * the moment it has gone (begin() queues the run until then). Returns false outside a rehearsal.
     */
    rehearseAgain() {
      if (!rehearsal || replay) return false;
      if (liftTimer) again = true;
      else if (!(st.nearDeath && st.hp > 0 && !falling)) wakeNearDeath(); // (a near-death titan already up stays)
      return true;
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

// Binds the live Base44 world (src/net/world.ts) to the game and the codex UI.
// Same shape as localWorld.js: { state, onChange, start, stop, addHit, shareOf, sendRun }.

import { World } from "@/net/world";
import { makeTitan } from "@/core/titan";
import { SIGIL_NAMES } from "./sigils";
import { base44 } from "@/api/base44Client";
import { liveItems, historyItems, mergeChronicle, loadHistory } from "./chronicle";

const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");

export function createLiveWorld(game, audio, hooks = {}) {
  const world = new World();
  const st = {
    spec: null,
    hp: 1,
    hpMax: 1,
    online: 1,
    watching: 0, // connected browsers that have not joined the hunt
    echoes: 0,
    hunters: [], // { id, name, sigil, me, flying }: only hunters who joined, on a connection still open
    feed: [],
    wokeAgo: "",
    local: false,
    mode: "connecting",
    interlude: 0, // seconds until the next titan wakes
    last: null, // the titan that just ended
  };
  let history = [];
  const rebuildFeed = () => {
    st.feed = mergeChronicle(history, liveItems(world.feed, st.spec));
  };
  const rebuildHunters = () => {
    const flying = world.inFlight();
    const playing = game.phase === "playing";
    st.hunters = world.hunters.map((r) => ({ id: r.id, name: r.name, sigil: r.sigil, me: r.id === world.you, flying: r.id === world.you ? playing : flying.has(r.id) }));
    st.watching = world.watchingCount;
  };
  let pendingTitan = null;
  let pendingTimer = null;
  const w = {
    world,
    state: st,
    onChange: null,
    start() {
      world.events.onStatus = (m) => {
        st.mode = m;
        st.local = m === "offline";
        w.emit();
      };
      world.events.onTitan = (t, spec) => {
        // let a falling titan finish lifting off the page before the next one is engraved
        const apply = () => {
          game.setTitan(t.seed, t.number);
          st.spec = game.spec;
          pendingTitan = null;
          rebuildFeed();
          w.emit();
        };
        // the next titan announced during the interlude (it arrives just before the "felled" news):
        // hold it until the fallen one has lifted off the page
        const interlude = game.spec && game.spec.seed !== t.seed && world.serverNow() < t.wokeAt && game.spec.number > 0 && t.number > game.spec.number;
        if (game.falling || interlude) {
          pendingTitan = apply;
          clearTimeout(pendingTimer);
          pendingTimer = setTimeout(() => pendingTitan?.(), 3800);
        } else if (game.phase === "playing" && game.spec && game.spec.number === t.number && game.spec.seed !== t.seed) {
          // the connection flickered (world ↔ local titan): finish this run first
          pendingTitan = apply;
        } else if (game.phase === "playing" && game.spec && game.spec.seed !== t.seed && t.number === 0) {
          pendingTitan = apply;
        } else apply();
      };
      world.events.onFelled = (end, next) => {
        st.last = end;
        game.fell();
        hooks.onFelled?.(end, next);
        w.emit();
      };
      world.events.onWake = (t) => {
        audio?.sfx("wake");
        hooks.onWake?.(t);
      };
      world.events.onStage = () => w.emit();
      world.events.onFeed = () => {
        rebuildFeed();
        w.emit();
      };
      // the welcome carries the actor's saved feed: show it at once, not only after the next event
      world.events.onWelcome = () => {
        rebuildFeed();
        w.emit();
      };
      world.events.onHunters = () => {
        rebuildHunters();
        w.emit();
      };
      // the chronicle on arrival: the latest real runs and titans from the actor's records
      loadHistory(base44?.entities).then((h) => {
        history = historyItems({ ...h, now: Date.now() });
        rebuildFeed();
        w.emit();
      });
      world.events.onRevive = (e) => {
        if (e.me && game.revive()) hooks.onRevived?.(e.byName);
      };
      world.events.onDown = () => {};
      game.clock = () => world.titanTime();
      game.stageFn = () => world.stage;
      game.others = world.others;
      game.events.onPos = (x, y, alive, flags) => world.sendPos(x, y, alive, flags);
      world.connect();
      w.tick = setInterval(() => {
        if (pendingTitan && !game.falling && game.phase !== "playing") pendingTitan();
        const t = world.titanTime();
        game.hpFrac = world.hpFrac;
        st.hp = world.hp;
        st.hpMax = world.hpMax;
        st.online = Math.max(1, world.onlineCount);
        rebuildHunters();
        st.interlude = t < 0 ? Math.ceil(-t) : 0;
        st.echoes = world.echoesAt().length;
        const mins = Math.floor(Math.max(0, t) / 60);
        st.wokeAgo = t < 60 ? "moments ago" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"} ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
        w.emit();
      }, 250);
      // hp must follow every frame for the titan's cracks, not just the UI tick
      w.hpTick = setInterval(() => (game.hpFrac = world.hpFrac), 50);
    },
    emit() {
      w.onChange?.(st);
    },
    stop() {
      clearInterval(w.tick);
      clearInterval(w.hpTick);
      clearTimeout(pendingTimer);
      world.close();
    },
    identify(profile) {
      world.setIdentity({ name: profile.name || "Nameless", sigil: profile.sigil, aspect: profile.aspect });
    },
    addHit(core, dmg, beat, surge) {
      world.addHit(core, dmg, beat, surge ? 1 : 0);
    },
    /** a mark at the start of a run: the blows the world has accepted from this browser so far */
    runMark() {
      return st.local ? null : { ok: world.stats.ok, hpMax: world.hpMax, number: world.titanNumber };
    },
    /** fraction of the titan's whole life the world accepted from you since the mark (late acks included) */
    moved(mark) {
      if (!mark || st.local || !(mark.hpMax > 1)) return null;
      return Math.max(0, world.stats.ok - mark.ok) / mark.hpMax;
    },
    shareOf(dmg) {
      const total = st.last && st.last.number === st.spec?.number ? st.last.damageTotal : st.hpMax - st.hp;
      return total > 0 ? Math.min(100, (dmg / total) * 100).toFixed(1) + "%" : null;
    },
    down(x, y) {
      world.sendDown(x, y);
    },
    async sendRun(s) {
      return world.sendRun(s);
    },
    sigilName: (i) => SIGIL_NAMES[i],
    specFor: (t) => makeTitan(t.seed, t.number),
    fmt,
  };
  return w;
}

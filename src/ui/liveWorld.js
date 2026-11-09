// Binds the live Base44 world (src/net/world.ts) to the game and the codex UI.
// Same shape as localWorld.js: { state, onChange, start, stop, addHit, shareOf, sendRun }.

import { World } from "@/net/world";
import { makeTitan } from "@/core/titan";
import { SIGIL_NAMES } from "./sigils";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
const STAGE = ["Calm", "Wrath", "Ruin"];
const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function feedHtml(f, spec) {
  const who = `<b>${esc(f.name || "A hunter")}</b>`;
  switch (f.k) {
    case "join":
      return `${who} joined the hunt.`;
    case "surge":
      return `${who} <span class="gold">surged</span>.`;
    case "break":
      return `${who} struck the wound beneath the ${["first", "second", "third", "fourth", "fifth", "sixth"][f.v ?? 0] ?? "hidden"} seal.`;
    case "down":
      return `${who}'s light went out.`;
    case "revive":
      return `${who} was rekindled.`;
    case "stage":
      return `${spec ? esc(spec.name) : "The titan"} passed into <b>${STAGE[f.v ?? 0]}</b>.`;
    case "felled":
      return `<b class="gold">${spec ? esc(spec.name) : "The titan"} was felled</b>${f.name ? `; the final blow was ${who}'s` : ""}.`;
    case "escaped":
      return `The titan slipped away unfelled.`;
    case "wake":
      return `The ${f.v ? ORD(f.v) : "next"} titan woke.`;
    default:
      return esc(f.k);
  }
}

export function createLiveWorld(game, audio, hooks = {}) {
  const world = new World();
  const st = {
    spec: null,
    hp: 1,
    hpMax: 1,
    online: 1,
    echoes: 0,
    hunters: [],
    feed: [],
    wokeAgo: "",
    local: false,
    mode: "connecting",
    interlude: 0, // seconds until the next titan wakes
    last: null, // the titan that just ended
  };
  let feedId = 0;
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
          w.emit();
        };
        if (game.falling) {
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
      world.events.onFeed = (_items, all) => {
        const seenJoin = new Set();
        const deduped = all
          .slice(-40)
          .reverse()
          .filter((f) => (f.k === "join" ? !seenJoin.has(f.name) && seenJoin.add(f.name) : true))
          .reverse();
        st.feed = deduped.slice(-30).map((f) => ({ id: f.n + ":" + f.k + ":" + (f.name || "") + ":" + feedId++, html: feedHtml(f, st.spec) }));
        w.emit();
      };
      world.events.onHunters = (roster) => {
        st.hunters = roster.map((r) => ({ id: r.id, name: r.name, sigil: r.sigil }));
        w.emit();
      };
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

// A stand-in world used until the live Base44 world connects (and as the offline fallback):
// the titan is chosen by the current 3-hour block, and only your own blows wound it.

import { makeTitan } from "@/core/titan";
import { hash32 } from "@/core/rng";

const BLOCK = 3 * 3600 * 1000;

export function createLocalWorld(game, opts = {}) {
  const q = new URLSearchParams(location.search);
  const now = Date.now();
  const block = Math.floor(now / BLOCK);
  const seed = opts.seed ?? (q.get("seed") ? Number(q.get("seed")) : hash32("local", block));
  const wokeAt = q.get("t") ? now - Number(q.get("t")) * 1000 : block * BLOCK;
  const number = opts.number ?? (q.get("n") ? Number(q.get("n")) : (block % 900) + 1);
  const hpMax = 400000;
  const st = {
    spec: makeTitan(seed, number),
    hp: hpMax * Number(q.get("hp") ?? 1),
    hpMax,
    online: 1,
    echoes: 0,
    hunters: [],
    feed: [],
    wokeAgo: "",
    local: true,
  };
  let feedId = 0;
  const w = {
    state: st,
    onChange: null,
    start() {
      game.setTitan(seed, number);
      game.clock = () => (Date.now() - wokeAt) / 1000;
      game.hpFrac = st.hp / st.hpMax;
      st.spec = game.spec;
      w.push(`<b>${st.spec.name}</b> woke and began to sing.`);
      w.tick = setInterval(() => {
        const mins = Math.floor((Date.now() - wokeAt) / 60000);
        st.wokeAgo = mins < 1 ? "moments ago" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"} ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
        w.onChange?.(st);
      }, 1000);
      w.onChange?.(st);
    },
    stop() {
      clearInterval(w.tick);
    },
    push(html) {
      st.feed.push({ id: ++feedId, html });
      if (st.feed.length > 30) st.feed.shift();
      w.onChange?.(st);
    },
    addHit(core, dmg) {
      st.hp = Math.max(0, st.hp - dmg);
      game.hpFrac = st.hp / st.hpMax;
    },
    shareOf(dmg) {
      const total = st.hpMax - st.hp;
      return total > 0 ? ((dmg / total) * 100).toFixed(1) + "%" : null;
    },
    sendRun(s) {
      w.push(`A hunter's light went out after <span class="gold">${Math.round(s.damage).toLocaleString("en-US")}</span> blows.`);
    },
  };
  return w;
}

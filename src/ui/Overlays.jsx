import { memo, useEffect, useRef, useState } from "react";
import { Sigil } from "./sigils";

// Fast-changing overlays live in their own components so the codex itself doesn't re-render with them.

/**
 * damage numbers and notes that rise and fade; `bind` receives a push(text, x, y, kind) function.
 * Written straight into the DOM (no React render per blow): a phone striking a dozen times a second spent a
 * third of its frame re-rendering this list. Blows landing within a moment of each other share one number,
 * and only a few numbers are ever in the air at once.
 */
const FLOAT_MAX = 10;
export const Floats = memo(function Floats({ bind }) {
  const box = useRef(null);
  useEffect(() => {
    const live = [];
    let last = null; // the newest blow number: the next blow soon after adds to it
    const drop = (el) => {
      const i = live.indexOf(el);
      if (i >= 0) live.splice(i, 1);
      el.remove();
      if (last?.el === el) last = null;
    };
    bind((text, x, y, kind) => {
      const root = box.current;
      if (!root) return;
      const now = performance.now();
      if (kind === "dmg") {
        const n = Number(text);
        if (last && now - last.t < 140 && Number.isFinite(n) && Math.abs(last.x - x) < 60 && Math.abs(last.y - y) < 60) {
          last.v += n;
          last.el.textContent = String(last.v);
          return;
        }
        // too many in the air: blows wait for the next number rather than adding to the crowd
        if (live.length >= FLOAT_MAX) return;
      } else if (live.length >= FLOAT_MAX) drop(live[0]);
      const el = document.createElement("div");
      el.className = "float " + kind + "-f";
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.textContent = text;
      root.appendChild(el);
      live.push(el);
      setTimeout(() => drop(el), 950);
      if (kind === "dmg") last = { el, t: now, x, y, v: Number(text) || 0 };
    });
    return () => {
      for (const el of live.splice(0)) el.remove();
    };
  }, [bind]);
  return <div ref={box} className="floats" aria-hidden="true" />;
});

/** names beside other hunters and echoes, refreshed ten times a second */
export const Labels = memo(function Labels({ game, world, u, hidden }) {
  const [list, setList] = useState([]);
  useEffect(() => {
    const tick = setInterval(() => {
      const lw = world?.world;
      const g = game;
      if (!lw || !g?.spec) return setList((l) => (l.length ? [] : l));
      const out = [];
      for (const h of lw.remoteHunters()) {
        if (h.flags & 128) continue;
        const p = g.screenOf(h.x, h.y);
        out.push({ k: "h" + h.id, x: p.x, y: p.y, text: h.name, sigil: h.sigil, kind: "live" });
      }
      for (const e of lw.echoesAt()) {
        const p = g.screenOf(e.x, e.y);
        out.push({ k: "e" + e.id, x: p.x, y: p.y, text: "echo · " + e.name, sigil: e.sigil, kind: "echo" });
      }
      setList(out.slice(0, 24));
    }, 100);
    return () => clearInterval(tick);
  }, [game, world]);
  if (hidden) return null;
  return list.map((l) => (
    <div key={l.k} className={"hunter-label " + l.kind} style={{ left: l.x, top: l.y }}>
      <Sigil id={l.sigil} size={u * 0.38} /> {l.text}
    </div>
  ));
});

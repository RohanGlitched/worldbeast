import { memo, useEffect, useRef, useState } from "react";
import { Sigil } from "./sigils";

// Fast-changing overlays live in their own components so the codex itself doesn't re-render with them.

/** damage numbers and notes that rise and fade; `bind` receives a push(text, x, y, kind) function */
export const Floats = memo(function Floats({ bind }) {
  const [list, setList] = useState([]);
  const id = useRef(0);
  useEffect(() => {
    bind((text, x, y, kind) => {
      const k = ++id.current;
      setList((f) => [...f.slice(-24), { id: k, text, x, y, kind }]);
      setTimeout(() => setList((f) => f.filter((q) => q.id !== k)), 950);
    });
  }, [bind]);
  return list.map((f) => (
    <div key={f.id} className={"float " + f.kind + "-f"} style={{ left: f.x, top: f.y }}>
      {f.text}
    </div>
  ));
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

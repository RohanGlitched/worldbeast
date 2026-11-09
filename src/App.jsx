import { useEffect, useRef, useState } from "react";
import { Game } from "@/game/Game";

export default function App() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const [hud, setHud] = useState(null);
  const [phase, setPhase] = useState("lobby");
  useEffect(() => {
    const g = new Game(canvasRef.current);
    gameRef.current = g;
    const q = new URLSearchParams(location.search);
    const seed = Number(q.get("seed") ?? 7);
    const hp = Number(q.get("hp") ?? 1);
    g.hpFrac = hp;
    g.setTitan(seed, 1);
    const t0 = performance.now() / 1000 - Number(q.get("t") ?? 0);
    g.clock = () => performance.now() / 1000 - t0;
    g.events.onHud = (h) => {
      setHud(h);
      setPhase(h.phase);
    };
    g.run();
    window.__game = g;
    return () => g.stop();
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "#1a1410" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />
      <div style={{ position: "absolute", left: 12, top: 10, color: "#efe4cc", font: "13px system-ui" }}>
        {gameRef.current?.spec?.name} · {gameRef.current?.spec?.archetype} · {phase} · hits {hud?.hits} · dmg {hud?.damage} · res {Math.round(hud?.resonance ?? 0)} · stage {hud?.stage}
      </div>
      {phase !== "playing" && (
        <button onClick={() => gameRef.current.start("ember")} style={{ position: "absolute", left: "50%", bottom: 40, transform: "translateX(-50%)", padding: "12px 22px", fontSize: 16 }}>
          Join the hunt
        </button>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Game } from "@/game/Game";
import { ARCHETYPE_INFO, STAGE_NAMES, stageFor } from "@/core/titan";
import { ASPECTS } from "@/core/hunt";
import { Sigil, SIGIL_NAMES } from "./sigils";
import { loadProfile, saveProfile, cleanName } from "./profile";
import { createLocalWorld } from "./localWorld";
import Canticle from "./Canticle";
import Bookmarks from "./Bookmarks";
import { shareRun } from "./share";
import Cover from "./Cover";

const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const NOTE = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

const ASPECT_ICON = {
  ember: "M12 2c1 4 6 6.2 6 11.6A6 6 0 0 1 6 13.6c0-2.6 1.4-4.2 2.6-5.2.2 2 1 3.4 2.4 3.8C10 8.6 10.6 5 12 2z",
  lance: "M12 1.5l2 4.5-1.2 1V21h-1.6V7L10 6zM8.5 16h7",
  bloom: "M12 6.2c2.2-3.2 6.3-1.4 5.5 2.2 3.4.6 3.1 5.2-.2 5.4.9 3.6-3.6 5-5.3 2.1-1.7 2.9-6.2 1.5-5.3-2.1-3.3-.2-3.6-4.8-.2-5.4C5.7 4.8 9.8 3 12 6.2z",
  mirror: "M12 2l6 7-6 13-6-13zM6 9h12M9.5 9L12 22M14.5 9L12 22",
};

export default function Hunt() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const worldRef = useRef(null);
  const [profile, setProfile] = useState(loadProfile);
  const [layout, setLayout] = useState(null);
  const [hud, setHud] = useState(null);
  const [phase, setPhase] = useState("lobby");
  const [summary, setSummary] = useState(null);
  const [world, setWorld] = useState(null);
  const [floats, setFloats] = useState([]);
  const [pickSigil, setPickSigil] = useState(false);
  const [shareMsg, setShareMsg] = useState(null);
  const [closed, setClosed] = useState(() => {
    try {
      return !sessionStorage.getItem("wb-opened") && !new URLSearchParams(location.search).has("open");
    } catch {
      return true;
    }
  });
  const floatId = useRef(0);
  const closedRef = useRef(true);
  closedRef.current = closed;
  const [tip, setTip] = useState(null);
  const tipsSeen = useRef(new Set(profile.tips || []));

  useEffect(() => {
    const g = new Game(canvasRef.current);
    gameRef.current = g;
    window.__game = g;
    const w = createLocalWorld(g);
    worldRef.current = w;
    w.onChange = (s) => setWorld({ ...s });
    g.events.onLayout = setLayout;
    g.events.onHud = (h) => {
      setHud(h);
      setPhase(h.phase);
    };
    g.events.onHits = (dmg, core, beat) => w.addHit(core, dmg, beat);
    g.events.onDown = (s) => {
      setSummary({ ...s, worldShare: w.shareOf(s.damage) });
      w.sendRun(s);
      setProfile((p) => {
        const n = { ...p, runs: p.runs + 1, total: p.total + s.damage, best: Math.max(p.best, s.damage), fresh: false };
        saveProfile(n);
        return n;
      });
    };
    g.events.onFloat = (text, x, y, kind) => {
      const p = g.screenOf(x, y);
      const id = ++floatId.current;
      setFloats((f) => [...f.slice(-24), { id, text, x: p.x, y: p.y, kind }]);
      setTimeout(() => setFloats((f) => f.filter((q) => q.id !== id)), 950);
    };
    document.title = "WORLDBEAST · one titan, everyone, right now";
    g.holdReveal = closedRef.current;
    w.start();
    g.run();
    setLayout(g.layout());
    return () => {
      w.stop();
      g.stop();
    };
  }, []);

  const begin = useCallback(() => {
    const g = gameRef.current;
    setSummary(null);
    g.start(profile.aspect);
    canvasRef.current?.focus();
  }, [profile.aspect]);

  // keyboard: Enter starts / restarts
  useEffect(() => {
    const k = (e) => {
      if (e.key === "Enter" && phase !== "playing" && document.activeElement?.tagName !== "INPUT") begin();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [phase, begin]);

  // first-run marginal notes: each shows once, in order of need
  const showTip = useCallback((id, html, ms = 4200) => {
    if (tipsSeen.current.has(id)) return;
    tipsSeen.current.add(id);
    setTip({ id, html });
    setTimeout(() => setTip((t) => (t?.id === id ? null : t)), ms);
    setProfile((p) => {
      const n = { ...p, tips: [...tipsSeen.current] };
      saveProfile(n);
      return n;
    });
  }, []);
  useEffect(() => {
    if (!hud || phase !== "playing") return;
    const touch = layout && !layout.spread;
    if (hud.time < 6) showTip("move", touch ? "Drag anywhere to fly. Only the bright pip at your star's heart can be struck." : "Fly with <b>WASD</b> or the arrows. Only the bright pip at your star's heart can be struck.");
    else if (hud.coresOpen > 0) showTip("wound", "A <b>gold wound</b> is open. Your light strikes open wounds by itself; fly nearer the titan to strike harder.");
    if (hud.grazes >= 3) showTip("graze", "<b>Grazing</b> an attack fills Resonance. Fill it and your light Surges.");
    if (hud.time > 14) showTip("dash", touch ? "Tap <b>dash</b> or double-tap to pass clean through an attack." : "<b>Space</b> dashes you clean through an attack.");
    if (hud.time > 24) showTip("song", "Every attack lands on the beat. Read what comes next in <b>the Canticle</b>.");
  }, [hud, phase, layout, showTip]);

  const update = (patch) =>
    setProfile((p) => {
      const n = { ...p, ...patch };
      saveProfile(n);
      return n;
    });

  const spec = world?.spec;
  const hpFrac = world ? Math.max(0, world.hp / world.hpMax) : 1;
  const stage = stageFor(hpFrac);
  const u = layout ? layout.pxPerUnit : 26;
  const styleU = { "--u": u + "px" };

  const leafBody = spec && (
    <>
      <div className="folio">
        <span>WORLDBEAST · a living bestiary</span>
        <span>The {ORD(spec.number)} Titan</span>
      </div>
      <div>
        <h1>{spec.name}</h1>
        <div className="epithet">{spec.epithet}</div>
      </div>
      <p className="lore">
        <span className="dropcap" aria-hidden="true">
          {spec.name[0]}
        </span>
        {ARCHETYPE_INFO[spec.archetype].blurb} It woke {world.wokeAgo} and sings at {spec.bpm} beats a minute in {NOTE[spec.root % 12]} {spec.mode}. Every hunter online fights it now, on the same beat, in the same moment.
      </p>
      <section className="wounds" aria-label="The titan's wounds">
        <div className="rubric">Its wounds</div>
        <div className="bar">
          <div className="fill" style={{ width: (1 - hpFrac) * 100 + "%" }} />
          <div className="stagemarks">
            <i style={{ left: "34%" }} />
            <i style={{ left: "67%" }} />
          </div>
        </div>
        <div className="caption">
          <span>
            {((1 - hpFrac) * 100).toFixed(1)}% struck · {fmt(world.hp)} of {fmt(world.hpMax)} left
          </span>
          <span className={"stage-name stage-" + stage}>{STAGE_NAMES[stage]}</span>
        </div>
      </section>
      <section aria-label="The Canticle">
        <div className="rubric" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>The Canticle</span>
          <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
            phrase {(hud?.phrase ?? 0) + 1} of 8
          </span>
        </div>
        <Canticle game={gameRef.current} height={u * 3.1} />
      </section>
      <section>
        <div className="rubric">
          {world.online} {world.online === 1 ? "hunter" : "hunters"} in the hunt{world.echoes ? ` · ${world.echoes} echoes` : ""}
        </div>
        <div className="hunters">
          {world.hunters.slice(0, 10).map((h) => (
            <span className="hunter-chip" key={h.id}>
              <Sigil id={h.sigil} size={u * 0.5} /> {h.name}
            </span>
          ))}
        </div>
      </section>
      <section style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <div className="rubric">The chronicle</div>
        <ul className="chronicle">
          {world.feed.slice(-7).reverse().map((f) => (
            <li key={f.id} dangerouslySetInnerHTML={{ __html: f.html }} />
          ))}
        </ul>
      </section>
    </>
  );

  const lobbyControls = (
    <section aria-label="Join the hunt" style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
      <div className="namebox">
        <button className="sigil-pick" onClick={() => setPickSigil((v) => !v)} aria-label={"Your sigil: " + SIGIL_NAMES[profile.sigil]}>
          <Sigil id={profile.sigil} size={u * 0.75} className="filled" />
        </button>
        <input aria-label="Your hunter's name" value={profile.name} maxLength={18} onChange={(e) => update({ name: cleanName(e.target.value) || "" })} onBlur={(e) => !cleanName(e.target.value) && update({ name: "Nameless" })} />
      </div>
      {pickSigil && (
        <div className="sigil-grid" role="group" aria-label="Choose a sigil">
          {SIGIL_NAMES.map((n, i) => (
            <button key={n} aria-pressed={profile.sigil === i} title={n} onClick={() => (update({ sigil: i }), setPickSigil(false))}>
              <Sigil id={i} size={u * 0.6} />
            </button>
          ))}
        </div>
      )}
      <div className="aspects" role="group" aria-label="Choose your light">
        {Object.values(ASPECTS).map((a) => (
          <button key={a.id} className="aspect" aria-pressed={profile.aspect === a.id} onClick={() => update({ aspect: a.id })}>
            <svg viewBox="0 0 24 24" className="sigil">
              <path d={ASPECT_ICON[a.id]} />
            </svg>
            {a.name}
          </button>
        ))}
      </div>
      <div className="aspect-line">{ASPECTS[profile.aspect].line}</div>
      <button className="join" onClick={begin}>
        Join the hunt
        <small>{world?.online > 1 ? `${world.online - 1} others are fighting it now` : "Your echo will fly with the hunters after you"}</small>
      </button>
    </section>
  );

  const runStats = hud && phase === "playing" && (
    <dl className="facts">
      <dt>Your blows</dt>
      <dd>{fmt(hud.damage)}</dd>
      <dt>Grazes</dt>
      <dd>{hud.grazes}</dd>
      <dt>Light</dt>
      <dd>{ASPECTS[profile.aspect].name}</dd>
    </dl>
  );

  const L = layout;
  const arena = L?.arena;
  return (
    <div className="stage" style={styleU}>
      {phase !== "playing" && !closed && <Bookmarks />}
      {closed && (
        <Cover
          rect={L ? (L.spread && L.left ? { x: L.left.x, y: L.left.y - 4, w: L.right.x + L.right.w - L.left.x, h: L.left.h + 8 } : null) : null}
          online={world?.online ?? 1}
          onOpen={() => {
            try {
              sessionStorage.setItem("wb-opened", "1");
            } catch {}
            gameRef.current.holdReveal = false;
            gameRef.current.events.onSfx?.("ui");
            setTimeout(() => setClosed(false), 1350);
          }}
        />
      )}
      <canvas ref={canvasRef} tabIndex={0} aria-label="The hunt. Move with WASD, the arrow keys, or by dragging. Dash with Space." />

      {/* the bestiary leaf (wide screens) */}
      {L?.spread && L.left && spec && (
        <div className="leaf" style={{ left: L.left.x, top: L.left.y, width: L.left.w, height: L.left.h }}>
          {leafBody}
          {phase === "playing" ? runStats : !summary && lobbyControls}
        </div>
      )}

      {/* phones: slim header + bottom sheet */}
      {L && !L.spread && spec && (
        <>
          <div className="topbar">
            <span className="name">{spec.name}</span>
            <span className="bar">
              <i style={{ width: hpFrac * 100 + "%" }} />
            </span>
            <span>{world.online} online</span>
          </div>
          {phase !== "playing" && !summary && (
            <div className="sheet leaf" style={{ position: "absolute", "--u": "30px" }}>
              <div>
                <h1>{spec.name}</h1>
                <div className="epithet">{spec.epithet}</div>
              </div>
              {lobbyControls}
            </div>
          )}
        </>
      )}

      {/* HUD over the arena */}
      {arena && phase === "playing" && hud && (
        <div className="hud" style={{ left: arena.x, top: arena.y, width: arena.w, height: arena.h }}>
          <div className="hud-top">
            <div className="lives" aria-label={`${hud.maxHits - hud.hits} of ${hud.maxHits} lights left`}>
              {Array.from({ length: hud.maxHits }, (_, i) => (
                <span key={i} className={"life" + (i < hud.maxHits - hud.hits ? "" : " lost")} />
              ))}
            </div>
            <div className="dmg">
              {fmt(hud.damage)}
              <small>blows struck</small>
            </div>
          </div>
          <div className="hud-bottom">
            <span className="reso-label">{hud.surging ? "Surge!" : "Resonance"}</span>
            <span className={"reso" + (hud.resonance >= 99 || hud.surging ? " full" : "")}>
              <i style={{ width: (hud.surging ? 100 : hud.resonance) + "%" }} />
            </span>
            <span className="combo">{hud.combo > 1 ? `×${hud.combo}` : ""}</span>
          </div>
          {L && !L.spread && (
            <button className="dashbtn" style={{ right: u * 0.5, bottom: u * 1.6 }} onPointerDown={(e) => (e.preventDefault(), gameRef.current.input.queueDash())}>
              dash
            </button>
          )}
        </div>
      )}

      {/* run summary */}
      {summary && arena && (
        <div className="summary" style={{ left: arena.x + arena.w * 0.08, width: arena.w * 0.84, top: arena.y + arena.h * 0.2 }} role="dialog" aria-label="Your run">
          <h2>{summary.felled ? "The titan is felled!" : "Your light went out"}</h2>
          <div className="rubric">
            against {spec?.name}, after {summary.time.toFixed(1)} s
          </div>
          <div className="big">{fmt(summary.damage)}</div>
          <div style={{ fontStyle: "italic", color: "var(--ink-2)" }}>blows struck{summary.worldShare ? ` · ${summary.worldShare} of the world's today` : ""}</div>
          <dl className="facts" style={{ marginTop: "0.7em" }}>
            <dt>Grazes</dt>
            <dd>{summary.grazes}</dd>
            <dt>Best chain</dt>
            <dd>{summary.bestCombo}</dd>
            <dt>Surges</dt>
            <dd>{summary.surges}</dd>
            <dt>Your best</dt>
            <dd>{fmt(Math.max(profile.best, summary.damage))}</dd>
          </dl>
          {shareMsg && <div className="rubric" style={{ marginTop: "0.5em" }}>{shareMsg}</div>}
          <div className="row">
            <button className="join" style={{ flex: 2, fontSize: "1.3em" }} onClick={begin} autoFocus>
              Hunt again
            </button>
            <button
              className="ghost"
              style={{ flex: 1 }}
              onClick={async () => {
                setShareMsg("Engraving your card…");
                const r = await shareRun({ spec, summary, profile, share: summary.worldShare });
                setShareMsg(r === "shared" ? "Shared." : r === "saved+copied" ? "Card saved; link copied." : "Card saved.");
                setTimeout(() => setShareMsg(null), 3000);
              }}
            >
              Share
            </button>
            <button className="ghost" style={{ flex: 1 }} onClick={() => setSummary(null)}>
              Rest
            </button>
          </div>
        </div>
      )}

      {tip && arena && phase === "playing" && (
        <div className="margin-note" style={{ left: arena.x + arena.w * 0.1, width: arena.w * 0.8, top: arena.y + arena.h * 0.36 }} key={tip.id} dangerouslySetInnerHTML={{ __html: tip.html }} />
      )}

      {floats.map((f) => (
        <div key={f.id} className={"float " + f.kind + "-f"} style={{ left: f.x, top: f.y }}>
          {f.text}
        </div>
      ))}
    </div>
  );
}

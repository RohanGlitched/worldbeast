import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Game } from "@/game/Game";
import { ARCHETYPE_INFO, STAGE_NAMES, stageFor } from "@/core/titan";
import { ASPECTS } from "@/core/hunt";
import { Sigil, SIGIL_NAMES } from "./sigils";
import { loadProfile, saveProfile, cleanName } from "./profile";
import { createLocalWorld } from "./localWorld";
import { createLiveWorld } from "./liveWorld";
import { AudioEngine } from "@/game/audio/AudioEngine";
import Canticle from "./Canticle";
import Bookmarks from "./Bookmarks";
import { shareRun } from "./share";
import Cover from "./Cover";
import { Floats, Labels } from "./Overlays";
import { unpackReplay, replayUrl } from "./replay";
import { Seal, SEALS, judgeSeals } from "./seals";

const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const NOTE = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

// what struck the last blow, and how to live through it next time
const KILLERS = {
  ring: ["a ring of ink", "Rings always leave gaps: slip between two drops rather than outrunning them."],
  spiral: ["a turning spiral", "Spirals sweep around: circle with them, not against them."],
  fan: ["an aimed volley", "Volleys are aimed at a spot, not at you: step sideways as they leave the mouth."],
  wall: ["a wall of drops", "Watch the gold posts at the top: the gap opens where they stand."],
  rain: ["falling rain", "Rain falls down thin guide lines: stand between them."],
  wave: ["a swaying stream", "Streams sway in a rhythm: move with the sway."],
  curve: ["a curving flight", "Curving drops bend one way: read the bend and step the other."],
  bloom: ["a bursting seed", "A gold seed bursts where it lands: be far from the mark."],
  beam: ["a sweeping beam", "Beams start along the dashed guide: cross behind the stroke, or dash through it."],
  slam: ["a shockwave", "Shockwaves have two gaps: find one, or dash through the ring."],
  zone: ["a flooding glyph", "Circles drawn on the page flood with ink: leave before they fill."],
  cross: ["crossing lines", "Diagonal lines leave diamond gaps: wait inside one."],
  hound: ["its hounds", "Hounds are thrown at where you stand: keep moving, and step aside the moment their mark flares."],
  glyph: ["a flooding glyph", "Circles drawn on the page flood with ink: leave before they fill."],
};
const killerOf = (k) => KILLERS[k] ?? ["the titan's ink", "Every attack is warned a beat early: watch the marks on its body and the guides on the page."];

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
  const pushFloat = useRef(() => {});
  const bindFloats = useCallback((fn) => (pushFloat.current = fn), []);
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

  const audioRef = useRef(null);
  const [replay] = useState(() => {
    const raw = new URLSearchParams(location.search).get("replay");
    return raw ? unpackReplay(raw) : null;
  });
  const runTimer = useRef(null);
  const pendingRun = useRef(null);
  const flushRun = () => {
    if (!runTimer.current) return;
    clearTimeout(runTimer.current);
    runTimer.current = null;
    const r = pendingRun.current;
    pendingRun.current = null;
    if (r) worldRef.current?.sendRun(r);
  };
  const [felled, setFelled] = useState(null);
  const [revived, setRevived] = useState(null);

  useEffect(() => {
    const g = new Game(canvasRef.current);
    gameRef.current = g;
    window.__game = g;
    let audio = null;
    try {
      audio = new AudioEngine({ lite: (navigator.hardwareConcurrency || 8) <= 4 });
    } catch {
      audio = null;
    }
    audioRef.current = audio;
    window.__audio = audio;
    g.events.onTitan = (spec, field) => audio?.setTitan(spec, field);
    g.events.onFrame = (t, stage, hp, playing, danger) => audio?.update(t, stage, hp, { playing, nearDanger: danger });
    g.events.onSfx = (n, x, str) => audio?.sfx(n, x, str);
    // a dev/test titan can be pinned with ?seed=; otherwise the live Base44 world decides
    const q = new URLSearchParams(location.search);
    const w = replay
      ? createLocalWorld(g, { seed: replay.seed, number: replay.number })
      : q.has("seed")
      ? createLocalWorld(g)
      : createLiveWorld(g, audio, {
          onFelled: (end) => {
            setFelled(end);
            setTimeout(() => setFelled(null), 9000);
          },
          onRevived: (by) => {
            clearTimeout(runTimer.current);
            runTimer.current = null;
            pendingRun.current = null;
            setSummary(null);
            setRevived(by || "a hunter");
            setTimeout(() => setRevived(null), 3000);
          },
        });
    worldRef.current = w;
    w.onChange = (s) => setWorld({ ...s });
    g.events.onLayout = setLayout;
    g.events.onHud = (h) => {
      setHud(h);
      setPhase(h.phase);
    };
    g.events.onHits = (dmg, core, beat, surge) => w.addHit(core, dmg, beat, surge);
    g.events.onDown = (s) => {
      const h = g.hunt;
      if (!s.felled && h && w.down) w.down(h.x, h.y);
      // a passing hunter may still rekindle this light: report the run once the spark has gone out
      clearTimeout(runTimer.current);
      pendingRun.current = s;
      runTimer.current = setTimeout(() => {
        runTimer.current = null;
        pendingRun.current = null;
        Promise.resolve(w.sendRun(s)).then((r) => r && setSummary((cur) => (cur && cur.startT === s.startT ? { ...cur, recorded: r.damage } : cur)));
      }, s.felled ? 0 : 8600);
      setProfile((p) => {
        const freshSeals = judgeSeals(p, s);
        setSummary({ ...s, worldShare: w.shareOf(s.damage), freshSeals });
        const n = { ...p, runs: p.runs + 1, total: p.total + s.damage, best: Math.max(p.best, s.damage), fresh: false, seals: [...(p.seals || []), ...freshSeals] };
        saveProfile(n);
        return n;
      });
    };
    g.events.onFloat = (text, x, y, kind) => {
      const p = g.screenOf(x, y);
      pushFloat.current(text, p.x, p.y, kind);
    };
    document.title = "WORLDBEAST · one titan, everyone, right now";
    g.holdReveal = closedRef.current;
    w.start();
    if (replay) g.startReplay(replay);
    g.run();
    setLayout(g.layout());
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      const cur = g.currentSummary();
      if (cur && cur.time > 3) w.sendRun(cur);
      else flushRun();
    };
    document.addEventListener("visibilitychange", onHide);
    // any first gesture wakes the sound
    const unlock = () => audio?.unlock().catch(() => {});
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      clearTimeout(runTimer.current);
      w.stop();
      g.stop();
      audio?.dispose();
    };
  }, []);

  const begin = useCallback(() => {
    const g = gameRef.current;
    if (g.falling || g.revealing || (world && world.interlude > 0)) return;
    audioRef.current?.unlock().catch(() => {});
    // the previous run's report goes now if its spark was still waiting
    flushRun();
    worldRef.current?.identify?.(profile);
    setSummary(null);
    // a first hunt starts half-charged, so the first Surge comes early
    g.start(profile.aspect, { resonance: (profile.runs || 0) === 0 ? 55 : 0, gentle: (profile.runs || 0) < 2 });
    canvasRef.current?.focus();
  }, [profile, world]);

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
    if (gameRef.current?.hunt?.houndWarned) showTip("hound", "<b>Hounds</b>: dark drops thrown at where you stand. Their dotted line shows the aim: keep moving.");
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
  const stage = gameRef.current?.stage ?? stageFor(hpFrac);
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
      {(() => {
        const next = SEALS.find((x) => !(profile.seals || []).includes(x.id) && x.id !== "first");
        return next && (profile.runs || 0) > 0 ? (
          <div className="next-seal">
            Next seal: <b>{next.name}</b>. {next.line}
          </div>
        ) : null;
      })()}
      <div className="seal-row" aria-label={`Seals: ${(profile.seals || []).length} of ${SEALS.length}`}>
        {SEALS.map((x, i) => (
          <Seal key={x.id} i={i} earned={(profile.seals || []).includes(x.id)} size={u * 0.95} />
        ))}
        <span className="seal-count">{(profile.seals || []).length} of {SEALS.length} seals</span>
      </div>
      <div className="namebox">
        <button className="sigil-pick" onClick={() => setPickSigil((v) => !v)} aria-label={"Your sigil: " + SIGIL_NAMES[profile.sigil]}>
          <Sigil id={profile.sigil} size={u * 0.75} className="filled" />
        </button>
        <input aria-label="Your hunter's name" value={profile.name} maxLength={18} onChange={(e) => update({ name: e.target.value.replace(/[<>{}[\]\\]/g, "").slice(0, 18) })} onBlur={(e) => update({ name: cleanName(e.target.value) || "Nameless" })} />
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
      {(profile.runs || 0) < 2 && (
        <ul className="howto" aria-label="How to hunt">
          <li>
            <i className="life" /> Three lights. Only the bright pip at your star's heart can be struck.
          </li>
          <li>
            <i className="hk">✦</i> Gold wounds open on the beat; your light strikes them by itself. Nearer the titan strikes harder.
          </li>
          <li>
            <i className="hk">≈</i> Brush past ink to fill Resonance, then Surge. {layout && !layout.spread ? "Double-tap" : "Space"} dashes through anything.
          </li>
        </ul>
      )}
      <button className="join" onClick={begin} disabled={!!world?.interlude || !!gameRef.current?.revealing}>
        {world?.interlude ? `The next titan stirs… ${world.interlude}` : gameRef.current?.revealing ? "The titan is being engraved…" : "Join the hunt"}
        <small>{world?.mode === "offline" ? "The world is out of reach: you hunt this titan alone for now" : world?.online > 1 ? `${world.online - 1} ${world.online - 1 === 1 ? "other is" : "others are"} watching or fighting it now` : "Your echo will fly with the hunters after you"}</small>
      </button>
    </section>
  );

  // during a hunt the lower half of the leaf becomes your ledger
  const runStats = hud && phase === "playing" && (
    <section className="ledger" aria-label="Your hunt">
      <div className="rubric">Your hunt, in {ASPECTS[profile.aspect].name}</div>
      <div className="ledger-big">
        {fmt(hud.damage)}
        <small>blows struck{world && world.hpMax > 1 ? ` · ${((hud.damage / world.hpMax) * 100).toFixed(2)}% of its life` : ""}</small>
      </div>
      <div className="ledger-row">
        <span>
          <b>{hud.time.toFixed(0)}</b> s alight
        </span>
        <span>
          <b>{hud.grazes}</b> grazes
        </span>
        <span>
          <b>{hud.bestCombo}</b> best chain
        </span>
        <span>
          <b>{hud.surges}</b> surges
        </span>
      </div>
    </section>
  );

  const L = layout;
  const arena = L?.arena;
  return (
    <div className="stage" style={styleU}>
      {phase !== "playing" && phase !== "replay" && !closed && L?.spread && <Bookmarks />}
      {closed && (
        <Cover
          rect={L ? (L.spread && L.left ? { x: L.left.x, y: L.left.y - 4, w: L.right.x + L.right.w - L.left.x, h: L.left.h + 8 } : null) : null}
          online={world?.online ?? 1}
          spec={world?.spec}
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
          {phase === "playing" && tip && <div className="margin-note in-leaf" key={tip.id} dangerouslySetInnerHTML={{ __html: '<span class="manicule">☞</span> ' + tip.html }} />}
          {phase === "playing" ? runStats : !summary && !replay && lobbyControls}
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
          {phase !== "playing" && phase !== "replay" && !summary && (
            <div className="sheet leaf" style={{ position: "absolute", "--u": "30px" }}>
              <div>
                <h1>{spec.name}</h1>
                <div className="epithet">{spec.epithet}</div>
              </div>
              {lobbyControls}
              <nav className="sheet-links" aria-label="Turn to">
                <a href="/hall">Hall of Titans</a>
                <a href="/how">How it works</a>
              </nav>
            </div>
          )}
        </>
      )}

      {/* HUD over the arena */}
      {arena && phase === "playing" && hud && (
        <div className="hud" style={{ left: arena.x, top: arena.y, width: arena.w, height: arena.h }}>
          <div className="hud-bottom">
            <div className="lives" aria-label={`${hud.maxHits - hud.hits} of ${hud.maxHits} lights left`}>
              {Array.from({ length: hud.maxHits }, (_, i) => (
                <span key={i} className={"life" + (i < hud.maxHits - hud.hits ? "" : " lost")} />
              ))}
            </div>
            <span className={"reso" + (hud.resonance >= 99 || hud.surging ? " full" : "")} aria-label="Resonance">
              <i style={{ width: (hud.surging ? 100 : hud.resonance) + "%" }} />
              <em>{hud.surging ? "Surge!" : hud.combo > 1 ? `×${hud.combo}` : "Resonance"}</em>
            </span>
            <div className="dmg">
              {fmt(hud.damage)}
              <small>blows</small>
            </div>
          </div>
          {L && !L.spread && (
            <button className="dashbtn" style={{ right: u * 0.5, bottom: 70 + u * 1.5 }} onPointerDown={(e) => (e.preventDefault(), gameRef.current.input.queueDash())}>
              dash
            </button>
          )}
        </div>
      )}

      {/* run summary */}
      {summary && arena && (
        <div className="summary" style={{ left: arena.x + arena.w * 0.08, width: arena.w * 0.84, top: arena.y + arena.h * (summary.felled ? 0.42 : 0.2) }} role="dialog" aria-label="Your run">
          <h2>{summary.felled ? "The titan is felled!" : "Your light went out"}</h2>
          <div className="rubric">
            against {spec?.name}, after {summary.time.toFixed(1)} s{!summary.felled && summary.killer ? `, struck down by ${killerOf(summary.killer)[0]}` : ""}
          </div>
          {!summary.felled && summary.killer && <p className="tip-line">{killerOf(summary.killer)[1]}</p>}
          {!summary.felled && world && !world.local && world.online > 1 && <div className="rubric">Your spark lingers for 8 s: a hunter who flies through it rekindles you.</div>}
          <div className="big">{fmt(summary.damage)}</div>
          <div style={{ fontStyle: "italic", color: "var(--ink-2)" }}>
            blows struck{summary.worldShare ? ` · ${summary.worldShare} of the world's today` : ""}
            {summary.recorded != null && Math.abs(summary.recorded - summary.damage) > 1 ? ` · ${fmt(summary.recorded)} reached the titan` : summary.recorded != null ? " · written in the Hall" : ""}
          </div>
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
          {summary.freshSeals?.length > 0 && (
            <div className="fresh-seals">
              {summary.freshSeals.map((id) => {
                const i = SEALS.findIndex((x) => x.id === id);
                return (
                  <span key={id} className="fresh-seal">
                    <Seal i={i} earned fresh size={u * 1.5} />
                    <span>
                      <b>{SEALS[i].name}</b>
                      <br />
                      <i>{SEALS[i].line}</i>
                    </span>
                  </span>
                );
              })}
            </div>
          )}
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
                const link = replayUrl({ seed: spec.seed, number: spec.number, stage: summary.stage, startT: summary.startT, damage: summary.damage, sigil: profile.sigil, name: profile.name, aspect: summary.aspect, path: summary.path });
                const r = await shareRun({ spec, summary, profile, share: summary.worldShare, link });
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

      {tip && arena && phase === "playing" && !L?.spread && (
        <div className="margin-note" style={{ left: arena.x + arena.w * 0.06, width: arena.w * 0.88, top: arena.y + 4 }} key={tip.id} dangerouslySetInnerHTML={{ __html: tip.html }} />
      )}

      {replay && arena && phase === "replay" && (
        <div className="replay-banner" style={{ left: arena.x, top: arena.y + 6, width: arena.w }}>
          <div>
            <span className="rubric">A ghost run</span> <Sigil id={replay.sigil} size={u * 0.5} /> <b>{replay.name}</b> against {spec?.name}: {fmt(replay.damage)} blows, {replay.duration.toFixed(0)} s.
          </div>
          <div className="replay-sub">The very attacks they faced, replayed from the titan's seed and the moment they began. (Their hounds are not shown.)</div>
          <a className="join" href="/" style={{ fontSize: "1.05em", marginTop: "0.4em", display: "inline-block", width: "auto", textDecoration: "none", padding: "0.2em 0.8em" }}>
            Hunt the titan awake now
          </a>
        </div>
      )}
      {felled && arena && (
        <div className="felled-stamp" style={{ left: arena.x, top: arena.y + arena.h * 0.12, width: arena.w }} role="status">
          <div className="felled-word">Felled</div>
          <div className="felled-line">
            {felled.blow ? (
              <>
                The final blow: <Sigil id={felled.blow.sigil} size={u * 0.6} /> <b>{felled.blow.name}</b>
              </>
            ) : (
              "The world brought it down together."
            )}
          </div>
          {felled.top?.length > 0 && (
            <ol className="felled-top">
              {felled.top.slice(0, 3).map((t, i) => (
                <li key={i}>
                  <Sigil id={t.sigil} size={u * 0.5} /> {t.name} <span>{fmt(t.damage)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {revived && arena && (
        <div className="margin-note" style={{ left: arena.x + arena.w * 0.1, width: arena.w * 0.8, top: arena.y + arena.h * 0.4 }}>
          <b>{revived}</b> flew through your spark. You rise again.
        </div>
      )}

      <Labels game={gameRef.current} world={worldRef.current} u={u} hidden={!!summary} />
      <Floats bind={bindFloats} />
    </div>
  );
}

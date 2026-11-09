import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { omenFor, judgeOmen, liveStreak, untilNext, dayIndex } from "./omen";
import { fmtAgo, presence } from "./chronicle";

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
  // overlays pinned to the page (leaf, HUD, summary, notes): they ride the camera's lean-in on a CSS
  // transform, and are laid out afresh once it settles
  const layerRef = useRef(null);
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
      const q = new URLSearchParams(location.search);
      return !sessionStorage.getItem("wb-opened") && !q.has("open") && !q.has("rehearse");
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
  const runMark = useRef(null); // the world's accepted blows when this run began (for "your blows moved the world")

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
    // (the song is composed in its own task, not inside the titan's first frame: a quarter-second less freeze)
    g.events.onTitan = (spec, field) => setTimeout(() => audio?.setTitan(spec, field), 0);
    g.events.onFrame = (t, stage, hp, playing, danger) => audio?.update(t, stage, hp, { playing, nearDanger: danger });
    g.events.onSfx = (n, x, str) => audio?.sfx(n, x, str);
    // a dev/test titan can be pinned with ?seed=, ?rehearse opens a rehearsal against a near-dead titan of
    // your own, a ghost link replays its run; otherwise the live Base44 world decides
    const q = new URLSearchParams(location.search);
    const hooks = {
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
    };
    const w = replay
      ? createLocalWorld(g, { seed: replay.seed, number: replay.number, replay })
      : q.has("rehearse")
      ? createLocalWorld(g, { rehearsal: true, audio }, hooks)
      : q.has("seed")
      ? createLocalWorld(g, { audio }, hooks)
      : createLiveWorld(g, audio, hooks);
    worldRef.current = w;
    w.onChange = (s) => setWorld({ ...s });
    g.events.onLayout = setLayout;
    g.events.onCamera = (m) => {
      const el = layerRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${m.tx}px, ${m.ty}px, 0) scale(${m.s})`;
      el.classList.toggle("folding", m.dir > 0);
      el.classList.toggle("unfolding", m.dir < 0);
    };
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
        // a titan of your own falling (a rehearsal, a pinned titan) is not a world titan: no Witness seal for it
        const freshSeals = judgeSeals(p, w.state.local && s.felled ? { ...s, felled: false } : s);
        const omen = judgeOmen(p, s);
        setSummary({ ...s, worldShare: w.shareOf(s.damage), mark: runMark.current, titanName: g.spec?.name, titanSpec: g.spec, freshSeals, omen });
        const n = { ...p, ...(omen || {}), runs: p.runs + 1, total: p.total + s.damage, best: Math.max(p.best, s.damage), fresh: false, seals: [...(p.seals || []), ...freshSeals] };
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
    // a ghost run starts when the book opens, not behind the cover
    if (replay && !closedRef.current) g.startReplay(replay);
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

  // the new layout is in the DOM: drop the lean-in's interim transform in the same paint
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    el.style.transform = "";
    el.classList.remove("folding", "unfolding");
  }, [layout]);

  const begin = useCallback(() => {
    const g = gameRef.current;
    // (joining while the titan is still being engraved finishes the engraving at once)
    if (g.falling || !g.ready || (world && world.interlude > 0)) return;
    audioRef.current?.unlock().catch(() => {});
    // the previous run's report goes now if its spark was still waiting
    flushRun();
    worldRef.current?.identify?.(profile);
    runMark.current = worldRef.current?.runMark?.() ?? null;
    setSummary(null);
    // a first hunt starts half-charged, so the first Surge comes early
    g.start(profile.aspect, { resonance: (profile.runs || 0) === 0 ? 55 : 0, gentle: (profile.runs || 0) < 2 });
    canvasRef.current?.focus();
  }, [profile, world]);

  // keyboard: Enter starts / restarts
  useEffect(() => {
    const k = (e) => {
      const el = document.activeElement;
      const free = !el || el === document.body || el.tagName === "CANVAS"; // a focused Join clicks itself
      if (e.key === "Enter" && phase !== "playing" && free && !e.defaultPrevented) {
        e.preventDefault();
        begin();
      }
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

  // what kind of world this page shows, so nothing reads as live that isn't
  const rehearsal = !!world?.rehearsal;
  const recorded = world?.replay ?? null;
  const pinned = !!world?.pinned;
  const live = !!world && !world.local;
  const who = world ? presence(world) : null;
  const struckPct = (1 - hpFrac) * 100;
  // never "100.0% struck" while wounds remain, never "0.0%" once a blow has landed
  const struckTxt = hpFrac > 0 && struckPct > 99.9 ? ">99.9" : struckPct > 0 && struckPct < 0.1 ? "<0.1" : struckPct.toFixed(1);

  const leafBody = spec && (
    <>
      <div className="folio">
        <span>WORLDBEAST · a living bestiary</span>
        <span>{recorded ? "A recorded run" : rehearsal ? "A rehearsal titan · yours alone" : `The ${ORD(spec.number)} Titan`}</span>
      </div>
      <div>
        <h1>{spec.name}</h1>
        <div className="epithet">{spec.epithet}</div>
      </div>
      <p className="lore">
        <span className="dropcap" aria-hidden="true">
          {spec.name[0]}
        </span>
        {ARCHETYPE_INFO[spec.archetype].blurb}{" "}
        {recorded ? (
          <>
            It sings at {spec.bpm} beats a minute in {NOTE[spec.root % 12]} {spec.mode}. What you see is a recorded run against it, recomputed from its seed: not the live world.
          </>
        ) : rehearsal ? (
          <>
            This one is yours alone, woken near death so you can see a titan fall: only your blows wound it and nothing here is written in the Hall. <a href="/">The live titan</a> is fought by everyone online.
          </>
        ) : (
          <>
            It woke {world.wokeAgo} and sings at {spec.bpm} beats a minute in {NOTE[spec.root % 12]} {spec.mode}. {live ? "Every hunter online fights it now, on the same beat, in the same moment." : "Only your blows wound it here."}
          </>
        )}
      </p>
      {recorded ? (
        <section className="wounds" aria-label="The recorded run">
          <div className="rubric">A recorded run</div>
          <div className="caption">
            <span>
              <Sigil id={recorded.sigil} size={u * 0.45} /> <b>{recorded.name}</b> struck {fmt(recorded.damage)} blows in {recorded.duration.toFixed(0)} s. The live world's wounds are not shown during a recorded run.
            </span>
          </div>
        </section>
      ) : (
        <section className="wounds" aria-label="The titan's wounds">
          <div className="rubric">{rehearsal ? "Its wounds · a rehearsal" : "Its wounds"}</div>
          <div className="bar">
            <div className="fill" style={{ width: struckPct + "%" }} />
            <div className="stagemarks">
              <i style={{ left: "34%" }} />
              <i style={{ left: "67%" }} />
            </div>
          </div>
          <div className="caption">
            <span>
              {world.interlude ? `Wakes in ${world.interlude} s · ${fmt(world.hpMax)} to strike` : `${struckTxt}% struck · ${fmt(world.hp)} of ${fmt(world.hpMax)} left`}
            </span>
            <span className={"stage-name stage-" + stage}>{STAGE_NAMES[stage]}</span>
          </div>
        </section>
      )}
      <section aria-label="The Canticle">
        <div className="rubric" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>The Canticle</span>
          <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
            phrase {(hud?.phrase ?? 0) + 1} of 8
          </span>
        </div>
        <Canticle game={gameRef.current} height={u * 3.1} />
      </section>
      <section hidden={!!recorded}>
        <div className="rubric">
          {rehearsal
            ? "Only you · a rehearsal"
            : pinned
            ? "Only you · a titan pinned to this page"
            : world.mode === "offline"
            ? "Out of reach of the world · only you"
            : who.header}
        </div>
        {live && world.hunters.length > 0 && (
          <div className="hunters">
            {world.hunters.slice(0, 10).map((h) => (
              <span className={"hunter-chip" + (h.flying ? " wb-flying" : " wb-resting")} key={h.id} title={h.flying ? "in flight now" : "between runs"}>
                <Sigil id={h.sigil} size={u * 0.5} /> {h.name}
                {h.me ? " (you)" : ""}
              </span>
            ))}
          </div>
        )}
      </section>
      <section style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <div className="rubric">The chronicle</div>
        <ul className="chronicle">
          {world.feed.slice(-7).reverse().map((f) => (
            <li key={f.id}>
              <span dangerouslySetInnerHTML={{ __html: f.html }} />
              {f.n ? <span className="wb-ago"> · {fmtAgo(Date.now() - f.n)}</span> : null}
            </li>
          ))}
          {live && world.feed.length === 0 && <li className="wb-ago">Nothing is written here yet: the next hunter to join writes the first line.</li>}
        </ul>
      </section>
    </>
  );

  const today = dayIndex();
  const omen = omenFor(today);
  const omenDone = profile.omenDay === today;
  const streak = liveStreak(profile, today);
  const omenBox = (
    <div className={"omen" + (omenDone ? " done" : "")} aria-label="Today's omen">
      <div className="omen-head">
        <span className="rubric">Today's omen</span>
        <span className="omen-meta">{omenDone ? "fulfilled" : `the same for every hunter · ${untilNext()} left`}</span>
      </div>
      <div className="omen-text">
        {omen.text}
        {!omenDone && omen.aspect && profile.aspect !== omen.aspect && (
          <>
            {" "}
            <button className="omen-take" onClick={() => update({ aspect: omen.aspect })}>
              Take up {ASPECTS[omen.aspect].name}
            </button>
          </>
        )}
      </div>
      {streak > 0 && (
        <div className="omen-streak">
          {streak === 1 ? "A first day kept." : `${streak} days kept in a row.`}
          {!omenDone ? " Fulfil today's to keep it." : " Come back tomorrow for the next."}
        </div>
      )}
    </div>
  );

  const lobbyControls = (
    <section aria-label="Join the hunt" style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
      {(profile.runs || 0) > 0 && omenBox}
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
      <button className="join" onClick={begin} disabled={!!world?.interlude || !gameRef.current?.ready}>
        {world?.interlude ? `The next titan stirs… ${world.interlude}` : !gameRef.current?.ready ? "The titan is being engraved…" : "Join the hunt"}
        <small>
          {world?.mode === "offline"
            ? "The world is out of reach: you hunt this titan alone for now"
            : rehearsal
            ? "A rehearsal against a titan of your own: nothing here is written in the Hall"
            : pinned
            ? "A titan pinned to this page: only your blows count, nothing is sent"
            : who?.join ?? ""}
        </small>
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

  // your lights and Resonance: kept outside the arena, where nothing is ever thrown
  const gauges = hud && phase === "playing" && (
    <div className="gauges">
      <div className="lives" aria-label={`${hud.maxHits - hud.hits} of ${hud.maxHits} lights left`}>
        {Array.from({ length: hud.maxHits }, (_, i) => (
          <span key={i} className={"life" + (i < hud.maxHits - hud.hits ? "" : " lost")} />
        ))}
      </div>
      <span className={"reso" + (hud.resonance >= 99 || hud.surging ? " full" : "")} aria-label="Resonance">
        <i style={{ width: (hud.surging ? 100 : hud.resonance) + "%" }} />
        <em>{hud.surging ? "Surge!" : hud.combo > 1 ? `×${hud.combo}` : "Resonance"}</em>
      </span>
    </div>
  );
  const dash = (cls, style) => (
    <button className={"dashbtn " + cls} style={style} onPointerDown={(e) => (e.preventDefault(), gameRef.current.input.queueDash())} aria-label="Dash">
      dash
    </button>
  );

  // the folded leaf beside the fight: the titan, its song, and your hunt
  const stripBody = spec && (
    <>
      <div className="folio">
        <span>The {ORD(spec.number)} Titan</span>
        <span className={"stage-name stage-" + stage}>{STAGE_NAMES[stage]}</span>
      </div>
      <h1 className="strip-name">{spec.name}</h1>
      <section className="wounds" aria-label="The titan's wounds">
        <div className="bar">
          <div className="fill" style={{ width: (1 - hpFrac) * 100 + "%" }} />
          <div className="stagemarks">
            <i style={{ left: "34%" }} />
            <i style={{ left: "67%" }} />
          </div>
        </div>
        <div className="caption">
          <span>{((1 - hpFrac) * 100).toFixed(1)}% struck</span>
          <span>
            {recorded ? "a recorded run" : rehearsal ? "a rehearsal" : pinned ? "only you" : who?.topbar}
          </span>
        </div>
      </section>
      <section aria-label="The Canticle">
        <div className="rubric" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>The Canticle</span>
          <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>{(hud?.phrase ?? 0) + 1} of 8</span>
        </div>
        <Canticle game={gameRef.current} height={u * 2.7} />
      </section>
      <section className="strip-chronicle" aria-label="The chronicle">
        <div className="rubric">The chronicle</div>
        <ul className="chronicle">
          {world.feed.slice(-4).reverse().map((f) => (
            <li key={f.id} dangerouslySetInnerHTML={{ __html: f.html }} />
          ))}
        </ul>
      </section>
      {gauges}
      {runStats}
    </>
  );

  // the run's summary: on the open leaf beside the titan (wide screens), in the side panel (a phone on its
  // side), or as a sealed note over the arena (tall screens)
  const summaryCard = (cls, style) => (
    <div className={"summary " + cls} style={style} role="dialog" aria-label="Your run">
      <h2>{summary.felled ? "The titan is felled!" : "Your light went out"}</h2>
      <div className="rubric">
        against {summary.titanName ?? spec?.name}, after {summary.time.toFixed(1)} s{!summary.felled && summary.killer ? `, struck down by ${killerOf(summary.killer)[0]}` : ""}
      </div>
      {!summary.felled && summary.killer && <p className="tip-line">{killerOf(summary.killer)[1]}</p>}
      {!summary.felled && live && who && who.others > 0 && <div className="rubric">Your spark lingers for 8 s: a hunter who flies through it rekindles you.</div>}
      <div className="big">{fmt(summary.damage)}</div>
      <div style={{ fontStyle: "italic", color: "var(--ink-2)" }}>
        blows struck
        {live && summary.felled && summary.worldShare ? ` · ${summary.worldShare} of the blows that felled it` : ""}
        {summary.recorded != null && Math.abs(summary.recorded - summary.damage) > 1 ? ` · ${fmt(summary.recorded)} reached the titan` : summary.recorded != null ? " · written in the Hall" : ""}
        {rehearsal ? " · a rehearsal, not written in the Hall" : pinned ? " · on this page only, not written in the Hall" : ""}
      </div>
      {(() => {
        // the real share of the live titan's life that the world accepted from this run
        const m = live ? worldRef.current?.moved?.(summary.mark) : null;
        if (!(m > 0)) return null;
        const pct = m * 100;
        return (
          <div className="wb-moved">
            Your blows moved the world <b>{pct >= 0.1 ? pct.toFixed(1) : pct >= 0.01 ? pct.toFixed(2) : "<0.01"}%</b>
            {summary.felled ? "" : ` · ${fmt(world.hp)} of ${fmt(world.hpMax)} left`}
          </div>
        );
      })()}
      {rehearsal && summary.felled && (
        <a className="wb-rehearse-live" href="/">
          Now hunt the live titan, with everyone
        </a>
      )}
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
      {summary.omen && (
        <div className="omen done fresh">
          <span className="rubric">The omen is fulfilled</span>
          <div className="omen-text">{omenFor(summary.omen.omenDay).text}</div>
          <div className="omen-streak">
            {summary.omen.omenStreak === 1 ? "Your first day kept. Return tomorrow for a new omen." : `${summary.omen.omenStreak} days kept in a row.`}
          </div>
        </div>
      )}
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
            const sp = summary.titanSpec ?? spec;
            const link = replayUrl({ seed: sp.seed, number: sp.number, stage: summary.stage, startT: summary.startT, damage: summary.damage, sigil: profile.sigil, name: profile.name, aspect: summary.aspect, path: summary.path });
            const r = await shareRun({ spec: sp, summary, profile, share: live ? summary.worldShare : null, link });
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
  );

  const L = layout;
  const arena = L?.arena;
  const mode = L?.mode ?? "spread";
  const page = L?.right;
  // the side panel beside the page on a phone held sideways
  const sideBox = L && page && mode === "side" ? { left: page.x + page.w + 14, top: 0, bottom: 0, right: 0 } : null;
  const playing = phase === "playing";
  return (
    <div className={"stage mode-" + mode + (L?.focus ? " is-focus" : "")} style={styleU}>
      {phase !== "playing" && phase !== "replay" && !closed && L?.spread && !L.focus && <Bookmarks />}
      {closed && (
        <Cover
          rect={L ? (L.spread && L.left && !L.focus ? { x: L.left.x, y: L.left.y - 4, w: L.right.x + L.right.w - L.left.x, h: L.left.h + 8 } : null) : null}
          meta={recorded ? "a recorded run, not the live world" : rehearsal ? "a rehearsal" : who?.cover}
          spec={world?.spec}
          replay={replay}
          onOpen={() => {
            try {
              sessionStorage.setItem("wb-opened", "1");
            } catch {}
            gameRef.current.holdReveal = false;
            gameRef.current.events.onSfx?.("ui");
            setTimeout(() => {
              setClosed(false);
              // the ghost run begins as the book opens, so its first seconds are seen
              if (replay) gameRef.current.startReplay(replay);
            }, 1350);
          }}
        />
      )}
      <canvas ref={canvasRef} tabIndex={0} aria-label="The hunt. Move with WASD, the arrow keys, or by dragging. Dash with Space." />

      <div className="world-layer" ref={layerRef}>
        {/* the bestiary leaf (wide screens); during a run it is folded to a strip beside the fight */}
        {L?.spread && L.left && spec && (
          <div className={"leaf" + (L.focus ? " strip" : " open")} key={L.focus ? "strip" : "open"} style={{ left: L.left.x, top: L.left.y, width: L.left.w, height: L.left.h }}>
            {L.focus ? (
              stripBody
            ) : (
              <>
                {leafBody}
                {playing && tip && <div className="margin-note in-leaf" key={tip.id} dangerouslySetInnerHTML={{ __html: '<span class="manicule">☞</span> ' + tip.html }} />}
                {playing ? runStats : summary ? summaryCard("in-leaf", null) : !replay && lobbyControls}
              </>
            )}
          </div>
        )}

        {/* the run's gauges: beside the page (sideways phone) or in the band under it (tall screens) */}
        {L && spec && playing && hud && mode === "side" && page && (
          <>
            <div className="hud-side" style={{ right: L.vw - page.x + 14, top: L.vh / 2 }}>
              <div className="hud-side-name">{spec.name}</div>
              <span className="hp">
                <i style={{ width: hpFrac * 100 + "%" }} />
              </span>
              {gauges}
              <div className="dmg">
                {fmt(hud.damage)}
                <small>blows</small>
              </div>
            </div>
            {dash("side", { left: page.x + page.w + Math.max(12, (L.vw - page.x - page.w) / 2 - 39), top: L.vh * 0.5 })}
          </>
        )}
        {L && spec && playing && hud && mode === "single" && page && (
          <div className="hud-band" style={{ left: 0, right: 0, top: page.y + page.h + 4, height: Math.max(56, L.vh - page.y - page.h - 4) }}>
            <div className="hud-band-row">
              {gauges}
              <div className="dmg">
                {fmt(hud.damage)}
                <small>blows</small>
              </div>
            </div>
            {dash("band", null)}
          </div>
        )}

        {/* run summary */}
        {summary && arena && mode === "single" && summaryCard("", { left: arena.x + arena.w * 0.06, width: arena.w * 0.88, top: arena.y + arena.h * (summary.felled ? 0.42 : 0.14) })}
        {summary && sideBox && !L.focus && summaryCard("in-side", sideBox)}

        {tip && arena && playing && (!L?.spread || L.focus) && (
          <div className="margin-note" style={{ left: arena.x + arena.w * 0.06, width: arena.w * 0.88, top: arena.y + 4 }} key={tip.id} dangerouslySetInnerHTML={{ __html: tip.html }} />
        )}

        {replay && arena && phase === "replay" && (
          <div className="replay-banner" style={{ left: arena.x, top: arena.y + 6, width: arena.w }}>
            <div>
              <span className="rubric">A ghost run · a recorded run, not live</span> <Sigil id={replay.sigil} size={u * 0.5} /> <b>{replay.name}</b> against {spec?.name}: {fmt(replay.damage)} blows, {replay.duration.toFixed(0)} s.
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
            {felled.local && (
              <div className="felled-line wb-felled-note">
                {felled.top?.[0] ? `Top hunter, from this run alone: ${felled.top[0].name}, ${fmt(felled.top[0].damage)} blows. ` : ""}
                {felled.rehearsal ? "A rehearsal: it is not written in the Hall." : "Only your blows, on this page: it is not written in the Hall."}
              </div>
            )}
            {!felled.local && felled.top?.length > 0 && (
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
      </div>

      {/* tall screens: slim header + bottom sheet; a phone on its side: the lobby in a side panel */}
      {L && !L.spread && spec && (
        <>
          {mode === "single" && (
            <div className="topbar">
              <span className="name">{spec.name}</span>
              {!recorded && (
                <span className="bar">
                  <i style={{ width: hpFrac * 100 + "%" }} />
                </span>
              )}
              <span>{recorded ? "a recorded run" : rehearsal ? "a rehearsal" : pinned ? "only you" : who?.topbar}</span>
            </div>
          )}
          {phase !== "playing" && phase !== "replay" && !summary && (
            <div className={"sheet leaf" + (sideBox ? " side-sheet" : "")} style={{ position: "absolute", "--u": "30px", ...(sideBox || {}) }}>
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

      <Labels game={gameRef.current} world={worldRef.current} u={u} hidden={!!summary} />
      <Floats bind={bindFloats} />
    </div>
  );
}

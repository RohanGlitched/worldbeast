import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Game, FALL } from "@/game/Game";
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
import { fmtAgo, presence, titanLines } from "./chronicle";

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

/**
 * "12.3" of the titan's life struck: rounded down, so never "100.0" while a wound remains, never "0.0" after a
 * blow; with an epsilon, so an exact tenth reads exactly (1,000 of 10,000 blows is "10.0", not "9.9")
 */
function struckText(hpFrac) {
  const p = (1 - hpFrac) * 100;
  if (hpFrac <= 0) return "100";
  if (p <= 0) return "0.0";
  if (p < 0.1) return "<0.1";
  return Math.min(99.9, Math.floor(p * 10 + 1e-6) / 10).toFixed(1);
}

// The run's numbers change ten times a second. They live in a small store that only the few leaves showing
// them subscribe to, so the codex around them is not re-rendered at 10 Hz (that cost a phone ~10 ms a frame).
function createHudStore() {
  let h = null;
  const subs = new Set();
  return {
    get: () => h,
    set(v) {
      h = v;
      for (const f of subs) f();
    },
    sub(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}
/** a value derived from the HUD: the component re-renders only when that value changes */
const useHudValue = (store, sel) => useSyncExternalStore(store.sub, () => sel(store.get()));
/**
 * numbers that change every tick are written straight into their text nodes (only when they change): no
 * React render, no reconciliation, just the one text change. `write(h, set)` calls set(key, text).
 */
function useHudText(store, write) {
  const refs = useRef({});
  const last = useRef({});
  const writer = useRef(write);
  writer.current = write;
  const at = (k) => (el) => (refs.current[k] = el);
  useEffect(() => {
    const set = (k, v) => {
      if (last.current[k] === v) return;
      last.current[k] = v;
      const el = refs.current[k];
      if (!el) return;
      if (k.endsWith("%")) el.style.width = v;
      else el.textContent = v;
    };
    const f = () => {
      const h = store.get();
      if (h) writer.current(h, set);
    };
    f();
    return store.sub(f);
  }, [store]);
  return at;
}

const Phrase = memo(function Phrase({ store, prefix = "" }) {
  const p = useHudValue(store, (h) => h?.phrase ?? 0);
  // (a titan still asleep, between a fall and its waking, sings no phrase yet: its clock is before zero)
  if (!(p >= 0)) return null;
  return (
    <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
      {prefix}
      {p + 1} of 8
    </span>
  );
});

const Ledger = memo(function Ledger({ store, aspectName, hpMax }) {
  const at = useHudText(store, (h, set) => {
    set("dmg", fmt(h.damage));
    set("pct", hpMax > 1 ? ` · ${((h.damage / hpMax) * 100).toFixed(2)}% of its life` : "");
    set("time", h.time.toFixed(0));
    set("grazes", String(h.grazes));
    set("chain", String(h.bestCombo));
    set("surges", String(h.surges));
  });
  return (
    <section className="ledger" aria-label="Your hunt">
      <div className="rubric">Your hunt, in {aspectName}</div>
      <div className="ledger-big">
        <span ref={at("dmg")}>0</span>
        <small>
          blows struck<span ref={at("pct")} />
        </small>
      </div>
      <div className="ledger-row">
        <span>
          <b ref={at("time")}>0</b> s alight
        </span>
        <span>
          <b ref={at("grazes")}>0</b> grazes
        </span>
        <span>
          <b ref={at("chain")}>0</b> best chain
        </span>
        <span>
          <b ref={at("surges")}>0</b> surges
        </span>
      </div>
    </section>
  );
});

// your lights and Resonance: kept outside the arena, where nothing is ever thrown
const Gauges = memo(function Gauges({ store }) {
  // (lights change a few times a run: those re-render; Resonance moves every tick: written in place)
  const left = useHudValue(store, (h) => (h ? h.maxHits - h.hits : 0));
  const max = useHudValue(store, (h) => h?.maxHits ?? 0);
  const full = useHudValue(store, (h) => !!h && (h.resonance >= 99 || h.surging));
  const at = useHudText(store, (h, set) => {
    set("reso%", (h.surging ? 100 : Math.round(h.resonance)) + "%");
    set("label", h.surging ? "Surge!" : h.combo > 1 ? `×${h.combo}` : "Resonance");
  });
  if (!max) return null;
  return (
    <div className="gauges">
      <div className="lives" aria-label={`${left} of ${max} lights left`}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={"life" + (i < left ? "" : " lost")} />
        ))}
      </div>
      <span className={"reso" + (full ? " full" : "")} aria-label="Resonance">
        <i ref={at("reso%")} style={{ width: "0%" }} />
        <em ref={at("label")}>Resonance</em>
      </span>
    </div>
  );
});

const Blows = memo(function Blows({ store }) {
  const at = useHudText(store, (h, set) => set("dmg", fmt(h.damage)));
  return (
    <div className="dmg">
      <span ref={at("dmg")}>0</span>
      <small> blows</small>
    </div>
  );
});

// today's omen, measured as you fly (only in the world, where omens count)
const OMEN_HUD = { graze: (h) => h.grazes, time: (h) => h.time, blows: (h) => h.damage, surge: (h) => h.surges, clean: (h) => h.clean, chain: (h) => h.bestCombo };
const OmenProgress = memo(function OmenProgress({ store, omen, done, aspect }) {
  const other = !!omen.aspect && omen.aspect !== aspect;
  const at = useHudText(store, (h, set) => {
    const v = Math.max(0, Math.min(omen.n, Math.floor(OMEN_HUD[omen.id]?.(h) ?? 0)));
    set("v", fmt(v));
    set("bar%", (v / omen.n) * 100 + "%");
  });
  return (
    <div className={"omen strip-omen" + (done ? " done" : "")} aria-label="Today's omen">
      <div className="omen-text">
        <span className="rubric">Today's omen{done ? ", fulfilled" : ""}:</span> {omen.text}
        {!done && other && <i className="omen-other"> Not with the light you carry.</i>}
      </div>
      {!done && !other && (
        <div className="omen-meter">
          <span className="omen-bar">
            <i ref={at("bar%")} style={{ width: "0%" }} />
          </span>
          <span>
            <b ref={at("v")}>0</b> of {fmt(omen.n)}
          </span>
        </div>
      )}
    </div>
  );
});

/**
 * Who else is in the air with you, from the world itself (live only): echoes of earlier runs flying their paths
 * again, by name. In a quiet world it says so, and what your run will leave behind.
 */
const StripPresence = memo(function StripPresence({ world, u, header }) {
  const [, tick] = useState(0);
  const [list, setList] = useState([]);
  useEffect(() => {
    const read = () => {
      const lw = world?.world;
      const seen = new Map();
      for (const e of lw?.echoesAt?.() ?? []) if (!seen.has(e.name)) seen.set(e.name, { name: e.name, sigil: e.sigil });
      setList((l) => {
        const n = [...seen.values()];
        return l.length === n.length && l.every((x, i) => x.name === n[i].name) ? l : n;
      });
      tick((v) => v + 1);
    };
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [world]);
  const hunters = world?.state?.hunters ?? [];
  const others = hunters.filter((h) => !h.me);
  return (
    <section className="strip-presence" aria-label="In the air">
      <div className="rubric">{header}</div>
      {others.length > 0 && (
        <div className="hunters">
          {hunters.slice(0, 8).map((h) => (
            <span className={"hunter-chip" + (h.flying ? " wb-flying" : " wb-resting")} key={h.id} title={h.flying ? "in flight now" : "between runs"}>
              <Sigil id={h.sigil} size={u * 0.45} /> {h.name}
              {h.me ? " (you)" : ""}
            </span>
          ))}
        </div>
      )}
      {list.length > 0 && (
        <>
          <div className="strip-echoes">{list.length === 1 ? "An echo flies with you:" : `${list.length} echoes fly with you:`}</div>
          <div className="hunters">
            {list.slice(0, 8).map((e) => (
              <span className="hunter-chip wb-echo" key={e.name}>
                <Sigil id={e.sigil} size={u * 0.45} /> {e.name}
              </span>
            ))}
            {list.length > 8 && <span className="hunter-chip wb-echo">+{list.length - 8}</span>}
          </div>
        </>
      )}
      {!others.length && !list.length && <p className="strip-quiet">No other light in the air. Your run becomes an echo that flies here, on this beat, for the next hunter.</p>}
    </section>
  );
});

const ASPECT_ICON = {
  ember: "M12 2c1 4 6 6.2 6 11.6A6 6 0 0 1 6 13.6c0-2.6 1.4-4.2 2.6-5.2.2 2 1 3.4 2.4 3.8C10 8.6 10.6 5 12 2z",
  lance: "M12 1.5l2 4.5-1.2 1V21h-1.6V7L10 6zM8.5 16h7",
  bloom: "M12 6.2c2.2-3.2 6.3-1.4 5.5 2.2 3.4.6 3.1 5.2-.2 5.4.9 3.6-3.6 5-5.3 2.1-1.7 2.9-6.2 1.5-5.3-2.1-3.3-.2-3.6-4.8-.2-5.4C5.7 4.8 9.8 3 12 6.2z",
  mirror: "M12 2l6 7-6 13-6-13zM6 9h12M9.5 9L12 22M14.5 9L12 22",
};

/**
 * Dev builds only (`?fakelive=N`): a titan of your own dressed as the live world (nobody hunting, N feed lines),
 * to lay out the live lobby without ever joining it. Production builds drop this branch entirely.
 */
function fakeLive(w, lines) {
  const st = w.state;
  const dress = () => {
    Object.assign(st, { local: false, pinned: false, rehearsal: false, counts: true, hunters: [], watching: 1, online: 1, echoes: 0, mode: "online" });
    st.feed = st.feed.slice(0, Math.max(0, lines));
  };
  let handler = null;
  Object.defineProperty(w, "onChange", { get: () => handler && ((s) => (dress(), handler(s))), set: (f) => (handler = f) });
  dress();
  return w;
}

export default function Hunt() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  // overlays pinned to the page (leaf, HUD, summary, notes): they ride the camera's lean-in on a CSS
  // transform, and are laid out afresh once it settles
  const layerRef = useRef(null);
  const worldRef = useRef(null);
  const [profile, setProfile] = useState(loadProfile);
  const [layout, setLayout] = useState(null);
  const layoutRef = useRef(null);
  layoutRef.current = layout;
  const [hudStore] = useState(createHudStore);
  const [phase, setPhase] = useState("lobby");
  // Join pressed while the next titan still sleeps (or is still being engraved): the run starts as it wakes
  const [queued, setQueued] = useState(false);
  const lastRun = useRef(null);
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
  const felledTimer = useRef(0);
  // a run that ended with the titan's fall: its card waits for the death beat, the stamp and the book opening
  // (Game FALL.CARD), so the climax plays first and the card never lands over it
  const [cardHold, setCardHold] = useState(false);
  const cardTimer = useRef(0);
  // the felled titan, while its body is still on the page (null once its plate has torn away)
  const [felledSpec, setFelledSpec] = useState(null);
  const [revived, setRevived] = useState(null);
  const runMark = useRef(null); // the world's accepted blows when this run began (for "your blows moved the world")
  /** a rehearsal whose near-death titan has fallen: what follows is the live titan, or another rehearsal */
  const spentRef = useRef(false);
  // "Rehearse another fall" was pressed: a fresh near-death titan is on its way (until it falls in its turn)
  const [again, setAgain] = useState(false);

  useEffect(() => {
    const g = new Game(canvasRef.current);
    gameRef.current = g;
    const q = new URLSearchParams(location.search);
    // the console handle (autopilot, probes) exists only in dev builds, or with ?debug=1 in a world of your own
    // (?seed=, ?rehearse, ?replay=): never on the live world, where one line would run a bot against everyone's titan
    const ownWorld = q.has("seed") || q.has("rehearse") || q.has("replay");
    const debug = !!import.meta.env?.DEV || (ownWorld && q.get("debug") === "1");
    if (debug) window.__game = g;
    let audio = null;
    try {
      audio = new AudioEngine({ lite: (navigator.hardwareConcurrency || 8) <= 4 });
    } catch {
      audio = null;
    }
    audioRef.current = audio;
    if (debug) window.__audio = audio;
    // (the song is composed in its own task, not inside the titan's first frame: a quarter-second less freeze)
    g.events.onTitan = (spec, field) => setTimeout(() => audio?.setTitan(spec, field), 0);
    g.events.onFrame = (t, stage, hp, playing, danger) => audio?.update(t, stage, hp, { playing, nearDanger: danger });
    g.events.onSfx = (n, x, str) => audio?.sfx(n, x, str);
    // a dev/test titan can be pinned with ?seed=, ?rehearse opens a rehearsal against a near-dead titan of
    // your own, a ghost link replays its run; otherwise the live Base44 world decides
    const hooks = {
      onFelled: (end, next) => {
        // on this page the caption counts the same blows as the run's summary (not the ones the wounds absorbed)
        const run = lastRun.current;
        if (end?.local && end.top?.[0] && run?.felled) end = { ...end, top: [{ ...end.top[0], damage: Math.round(run.damage) }, ...end.top.slice(1)] };
        // the leaf tells of the felled titan while its body is on the page (its death, the stamp, the plate
        // tearing away: Game FALL), then of the next, engraved in during the interlude
        setFelledSpec(g.spec ?? null);
        setFelled(end);
        // (a rehearsal asked for again has now had its fall: what follows is the live titan, or another rehearsal)
        setAgain(false);
        clearTimeout(felledTimer.current);
        felledTimer.current = setTimeout(() => setFelled(null), FALL.GONE * 1000);
        // the next titan's geometry is built in an idle moment after the stamp, not when the world wakes it
        if (next && Number.isFinite(next.seed)) g.prebuild(next.seed, next.number);
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
    const w = import.meta.env?.DEV && q.has("fakelive")
      ? fakeLive(createLocalWorld(g, { audio }, hooks), Number(q.get("fakelive")) || 0)
      : replay
      ? createLocalWorld(g, { seed: replay.seed, number: replay.number, replay })
      : q.has("rehearse")
      ? createLocalWorld(g, { rehearsal: true, audio }, hooks)
      : q.has("seed")
      ? createLocalWorld(g, { audio }, hooks)
      : createLiveWorld(g, audio, hooks);
    worldRef.current = w;
    g.onFelledGone = () => setFelledSpec(null);
    // the world's state reaches the codex at most five times a second (a busy live world emits far more),
    // and once a second while you fly: the strip's numbers need no more, and each pass re-renders the book
    let worldTimer = 0,
      worldAt = 0,
      phaseNow = "lobby";
    w.onChange = (s) => {
      if (worldTimer) return;
      const wait = Math.max(0, (phaseNow === "playing" ? 1000 : 200) - (performance.now() - worldAt));
      worldTimer = setTimeout(() => {
        worldTimer = 0;
        worldAt = performance.now();
        setWorld({ ...s });
      }, wait);
    };
    g.events.onLayout = setLayout;
    g.events.onCamera = (m) => {
      const el = layerRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${m.tx}px, ${m.ty}px, 0) scale(${m.s})`;
      el.classList.toggle("folding", m.dir > 0);
      el.classList.toggle("unfolding", m.dir < 0);
    };
    g.events.onHud = (h) => {
      hudStore.set(h);
      if (h.phase !== phaseNow) setPhase((phaseNow = h.phase));
      if (h.phase === "playing") tipsFor.current(h);
    };
    g.events.onHits = (dmg, core, beat, surge) => w.addHit(core, dmg, beat, surge);
    g.events.onDown = (s) => {
      lastRun.current = s;
      clearTimeout(cardTimer.current);
      setCardHold(!!s.felled);
      if (s.felled) cardTimer.current = setTimeout(() => setCardHold(false), FALL.CARD * 1000);
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
        // only runs in the world count: a rehearsal, a pinned titan or a world out of reach earns no seal, no
        // best and no omen (it still counts as a run behind you, for the gentle first hunts)
        const counts = !!w.state.counts;
        const freshSeals = counts ? judgeSeals(p, s) : [];
        const omen = counts ? judgeOmen(p, s) : null;
        setSummary({ ...s, counts, worldShare: w.shareOf(s.damage), mark: runMark.current, titanName: g.spec?.name, titanSpec: g.spec, freshSeals, omen });
        const n = counts
          ? { ...p, ...(omen || {}), runs: p.runs + 1, total: p.total + s.damage, best: Math.max(p.best, s.damage), fresh: false, seals: [...(p.seals || []), ...freshSeals] }
          : { ...p, runs: p.runs + 1, fresh: false };
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
      clearTimeout(cardTimer.current);
      clearTimeout(worldTimer);
      w.stop();
      g.stop();
      audio?.dispose();
    };
  }, []);

  // with the run's card on the open leaf, the chronicle above it shows whole lines or none: its lines wrap into a
  // column off the leaf when they don't fit, but a first line taller than the room left would be cut in half
  useLayoutEffect(() => {
    const sec = layerRef.current?.querySelector(".leaf.open .leaf-chronicle");
    if (!sec) return;
    const ul = sec.querySelector(".chronicle");
    const li = ul?.firstElementChild;
    const cut = !!(sec.closest(".with-card") && li && li.getBoundingClientRect().bottom > ul.getBoundingClientRect().bottom + 1);
    if (sec.classList.contains("none-fit") !== cut) sec.classList.toggle("none-fit", cut);
  });

  // the new layout is in the DOM: drop the lean-in's interim transform in the same paint
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    el.style.transform = "";
    el.classList.remove("folding", "unfolding");
  }, [layout]);

  const begin = useCallback(
    (fromQueue = false) => {
      const g = gameRef.current;
      if (!g || g.phase === "playing") return;
      // a rehearsal whose titan has fallen: the hunt from here is the live titan's (never a forgiving fight
      // against a whole titan of your own); "Rehearse another fall" is the other way on
      if (spentRef.current) {
        location.assign("/");
        return;
      }
      // a rehearsal's felled titan leaves the page now, and the next one is engraved in
      g.releaseFelled();
      audioRef.current?.unlock().catch(() => {});
      // the next titan still sleeps, or is still being engraved: join it the moment it can be hunted
      // (pressing again while waiting stands down)
      if (g.falling || !g.ready || worldRef.current?.state?.interlude > 0) {
        setSummary(null);
        setQueued((v) => (fromQueue ? v : !v));
        return;
      }
      setQueued(false);
      // the previous run's report goes now if its spark was still waiting
      flushRun();
      worldRef.current?.identify?.(profile);
      runMark.current = worldRef.current?.runMark?.() ?? null;
      setSummary(null);
      // a first hunt starts half-charged, so the first Surge comes early
      // (the world may soften the run: a rehearsal is forgiving, a hit costs Resonance instead of a light)
      g.start(profile.aspect, { resonance: (profile.runs || 0) === 0 ? 55 : 0, gentle: (profile.runs || 0) < 2, ...(worldRef.current?.state?.huntOpts || {}) });
      canvasRef.current?.focus();
    },
    [profile],
  );
  // a queued run starts as soon as the titan can be hunted
  useEffect(() => {
    if (!queued) return;
    const g = gameRef.current;
    if (phase === "playing") return setQueued(false);
    if (g && !g.falling && g.ready && !(world?.interlude > 0)) begin(true);
  }, [queued, world, phase, begin]);
  // the summary put away (Rest, Hunt again): a felled titan still on the page tears away now
  useEffect(() => {
    if (!summary) gameRef.current?.releaseFelled();
  }, [summary]);

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
  // (called from the game's 10 Hz HUD tick, not from a render)
  const tipsFor = useRef(() => {});
  tipsFor.current = (hud) => {
    const L = layoutRef.current;
    // never while the leaf is still folding (the note would hang over the desk): only once the run's layout is in
    if (!L || (L.spread && !L.focus)) return;
    const touch = !L.spread;
    // (a first hunt: the titan holds back for this hunter alone, core/hunt.ts gentle; the note says for how long)
    const held = gameRef.current?.hunt?.gentleLeft > 1 ? ` The titan holds back for your first ${Math.round(gameRef.current.hunt.gentleLeft)} s.` : "";
    if (hud.time < 6) showTip("move", (touch ? "Drag anywhere to fly. Only the bright pip at your star's heart can be struck." : "Fly with <b>WASD</b> or the arrows. Only the bright pip at your star's heart can be struck.") + held, held ? 5600 : 4200);
    else if (hud.coresOpen > 0) showTip("wound", "A <b>gold wound</b> is open. Your light strikes open wounds by itself; fly nearer the titan, and away from the outer margins, to strike harder.");
    if (gameRef.current?.hunt?.houndWarned) showTip("hound", "<b>Hounds</b>: dark drops thrown at where you stand. Their arrowed line shows the aim: keep moving.");
    if (hud.grazes >= 3) showTip("graze", "<b>Grazing</b> an attack fills Resonance. Fill it and your light Surges.");
    if (hud.time > 14) showTip("dash", touch ? "Tap <b>dash</b> or double-tap to pass clean through an attack." : "<b>Space</b> dashes you clean through an attack.");
    if (hud.time > 24) showTip("song", "Every attack lands on the beat. Read what comes next in <b>the Canticle</b>.");
    if (hud.hits >= 1) showTip("relight", "A lost light <b>returns</b> after 15 s unstruck, or on a Surge: up to twice a run.");
    const hunt = gameRef.current?.hunt;
    // a first hunt's grace field ends (core/hunt.ts graceEnding: its last 2 s; graceEndedAt once it has)
    if (hunt && (hunt.graceEnding || (hunt.graceEndedAt >= 0 && hud.time - hunt.graceEndedAt < 4))) showTip("grace-end", "<b>The titan stops holding back.</b> From here it fights you as it fights every hunter.", 4600);
    // a still light strikes at 40% (core/hunt.ts still)
    if (hunt?.still) showTip("still", "A <b>still light</b> strikes weakly: keep flying, nearer the titan.");
  };

  const update = (patch) =>
    setProfile((p) => {
      const n = { ...p, ...patch };
      saveProfile(n);
      return n;
    });

  const g0 = gameRef.current;
  // what kind of world this page shows, so nothing reads as live that isn't
  const rehearsal = !!world?.rehearsal;
  const recorded = world?.replay ?? null;
  const pinned = !!world?.pinned;
  const live = !!world && !world.local;
  const offline = world?.mode === "offline";
  const who = world ? presence(world) : null;
  // a felled titan stays on the leaf while its body is on the page; then the leaf turns to the next titan
  const heldSpec = felledSpec;
  const counts = !!world?.counts;
  const spec = heldSpec ?? world?.spec;
  const hpFrac = heldSpec ? 0 : world ? Math.max(0, world.hp / world.hpMax) : 1;
  const stage = g0?.stage ?? stageFor(hpFrac);
  const u = layout ? layout.pxPerUnit : 26;
  const styleU = { "--u": u + "px" };
  const struckTxt = struckText(hpFrac);
  // one convention on every bar (leaf, strip, a phone's top bar, a sideways phone's HUD): red is the life it has
  // left, draining as it is struck; how much is struck is said in words beside it. The marks are where it turns
  // to Wrath (66% left) and to Ruin (33% left).
  const lifeBar = (
    <div className="bar" role="img" aria-label={`${struckTxt}% struck`}>
      <div className="fill" style={{ width: hpFrac * 100 + "%" }} />
      <div className="stagemarks">
        <i style={{ left: "33%" }} />
        <i style={{ left: "66%" }} />
      </div>
    </div>
  );
  const interlude = world?.interlude ?? 0;
  const runs = profile.runs || 0;
  // alone in the live world (or out of its reach): offer a 15-second rehearsal, where a judge can see a fall
  const offerRehearse = !recorded && !rehearsal && !pinned && ((live && world.hunters.length === 0) || offline);
  // the rehearsal's near-death titan has fallen (its body is still on the page, or the whole titan after it woke),
  // and another rehearsal has not been asked for since
  const spent = rehearsal && !again && (!world?.nearDeath || !!heldSpec);
  spentRef.current = spent;
  const rehearseAgain = () => {
    const w = worldRef.current;
    clearTimeout(cardTimer.current);
    setCardHold(false);
    // the world wakes another near-death titan of your own in place (localWorld.rehearseAgain: at once, or as the
    // fallen plate lifts away), and the run joins it the moment it can be hunted (begin queues until then)
    if (typeof w?.rehearseAgain === "function" && w.rehearseAgain() !== false) {
      setAgain(true);
      spentRef.current = false;
      setSummary(null);
      gameRef.current?.releaseFelled();
      begin();
      return;
    }
    const q = new URLSearchParams(location.search);
    location.assign("/?rehearse=1" + (q.get("debug") === "1" ? "&debug=1" : ""));
  };
  // (out of reach after being online, the page still shows the world's last live titan: liveWorld holdingLive)
  const holding = offline && !!world?.holdingLive;
  const presenceLine = rehearsal ? "Only you · a rehearsal" : pinned ? "Only you · a titan pinned to this page" : holding ? "Out of reach for a moment · the live titan is held here" : offline ? "Out of reach of the world · only you" : who?.header;

  // the chronicle: the world's real lines, newest first; when a live world has written fewer than three, the
  // titan's own true record fills in (when it woke, its Canticle, how much of it is struck), never invented hunters
  const chronLines = !world
    ? []
    : [
        ...world.feed.slice(-7).reverse(),
        ...(live && !heldSpec && !recorded && world.feed.length < 3 && spec ? titanLines({ spec, hp: world.hp, hpMax: world.hpMax, wokeAgo: world.wokeAgo, note: NOTE[spec.root % 12], have: world.feed.length }).map((t, i) => ({ id: "titan" + i, html: t, titan: true })) : []),
      ];

  const today = dayIndex();
  const omen = omenFor(today);
  const omenDone = profile.omenDay === today;
  const streak = liveStreak(profile, today);

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
        ) : heldSpec ? (
          rehearsal ? (
            <>Felled by your blows, in a rehearsal. Its plate is torn from the book, and the next titan is engraved in its place.</>
          ) : (
            <>Felled. Its plate is torn from the book, and the next titan is engraved in its place.</>
          )
        ) : rehearsal && interlude > 0 && !world.nearDeath ? (
          <>
            The next titan of your rehearsal, whole and asleep: it wakes in {interlude} s and sings at {spec.bpm} beats a minute in {NOTE[spec.root % 12]} {spec.mode}. Only your blows wound it. <a href="/">The live titan</a> is fought by everyone online.
          </>
        ) : rehearsal ? (
          <>
            {world.nearDeath ? "This one is yours alone, woken near death so you can see a titan fall:" : "This one is yours alone, as whole as a live titan:"} only your blows wound it, and it is not written in the Hall. <a href="/">The live titan</a> is fought by everyone online.
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
          {lifeBar}
          <div className="caption">
            <span>
              {heldSpec ? interlude ? `Felled · the next titan wakes in ${interlude} s` : "Felled · the next titan stirs" : interlude ? `Wakes in ${interlude} s · ${fmt(world.hpMax)} to strike` : `${struckTxt}% struck · ${fmt(world.hp)} of ${fmt(world.hpMax)} left`}
            </span>
            <span className={"stage-name stage-" + stage}>{STAGE_NAMES[stage]}</span>
          </div>
        </section>
      )}
      <section aria-label="The Canticle">
        <div className="rubric" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>The Canticle</span>
          <Phrase store={hudStore} prefix="phrase " />
        </div>
        <Canticle game={g0} height={u * 2.8} />
      </section>
      <section hidden={!!recorded} className="presence">
        <div className="rubric">{presenceLine}</div>
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
      <section className={"leaf-chronicle" + (chronLines.length < 3 ? " few" : "")} aria-label="The chronicle">
        <div className="rubric">The chronicle</div>
        <ul className="chronicle">
          {chronLines.map((f) => (
            <li key={f.id} className={f.titan ? "wb-titan-line" : undefined}>
              <span dangerouslySetInnerHTML={{ __html: f.html }} />
              {f.n ? <span className="wb-ago"> · {fmtAgo(Date.now() - f.n)}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );

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

  const ready = !!g0?.ready;
  const joinLabel = queued
    ? interlude
      ? `You join as it wakes… ${interlude}`
      : "You join in a moment…"
    : interlude
    ? `The next titan stirs… ${interlude}`
    : !ready
    ? "The titan is being engraved…"
    : "Join the hunt";
  const joinSub = queued
    ? "Press again to wait instead"
    : interlude || !ready
    ? "Press to join the moment it can be hunted"
    : offline
    ? holding
      ? "Out of reach: the live titan is held here until the connection returns"
      : "The world is out of reach: you hunt this titan alone for now"
    : rehearsal
    ? "A rehearsal against a titan of your own: nothing here is written in the Hall"
    : pinned
    ? "A titan pinned to this page: only your blows count, nothing is sent"
    : who?.join ?? "";

  // the lobby: the choices may scroll on a short page, but Join is pinned below them and is never clipped
  const lobbyControls = (
    <section className="lobby" aria-label="Join the hunt">
      <div className="lobby-mid">
        {runs > 0 && counts && omenBox}
        {(() => {
          // (only the world's runs earn seals and omens: a rehearsal or a pinned titan never shows them)
          const next = SEALS.find((x) => !(profile.seals || []).includes(x.id) && x.id !== "first");
          return next && runs > 0 && counts ? (
            <div className="next-seal">
              Next seal: <b>{next.name}</b>. {next.line}
            </div>
          ) : null;
        })()}
        {/* (a first visit has no seals to show: its room goes to the how-to) */}
        {runs > 0 && (
          <div className="seal-row" aria-label={`Seals: ${(profile.seals || []).length} of ${SEALS.length}`}>
            {SEALS.map((x, i) => (
              <Seal key={x.id} i={i} earned={(profile.seals || []).includes(x.id)} size={Math.round(u * 0.85)} />
            ))}
            <span className="seal-count">
              {(profile.seals || []).length} of {SEALS.length} seals
            </span>
          </div>
        )}
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
            <button key={a.id} className="aspect" aria-pressed={profile.aspect === a.id} title={a.line} onClick={() => update({ aspect: a.id })}>
              <svg viewBox="0 0 24 24" className="sigil">
                <path d={ASPECT_ICON[a.id]} />
              </svg>
              {a.name}
            </button>
          ))}
        </div>
        {/* (on a first visit the how-to takes this line; each light still describes itself on hover) */}
        {runs > 0 && <div className="aspect-line">{ASPECTS[profile.aspect].line}</div>}
        {/* the how-to is for a first visit; once a run is behind you the omen takes its place */}
        {runs === 0 && (
          <ul className="howto" aria-label="How to hunt">
            <li>
              <i className="life" /> Three lights. Only the bright pip at your star's heart can be struck.
            </li>
            <li>
              <i className="hk">✦</i> Gold wounds open on the beat; your light strikes them by itself. Nearer the titan, and nearer the middle, strikes harder.
            </li>
            <li>
              <i className="hk">≈</i> Brush past ink to fill Resonance, then Surge. {layout && !layout.spread ? "Double-tap" : "Space"} dashes through anything.
            </li>
          </ul>
        )}
      </div>
      {spent ? (
        // the rehearsal has shown its fall: the way on is the live titan, everyone's; another rehearsal is second
        <>
          <a className="join" href="/">
            Hunt the live titan
            <small>Everyone online fights it, on the same beat</small>
          </a>
          <button className="join-alt" onClick={rehearseAgain}>
            Rehearse another fall <small>a 15-second rehearsal</small>
          </button>
        </>
      ) : (
        <button className={"join" + (queued ? " queued" : "") + (!ready || interlude ? " waiting" : "")} onClick={() => begin()} aria-busy={!ready || interlude > 0}>
          {joinLabel}
          <small>{joinSub}</small>
        </button>
      )}
      {/* nobody else in the world this minute: the one place a newcomer can see a titan fall, in a 15-second rehearsal */}
      {offerRehearse && (
        <a className="join-alt" href="/?rehearse=1">
          See a titan fall <small>· a 15-second rehearsal</small>
        </a>
      )}
    </section>
  );

  const playing = phase === "playing";
  const dash = (cls, style) => (
    <button className={"dashbtn " + cls} style={style} onPointerDown={(e) => (e.preventDefault(), gameRef.current.input.queueDash())} aria-label="Dash">
      dash
    </button>
  );
  const ledger = playing && <Ledger store={hudStore} aspectName={ASPECTS[profile.aspect].name} hpMax={world?.hpMax ?? 0} />;
  const gauges = playing && <Gauges store={hudStore} />;
  const tipNote = (cls, style) => tip && <div className={"margin-note " + cls} style={style} key={tip.id} dangerouslySetInnerHTML={{ __html: '<span class="manicule">☞</span> ' + tip.html }} />;

  // the folded leaf beside the fight: the titan, its song, who else is here and what has happened, your hunt
  const stripBody = spec && (
    <>
      <div className="folio">
        <span>{recorded ? "A recorded run" : rehearsal ? "A rehearsal titan" : `The ${ORD(spec.number)} Titan`}</span>
        <span className={"stage-name stage-" + stage}>{STAGE_NAMES[stage]}</span>
      </div>
      <h1 className="strip-name">{spec.name}</h1>
      <section className="wounds" aria-label="The titan's wounds">
        {lifeBar}
        <div className="caption">
          <span>{heldSpec ? "Felled" : `${struckTxt}% struck`}</span>
          <span>{recorded ? "a recorded run" : rehearsal ? "a rehearsal" : pinned ? "only you" : who?.topbar}</span>
        </div>
      </section>
      {/* the killing blow: the camera holds on the fight through the death beat and the stamp (Game FALL.HOLD);
          the leaf says so, rather than going blank while the book opens */}
      {heldSpec && felled && (
        <div className="strip-felled" role="status">
          <div className="strip-felled-word">Felled</div>
          <div className="strip-felled-line">
            {felled.blow ? (
              <>
                The final blow: <Sigil id={felled.blow.sigil} size={u * 0.55} /> <b>{felled.blow.name}</b>
              </>
            ) : (
              "The world brought it down together."
            )}
          </div>
        </div>
      )}
      <section aria-label="The Canticle">
        <div className="rubric" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>The Canticle</span>
          <Phrase store={hudStore} />
        </div>
        <Canticle game={g0} height={u * 2.7} />
      </section>
      {playing && tip && tipNote("in-leaf in-strip")}
      {/* who is in the air with you (live: hunters and echoes by name), then what has happened */}
      {live ? <StripPresence world={worldRef.current} u={u} header={presenceLine} /> : <div className="rubric strip-who">{recorded ? "A recorded run" : presenceLine}</div>}
      <section className="strip-chronicle" aria-label="The chronicle">
        <div className="rubric">The chronicle</div>
        <ul className="chronicle">
          {chronLines.slice(0, 8).map((f) => (
            <li key={f.id} className={f.titan ? "wb-titan-line" : undefined}>
              <span dangerouslySetInnerHTML={{ __html: f.html }} />
              {f.n ? <span className="wb-ago"> · {fmtAgo(Date.now() - f.n)}</span> : null}
            </li>
          ))}
        </ul>
      </section>
      {counts && !recorded && <OmenProgress store={hudStore} omen={omen} done={omenDone} aspect={profile.aspect} />}
      {gauges}
      {playing || heldSpec ? <Ledger store={hudStore} aspectName={ASPECTS[profile.aspect].name} hpMax={world?.hpMax ?? 0} /> : null}
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
        {rehearsal ? " · a rehearsal: not recorded" : !summary.counts ? " · on this page only: not recorded" : ""}
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
      {live && world.shrugged > 0 && <div className="wb-shrug">Others are fighting this titan too: past two fifths of its life, your blows land at a quarter.</div>}
      <dl className="facts" style={{ marginTop: "0.7em" }}>
        <dt>Grazes</dt>
        <dd>{summary.grazes}</dd>
        <dt>Best chain</dt>
        <dd>{summary.bestCombo}</dd>
        <dt>Surges</dt>
        <dd>{summary.surges}</dd>
        {summary.counts && (
          <>
            <dt>Your best</dt>
            <dd>{fmt(Math.max(profile.best, summary.damage))}</dd>
          </>
        )}
      </dl>
      {summary.omen && (
        <div className="omen done fresh">
          <span className="rubric">The omen is fulfilled</span>
          <div className="omen-text">{omenFor(summary.omen.omenDay).text}</div>
          <div className="omen-streak">{summary.omen.omenStreak === 1 ? "Your first day kept. Return tomorrow for a new omen." : `${summary.omen.omenStreak} days kept in a row.`}</div>
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
      {shareMsg && (
        <div className="rubric" style={{ marginTop: "0.5em" }}>
          {shareMsg}
        </div>
      )}
      {spent && (
        // a rehearsal's fall: the way on is the live titan (never a forgiving fight against a whole titan of your own)
        <div className="row">
          <a className="join" href="/" style={{ flex: 1, fontSize: "1.3em" }} autoFocus>
            Hunt the live titan
            <small>everyone online, the same titan, the same beat</small>
          </a>
        </div>
      )}
      <div className="row">
        {spent ? (
          <button className="ghost" style={{ flex: 2 }} onClick={rehearseAgain}>
            Rehearse another fall
          </button>
        ) : (
          <button className="join" style={{ flex: 2, fontSize: "1.3em" }} onClick={() => begin()} autoFocus>
            Hunt again
          </button>
        )}
        <button
          className="ghost"
          style={{ flex: 1 }}
          onClick={async () => {
            setShareMsg("Engraving your card…");
            const sp = summary.titanSpec ?? spec;
            const kind = rehearsal ? "rehearsal" : pinned || offline ? "own" : "live";
            // (a rehearsal's ghost would replay a titan that never falls: its link opens a rehearsal of one's own)
            const link = kind === "rehearsal" ? location.origin + "/?rehearse=1" : replayUrl({ seed: sp.seed, number: sp.number, stage: summary.stage, startT: summary.startT, damage: summary.damage, sigil: profile.sigil, name: profile.name, aspect: summary.aspect, path: summary.path });
            const r = await shareRun({ spec: sp, summary, profile, share: live ? summary.worldShare : null, link, kind });
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
      {/* after a fall the next titan sleeps for a while: said under the buttons (inside one it wrapped to three lines) */}
      {!spent && interlude > 0 && <div className="row-note">The next titan wakes in {interlude} s: Hunt again joins it as it does.</div>}
    </div>
  );

  const L = layout;
  const arena = L?.arena;
  const mode = L?.mode ?? "spread";
  const page = L?.right;
  // the side panel beside the page on a phone held sideways
  const sideBox = L && page && mode === "side" ? { left: page.x + page.w + 14, top: 0, bottom: 0, right: 0 } : null;
  return (
    <main className={"stage mode-" + mode + (L?.focus ? " is-focus" : "")} style={styleU}>
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
          <div className={"leaf" + (L.focus ? " strip" : " open") + (!L.focus && summary && !playing ? " with-card" : "")} key={L.focus ? "strip" : "open"} style={{ left: L.left.x, top: L.left.y, width: L.left.w, height: L.left.h }}>
            {L.focus ? (
              stripBody
            ) : (
              <>
                {leafBody}
                {playing ? ledger : summary ? (cardHold ? null : summaryCard("in-leaf", null)) : !replay && lobbyControls}
              </>
            )}
          </div>
        )}

        {/* the run's gauges: beside the page (sideways phone) or in the band under it (tall screens) */}
        {L && spec && playing && mode === "side" && page && (
          <>
            <div className="hud-side" style={{ right: L.vw - page.x + 10, top: L.vh / 2 }}>
              <div className="hud-side-name">{spec.name}</div>
              <span className="hp">
                <i style={{ width: hpFrac * 100 + "%" }} />
              </span>
              {gauges}
              <Blows store={hudStore} />
            </div>
            {tip && tipNote("side-note", { left: 8, width: Math.max(120, page.x - 18), top: 8 })}
            {dash("side", { left: page.x + page.w + Math.max(12, (L.vw - page.x - page.w) / 2 - 39), top: L.vh * 0.5 })}
          </>
        )}
        {L && spec && playing && mode === "single" && page && (
          <div className="hud-band" style={{ left: 0, right: 0, top: page.y + page.h + 4, height: Math.max(56, L.vh - page.y - page.h - 4) }}>
            <div className="hud-band-row">
              {gauges}
              <Blows store={hudStore} />
            </div>
            {dash("band", null)}
          </div>
        )}

        {/* run summary */}
        {summary && !cardHold && arena && mode === "single" && summaryCard("", { left: arena.x + arena.w * 0.06, width: arena.w * 0.88, top: arena.y + arena.h * (summary.felled ? 0.42 : 0.14) })}
        {summary && !cardHold && sideBox && !L.focus && summaryCard("in-side", sideBox)}

        {/* a tall screen's notes sit in the titan's band, above the arena: never over the attack lanes */}
        {tip && arena && page && playing && mode === "single" && tipNote("band-note", { left: arena.x + arena.w * 0.04, width: arena.w * 0.92, top: Math.max(page.y, 0) + 46 })}

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
        {felled && arena && page && (
          <div className="felled-stamp" style={{ left: page.x, top: g0 ? g0.screenOf(0, 25.2 - (L.focus ? g0.view.drop[1] : 0)).y : arena.y, width: page.w }} role="status">
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
                {felled.top?.[0] ? `${fmt(felled.top[0].damage)} blows, all of them yours.` : ""}
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
              <div className="sheet-head">
                <h1>{spec.name}</h1>
                <div className="epithet">{spec.epithet}</div>
                <nav className="sheet-links" aria-label="Turn to">
                  <a href="/hall">Hall of Titans</a>
                  <a href="/how">How it works</a>
                </nav>
              </div>
              {lobbyControls}
            </div>
          )}
        </>
      )}

      <Labels game={g0} world={worldRef.current} u={u} hidden={!!summary} />
      <Floats bind={bindFloats} />
    </main>
  );
}

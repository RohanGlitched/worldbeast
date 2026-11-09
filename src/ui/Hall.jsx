import { useEffect, useMemo, useState } from "react";
import { makeTitan, ARCHETYPE_INFO } from "@/core/titan";
import { hash32 } from "@/core/rng";
import { plateImg } from "./plates";
import { portraitOffThread } from "@/game/portraitClient";
import { listTitans, listHunters, titanEchoes } from "./data";
import { decodePath } from "@/net/pathcodec";
import { replayUrl } from "./replay";
import { Sigil } from "./sigils";
import { Link } from "./router";
import Footer from "./Footer";
import Bookmarks from "./Bookmarks";
import { base44 } from "@/api/base44Client";
import { fmtAgo, recentRuns } from "./chronicle";

const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
const dur = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
/** how long a titan has been awake: minutes, then hours (a sleeper nobody has struck can stay up for days) */
const awakeFor = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`;
};

/**
 * Run `fn` when the main thread is idle (or after `timeout` ms at most): the Hall's secondary reads (ghost runs,
 * the latest hunts) wait until the plates have painted. R5: on a phone at 4x they added ~650 ms of main-thread
 * work during the first seconds.
 */
function whenIdle(fn, timeout = 2500) {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 400);
  return () => clearTimeout(id);
}

/**
 * A titan's engraving, drawn live after the page's first paint on a worker thread (portraitClient.ts), or
 * where a worker cannot draw, one step per idle slot on the page: the Hall reads and scrolls while the
 * plates come in. Until then the plate shows its hatched placeholder.
 */
function useLivePortrait(seed, number, crack) {
  const [img, setImg] = useState(null);
  useEffect(() => {
    if (seed == null) return;
    let live = true;
    setImg(null);
    const id = setTimeout(() => {
      portraitOffThread(seed, number, { crack })
        .then((url) => live && setImg(url))
        .catch(() => {});
    }, 60);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [seed, number, crack]);
  return img;
}

function Plate({ t, live }) {
  const spec = useMemo(() => makeTitan(t.seed, t.number), [t.seed, t.number]);
  // a felled titan's plate shows its gold seams; a living one as wounded as the world has left it
  const left = (t.hp ?? t.hpMax) / (t.hpMax || 1);
  const crack = t.status === "felled" ? 0.9 : Number.isFinite(left) ? Math.round(Math.min(1, Math.max(0, 1 - left)) * 100) / 100 : 0;
  const img = useLivePortrait(t.seed, t.number, crack);
  const [ghosts, setGhosts] = useState([]);
  useEffect(() => {
    if (!t.number) return;
    let on = true;
    // (after the plates have painted: decoding paths and packing links is the Hall's heaviest work on a phone)
    const cancel = whenIdle(() =>
      titanEchoes(t.number, t.seed, 3).then((list) =>
        on &&
        setGhosts(
          list
            .map((e) => {
              const path = decodePath(e.path || "");
              if (!path) return null;
              // an echo starts at a beat of the titan's repeating song: any loop of it holds the same attacks
              const link = replayUrl({ seed: t.seed, number: t.number, stage: e.stage, startT: (e.loopBeat || 0) * spec.beat, damage: e.damage, sigil: e.sigil, name: e.name, aspect: e.aspect, path });
              return link && { id: e.id, name: e.name, sigil: e.sigil, damage: e.damage, link: link.replace(location.origin, "") };
            })
            .filter(Boolean),
        ),
      ),
    );
    return () => {
      on = false;
      cancel();
    };
  }, [t.number, t.seed, spec.beat]);
  const status = live ? "awake" : t.status;
  const dealt = Math.max(0, Math.round(t.damageTotal ?? (t.hpMax || 0) - (t.hp ?? t.hpMax ?? 0)));
  // the titan awake now, and nobody has landed a blow on it yet: an invitation, not "Wounds 0 · Hunters 0"
  const unstruck = status === "awake" && dealt === 0 && !t.hunterCount;
  return (
    <article className={"plate status-" + status} style={{ "--plate-body": spec.plate.body, "--plate-accent": spec.plate.accent }}>
      <div className="plate-art">{img ? <img src={img} alt={`An engraving of ${spec.name}`} /> : <div className="plate-ph" role="img" aria-label={`The engraving of ${spec.name} is being drawn`} />}</div>
      <div className="plate-text">
        <div className="folio">
          <span>The {ORD(t.number)} Titan</span>
          <span>{ARCHETYPE_INFO[spec.archetype].label}</span>
        </div>
        {status === "awake" && (
          // beside the name, not over the engraving's top corner (it covered the Strider's towers)
          <Link className="stamp awake" to="/" style={{ position: "relative", top: "auto", right: "auto", float: "right", margin: "6px 2px 0 10px", fontSize: 20 }}>
            Awake now
          </Link>
        )}
        <h3>{spec.name}</h3>
        <div className="epithet">{spec.epithet}</div>
        {status === "felled" && <div className="stamp felled">Felled</div>}
        {status === "escaped" && <div className="stamp escaped">Escaped</div>}
        {unstruck && (
          <p className="lore wb-unstruck">
            <Link to="/">Unstruck. Be the first wound.</Link>
          </p>
        )}
        <dl className="facts">
          {t.wokeAt && (
            <>
              <dt>{status === "awake" ? "Awake" : "Lived"}</dt>
              <dd>{status === "awake" ? awakeFor(Date.now() - t.wokeAt) : dur((t.felledAt || Date.now()) - t.wokeAt)}</dd>
            </>
          )}
          {!unstruck && (
            <>
              <dt>Wounds</dt>
              <dd>{fmt(dealt)}</dd>
              <dt>Hunters</dt>
              <dd>{fmt(t.hunterCount)}</dd>
            </>
          )}
          {t.finalBlowName && (
            <>
              <dt>Final blow</dt>
              <dd className="hunter-chip">
                <Sigil id={t.finalBlowSigil} size={16} /> {t.finalBlowName}
              </dd>
            </>
          )}
        </dl>
        {t.epitaph && <p className="epitaph">{t.epitaph}</p>}
        {ghosts.length > 0 && (
          <div className="ghosts">
            <span className="rubric">Watch a ghost run</span>
            {ghosts.map((g) => (
              <a key={g.id} href={g.link}>
                <Sigil id={g.sigil} size={14} /> {g.name} <span>{fmt(g.damage)}</span>
              </a>
            ))}
          </div>
        )}
        {t.topHunters?.length > 0 && (
          <ol className="top-hunters">
            {t.topHunters.slice(0, 3).map((h, i) => (
              <li key={i}>
                <Sigil id={h.sigil} size={14} /> {h.name} <span>{fmt(h.damage)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </article>
  );
}

function GhostPlate({ seed, label }) {
  // the empty plates' specimens are fixed seeds, engraved ahead of time (plates.js)
  const pre = plateImg(seed);
  const img = useLivePortrait(pre ? null : seed, 1, 0);
  return (
    <article className="plate ghost" aria-label={`A plate yet to be filled: a ${label} may wake one day`}>
      <div className="plate-art">{pre ? <img {...pre} alt="" decoding="async" /> : img ? <img src={img} alt="" /> : <div className="plate-ph" />}</div>
      <div className="plate-text">
        <div className="folio">
          <span>A plate yet to be filled</span>
          <span>{ARCHETYPE_INFO[label].label}</span>
        </div>
        <p className="lore">{ARCHETYPE_INFO[label].blurb} One may wake when the titan now awake is felled.</p>
      </div>
    </article>
  );
}

/** No titan has ended yet: say so, and show the first plate being written by the titan awake now. */
function FirstPlate({ awake }) {
  const spec = awake ? makeTitan(awake.seed, awake.number) : null;
  const dealt = awake ? Math.max(0, Math.round(awake.damageTotal ?? (awake.hpMax || 0) - (awake.hp ?? awake.hpMax ?? 0))) : 0;
  const pct = awake && awake.hpMax ? (dealt / awake.hpMax) * 100 : 0;
  return (
    <article className="plate empty wb-first-plate">
      <div className="plate-text">
        <div className="folio">
          <span>The first plate</span>
          <span>being written now</span>
        </div>
        <h3>No titan has fallen yet</h3>
        {spec ? (
          dealt > 0 ? (
            <p className="lore">
              The first plate will be <b>{spec.name}</b>'s. As of its last record it has taken{" "}
              <b>{pct < 0.1 ? "<0.1" : pct.toFixed(1)}%</b> of its wounds: {fmt(dealt)} of {fmt(awake.hpMax)} blows
              {awake.hunterCount ? `, from ${fmt(awake.hunterCount)} ${awake.hunterCount === 1 ? "hunter" : "hunters"}` : ""}. When it falls, its engraving, the final blow and its greatest hunters are written here for good, and the next titan wakes.
            </p>
          ) : (
            <p className="lore">
              The first plate will be <b>{spec.name}</b>'s. Nobody has struck it yet: the first wound could be yours, and in a quiet world every blow you land counts in full. When it falls, its engraving, the final blow and its greatest hunters are written here for good, and the next titan wakes.
            </p>
          )
        ) : (
          <p className="lore">When the world fells the titan that is awake, its engraving, its final blow and its greatest hunters are written here for good.</p>
        )}
        <Link className="join" to="/" style={{ marginTop: "0.6em" }}>
          {spec ? `Strike ${spec.name} now` : "Join the hunt"}
        </Link>
        <p className="wb-rehearse">
          Or <a href="/?rehearse=1">rehearse a fall</a>: a titan of your own, woken near death, so you can see what the Hall records. It doesn't count, and nothing of it is written here.
        </p>
      </div>
    </article>
  );
}

/** the latest finished runs, as the actor recorded them */
function RecentRuns({ runs, titans }) {
  if (!runs.length) return null;
  const names = new Map(titans.map((t) => [t.number, makeTitan(t.seed, t.number).name]));
  return (
    <section className="doc-section">
      <h2>The latest hunts</h2>
      <p className="lore">Runs as the world recorded them: only blows the world accepted count.</p>
      <ol className="roll wb-recent">
        {runs.map((r) => {
          const at = Number.isFinite(r.createdAt) ? r.createdAt : Date.parse(r.created_date || "");
          return (
            <li key={r.id}>
              <Sigil id={r.sigil ?? 0} size={20} />
              <span className="roll-name">{r.name || "A hunter"}</span>
              <span className="roll-d">{fmt(r.damage)} blows</span>
              <span className="roll-r">
                {names.get(r.titanNumber) ? `against ${names.get(r.titanNumber)} · ` : ""}
                {fmtAgo(Date.now() - at)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function Hall() {
  const [titans, setTitans] = useState(null);
  const [hunters, setHunters] = useState([]);
  const [runs, setRuns] = useState([]);
  useEffect(() => {
    document.title = "The Hall of Titans · WORLDBEAST";
    let on = true;
    listTitans().then((t) => on && setTitans(t));
    listHunters(12).then((h) => on && setHunters(h));
    // the latest hunts sit at the foot of the page: read them once the plates are up
    const cancel = whenIdle(() => recentRuns(base44?.entities, 8).then((r) => on && setRuns(r)));
    return () => {
      on = false;
      cancel();
    };
  }, []);
  const list = titans ?? [];
  const awake = list.find((t) => t.status === "awake");
  const rest = list.filter((t) => t !== awake);
  const fallback = !awake && titans !== null ? (() => {
    const block = Math.floor(Date.now() / (3 * 3600 * 1000));
    return { seed: hash32("local", block), number: (block % 900) + 1, status: "awake" };
  })() : null;
  return (
    <main className="doc">
      <Bookmarks />
      <header className="doc-head">
        <div className="folio">
          <span>WORLDBEAST</span>
          <span>A living bestiary</span>
        </div>
        <h1>The Hall of Titans</h1>
        <p className="lead">Every titan the world has fought. Each was born from a single number, sang its own song, and will never wake again. The felled are kept here with the names of the hunters who brought them down.</p>
      </header>
      <h2 id="wb-plates" className="sr-only">
        The titans' plates
      </h2>
      <section className="plates" aria-labelledby="wb-plates">
        {(awake || fallback) && <Plate t={awake || fallback} live />}
        {rest.map((t) => (
          <Plate key={t.number} t={t} />
        ))}
        {titans !== null && rest.length === 0 && <FirstPlate awake={awake} />}
        {titans !== null &&
          rest.length === 0 &&
          [[1, "throne"], [2, "coil"], [7, "strider"], [10, "bloom"]]
            .filter(([, label]) => !awake || makeTitan(awake.seed, awake.number).archetype !== label)
            .slice(0, 1)
            .map(([seed, label]) => <GhostPlate key={label} seed={seed} label={label} />)}
        {titans !== null && rest.length === 1 && (
          <article className="plate empty">
            <div className="plate-text">
              <h3>Plates yet to be filled</h3>
              <p className="lore">When the world fells the titan that is awake, its engraving, its final blow and its greatest hunters are written here for good, and a new titan wakes: born from a new number, singing a new song.</p>
              <Link className="join" to="/" style={{ marginTop: "0.8em" }}>
                Join the hunt
              </Link>
            </div>
          </article>
        )}
        {titans === null && <div className="plate plate-ph" aria-busy="true" />}
      </section>
      <section className="doc-section">
        <h2>The greatest hunters</h2>
        <p className="lore">All-time blows struck across every titan.</p>
        {hunters.length === 0 ? (
          <p className="lore">No hunter has finished a run yet. The first names written here will be the first to strike.</p>
        ) : (
          <ol className="roll">
            {hunters.map((h, i) => (
              <li key={h.hunterKey || i}>
                <span className="roll-n">{i + 1}</span>
                <Sigil id={h.sigil} size={20} />
                <span className="roll-name">{h.name}</span>
                <span className="roll-d">{fmt(h.damageTotal)} blows</span>
                <span className="roll-r">{h.titansFelled ? `${h.titansFelled} felled` : `${h.runs} ${h.runs === 1 ? "run" : "runs"}`}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <RecentRuns runs={runs} titans={list} />
      <Footer />
    </main>
  );
}

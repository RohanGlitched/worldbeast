import { useEffect, useMemo, useState } from "react";
import { makeTitan, ARCHETYPE_INFO } from "@/core/titan";
import { hash32 } from "@/core/rng";
import { portrait } from "@/game/portrait";
import { listTitans, listHunters } from "./data";
import { Sigil } from "./sigils";
import { Link } from "./router";
import Footer from "./Footer";
import Bookmarks from "./Bookmarks";

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

function Plate({ t, live }) {
  const spec = useMemo(() => makeTitan(t.seed, t.number), [t.seed, t.number]);
  const [img, setImg] = useState(null);
  useEffect(() => {
    const id = requestIdleCallback ? requestIdleCallback(() => setImg(portrait(t.seed, t.number, { crack: t.status === "felled" ? 0.9 : 1 - (t.hp ?? t.hpMax) / (t.hpMax || 1) }))) : setTimeout(() => setImg(portrait(t.seed, t.number)), 30);
    return () => (cancelIdleCallback ? cancelIdleCallback(id) : clearTimeout(id));
  }, [t.seed, t.number, t.status, t.hp, t.hpMax]);
  const status = live ? "awake" : t.status;
  return (
    <article className={"plate status-" + status} style={{ "--plate-body": spec.plate.body, "--plate-accent": spec.plate.accent }}>
      <div className="plate-art">{img ? <img src={img} alt={`An engraving of ${spec.name}`} /> : <div className="plate-ph" />}</div>
      <div className="plate-text">
        <div className="folio">
          <span>The {ORD(t.number)} Titan</span>
          <span>{ARCHETYPE_INFO[spec.archetype].label}</span>
        </div>
        <h3>{spec.name}</h3>
        <div className="epithet">{spec.epithet}</div>
        {status === "felled" && <div className="stamp felled">Felled</div>}
        {status === "escaped" && <div className="stamp escaped">Escaped</div>}
        {status === "awake" && (
          <Link className="stamp awake" to="/">
            Awake now
          </Link>
        )}
        <dl className="facts">
          {t.wokeAt && (
            <>
              <dt>Lived</dt>
              <dd>{dur((t.felledAt || Date.now()) - t.wokeAt)}</dd>
            </>
          )}
          <dt>Wounds</dt>
          <dd>{fmt(t.damageTotal ?? (t.hpMax || 0) - (t.hp ?? t.hpMax ?? 0))}</dd>
          <dt>Hunters</dt>
          <dd>{fmt(t.hunterCount)}</dd>
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
  const [img, setImg] = useState(null);
  useEffect(() => {
    const id = setTimeout(() => setImg(portrait(seed, 1)), 120);
    return () => clearTimeout(id);
  }, [seed]);
  return (
    <article className="plate ghost" aria-label={`A plate yet to be filled: a ${label} may wake one day`}>
      <div className="plate-art">{img ? <img src={img} alt="" /> : <div className="plate-ph" />}</div>
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

export default function Hall() {
  const [titans, setTitans] = useState(null);
  const [hunters, setHunters] = useState([]);
  useEffect(() => {
    document.title = "The Hall of Titans · WORLDBEAST";
    listTitans().then(setTitans);
    listHunters(12).then(setHunters);
  }, []);
  const list = titans ?? [];
  const awake = list.find((t) => t.status === "awake");
  const rest = list.filter((t) => t !== awake);
  const fallback = !awake && titans !== null ? (() => {
    const block = Math.floor(Date.now() / (3 * 3600 * 1000));
    return { seed: hash32("local", block), number: (block % 900) + 1, status: "awake" };
  })() : null;
  return (
    <div className="doc">
      <Bookmarks />
      <header className="doc-head">
        <div className="folio">
          <span>WORLDBEAST</span>
          <span>A living bestiary</span>
        </div>
        <h1>The Hall of Titans</h1>
        <p className="lead">Every titan the world has fought. Each was born from a single number, sang its own song, and will never wake again. The felled are kept here with the names of the hunters who brought them down.</p>
      </header>
      <section className="plates" aria-label="Titans">
        {(awake || fallback) && <Plate t={awake || fallback} live />}
        {rest.map((t) => (
          <Plate key={t.number} t={t} />
        ))}
        {titans !== null &&
          rest.length < 3 &&
          [[1, "throne"], [2, "coil"], [7, "strider"], [10, "bloom"]].slice(0, 3 - rest.length).map(([seed, label]) => <GhostPlate key={label} seed={seed} label={label} />)}
        {titans !== null && rest.length < 2 && (
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
      <Footer />
    </div>
  );
}

import { useEffect, useState } from "react";
import { ARCHETYPE_INFO, ARCHETYPES, makeTitan } from "@/core/titan";
import { portrait } from "@/game/portrait";
import Footer from "./Footer";
import Bookmarks from "./Bookmarks";
import { Link } from "./router";

// Seeds known to wake each anatomy, for the specimen plates.
const SPECIMENS = { throne: 1, coil: 2, strider: 7, bloom: 10, swarmheart: 5 };

const KINDS = [
  ["Ring", "A fan of ink thrown from a mouth or a hand, always with gaps between drops."],
  ["Spiral", "Drops released one after another as the source turns, folded downward."],
  ["Fan", "Waves of drops aimed at a point on the page, not at you: everyone sees the same aim."],
  ["Wall", "A row across the page with one gap; the gap posts appear two beats early."],
  ["Rain", "Columns marked by thin guides, then fast drops down each column."],
  ["Wave", "A stream that sways side to side as it falls."],
  ["Curve", "Drops that bend as they fly, along exact circular arcs."],
  ["Bloom", "A gold seed drifts to a mark, then bursts into a ring."],
  ["Beam", "A brushstroke that sweeps an arc; a dashed guide shows where it starts."],
  ["Slam", "A ring that spreads from where a foot or fist lands, with two gaps to slip through."],
  ["Glyph", "A circle drawn on the page that fills, then floods with ink for a few beats."],
  ["Cross", "Diagonal lines entering from the margins, crossing the page."],
];

function Specimen({ arch }) {
  const seed = SPECIMENS[arch];
  const spec = makeTitan(seed, 1);
  const [img, setImg] = useState(null);
  useEffect(() => {
    const id = setTimeout(() => setImg(portrait(seed, 1, { w: 300, h: 250 })), 40);
    return () => clearTimeout(id);
  }, [seed]);
  return (
    <figure className="specimen">
      {img ? <img src={img} alt={`A ${ARCHETYPE_INFO[arch].label}: ${spec.name}`} /> : <div className="plate-ph" />}
      <figcaption>
        <b>{ARCHETYPE_INFO[arch].label}</b> {ARCHETYPE_INFO[arch].blurb}
      </figcaption>
    </figure>
  );
}

export default function How() {
  useEffect(() => {
    document.title = "How it works · WORLDBEAST";
  }, []);
  return (
    <div className="doc">
      <Bookmarks />
      <header className="doc-head">
        <div className="folio">
          <span>WORLDBEAST</span>
          <span>How it works</span>
        </div>
        <h1>One fight, every browser</h1>
        <p className="lead">Hundreds of people can fight the same titan at once and see the same attack land on the same beat, though no server ever simulates a single drop of ink. Here is how.</p>
      </header>

      <section className="doc-section two">
        <div>
          <h2>The fight is a function of time</h2>
          <p>
            Each titan is born from one number, its <i>seed</i>. From it come its anatomy, its colours, its name, its tempo and key, and the plan of every attack it will make: which kind, on which beat, from where. Every drop of ink has a closed-form path: its position is worked out directly from the seed and the seconds since the titan woke.
          </p>
          <p>So every browser that knows the seed and the time draws the identical fight. Someone who joins late lands in exactly the same moment as everyone else. The server only has to agree on the clock.</p>
        </div>
        <figure className="diagram" aria-label="How the shared fight is computed">
          <svg viewBox="0 0 420 300" role="img">
            <defs>
              <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L10 5L0 10z" fill="currentColor" />
              </marker>
            </defs>
            <g className="dg-box">
              <rect x="10" y="20" width="120" height="58" />
              <text x="70" y="44">Base44 actor</text>
              <text x="70" y="62" className="small">clock · wounds · hunters</text>
              <rect x="150" y="20" width="120" height="58" />
              <text x="210" y="44">seed</text>
              <text x="210" y="62" className="small">one number per titan</text>
              <rect x="290" y="20" width="120" height="58" />
              <text x="350" y="44">t</text>
              <text x="350" y="62" className="small">seconds since it woke</text>
              <rect x="110" y="130" width="200" height="58" className="gold" />
              <text x="210" y="154">fight(seed, t, stage)</text>
              <text x="210" y="172" className="small">pure, closed form, identical everywhere</text>
            </g>
            <g className="dg-lines">
              <path d="M70 78 C70 110, 150 115, 170 130" markerEnd="url(#ar)" />
              <path d="M210 78 L210 128" markerEnd="url(#ar)" />
              <path d="M350 78 C350 110, 270 115, 250 130" markerEnd="url(#ar)" />
              <path d="M150 188 L70 238" markerEnd="url(#ar)" />
              <path d="M210 188 L210 238" markerEnd="url(#ar)" />
              <path d="M270 188 L350 238" markerEnd="url(#ar)" />
            </g>
            <g className="dg-box">
              <rect x="20" y="240" width="100" height="44" />
              <text x="70" y="266">your browser</text>
              <rect x="160" y="240" width="100" height="44" />
              <text x="210" y="266">a hunter, Lima</text>
              <rect x="300" y="240" width="100" height="44" />
              <text x="350" y="266">one, Osaka</text>
            </g>
          </svg>
          <figcaption>Only the clock, the wounds and the hunters' positions travel over the network. The attacks are computed, not sent.</figcaption>
        </figure>
      </section>

      <section className="doc-section">
        <h2>Five anatomies</h2>
        <p>Every titan is one of five body plans, built and posed in real time from its seed, then drawn as a copperplate engraving: the lines follow each part's surface, cross-hatching deepens in shadow, and a hand-coloured wash sits beneath. As the world wounds it, gold seams open across its body.</p>
        <div className="specimens">
          {ARCHETYPES.map((a) => (
            <Specimen key={a} arch={a} />
          ))}
        </div>
      </section>

      <section className="doc-section">
        <h2>Twelve forms of attack</h2>
        <p>A titan speaks a vocabulary of seven or eight of these, weighted by its anatomy and temper. Its attacks follow its song: eight phrases of sixteen bars, after which the Canticle repeats. As the world wounds it, it moves from Calm to Wrath to Ruin, its song grows denser, and in Ruin it adds a signature attack of its own.</p>
        <dl className="kinds">
          {KINDS.map(([k, d]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="doc-section two">
        <div>
          <h2>Built on Base44</h2>
          <p>
            <b>An actor keeps the world.</b> A single Base44 actor session holds the authoritative clock, the titan's wounds and who is hunting. Browsers connect over a WebSocket, even without an account, send their position ten times a second, and receive everyone else's.
          </p>
          <p>
            <b>Blows are checked, not trusted.</b> The actor runs the same fight code as the browser, so it knows on which beats each wound is open. It rejects blows on closed wounds and blows faster than any light can strike.
          </p>
          <p>
            <b>The database is the memory.</b> Titans, hunters, runs and echoes are Base44 records written only by the actor; anyone can read them, nobody can forge them.
          </p>
        </div>
        <div>
          <h2>Echoes</h2>
          <p>When your light goes out, your path is kept as an echo. Because the Canticle repeats, an echo can fly again exactly where it flew before, dodging the same attacks on the same beats. The pale dotted stars beside you are the real routes of hunters who came before.</p>
          <h2>Never empty, never a login</h2>
          <p>If the world can't be reached, the titan of the current three-hour bell wakes in your browser alone, and the game keeps trying to rejoin. There is no sign-in, no paywall and no download.</p>
          <Link className="join" to="/">
            Join the hunt
          </Link>
        </div>
      </section>
      <Footer />
    </div>
  );
}

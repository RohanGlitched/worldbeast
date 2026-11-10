import { Link } from "./router";

export const CHANGELOG = [
  ["Nov 10", "A weightier fall: the camera holds on the killing blow, the gold burst and the FELLED stamp before the book opens. Rehearsals: see a titan of your own fall, then hunt the live one."],
  ["Nov 10", "A quiet world counts every blow in full, a first hunt is gentler while you learn, and the Hall shows the first plate being written."],
  ["Nov 9", "Launch. The test world is wiped and Orthargek, the first titan, wakes. The daily omen begins."],
  ["Nov 9", "Ghost links: share a run and anyone can watch it against the very attacks you faced. Hounds, epitaphs, seals."],
  ["Nov 9", "The first titans wake: five anatomies, twelve attack forms, the Canticle, echoes, the open codex."],
];

export default function Footer() {
  return (
    <footer className="doc-footer">
      <div className="foot-grid">
        <div>
          <div className="foot-title">Worldbeast</div>
          <p>One titan. Everyone online. The same moment. A living bestiary built on Base44: the world's clock, wounds and hunters live in a Base44 actor; every titan, run and echo is a Base44 record.</p>
        </div>
        <nav aria-label="Pages">
          <div className="rubric">The codex</div>
          <Link to="/">The hunt</Link>
          <Link to="/hall">The Hall of Titans</Link>
          <Link to="/how">How it works</Link>
        </nav>
        <div>
          <div className="rubric">Play</div>
          <p>Free, no login, no download. Keyboard, mouse, touch or gamepad. Sound on: every attack lands on the beat.</p>
        </div>
        <div>
          <div className="rubric">Changes</div>
          <ul className="changelog">
            {CHANGELOG.map(([d, t]) => (
              <li key={d + t.slice(0, 12)}>
                <b>{d}</b> {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="colophon">Engraved in real time with three.js; sung with the Web Audio API; hosted and kept by Base44. Made for the Base44 × Nitro Web Game Contest, 2026.</div>
    </footer>
  );
}

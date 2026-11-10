import { Link } from "./router";

export const CHANGELOG = [
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
      <div className="colophon">
        An original game by Rohan Borade: code, titans, art, music and sound made for the Base44 × Nitro Web Game Contest, 9–10 November 2026, on Base44 with the Base44 CLI. Engraved in real time with three.js; sung with the Web Audio API; hosted and kept by Base44. Source and full history:{" "}
        <a href="https://github.com/RohanGlitched/worldbeast" target="_blank" rel="noopener">github.com/RohanGlitched/worldbeast</a>. © 2026 Rohan Borade.
      </div>
    </footer>
  );
}

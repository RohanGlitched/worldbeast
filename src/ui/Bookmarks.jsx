import { Link, usePath } from "./router";

// Silk ribbons hanging over the top of the codex: the site's navigation.
const MARKS = [
  ["/", "The hunt", "#c8321f"],
  ["/hall", "Hall of Titans", "#2b4a8b"],
  ["/how", "How it works", "#b8861f"],
];

export default function Bookmarks({ style }) {
  const path = usePath();
  return (
    <nav className="ribbons" style={style} aria-label="Turn to">
      {MARKS.map(([to, label, color]) => (
        <Link key={to} to={to} className={"ribbon" + (path === to ? " here" : "")} style={{ "--rib": color }} aria-current={path === to ? "page" : undefined}>
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

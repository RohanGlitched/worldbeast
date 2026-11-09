import { Link, usePath } from "./router";

// Silk ribbons hanging over the top of the codex: the site's navigation.
const MARKS = [
  ["/", "The hunt", "#c8321f", "Hunt"],
  ["/hall", "Hall of Titans", "#2b4a8b", "Hall"],
  ["/how", "How it works", "#b8861f", "How"],
];

export default function Bookmarks({ style }) {
  const path = usePath();
  return (
    <nav className="ribbons" style={style} aria-label="Turn to">
      {MARKS.map(([to, label, color, short]) => (
        <Link key={to} to={to} className={"ribbon" + (path === to ? " here" : "")} style={{ "--rib": color }} aria-current={path === to ? "page" : undefined}>
          <span>{typeof window !== "undefined" && window.innerWidth < 640 ? short : label}</span>
        </Link>
      ))}
    </nav>
  );
}

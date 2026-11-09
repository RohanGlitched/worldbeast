import { useEffect } from "react";
import { Link } from "./router";
import Bookmarks from "./Bookmarks";

export default function NotFound() {
  useEffect(() => {
    document.title = "A blank leaf · WORLDBEAST";
  }, []);
  return (
    <div className="doc">
      <Bookmarks />
      <header className="doc-head">
        <div className="folio">
          <span>WORLDBEAST</span>
          <span>A blank leaf</span>
        </div>
        <h1>No titan here</h1>
        <p className="lead">This page of the codex was never written. The titan you are looking for is awake on the first page.</p>
        <Link className="join" to="/">
          Return to the hunt
        </Link>
      </header>
    </div>
  );
}

import { useEffect, useState } from "react";

// The closed codex: tooled leather, a gilded title, a clasp. Opening it unlocks sound and wakes the page.

export default function Cover({ rect, onOpen, online }) {
  const [opening, setOpening] = useState(false);
  const open = () => {
    if (opening) return;
    setOpening(true);
    onOpen?.();
  };
  useEffect(() => {
    const k = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const style = rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { inset: 0 };
  return (
    <div className={"cover-wrap" + (opening ? " opening" : "")} style={style}>
      <button className="cover" onClick={open} aria-label="Open the codex and join the hunt">
        <svg className="cover-tooling" viewBox="0 0 400 560" preserveAspectRatio="none" aria-hidden="true">
          <rect x="18" y="18" width="364" height="524" />
          <rect x="30" y="30" width="340" height="500" />
          <path d="M200 70 L214 112 L256 126 L214 140 L200 182 L186 140 L144 126 L186 112 Z" className="gilt" />
          <circle cx="200" cy="126" r="9" />
          <path d="M60 60 q30 10 40 40 M340 60 q-30 10 -40 40 M60 500 q30 -10 40 -40 M340 500 q-30 -10 -40 -40" />
          <path d="M70 430 H330 M90 444 H310" />
        </svg>
        <span className="cover-title">Worldbeast</span>
        <span className="cover-sub">One titan · everyone online · the same moment</span>
        <span className="cover-open">{opening ? "…" : "Open the codex"}</span>
        <span className="cover-meta">{online > 1 ? `${online} hunters inside` : "A living bestiary"} · sound on</span>
        <span className="clasp" aria-hidden="true" />
      </button>
    </div>
  );
}

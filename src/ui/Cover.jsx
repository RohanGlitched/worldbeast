import { useEffect, useState } from "react";
import { portraitAsync } from "@/game/portrait";

// The closed codex: tooled leather, a gilded title, a clasp. Opening it unlocks sound and wakes the page.

const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

// `meta`: an honest line about who is here (see chronicle.js presence); `replay`: a ghost link's run, if any
export default function Cover({ rect, onOpen, meta, spec, replay }) {
  const [opening, setOpening] = useState(false);
  const [img, setImg] = useState(null);
  // the titan has inked in: the blank compass under it is put away (no double exposure)
  const [inked, setInked] = useState(false);
  useEffect(() => {
    if (!spec) return;
    // drawn by the game's renderer once the titan's programs are linked; until then the medallion is blank
    // vellum, and only the titan awake now ever inks into it (never another titan's art, never a cross-fade)
    let live = true;
    // at the size it is shown (the image overhangs the medallion by 18%), in device pixels (up to 3x): never
    // drawn smaller and stretched, which left the engraving's hatching soft
    const css = typeof window !== "undefined" ? Math.ceil(Math.min(window.innerHeight * 0.34, 300) * 1.18) : 354;
    const size = Math.max(160, Math.min(420, css));
    const dpr = typeof window !== "undefined" ? Math.min(3, Math.max(1, window.devicePixelRatio || 1)) : 1;
    portraitAsync(spec.seed, spec.number, { w: size, h: size, dpr })
      .then((url) => live && setImg({ seed: spec.seed, url }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [spec?.seed, spec?.number]);
  const shown = img && spec && img.seed === spec.seed ? img.url : null;
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
      <button className="cover" onClick={open} aria-label={replay ? "Open the codex and watch the recorded run" : "Open the codex and join the hunt"}>
        <svg className="cover-tooling" viewBox="0 0 400 560" preserveAspectRatio="none" aria-hidden="true">
          <rect x="18" y="18" width="364" height="524" />
          <rect x="30" y="30" width="340" height="500" />

          <path d="M60 60 q30 10 40 40 M340 60 q-30 10 -40 40 M60 500 q30 -10 40 -40 M340 500 q-30 -10 -40 -40" />
          <path d="M70 430 H330 M90 444 H310" />
        </svg>
        {/* the blank compass is put away the moment the titan starts inking in (onLoad), not after it has: the two
            were a double exposure for the length of the fade */}
        <span className={"medallion" + (shown && inked ? " inked" : "")} aria-hidden="true">
          {shown ? <img key={img.seed} src={shown} alt="" onLoad={() => setInked(true)} onError={() => setInked(false)} /> : null}
        </span>
        {/* (the line is there from the first paint, blank until the world names its titan: nothing below it shifts) */}
        {replay ? (
          <span className="cover-awake">
            A ghost run: {replay.name}, {Math.round(replay.damage).toLocaleString("en-US")} blows{spec ? ` against ${spec.name}` : ""}
          </span>
        ) : (
          <span className={"cover-awake" + (spec ? "" : " pending")}>{spec ? `Awake now: ${spec.name}, ${spec.epithet}` : " "}</span>
        )}
        <span className="cover-title">Worldbeast</span>
        <span className="cover-sub">One titan · everyone online · the same moment</span>
        <span className="cover-open">{opening ? "…" : replay ? `Watch ${replay.name}'s run${spec ? ` against ${spec.name}` : ""}` : "Open the codex"}</span>
        <span className="cover-meta">
          {meta || "A living bestiary"} · sound on{coarse() ? "" : " · Enter opens"}
        </span>
        <span className="clasp" aria-hidden="true" />
      </button>
    </div>
  );
}

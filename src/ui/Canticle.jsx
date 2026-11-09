import { memo, useEffect, useRef } from "react";
import { coreOpen, PHRASE_BEATS, LOOP_PHRASES } from "@/core/titan";

// The titan's song written as plainchant: a four-line red staff, square neumes for each attack
// (pitch by kind, size by weight), gold bars where its wounds open. The playhead is "now".

const PITCH = { ring: 5, spiral: 6, fan: 3, wall: 1, rain: 7, wave: 4, curve: 4, bloom: 6, beam: 2, slam: 0, glyph: 1, cross: 3 };
const AHEAD = 18;
const BEHIND = 4;

// (memo: the codex re-renders around it; the staff redraws itself, at most 30 times a second, only while seen)
function Canticle({ game, height = 110 }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf = 0;
    let lastAt = 0;
    let seen = true;
    const cv = ref.current;
    const ctx = cv.getContext("2d");
    // nothing to draw while the staff is off screen (under the cover, a folded leaf) or the tab is hidden
    let io = null;
    try {
      io = new IntersectionObserver((e) => (seen = e[e.length - 1].isIntersecting));
      io.observe(cv);
    } catch {}
    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      if (!seen || document.hidden || now - lastAt < 31) return;
      lastAt = now;
      const g = game;
      if (!g?.spec || !g.field) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth,
        H = cv.clientHeight;
      if (cv.width !== Math.round(W * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const p = g.spec.plate;
      const t = g.clock();
      const beat = t / g.spec.beat;
      const stage = g.stage;
      const x0 = W * (BEHIND / (AHEAD + BEHIND));
      const px = W / (AHEAD + BEHIND);
      const top = H * 0.12,
        gap = H * 0.13;
      const staffY = (i) => top + gap * i;
      const bx = (b) => x0 + (b - beat) * px;
      // core windows (gold) along the foot
      const footY = staffY(3) + gap * 1.15;
      g.spec.cores.forEach((c, ci) => {
        for (let b = Math.floor(beat - BEHIND); b < beat + AHEAD; b++) {
          if (coreOpen(c, b, stage)) {
            ctx.fillStyle = p.gold;
            ctx.globalAlpha = 0.75;
            ctx.fillRect(bx(b), footY + ci * 3.2, px + 0.5, 2.4);
          }
        }
      });
      ctx.globalAlpha = 1;
      // the staff
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, staffY(i));
        ctx.lineTo(W, staffY(i));
        ctx.stroke();
      }
      // bar lines every 4 beats, phrase lines heavier
      for (let b = Math.ceil((beat - BEHIND) / 4) * 4; b < beat + AHEAD; b += 4) {
        const x = bx(b);
        const phraseLine = b % PHRASE_BEATS === 0;
        ctx.strokeStyle = p.ink;
        ctx.globalAlpha = phraseLine ? 0.8 : 0.25;
        ctx.lineWidth = phraseLine ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, staffY(0));
        ctx.lineTo(x, staffY(3));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // neumes
      const pa = Math.floor(beat / PHRASE_BEATS);
      for (const ph of [pa - 1, pa, pa + 1]) {
        if (ph < 0) continue;
        const plan = g.field.plan(((ph % LOOP_PHRASES) + LOOP_PHRASES) % LOOP_PHRASES, stage);
        for (const v of plan.volleys) {
          const b = ph * PHRASE_BEATS + v.beat;
          if (b < beat - BEHIND || b > beat + AHEAD) continue;
          const x = bx(b);
          const pitch = PITCH[v.kind] ?? 3;
          const y = staffY(3) - (pitch * gap) / 2;
          const s = v.heavy ? gap * 0.95 : gap * 0.7;
          const past = b < beat;
          ctx.globalAlpha = past ? 0.3 : 1;
          ctx.fillStyle = v.heavy ? p.accent : p.ink;
          // punctum: a square note with a slight calligraphic slant
          ctx.save();
          ctx.translate(x, y);
          ctx.transform(1, -0.12, 0, 1, 0, 0);
          ctx.fillRect(-s / 2, -s / 2, s, s * 0.82);
          if (v.heavy) {
            ctx.fillRect(s / 2 - 1.5, -s / 2, 1.5, s * 1.8); // a tail for the heavy ones
          }
          ctx.restore();
          // the warning window: a light wash before each note
          if (!past && b - beat < v.tele) {
            ctx.globalAlpha = 0.18;
            ctx.fillStyle = v.heavy ? p.accent : p.ink;
            ctx.fillRect(bx(b - v.tele), staffY(0), v.tele * px, staffY(3) - staffY(0));
          }
        }
      }
      ctx.globalAlpha = 1;
      // the playhead: now
      ctx.strokeStyle = p.gold;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, staffY(0) - gap * 0.5);
      ctx.lineTo(x0, footY + 16);
      ctx.stroke();
      ctx.fillStyle = p.gold;
      ctx.beginPath();
      ctx.moveTo(x0 - 5, staffY(0) - gap * 0.5);
      ctx.lineTo(x0 + 5, staffY(0) - gap * 0.5);
      ctx.lineTo(x0, staffY(0) - gap * 0.5 + 7);
      ctx.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [game]);
  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} aria-label="The titan's song: upcoming attacks as notes on a staff; gold bars mark when its wounds are open." />;
}

export default memo(Canticle);

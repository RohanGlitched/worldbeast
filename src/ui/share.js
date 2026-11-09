import { portraitAsync } from "@/game/portrait";
import { SIGIL_NAMES } from "./sigils";

// A 1200×630 card for the run: the titan's engraving, your blows and your share of the world's.

const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

export async function makeCard({ spec, summary, profile, share }) {
  await document.fonts.ready;
  const W = 1200,
    H = 630;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const p = spec.plate;
  // vellum with a ruled frame
  g.fillStyle = "#1a1410";
  g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#f3e9d3");
  grad.addColorStop(1, "#e6d8b9");
  g.fillStyle = grad;
  g.fillRect(24, 24, W - 48, H - 48);
  g.strokeStyle = p.accent2;
  g.lineWidth = 2;
  g.strokeRect(44, 44, W - 88, H - 88);
  g.strokeStyle = p.accent;
  g.lineWidth = 4;
  g.strokeRect(54, 54, W - 108, H - 108);
  // the titan
  const img = await loadImg(await portraitAsync(spec.seed, spec.number, { crack: summary.felled ? 1 : 0.4, w: 560, h: 470 }));
  g.drawImage(img, 640, 90, 520, 436);
  // words
  g.fillStyle = "#7a6a58";
  g.font = "italic 26px 'IM Fell English', serif";
  g.fillText(`The ${ORD(spec.number)} Titan`, 96, 120);
  g.fillStyle = "#231c17";
  g.font = "700 92px 'UnifrakturCook', serif";
  g.fillText(spec.name, 92, 210);
  g.fillStyle = p.accent;
  g.font = "italic 30px 'IM Fell English', serif";
  g.fillText(spec.epithet, 96, 252);
  g.fillStyle = "#231c17";
  g.font = "800 112px 'EB Garamond', serif";
  g.fillText(Math.round(summary.damage).toLocaleString("en-US"), 92, 400);
  g.font = "italic 30px 'EB Garamond', serif";
  g.fillStyle = "#4a3e33";
  const line = summary.felled ? "blows struck, and the titan fell" : share ? `blows struck · ${share} of the world's wounds` : "blows struck against it";
  g.fillText(line, 96, 446);
  g.font = "26px 'EB Garamond', serif";
  g.fillText(`${profile.name}, bearing the ${SIGIL_NAMES[profile.sigil]}`, 96, 500);
  g.fillStyle = p.accent;
  g.font = "700 40px 'UnifrakturCook', serif";
  g.fillText("WORLDBEAST", 96, 566);
  g.fillStyle = "#7a6a58";
  g.font = "italic 22px 'IM Fell English', serif";
  g.fillText("one titan · everyone online · the same moment", 380, 562);
  return new Promise((res) => c.toBlob((b) => res(b), "image/png"));
}

export async function shareRun(args) {
  const blob = await makeCard(args);
  const url = args.link || location.origin + "/";
  const text = `I struck ${Math.round(args.summary.damage).toLocaleString("en-US")} blows against ${args.spec.name}, the ${ORD(args.spec.number)} titan. Everyone online fights it at the same moment. Watch my run:`;
  const file = new File([blob], "worldbeast.png", { type: "image/png" });
  // phones get the share sheet; desktops save the card and copy the link (the desktop sheet is slow and often empty)
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text, url });
      return "shared";
    } catch {
      /* fall through to download */
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `worldbeast-${args.spec.name.toLowerCase()}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    return "saved+copied";
  } catch {
    return "saved";
  }
}

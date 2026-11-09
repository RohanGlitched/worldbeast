// Draws the static art with the game's own engraving code (src/game/portrait.ts), in a real browser:
//   public/art/plates/<seed>.webp, <seed>@2x.webp   the fixed-seed plates (How it works specimens, the Hall's empty plates)
//   public/art/thumb.png (1200x1200), og.png (1200x630), docs/cover.png   key art: Orthargek, the first titan
//   public/art/medallion-blank.svg (+ .png)            the cover medallion's neutral placeholder (no titan); the
//                                                      PNG is then palette-reduced (any PNG quantiser) to stay small
//
// Usage: node scripts/render-art.mjs [plates] [key] [blank]   (all three when none is named)
// Needs Playwright with Chromium. It is not a dependency of the app: point PLAYWRIGHT at an install
// (PLAYWRIGHT=/path/to/node_modules/playwright) or have `playwright` resolvable from here.
// Run it after any change to the engraving (material.ts, titan.ts, form.ts) so the static plates match the game.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const want = new Set(process.argv.slice(2));
const all = want.size === 0;
const pwSpec = process.env.PLAYWRIGHT || "playwright";
const { chromium } = await import(/^[a-zA-Z]:[\\/]|^\//.test(pwSpec) ? pathToFileURL(path.join(pwSpec, "index.mjs")).href : pwSpec);

// the seeds How it works and the Hall show as fixed plates (How.jsx SPECIMENS, Hall.jsx ghost plates)
export const PLATE_SEEDS = [1, 2, 5, 7, 10];
const ORTHARGEK = { seed: 2870491872, number: 1 };

const server = await createServer({ root, logLevel: "error", server: { port: 0, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const write = (rel, dataUrl) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(rel, Math.round(fs.statSync(f).size / 1024) + " KB");
};

try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("page:", e.message));
  await page.goto(base + "/art-render", { waitUntil: "load" });
  // draws a portrait and returns it as a data URL (PNG, or WebP at quality q)
  await page.evaluate(() => {
    window.__draw = async (seed, number, opts, type = "image/png", q = 0.9) => {
      const m = await import("/src/game/portrait.ts");
      const png = m.portraitSync(seed, number, opts);
      if (type === "image/png") return png;
      const img = new Image();
      img.src = png;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL(type, q);
    };
    window.__spec = async (seed, number) => {
      const t = await import("/src/core/titan.ts");
      const s = t.makeTitan(seed, number);
      return { name: s.name, epithet: s.epithet, archetype: s.archetype, label: t.ARCHETYPE_INFO[s.archetype].label };
    };
  });

  if (all || want.has("plates")) {
    for (const seed of PLATE_SEEDS)
      for (const dpr of [1, 2]) {
        const url = await page.evaluate(([s, d]) => window.__draw(s, 1, { w: 360, h: 300, dpr: d }, "image/webp", 0.86), [seed, dpr]);
        write(`public/art/plates/${seed}${dpr === 2 ? "@2x" : ""}.webp`, url);
      }
  }

  if (all || want.has("key")) {
    const { seed, number } = ORTHARGEK;
    const spec = await page.evaluate(([s, n]) => window.__spec(s, n), [seed, number]);
    // the medallion: the titan large, its walled city at the centre of the disc
    const medal = await page.evaluate(([s, n]) => window.__draw(s, n, { w: 1000, h: 1000, dpr: 1, view: { cx: 0, cy: 26.6, halfH: 11.6 } }), [seed, number]);
    // the banner: the whole titan, on the right
    const full = await page.evaluate(([s, n]) => window.__draw(s, n, { w: 700, h: 560, dpr: 1, view: { cx: 0, cy: 26.4, halfH: 9.6 } }), [seed, number]);
    const fonts = `<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..800;1,400..800&family=IM+Fell+English:ital@0;1&family=UnifrakturCook:wght@700&display=block" rel="stylesheet" />`;
    const shot = async (html, w, h, rels) => {
      const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      await p.setContent(`<!doctype html><html><head><meta charset="utf-8">${fonts}</head><body style="margin:0">${html}</body></html>`, { waitUntil: "networkidle" });
      await p.evaluate(() => document.fonts.ready);
      const buf = await p.screenshot({ type: "png" });
      for (const rel of rels) write(rel, "data:image/png;base64," + buf.toString("base64"));
      await p.close();
    };
    await shot(thumbHtml(medal), 1200, 1200, ["public/art/thumb.png"]);
    await shot(ogHtml(full, spec), 1200, 630, ["public/art/og.png", "docs/cover.png"]);
  }

  if (all || want.has("blank")) {
    const svg = blankHtml();
    fs.writeFileSync(path.join(root, "public/art/medallion-blank.svg"), svg.trim() + "\n");
    console.log("public/art/medallion-blank.svg", Math.round(svg.length / 102.4) / 10 + " KB");
    const p = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
    write("public/art/medallion-blank.png", "data:image/png;base64," + (await p.screenshot({ type: "png", omitBackground: true })).toString("base64"));
    await p.close();
  }
} finally {
  await browser.close();
  await server.close();
}

// ---------------------------------------------------------------- compositions

function thumbHtml(titan) {
  return `
<div style="position:relative;width:1200px;height:1200px;overflow:hidden;background:radial-gradient(circle at 50% 42%, #6b1f16 0%, #4a120c 45%, #2a0a06 100%)">
  <div style="position:absolute;inset:34px;border:2px solid rgba(214,165,49,.75)"></div>
  <div style="position:absolute;inset:44px;border:1px solid rgba(214,165,49,.35)"></div>
  <div style="position:absolute;left:84px;top:64px;width:1032px;height:1032px;border-radius:50%;
       background:linear-gradient(160deg,#f3d27a,#b8861f 45%,#e9c46a 70%,#8a6418);box-shadow:0 18px 60px rgba(0,0,0,.6)"></div>
  <div style="position:absolute;left:100px;top:80px;width:1000px;height:1000px;border-radius:50%;background:#2a0d08"></div>
  <div style="position:absolute;left:108px;top:88px;width:984px;height:984px;border-radius:50%;overflow:hidden;
       background:radial-gradient(circle,#f3e9d3 55%,#e2d2ae);box-shadow:inset 0 0 60px rgba(90,60,20,.45)">
    <div style="position:absolute;inset:0;background:repeating-linear-gradient(-35deg,rgba(35,28,23,.06) 0 1px,transparent 1px 6px)"></div>
    <img src="${titan}" style="position:absolute;left:-8px;top:-8px;width:1000px;height:1000px">
  </div>
  <div style="position:absolute;left:0;right:0;top:968px;text-align:center;font-family:'UnifrakturCook';font-weight:700;font-size:150px;line-height:1;
       color:#f1cf74;-webkit-text-stroke:2px #3a1408;text-shadow:0 4px 0 #6b4a12,0 10px 30px rgba(0,0,0,.75),0 0 40px rgba(233,196,106,.35)">Worldbeast</div>
</div>`;
}

function ogHtml(titan, spec) {
  return `
<div style="position:relative;width:1200px;height:630px;overflow:hidden;font-family:'EB Garamond',serif;color:#231c17;
     background:radial-gradient(ellipse at 70% 40%,#f6eed9,#ece0c3 70%,#e2d3b0)">
  <div style="position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(35,28,23,.035) 0 1px,transparent 1px 5px)"></div>
  <div style="position:absolute;inset:12px;border:3px double #2b4a8b"></div>
  <div style="position:absolute;inset:30px;border:2px solid #c8321f"></div>
  <div style="position:absolute;left:76px;top:122px;width:500px">
    <div style="font-family:'UnifrakturCook';font-weight:700;font-size:100px;line-height:1">Worldbeast</div>
    <div style="font-style:italic;color:#c8321f;font-size:37px;line-height:1.22;margin-top:30px">One titan. Everyone online.<br>The same moment.</div>
    <div style="font-size:23px;line-height:1.45;margin-top:30px;color:#3a2e24">A living bestiary. Dodge its ink on the beat of its own song, and strike its gold wounds with hunters worldwide.</div>
  </div>
  <img src="${titan}" style="position:absolute;right:40px;top:36px;width:620px;height:496px">
  <div style="position:absolute;right:40px;bottom:50px;width:620px;text-align:center;font-family:'IM Fell English';font-style:italic;font-size:22px;color:#5a4636">
    ${spec.name}, ${spec.epithet} &middot; the first titan
  </div>
</div>`;
}

// a blank engraved vellum disc with the Worldbeast sigil, cut in the same hand as the titans (no titan in it)
function blankHtml() {
  const rings = Array.from({ length: 34 }, (_, i) => `<circle cx="300" cy="300" r="${40 + i * 7.6}" />`).join("");
  return `
<svg width="600" height="600" viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The Worldbeast sigil on a blank engraved plate">
  <defs>
    <radialGradient id="v" cx="50%" cy="50%" r="50%"><stop offset="58%" stop-color="#f3e9d3"/><stop offset="100%" stop-color="#e2d2ae"/></radialGradient>
    <clipPath id="c"><circle cx="300" cy="300" r="300"/></clipPath>
    <pattern id="h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="6" height="6" fill="none"/><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(35,28,23,.07)" stroke-width="1.2"/></pattern>
  </defs>
  <g clip-path="url(#c)">
    <rect width="600" height="600" fill="url(#v)"/>
    <rect width="600" height="600" fill="url(#h)"/>
    <g fill="none" stroke="rgba(35,28,23,.085)" stroke-width="1">${rings}</g>
    <g transform="translate(300 300) scale(4.6) translate(-32 -32)" opacity=".5">
      <path d="M32 10 L37 26 L54 32 L37 38 L32 54 L27 38 L10 32 L27 26 Z" fill="#d6a531" stroke="#231c17" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M32 14 L32 50 M14 32 L50 32" stroke="#231c17" stroke-width=".5" opacity=".55"/>
      <circle cx="32" cy="32" r="5" fill="#c8321f" stroke="#231c17" stroke-width="1.2"/>
    </g>
    <circle cx="300" cy="300" r="296" fill="none" stroke="rgba(90,60,20,.25)" stroke-width="8"/>
  </g>
</svg>`;
}

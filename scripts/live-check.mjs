// Live two-browser check of the world actor on the deployed site.
//   node scripts/live-check.mjs [--site URL] [--session world-check] [--no-build]
// Playwright: resolved from node_modules, or set PW_MODULE to a playwright package path.
// By default it uses a test session ("world-check"): same actor code, its own titan, and no
// Titan/Run/Hunter writes (only an Echo keyed by the test titan's seed). It also connects one
// silent client to world-1 to confirm the real titan's record exists.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const appId = (readFileSync(join(root, "base44/.app.jsonc"), "utf8").match(/"id"\s*:\s*"([^"]+)"/) || [])[1];
const SITE = arg("--site", process.env.WB_SITE || `https://worldbeast-${appId.slice(-8)}.base44.app`);
const SESSION = arg("--session", "world-check");

if (!process.argv.includes("--no-build")) execSync("npx vite build --config scripts/netcheck/vite.config.mjs", { cwd: root, stdio: "inherit" });
const bundle = readFileSync(join(root, "scripts/netcheck/dist/netcheck.js"), "utf8");

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || "playwright");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openClient(browser, label, sigil, session = SESSION) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, e.message));
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    ({ appId, session, label, sigil }) => {
      const WB = window.WB;
      const client = WB.createClient({ appId, serverUrl: "", requiresAuth: false });
      const w = new WB.World({ client, session });
      window.__c = client;
      window.__w = w;
      window.__acks = [];
      window.__revives = [];
      window.__runs = [];
      w.events.onAck = (ok, bad, why) => window.__acks.push({ ok, bad, why, at: performance.now() });
      w.events.onRevive = (e) => window.__revives.push(e);
      w.connect();
      if (label) w.setIdentity({ name: label, sigil, aspect: "ember" });
      // fly: a circle until told otherwise
      window.__fly = { cx: sigil === 3 ? -3 : 3, cy: 6, r: 1.5, line: null, alive: true };
      window.__jit = { last: performance.now(), max: 0 };
      window.__flyTimer = setInterval(() => {
        const j = window.__jit, nowj = performance.now();
        j.max = Math.max(j.max, nowj - j.last);
        j.last = nowj;
        const f = window.__fly;
        const t = performance.now() / 1000;
        let x, y;
        if (f.line) {
          const k = Math.min(1, (performance.now() - f.line.t0) / f.line.ms);
          x = f.line.x0 + (f.line.x1 - f.line.x0) * k;
          y = f.line.y0 + (f.line.y1 - f.line.y0) * k;
        } else {
          x = f.cx + Math.cos(t * 2) * f.r;
          y = f.cy + Math.sin(t * 2) * f.r;
        }
        f.x = x;
        f.y = y;
        if (label) w.sendPos(x, y, f.alive, 0);
      }, 50);
    },
    { appId, session, label, sigil },
  );
  return { ctx, page, label };
}

const ev = (c, fn, a) => c.page.evaluate(fn, a);

async function waitFor(c, fn, ms, a) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(c, fn, a)) return true;
    await sleep(150);
  }
  return false;
}

// send n valid hits of `dmg` (only while some core is open, at the current beat)
const validHits = (c, n, dmg) =>
  ev(
    c,
    async ({ n, dmg }) => {
      const w = window.__w, WB = window.WB;
      let sent = 0;
      const t0 = performance.now();
      while (sent < n && performance.now() - t0 < 30000) {
        const b = w.titanTime() / w.spec.beat;
        const core = w.spec.cores.findIndex((c) => WB.coreOpen(c, b, w.stage) && WB.coreOpen(c, b + 0.8, w.stage));
        if (core >= 0) {
          w.addHit(core, dmg, b);
          sent++;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      w.flushHits();
      return sent;
    },
    { n, dmg },
  );

// raw hit message, resolves with its ack
const rawHit = (c, kind) =>
  ev(
    c,
    async (kind) => {
      const w = window.__w, WB = window.WB;
      const before = window.__acks.length;
      let b = w.titanTime() / w.spec.beat;
      for (let i = 0; i < 200; i++) {
        const open = w.spec.cores.findIndex((c) => WB.coreOpen(c, b, w.stage) && WB.coreOpen(c, b + 0.8, w.stage));
        const closed = w.spec.cores.findIndex((c) => !WB.coreOpen(c, b, 2) && !WB.coreOpen(c, b + 0.8, 2));
        const need = kind === "closed" ? closed : open;
        if (need >= 0) {
          const rows = {
            closed: [[closed, 5, b]],
            beat: [[open, 5, b + 10]],
            nan: [[open, null, b]],
            negative: [[open, -5, b]],
            huge: [[open, 99999, b]],
            core: [[42, 5, b]],
            flood: Array.from({ length: 64 }, () => [open, 200, b]),
          }[kind];
          w.debugSend({ t: "hit", hits: rows });
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
        b = w.titanTime() / w.spec.beat;
      }
      const t0 = performance.now();
      while (window.__acks.length === before && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 30));
      return window.__acks[before] ?? null;
    },
    kind,
  );

const browser = await chromium.launch({ headless: true });
try {
  console.log(`site ${SITE}  session ${SESSION}`);
  const A = await openClient(browser, "netcheck A", 3);
  const B = await openClient(browser, "netcheck B", 9);

  const online = await Promise.all([A, B].map((c) => waitFor(c, () => window.__w.mode === "online", 15000)));
  check("both clients connect anonymously and get a welcome", online.every(Boolean), online.join(","));
  if (!online.every(Boolean)) throw new Error("not online");
  const titan = await ev(A, () => ({ ...window.__w.titan, name: window.__w.spec.name, hp: window.__w.hp }));
  console.log(`titan #${titan.number} ${titan.name} seed ${titan.seed} hp ${titan.hp}/${titan.hpMax} t=${(await ev(A, () => window.__w.titanTime())).toFixed(1)}s`);

  const ids = { A: await ev(A, () => window.__w.you), B: await ev(B, () => window.__w.you) };
  const seesA = await waitFor(B, (id) => window.__w.remoteHunters().some((h) => h.id === id), 6000, ids.A);
  const seesB = await waitFor(A, (id) => window.__w.remoteHunters().some((h) => h.id === id), 6000, ids.B);
  check("each client sees the other hunter move", seesA && seesB, `A=${ids.A} B=${ids.B}`);
  const named = await ev(A, (id) => window.__w.roster.get(id)?.name, ids.B);
  check("roster carries the other hunter's name", named === "netcheck B", String(named));
  const posErr = await Promise.all([
    ev(A, (id) => {
      const h = window.__w.remoteHunters().find((h) => h.id === id);
      return h ? { x: h.x, y: h.y } : null;
    }, ids.B),
    ev(B, () => ({ x: window.__fly.x, y: window.__fly.y })),
  ]);
  if (posErr[0]) console.log(`B as seen by A (120 ms interpolated): ${posErr[0].x.toFixed(2)},${posErr[0].y.toFixed(2)}  B actual ${posErr[1].x.toFixed(2)},${posErr[1].y.toFixed(2)}`);

  await sleep(3000); // pings settle
  const diffs = [];
  for (let i = 0; i < 7; i++) {
    const [a, b] = await Promise.all([ev(A, () => window.__w.serverNow() - Date.now()), ev(B, () => window.__w.serverNow() - Date.now())]);
    diffs.push(a - b);
    await sleep(200);
  }
  diffs.sort((x, y) => x - y);
  const agree = diffs[3];
  const rtt = { A: await ev(A, () => window.__w.rtt), B: await ev(B, () => window.__w.rtt) };
  check("clock offsets agree within 30 ms", Math.abs(agree) <= 30, `median A-B ${agree.toFixed(1)} ms (spread ${diffs[0].toFixed(1)}..${diffs[6].toFixed(1)})`);
  console.log(`RTT median A ${rtt.A.toFixed(0)} ms, B ${rtt.B.toFixed(0)} ms`);

  // ---- valid hits from both
  const hp0 = await ev(A, () => window.__w.hp);
  const ackStart = { A: await ev(A, () => window.__acks.length), B: await ev(B, () => window.__acks.length) };
  const [sentA, sentB] = await Promise.all([validHits(A, 8, 5), validHits(B, 8, 7)]);
  await sleep(1500);
  const okSum = async (c, from) => ev(c, (from) => window.__acks.slice(from).reduce((s, a) => s + a.ok, 0), from);
  const badSum = async (c, from) => ev(c, (from) => window.__acks.slice(from).reduce((s, a) => s + a.bad, 0), from);
  const okA = await okSum(A, ackStart.A), okB = await okSum(B, ackStart.B);
  const badV = (await badSum(A, ackStart.A)) + (await badSum(B, ackStart.B));
  check("valid hits are accepted", okA === sentA * 5 && okB === sentB * 7 && badV === 0, `A ${okA}/${sentA * 5}, B ${okB}/${sentB * 7}, rejected ${badV}`);
  const [hpA, hpB] = [await ev(A, () => window.__w.hp), await ev(B, () => window.__w.hp)];
  check("hp falls by exactly the accepted damage, identically for both", hpA === hpB && hp0 - hpA === okA + okB, `hp ${hp0} -> A ${hpA} / B ${hpB} (accepted ${okA + okB})`);

  // ---- invalid hits from A
  const hpBefore = await ev(A, () => window.__w.hp);
  for (const [kind, want] of [["closed", "closed"], ["beat", "beat"], ["nan", "bad"], ["negative", "bad"], ["huge", "bad"], ["core", "bad"]]) {
    const ack = await rawHit(A, kind);
    check(`invalid hit (${kind}) is rejected`, ack && ack.ok === 0 && ack.bad === 1 && ack.why === want, JSON.stringify(ack));
  }
  await sleep(400);
  const hpAfter = [await ev(A, () => window.__w.hp), await ev(B, () => window.__w.hp)];
  check("rejected hits leave hp untouched", hpAfter[0] === hpBefore && hpAfter[1] === hpBefore, `${hpBefore} -> ${hpAfter.join("/")}`);
  const flood = await rawHit(A, "flood");
  check("a 12,800-damage burst is cut to the 2 s rate budget", flood && flood.bad > 0 && flood.why === "rate" && flood.ok <= 4900, JSON.stringify(flood));
  await sleep(500);
  const hpFlood = [await ev(A, () => window.__w.hp), await ev(B, () => window.__w.hp)];
  check("both clients agree on hp after the burst", hpFlood[0] === hpFlood[1] && hpBefore - hpFlood[0] === flood.ok, `${hpFlood.join("/")}`);

  // ---- down and revive
  const spot = await ev(A, () => {
    window.__fly.alive = false;
    window.__fly.cx = window.__fly.x;
    window.__fly.cy = window.__fly.y;
    window.__fly.r = 0;
    window.__w.sendDown(window.__fly.x, window.__fly.y);
    return { x: window.__fly.x, y: window.__fly.y };
  });
  const sparkSeen = await waitFor(B, (id) => window.__w.sparks.has(id), 3000, ids.A);
  check("B sees A's downed spark", sparkSeen);
  await ev(B, (s) => (window.__fly.line = { x0: s.x - 2.5, y0: s.y + 0.3, x1: s.x + 2.5, y1: s.y + 0.3, t0: performance.now(), ms: 1200 }), spot);
  const revived = await waitFor(A, () => window.__revives.some((r) => r.me), 5000);
  const rv = await ev(A, () => window.__revives[0]);
  check("B flying through the spark revives A", revived, JSON.stringify(rv));
  if (!revived) console.log("debug", JSON.stringify({ spot, B: await ev(B, () => ({ fly: window.__fly, sparks: [...window.__w.sparks.values()], you: window.__w.you, revives: window.__revives })), A: await ev(A, () => ({ you: window.__w.you, revives: window.__revives, mode: window.__w.mode, jitter: window.__jit })) }));
  await ev(A, () => (window.__fly.alive = true));
  await ev(B, () => (window.__fly.line = null));

  // ---- a run: claims far more than landed, carries a 24 s path
  const run = await ev(A, async () => {
    const w = window.__w;
    const now = w.titanTime();
    const startT = Math.max(0, now - 25);
    const time = Math.min(24, now - startT - 0.5);
    const path = [];
    for (let i = 0; i < Math.floor(time * 10); i++) path.push(Math.round((-3 + Math.cos(i / 10) * 1.5) * 20), Math.round((6 + Math.sin(i / 10) * 1.5) * 20));
    return w.sendRun({ damage: 1e6, time, grazes: 12, bestCombo: 9, surges: 0, aspect: "ember", startT, stage: w.stage, path });
  });
  const landedA = await ev(A, () => window.__acks.reduce((s, a) => s + a.ok, 0));
  check("a run claiming 1,000,000 is clamped to what landed", run && run.clamped && run.damage <= landedA + 60, JSON.stringify(run) + ` landed ${landedA}`);
  check("the run's path is stored as an echo", run && run.echo === true);
  const echoRows = await ev(A, async () => {
    const w = window.__w;
    let rows = [];
    for (let i = 0; i < 20 && !rows.length; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      rows = await window.__c.entities.Echo.filter({ titanSeed: w.titanSeed }, "-created_date", 10);
    }
    return rows.map((r) => ({ phrase: r.phrase, loopBeat: r.loopBeat, stage: r.stage, duration: r.duration, len: r.path.length, name: r.name }));
  });
  check("the echo is readable anonymously from the Echo entity", echoRows.length > 0, JSON.stringify(echoRows[0] ?? null));

  // ---- leave
  await B.ctx.close();
  const left = await waitFor(A, (id) => !window.__w.roster.has(id), 5000, ids.B);
  check("A sees B leave", left);

  // ---- the real world: a silent client confirms the titan and its record
  const W = await openClient(browser, null, 0, "world-1");
  const wOnline = await waitFor(W, () => window.__w.mode === "online", 15000);
  const real = wOnline ? await ev(W, () => ({ ...window.__w.titan, hp: window.__w.hp, name: window.__w.spec.name })) : null;
  await sleep(1500);
  const rec = await ev(W, async (n) => (await window.__c.entities.Titan.filter({ number: n }, "-created_date", 1))[0] ?? null, real?.number ?? 1);
  check("world-1 is live and its Titan record exists", wOnline && rec && rec.seed === real.seed, real ? `#${real.number} ${real.name} hp ${real.hp}/${real.hpMax}` : "offline");
  await W.ctx.close();
  await A.ctx.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; RTT A ${rtt.A.toFixed(0)} ms B ${rtt.B.toFixed(0)} ms; clock agreement ${agree.toFixed(1)} ms`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("live check aborted:", e.message);
  process.exitCode = 2;
} finally {
  await browser.close();
}

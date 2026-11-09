import * as THREE from "three";
import { ARENA, coreOpen, makeTitan, PHRASE_BEATS, LOOP_PHRASES, Stage, stageFor, TitanSpec } from "@/core/titan";
import { Field, FieldFrame, newFrame, STRIDE } from "@/core/field";
import { AspectId, Hunt, MAX_HITS } from "@/core/hunt";
import { applyCam, camRect, createView, lerpCam, layoutView, Mode, PAGE, Rect, sizeView, toScreen, View } from "./render/stage";
import { PageLayer } from "./render/page";
import { InkLayer } from "./render/ink";
import { Titan, TitanCtx } from "./render/titan/titan";
import { HunterDraw, HunterLayer } from "./render/hunters";
import { FxLayer, P } from "./render/fx";
import { Input } from "./input";
import { Bot } from "@/core/bot/bot";
import { setPortraitHost } from "./portrait";

// The conductor: one synced clock, one titan, your run, everyone else's sparks, the page.

export type Phase = "lobby" | "playing" | "down" | "replay";

/**
 * A titan's fall, in seconds from the killing blow: its death beat (it sags and shudders on the beat while ink
 * bleeds down the page), the FELLED stamp slamming onto the body (SLAM, on the felled peal's chord), its colour
 * draining to bare lines, the plate held under the stamp, then torn away (RELEASE..GONE) before the next titan
 * is engraved in. The stamp in the DOM (Hunt.jsx, index.css .felled-stamp) keeps the same clock.
 */
export const FALL = { SLAM: 1.6, DRAIN: 1.1, RELEASE: 5.6, LIFT: 1.2, GONE: 6.8 };
const fallReveal = (f: number) => (f < FALL.SLAM ? 3 : f < FALL.SLAM + FALL.DRAIN ? 3 - (2 * (f - FALL.SLAM)) / FALL.DRAIN : f < FALL.RELEASE ? 1 : Math.max(0, 1 - (f - FALL.RELEASE) / FALL.LIFT));
/** after a frame gap this long during a run (a hitch: GC, a busy GPU, a notification) the light is spared a moment */
const HITCH_S = 0.3;
const HITCH_GRACE = 0.5;

export interface Others {
  /** live hunters and echoes to draw (positions in arena units) */
  list(t: number): HunterDraw[];
}

export interface HudState {
  phase: Phase;
  hits: number;
  maxHits: number;
  resonance: number;
  surging: boolean;
  damage: number;
  combo: number;
  grazes: number;
  dashReady: number; // 0..1
  stage: Stage;
  beat: number;
  phrase: number;
  time: number;
  coresOpen: number;
  surges: number;
  bestCombo: number;
  /** the longest stretch unstruck so far, s */
  clean: number;
}

export interface GameEvents {
  onHud?(h: HudState): void;
  onHits?(dmg: number, core: number, beat: number, surge?: boolean): void; // local damage dealt (to send to the world)
  onDown?(summary: RunSummary): void;
  onSfx?(name: string, x?: number, strength?: number): void;
  onFloat?(text: string, x: number, y: number, kind: "dmg" | "graze" | "info"): void;
  /** the layout settled (once per change: never during a camera move) */
  onLayout?(l: Layout): void;
  /**
   * while the camera leans in or out: how screen positions from the last layout map to the screen now
   * (x' = x * s + tx, y' = y * s + ty), so DOM overlays can follow with a CSS transform. dir: +1 in, -1 out.
   */
  onCamera?(m: { s: number; tx: number; ty: number; dir: number; k: number }): void;
  /** every frame while a run is live: send your position to the world */
  onPos?(x: number, y: number, alive: boolean, flags: number): void;
  /** every frame: drive the music */
  onFrame?(t: number, stage: Stage, hpFrac: number, playing: boolean, nearDanger: number): void;
  /** a new titan was built (rebuild the song) */
  onTitan?(spec: TitanSpec, field: Field): void;
}

export interface Layout {
  /** the open codex (wide screens) */
  spread: boolean;
  portrait: boolean;
  /** spread | side (a short landscape screen) | single (a tall screen) */
  mode: Mode;
  /** the camera leans in on the fight (a run is live): in spread mode the left leaf is folded to a strip */
  focus: boolean;
  pxPerUnit: number;
  /** CSS-pixel rects of the leaves (left is null when not in spread mode; the strip while folded) */
  left: { x: number; y: number; w: number; h: number } | null;
  right: { x: number; y: number; w: number; h: number };
  arena: { x: number; y: number; w: number; h: number };
  /** CSS pixels kept clear along the bottom (single mode) */
  reserve: number;
  vw: number;
  vh: number;
}

export interface RunSummary {
  damage: number;
  time: number;
  grazes: number;
  bestCombo: number;
  surges: number;
  aspect: AspectId;
  path: number[]; // quantised x,y at 10 Hz for the echo
  startT: number; // titan time when the run began
  stage: Stage;
  felled?: boolean; // the run ended because the world felled the titan
  cleanTime?: number;
  finalBlow?: boolean;
  killer?: string;
}

export class Game {
  view: View;
  page: PageLayer;
  ink: InkLayer;
  hunters: HunterLayer;
  fx: FxLayer;
  titan!: Titan;
  spec!: TitanSpec;
  field!: Field;
  input: Input;
  phase: Phase = "lobby";
  hunt: Hunt | null = null;
  events: GameEvents = {};
  others: Others | null = null;
  /** seconds since the current titan woke, as agreed with the world */
  clock: () => number = () => performance.now() / 1000;
  hpFrac = 1;
  quality = 1;
  reducedMotion = false;
  /** the codex is still closed: keep the titan unengraved until it opens */
  holdReveal = false;
  /** demo / attract mode: a look-ahead bot plays your run */
  autopilot: Bot | null = null;

  private canvas: HTMLCanvasElement;
  private raf = 0;
  private last = 0;
  private shake = 0;
  private hurtFlash = 0;
  private titanHurt = 0;
  private coreHit: number[] = [];
  private target = { x: 0, y: 3 };
  private pathAcc = 0;
  private path: number[] = [];
  private runStart = 0;
  private hudT = 0;
  private lastHurt = 0;
  private lastSurges = 0;
  private lastRelights = 0;
  private lastBeatInt = -1;
  private frameTimes: number[] = [];
  private cssW = 1;
  private cssH = 1;
  /** seconds since this titan was first drawn: drives the engraving-in sequence */
  private revealT = 0;
  /**
   * The lean-in: the camera glides between the whole book (0) and the fight (1). Only the projection
   * moves while it does; the backing store, the baked paper and the DOM layout change once, at the end.
   */
  private fz = { from: 0, to: 0, t: 1, dur: 1 };
  /** where the camera is now, 0..1 (eased) */
  private camAt = 0;
  private focusPhase: Phase = "lobby";
  private downHold = 0;
  /** the camera rect when the layout was last handed to the DOM */
  private layoutRect: Rect = { x0: 0, x1: 1, y0: 0, y1: 1 };
  private qualityAt = 0;
  /** frame-time samples are ignored until then (camera moves, resizes, the first frames) */
  private quietUntil = 0;
  private slowWindows = 0;
  private paperSpec: Parameters<PageLayer["bake"]>[1] | null = null;
  /** the paper's programs are linked (until then nothing is drawn) */
  private pageReady = false;
  /** every program is linked off the main thread; until then only the paper is drawn, so nothing stalls */
  private compiled = false;
  /** Join was pressed while the titan was still being engraved: finish it quickly */
  private rushReveal = false;
  private fallT = -1;
  /** how far the titan is drawn below its place now (the run's view lowers it; see stage.ts RUN_DROP) */
  drop = 0;
  /** each dart's distance to its wound when first drawn (to bend its streak onto the lowered titan) */
  private dartFrom = new WeakMap<object, number>();
  /** frames of the off-page warm-up draw done (see frame) */
  private warmed = 0;
  private ro: ResizeObserver;
  private safeBottom = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.view = createView(canvas);
    this.page = new PageLayer(this.view.scene);
    this.ink = new InkLayer(this.view.scene);
    this.hunters = new HunterLayer(this.view.scene);
    this.fx = new FxLayer(this.view.scene);
    this.input = new Input(canvas, (dx, dy) => ({ x: dx * this.view.unitsPerPx, y: -dy * this.view.unitsPerPx }));
    this.reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const r = this.view.renderer;
    // Ask for every extension three will look up later now, while the GPU process is idle: a first
    // lookup is a synchronous round trip, and behind a queue of shader links it waited 370 ms.
    for (const x of ["EXT_texture_filter_anisotropic", "WEBGL_multisampled_render_to_texture", "EXT_color_buffer_float", "EXT_color_buffer_half_float", "OES_texture_float_linear", "EXT_float_blend", "WEBGL_render_shared_exponent", "KHR_parallel_shader_compile"]) {
      try {
        r.extensions.has(x);
      } catch {}
    }
    // the paper's two programs first (small): the desk and the leaves can show while the titan's link
    const pageDone = () => {
      if (this.pageReady) return;
      this.primePrograms();
      this.pageReady = true;
    };
    try {
      Promise.all([this.page.compileBake(r), r.compileAsync(this.page.mesh, this.view.camera, this.view.scene)]).then(pageDone, pageDone);
    } catch {
      pageDone();
    }
    setTimeout(pageDone, 1500);
    // the cover medallion and share cards are drawn by this renderer (no second WebGL context)
    setPortraitHost({ renderer: r, ready: () => this.untilReady(), titanFor: (seed) => (this.spec?.seed === seed && this.titan ? this.titan : null) });
    this.resize();
    window.addEventListener("resize", this.resize);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }
  private onVisibility = () => {
    this.quietUntil = performance.now() + 1500;
  };

  /** the titan's programs are warm: Join can be pressed (the engraving may still be finishing) */
  get ready() {
    return !!this.spec && this.compiled;
  }
  /**
   * Read every linked program's uniform and attribute tables now, before any of them draws. These reads
   * are synchronous; done mid-frame they each waited behind the draws queued before them (the GPU builds
   * its shader variants at first draw), which made the first full frame a 600 ms freeze.
   */
  private primePrograms(list = this.programList(), budgetMs = Infinity) {
    const t0 = performance.now();
    while (list.length && performance.now() - t0 < budgetMs) {
      const p = list.shift()!;
      try {
        p.getUniforms();
        p.getAttributes();
      } catch {}
    }
    return list.length === 0;
  }
  private programList() {
    const progs = (this.view.renderer.info.programs || []) as unknown as Array<{ isReady?: () => boolean; getUniforms(): unknown; getAttributes(): unknown }>;
    return progs.filter((p) => !p.isReady || p.isReady());
  }
  private primeQueue: ReturnType<Game["programList"]> | null = null;
  /** a slice of program priming per frame; when it is all done, the titan may draw */
  private primeStep() {
    if (!this.primeQueue) return;
    if (!this.primePrograms(this.primeQueue, 6)) return;
    this.primeQueue = null;
    this.compiled = true;
    for (const w of this.whenReady.splice(0)) w();
  }
  private compileToken: object = {};
  private whenReady: Array<() => void> = [];
  /** resolves once the titan's programs are linked */
  untilReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((r) => this.whenReady.push(r));
  }

  setTitan(seed: number, number: number) {
    if (this.spec?.seed === seed) return;
    // the old titan leaves the page now but is disposed only once the new one's programs are compiled: the
    // titans share their programs (the engraving's settings are uniforms), and disposing first would throw them
    // away for the new titan to build again
    let retired: Titan | null = null;
    if (this.titan) {
      if (this.fallT >= 0 && this.fallT < FALL.GONE && !this.kept) {
        // a felled titan stays on the page through its death and the stamp (FALL), then its plate tears away
        // and this one is engraved in; it is built and compiled behind it meanwhile
        this.kept = this.titan;
        this.keptT = this.fallT;
      } else {
        this.view.scene.remove(this.titan.group);
        retired = this.titan;
      }
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      retired?.dispose();
    };
    this.spec = makeTitan(seed, number);
    this.field = new Field(this.spec);
    // (built ahead in an idle moment after a fall when the world named the next titan: see prebuild)
    const pre = this.prebuilt?.spec.seed === seed && this.prebuilt.spec.number === number ? this.prebuilt : null;
    if (this.prebuilt && !pre) this.prebuilt.dispose();
    this.prebuilt = null;
    this.titan = pre ?? new Titan(this.spec);
    this.titan.u.uReveal.value = 0;
    this.revealT = 0;
    this.fallT = -1;
    this.view.scene.add(this.titan.group);
    this.ink.hush(false);
    this.rushReveal = false;
    // warm every program off the main thread where the browser allows it (KHR_parallel_shader_compile).
    // Nothing but the paper is drawn until they are linked, so the first use never blocks.
    const token = (this.compileToken = {});
    const done = () => {
      settle();
      if (this.compileToken !== token || this.compiled || this.primeQueue) return;
      // read the linked programs' tables a few per frame (see primeStep), then draw the titan
      this.primeQueue = this.programList();
    };
    this.compiled = false;
    this.primeQueue = null;
    try {
      const r = this.view.renderer;
      if (this.kept) {
        // (compile only collects visible objects: show the hidden titan for the moment it is collected)
        const g = this.titan.group;
        g.visible = true;
        const p = r.compileAsync(g, this.view.camera, this.view.scene);
        g.visible = false;
        p.then(done, done);
      } else r.compileAsync(this.view.scene, this.view.camera).then(done, done);
    } catch {
      done();
    }
    setTimeout(done, 4000); // never wait longer than this
    this.resize();
    const p = this.spec.plate;
    this.page.setPlate(p);
    this.ink.setPlate(p);
    this.hunters.setGold(p.gold, p.ink);
    this.fx.setPlate(p.gold, p.accent, p.accent2, p.ink);
    this.coreHit = this.spec.cores.map(() => 0);
    this.hunt = null;
    this.phase = "lobby";
    this.events.onTitan?.(this.spec, this.field);
  }

  /** a felled titan kept on the page while the next one is built behind it, and how long since it fell */
  private kept: Titan | null = null;
  private keptT = 0;
  /** the next titan, built in an idle moment after a fall (setTitan takes it when the world names it) */
  private prebuilt: Titan | null = null;
  private prebuildTimer = 0;
  /** a felled titan is on the page (its death, the stamp, the plate tearing away) */
  get keeping() {
    return !!this.kept || (this.fallT >= 0 && this.fallT < FALL.GONE);
  }
  /** told when the felled titan has left the page (the next is being engraved) */
  onFelledGone: (() => void) | null = null;
  /** hurry the felled titan away (Hunt again, Rest): its plate tears now rather than after the stamp */
  releaseFelled() {
    if (this.kept) this.keptT = Math.max(this.keptT, FALL.RELEASE);
    else if (this.fallT >= 0 && this.fallT < FALL.RELEASE) this.fallT = FALL.RELEASE;
  }
  /** the felled plate is gone: dispose it, and engrave the next titan in */
  private dropKept() {
    const k = this.kept;
    if (!k) return;
    this.kept = null;
    this.view.scene.remove(k.group);
    k.dispose();
    if (this.titan) {
      this.titan.group.visible = true;
      this.titan.u.uReveal.value = 0;
    }
    this.revealT = 0;
    this.onFelledGone?.();
  }
  /**
   * Build the next titan ahead, when the main thread is idle and the fall's death beat has played (its geometry
   * is ~65 ms of work on a laptop, several times that on a busy phone: never inside the fall's own frames).
   */
  prebuild(seed: number, number: number) {
    if (!Number.isFinite(seed) || this.spec?.seed === seed || this.prebuilt?.spec.seed === seed) return;
    clearTimeout(this.prebuildTimer);
    const build = () => {
      if (this.spec?.seed === seed || this.prebuilt?.spec.seed === seed) return;
      this.prebuilt?.dispose();
      this.prebuilt = new Titan(makeTitan(seed, number));
    };
    const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    this.prebuildTimer = window.setTimeout(() => (ric ? ric(build, { timeout: 1200 }) : build()), (FALL.SLAM + 0.5) * 1000);
  }

  /** the world felled the titan: it shudders, its seams flood with gold, then the engraving lifts away */
  fell() {
    if (this.fallT >= 0) return;
    this.fallT = 0;
    this.shake = 1.2;
    this.events.onSfx?.("felled");
    // the ink still in flight dissolves into flecks: the stamp never lands over falling drops
    const f = this.hunt && this.phase === "playing" ? this.hunt.frame : this.lobbyFrame;
    const n = Math.min(f.bulletCount, 180);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE.B;
      this.fx.burst(f.bullets[o], f.bullets[o + 1], 1, { type: P.Fleck, size: 0.1, speed: 2.5, life: 0.7, g: -1.5 });
    }
    // (the drops still drawn fade off the page; nothing new is thrown)
    this.ink.hush(true);
    const h = this.hunt;
    if (h && this.phase === "playing" && h.alive) {
      // your run ends with the titan: a victory, not a death
      h.alive = false;
      this.phase = "down";
      this.events.onDown?.(this.summaryOf(h, this.stage, true));
    }
  }
  /** the run as it stands (used when the page is closed mid-run) */
  currentSummary(): RunSummary | null {
    const h = this.hunt;
    return h && this.phase === "playing" ? this.summaryOf(h, this.stage, false) : null;
  }

  /** play back a recorded run against the same titan at the same moments (ghost links) */
  startReplay(r: { stage: Stage; startT: number; duration: number; path: number[]; sigil: number }) {
    const t0 = performance.now();
    const loop = r.duration + 2.5;
    this.stageFn = () => r.stage;
    this.clock = () => r.startT + ((performance.now() - t0) / 1000) % loop;
    const n = r.path.length / 2;
    const ghost = { x: 0, y: 3, kind: 0 as const, hue: r.sigil / 16, inv: 0, dash: 0, surge: 0, seed: 0.5 };
    this.replayPos = (t: number) => {
      const k = (t - r.startT) * 10;
      if (k < 0 || k > n - 1) return null;
      const i = Math.floor(k),
        f = k - i;
      const j = Math.min(n - 1, i + 1);
      ghost.x = (r.path[i * 2] * (1 - f) + r.path[j * 2] * f) / 20;
      ghost.y = (r.path[i * 2 + 1] * (1 - f) + r.path[j * 2 + 1] * f) / 20;
      return ghost;
    };
    this.others = { list: (t: number) => {
      const gpos = this.replayPos?.(t);
      return gpos ? [gpos] : [];
    } };
    this.phase = "replay";
    this.skipReveal();
  }
  replayPos: ((t: number) => { x: number; y: number } | null) | null = null;

  /** someone flew through your spark: rise again */
  revive() {
    const h = this.hunt;
    if (!h || this.phase !== "down" || this.fallT >= 0) return false;
    h.revive();
    this.phase = "playing";
    this.lastHurt = h.hurtEvents;
    this.fx.ring(h.x, h.y, 3, 0, 0.7);
    this.fx.burst(h.x, h.y, 30, { type: P.Fleck, size: 0.14, speed: 7, life: 1, g: 2 });
    this.events.onSfx?.("revive", h.x);
    return true;
  }

  private summaryOf(h: Hunt, stage: Stage, felled: boolean): RunSummary {
    return { damage: h.damage, time: h.time, grazes: h.grazeCount, bestCombo: h.bestCombo, surges: h.surges, aspect: h.aspect.id, path: this.path.slice(), startT: this.runStart, stage, felled, cleanTime: h.cleanBest, killer: h.lastHitKind };
  }
  get falling() {
    return this.fallT >= 0;
  }

  get revealing() {
    return this.revealT < 3.8;
  }
  skipReveal() {
    this.revealT = 6;
    if (this.titan) this.titan.u.uReveal.value = 3;
  }

  /** the world decides the stage when online; otherwise it follows the wounds */
  stageFn: (() => Stage) | null = null;
  get stage(): Stage {
    return this.stageFn ? this.stageFn() : stageFor(this.hpFrac);
  }

  setAutopilot(on: boolean, greed = 0.6) {
    this.autopilot = on && this.field ? new Bot(this.field, 1, greed) : null;
  }

  start(aspect: AspectId, opts: { resonance?: number; gentle?: boolean; forgiving?: boolean } = {}) {
    // (forgiving: a rehearsal, where a hit costs Resonance instead of a light)
    this.hunt = new Hunt(this.spec, this.field, aspect, { forgiving: opts.forgiving });
    if (opts.resonance) this.hunt.resonance = opts.resonance;
    if (opts.gentle) {
      this.hunt.houndsAfter = 20;
      this.hunt.invuln = 4;
    }
    // a spawn point that stays clear through the grace and two beats more (deterministic for this seed and moment)
    this.hunt.place(this.clock(), this.stage);
    this.target = { x: this.hunt.x, y: this.hunt.y };
    this.lastRelights = 0;
    this.phase = "playing";
    this.path = [];
    this.pathAcc = 0;
    this.runStart = this.clock();
    this.lastHurt = 0;
    this.lastSurges = 0;
    // joined while the titan was still being engraved: finish the engraving in a moment (spawn grace covers it)
    if (this.revealing) this.rushReveal = true;
    this.events.onSfx?.("start");
  }

  run() {
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // (the quality judge sees the real frame time, to tell an isolated stall from a slow machine)
      const raw = Math.max(0, (now - this.last) / 1000);
      const dt = Math.min(0.05, raw);
      this.last = now;
      // the world's clock ran on through the gap but your light did not move: spare it for a moment, so a
      // hitch is never what kills you (a hidden tab's pause is not a hitch: the run is reported then)
      if (raw > HITCH_S && raw < 3 && this.phase === "playing" && this.hunt?.alive) {
        const h = this.hunt;
        h.invuln = Math.max(h.invuln, HITCH_GRACE + dt);
        this.fx.ring(h.x, h.y, 1.5, 4, HITCH_GRACE);
      }
      this.primeStep();
      this.frame(dt);
      this.adaptQuality(raw);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ro.disconnect();
    this.input.dispose();
    setPortraitHost(null);
    this.view.renderer.dispose();
  }

  /** the canvas changed size (or the quality stepped): size the backing store, lay out, bake, tell the DOM */
  private resize = () => {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width),
      h = Math.max(1, r.height);
    const sized = w !== this.cssW || h !== this.cssH;
    this.cssW = w;
    this.cssH = h;
    const v = this.view;
    sizeView(v, w, h, this.quality);
    // (only tall screens keep a bottom band; reading the safe area forces a style pass, so skip it elsewhere)
    if (sized && w / h < 1.12) this.safeBottom = readSafeBottom();
    const wasMode = v.mode;
    // tall screens keep a band clear along the bottom: the host's badge and the run's gauges live there
    layoutView(v, w, h, 92 + this.safeBottom, this.spec?.archetype === "throne");
    if (v.mode !== wasMode && this.fz.t < 1) this.fz.t = 1;
    if (this.fz.t < 1) {
      // mid-glide: finish it now rather than chase a moving target
      this.fz.t = 1;
      this.camAt = this.fz.to;
    }
    // a run on a screen that can't lean in keeps the plain view
    if (v.mode === "single") this.camAt = this.fz.to = this.fz.from = 0;
    this.applyCamera();
    // the papers cover both views (and a margin for camera shake), each at its own density
    const c0 = camRect(v.cams[0]),
      c1 = camRect(v.cams[1]);
    const m = 2;
    const u = { x0: Math.min(c0.x0, c1.x0) - m, y0: Math.min(c0.y0, c1.y0) - m, x1: Math.max(c0.x1, c1.x1) + m, y1: Math.max(c0.y1, c1.y1) + m };
    const dens = (i: number) => (v.dpr * w) / (v.cams[i].halfW * 2);
    this.paperSpec = { u, densA: dens(0), densB: dens(1), leaf: v.leftLeaf, strip: v.strip, needB: v.mode !== "single" };
    if (sized) this.quietUntil = performance.now() + 1200;
    this.emitLayout();
  };

  /** point the camera where the lean-in has got to (a projection matrix and a few uniforms: no re-bake, no re-layout) */
  private applyCamera() {
    const v = this.view;
    applyCam(v, lerpCam(v.cams[0], v.cams[1], this.camAt));
    // the run's view lowers the titan over the arena's top band (stage.ts RUN_DROP), gliding with the camera
    this.drop = v.drop[0] + (v.drop[1] - v.drop[0]) * this.camAt;
    for (const t of [this.titan, this.kept]) {
      if (!t) continue;
      // engraving lines: about one line every 4.5 device pixels, whatever the screen and the zoom
      t.u.uPx.value = v.unitsPerPx / v.dpr;
      // in the open book the titan may spill onto the desk, but never across the gutter onto the text
      t.u.uClipX.value = v.spread ? -PAGE.W / 2 - 0.15 : -1e4;
      t.u.uClipX2.value = v.spread ? PAGE.W / 2 + 0.15 : 1e4;
    }
  }

  private emitLayout() {
    this.layoutRect = { ...this.view.rect };
    this.events.onLayout?.(this.layout());
  }

  /** start leaning in (1) or back out to the whole book (0) */
  private beginFocus(to: number) {
    const span = Math.abs(to - this.camAt);
    this.fz = { from: this.camAt, to, t: 0, dur: this.reducedMotion ? 1e-3 : (to ? 1.05 : 0.9) * Math.max(0.35, span) };
    // the glide and the frame after it never count against the quality
    this.frameTimes.length = 0;
    this.quietUntil = performance.now() + this.fz.dur * 1000 + 700;
  }

  private stepFocus(dt: number) {
    const v = this.view;
    // when your light goes out, stay close for a breath (the burst, the silence) before the book opens again
    if (this.phase === "down" && this.focusPhase === "playing") this.downHold = 0.55;
    this.focusPhase = this.phase;
    this.downHold = Math.max(0, this.downHold - dt);
    const live = this.phase === "playing" || this.phase === "replay" || (this.phase === "down" && this.downHold > 0);
    const want = v.mode !== "single" && live && !this.falling ? 1 : 0;
    if (want !== this.fz.to) this.beginFocus(want);
    if (this.fz.t >= 1) return;
    this.fz.t = Math.min(1, this.fz.t + dt / this.fz.dur);
    const k = this.fz.t;
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in-out cubic
    this.camAt = this.fz.from + (this.fz.to - this.fz.from) * e;
    this.applyCamera();
    if (this.fz.t >= 1) {
      this.camAt = this.fz.to;
      this.emitLayout();
    } else {
      const L = this.layoutRect,
        C = v.rect;
      const cw = C.x1 - C.x0,
        ch = C.y1 - C.y0;
      this.events.onCamera?.({ s: (L.x1 - L.x0) / cw, tx: ((L.x0 - C.x0) / cw) * this.cssW, ty: ((C.y1 - L.y1) / ch) * this.cssH, dir: this.fz.to > this.fz.from ? 1 : -1, k: e });
    }
  }

  private adaptQuality(raw: number) {
    const now = performance.now();
    // the first seconds (shader warm-up, the engraving), camera glides and resizes never count
    // (a hidden tab's pause is not a stall)
    if (!this.compiled || this.revealT < 6 || this.fz.t < 1 || now < this.quietUntil || raw > 3) {
      this.frameTimes.length = 0;
      return;
    }
    this.frameTimes.push(raw);
    if (this.frameTimes.length < 90) return;
    const ft = this.frameTimes;
    // the middle and the tail from frame times clamped at 50 ms (one long stall is one slow frame, not a slow
    // second); stalls of 100 ms and more counted apart, except an isolated one over 250 ms among smooth frames
    // (a GC, a notification, a screen recorder starting): that is the machine, not the page's load
    const clamped = ft.map((x) => Math.min(0.05, x));
    const avg = clamped.reduce((a, b) => a + b, 0) / clamped.length;
    const sorted = clamped.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    let stalls = 0;
    for (let i = 0; i < ft.length; i++) {
      if (ft[i] <= 0.1) continue;
      if (ft[i] > 0.25) {
        let isolated = true;
        for (let j = Math.max(0, i - 10); j <= Math.min(ft.length - 1, i + 10) && isolated; j++) if (j !== i && ft[j] >= 0.02) isolated = false;
        if (isolated) continue;
      }
      stalls++;
    }
    ft.length = 0;
    if (now - this.qualityAt < 6000) return; // give each step time to settle
    const slow = avg > 1 / 48 || p95 > 1 / 26 || stalls >= 3;
    // step down (1 → 0.75 → 0.5) only when frames run long for two windows running, at every density: a
    // passing hitch never softens the engraving; step back up when there is headroom
    if (slow && this.quality > 0.5) {
      this.slowWindows++;
      if (this.slowWindows < 2) return;
      this.slowWindows = 0;
      this.qualityAt = now;
      this.quality = this.quality > 0.75 ? 0.75 : 0.5;
      this.resize();
    } else {
      this.slowWindows = 0;
      if (!slow && avg < 1 / 58 && p95 < 1 / 40 && stalls === 0 && this.quality < 1) {
        this.qualityAt = now;
        this.quality = this.quality < 0.75 ? 0.75 : 1;
        this.resize();
      }
    }
  }

  layout(): Layout {
    const v = this.view;
    const rr = (x0: number, y0: number, x1: number, y1: number) => {
      const a = this.screenOf(x0, y1),
        b = this.screenOf(x1, y0);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    };
    const focus = this.camAt >= 1 && v.mode !== "single";
    const leaf = v.spread ? (focus ? v.strip : v.leftLeaf) : null;
    return {
      spread: v.spread,
      portrait: v.portrait,
      mode: v.mode,
      focus,
      pxPerUnit: 1 / v.unitsPerPx,
      left: leaf ? rr(leaf.x0, Math.max(leaf.y0, v.rect.y0), leaf.x1, Math.min(leaf.y1, v.rect.y1 - 0.4)) : null,
      right: rr(-PAGE.W / 2, PAGE.Y0, PAGE.W / 2, PAGE.Y1),
      arena: rr(-ARENA.W / 2, 0, ARENA.W / 2, ARENA.H),
      reserve: v.reserve,
      vw: this.cssW,
      vh: this.cssH,
    };
  }

  /** world -> css px, for DOM overlays (names, numbers) */
  screenOf(x: number, y: number) {
    return toScreen(this.view, x, y, this.cssW, this.cssH);
  }

  private frame(dt: number) {
    if (!this.spec) return;
    const t = this.clock();
    const beat = t / this.spec.beat;
    const stage = this.stage;
    const h = this.hunt;

    // --- your run
    if (h && this.phase === "playing") {
      const st = this.input.poll();
      if (this.autopilot) {
        const d = this.autopilot.decide(h, t, stage);
        st.mx = d.mx;
        st.my = d.my;
        st.dash = d.dash;
        st.drag.active = false;
      }
      let tx: number | undefined, ty: number | undefined;
      if (st.drag.active) {
        const d = this.input.takeDrag();
        this.target.x = Math.max(-ARENA.W / 2 + 0.3, Math.min(ARENA.W / 2 - 0.3, this.target.x + d.x));
        this.target.y = Math.max(0.4, Math.min(ARENA.H - 1.2, this.target.y + d.y));
        tx = this.target.x;
        ty = this.target.y;
      } else {
        this.target.x = h.x;
        this.target.y = h.y;
      }
      const prevGrazes = h.grazeCount;
      const wasAlive = h.alive;
      h.step(t, dt, { mx: st.mx, my: st.my, dash: st.dash, tx, ty }, stage);
      if (st.dash && h.dashing) this.events.onSfx?.("dash", h.x);
      // grazes
      if (h.grazeCount > prevGrazes) {
        this.events.onSfx?.("graze", h.x, h.grazeCount - prevGrazes);
        this.fx.burst(h.x, h.y, 2, { type: P.Fleck, size: 0.07, speed: 3, life: 0.35, g: 0 });
        if (h.combo > 0 && h.combo % 10 === 0) this.events.onFloat?.(`${h.combo} grazes`, h.x, h.y + 0.8, "graze");
      }
      // hurt
      if (h.hurtEvents > this.lastHurt) {
        this.lastHurt = h.hurtEvents;
        this.shake = Math.max(this.shake, 0.5);
        this.hurtFlash = 1;
        this.fx.burst(h.x, h.y, 22, { type: P.Ink, col: 3, speed: 7, size: 0.16, life: 0.8, g: -2 });
        this.fx.ring(h.x, h.y, 2.4, 1);
        this.events.onSfx?.("hurt", h.x);
        if (navigator.vibrate) navigator.vibrate(60);
      }
      if (h.relights > this.lastRelights) {
        this.lastRelights = h.relights;
        this.fx.ring(h.x, h.y, 3, 0, 0.7);
        this.events.onSfx?.("relight", h.x);
        this.events.onFloat?.("A light returns", h.x, h.y + 1, "info");
      }
      if (h.surges > this.lastSurges) {
        this.lastSurges = h.surges;
        this.events.onSfx?.("surge", h.x);
        this.fx.ring(h.x, h.y, 3.5, 0, 0.6);
        this.events.onFloat?.("Surge", h.x, h.y + 1, "info");
      }
      // damage dealt
      if (h.events.length) {
        let sum = 0;
        for (const e of h.events) {
          sum += e.dmg;
          this.coreHit[e.core] = 1;
          this.titanHurt = Math.min(1, this.titanHurt + (e.surge ? 0.12 : 0.05));
          this.fx.burst(e.x, e.y - this.drop, e.surge ? 6 : 3, { type: P.Fleck, size: 0.12, speed: 7, life: 0.6, g: -9 });
          this.events.onFloat?.(String(e.dmg), e.x + (Math.random() - 0.5) * 1.4, e.y + 0.6 - this.drop, "dmg");
          this.events.onHits?.(e.dmg, e.core, e.beat, e.surge);
        }
        this.events.onSfx?.("strike", h.events[0].x, Math.min(1, sum / 60));
        h.events.length = 0;
      }
      // dart streaks
      // (bent onto the titan where it is drawn: lowered by the run's view, its wounds with it)
      for (const d of h.darts) {
        const left = Math.hypot(d.tx - d.x, d.ty - d.y);
        let from = this.dartFrom.get(d);
        if (from === undefined) this.dartFrom.set(d, (from = Math.max(1e-3, left)));
        const y = d.y - this.drop * Math.max(0, Math.min(1, 1 - left / from));
        this.fx.add({ x: d.x, y, vx: (d.tx - d.x) * 4, vy: (d.ty - this.drop - y) * 4, type: P.Streak, col: d.surge ? 4 : 0, size: d.surge ? 0.16 : 0.11, max: 0.07, drag: 0 });
      }
      // echo path
      this.pathAcc += dt;
      while (this.pathAcc >= 0.1) {
        this.pathAcc -= 0.1;
        this.path.push(Math.round(h.x * 20), Math.round(h.y * 20));
      }
      if (wasAlive && !h.alive) {
        this.phase = "down";
        this.shake = 0.9;
        this.fx.burst(h.x, h.y, 40, { type: P.Fleck, size: 0.14, speed: 9, life: 1.2, g: -4 });
        this.events.onSfx?.("down", h.x);
        if (navigator.vibrate) navigator.vibrate([80, 60, 140]);
        this.events.onDown?.(this.summaryOf(h, stage, false));
      }
    } else if (this.fallT >= 0.4 || this.kept) {
      // a felled titan throws nothing more
      clearFrame(this.lobbyFrame);
    } else {
      this.field.sample(t, stage, this.lobbyFrame);
    }
    const frame = h && this.phase === "playing" ? h.frame : this.lobbyFrame;

    if (h && (this.phase === "playing" || this.phase === "down")) {
      const flags = (h.dashing ? 1 : 0) | (h.surging ? 2 : 0) | (h.invuln > 0 ? 4 : 0);
      this.events.onPos?.(h.x, h.y, h.alive, flags);
    }
    this.events.onFrame?.(t, stage, this.hpFrac, this.phase === "playing", h && this.phase === "playing" ? 1 - Math.max(0, Math.min(1, h.nearest / 1.5)) : 0);

    // --- beat events
    const beatInt = Math.floor(beat);
    if (beatInt !== this.lastBeatInt) {
      this.lastBeatInt = beatInt;
      this.events.onSfx?.("beat", 0, beatInt % 4 === 0 ? 1 : 0.5);
    }

    // --- titan
    const cues = this.cuesAt(beat, stage);
    const coreOpenArr = this.spec.cores.map((c) => coreOpen(c, beat, stage));
    for (let i = 0; i < this.coreHit.length; i++) this.coreHit[i] = Math.max(0, this.coreHit[i] - dt * 6);
    this.titanHurt = Math.max(0, this.titanHurt - dt * 2.5);
    const ghostNow = this.phase === "replay" ? this.replayPos?.(t) : null;
    const me = h && this.phase === "playing" ? { x: h.x, y: h.y } : ghostNow ? { x: ghostNow.x, y: ghostNow.y } : { x: 0, y: 4 };
    const coreSoon = this.spec.cores.map((c, i) => !coreOpenArr[i] && t >= 0 && (coreOpen(c, beat + 1, stage) || coreOpen(c, beat + 2, stage)));
    const ctx: TitanCtx = { t, beat, player: me, cues, stage, crack: 1 - this.hpFrac, hurt: this.titanHurt, coreOpen: coreOpenArr, coreHit: this.coreHit, coreSoon };
    if (this.fallT >= 0) {
      const f0 = this.fallT;
      this.fallT += dt;
      this.fallBeat(f0, this.fallT, ctx);
      this.titan.u.uReveal.value = fallReveal(this.fallT);
      // (no successor yet, as in a slow live world: the page is empty once the plate has gone)
      if (f0 < FALL.GONE && this.fallT >= FALL.GONE) this.onFelledGone?.();
    }
    this.titan.update(ctx, dt);
    const k = this.kept;
    if (k) {
      // the felled titan kept on the page dies on, under its stamp, while the next waits hidden behind it
      const f0 = this.keptT;
      this.keptT += dt;
      const none = k.spec.cores.map(() => false);
      const kc: TitanCtx = { ...ctx, cues: [], coreOpen: none, coreSoon: none, coreHit: k.spec.cores.map(() => 0) };
      this.fallBeat(f0, this.keptT, kc);
      k.u.uReveal.value = fallReveal(this.keptT);
      k.update(kc, dt);
      if (this.keptT >= FALL.GONE) this.dropKept();
    }
    if (this.revealT < 6 && this.fallT < 0 && !this.kept) {
      // (reduced motion: the plate is simply there, fully engraved)
      if (!this.holdReveal && this.compiled) this.revealT = this.reducedMotion ? 6 : this.revealT + dt * (this.rushReveal ? 6 : 1);
      const r = this.revealT;
      // lines cut in over 2.6 s, colour bleeds in over 1.3 s, gold settles over 1 s
      this.titan.u.uReveal.value = r < 2.6 ? (r / 2.6) : r < 3.9 ? 1 + (r - 2.6) / 1.3 : Math.min(3, 2 + (r - 3.9));
      if (this.revealT >= 6) this.titan.u.uReveal.value = 3;
    }

    // --- page, ink, hunters, fx
    const pulse = t < 0 ? 0 : Math.pow(1 - (beat % 1), 6) * (beatInt % 4 === 0 ? 1 : 0.45);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    // (the camera for this frame: the lean-in glides here, before anything reads the view)
    this.stepFocus(dt);
    this.poseTitan(this.titan, this.fallT);
    if (this.kept) this.poseTitan(this.kept, this.keptT);
    const v = this.view;
    const crease = v.leftLeaf && v.strip ? v.leftLeaf.x0 + (v.strip.x0 - v.leftLeaf.x0) * Math.min(1, this.camAt * 1.15) : 0;
    this.page.update(v.rect, stage, pulse, this.hurtFlash, this.camAt, crease, v.spread ? v.leftLeaf : null);
    this.ink.update(frame, t);
    this.ink.uniforms.uShow.value = Math.min(1, Math.max(0, (this.revealT - 2.4) / 1.4));
    const draws: HunterDraw[] = this.others ? this.others.list(t) : [];
    if (h && this.phase === "playing") draws.push({ x: h.x, y: h.y, kind: 0, hue: 0.12, inv: h.invuln > 0 ? Math.min(1, h.invuln) : 0, dash: h.dashing ? 1 : 0, surge: h.surging ? 1 : 0, seed: 0.3, grace: h.inGrace ? h.invuln / h.graceMax : 0 });
    let mine = h && this.phase === "playing" ? { x: h.x, y: h.y, alive: h.alive } : null;
    if (!mine && this.warmed < 3 && this.phase === "lobby" && this.compiled && this.revealT >= 6) {
      // the hunters' layer and your light's trail are first drawn here, off the page, while nothing is at stake:
      // a first draw builds the GPU's variants for them, and in the run's first seconds that was a hitch
      draws.push({ x: 0, y: -60, kind: 0, hue: 0.12, inv: 0.5, dash: 1, surge: 1, seed: 0.3, grace: 0.5 });
      mine = { x: 0, y: -60, alive: true };
      this.warmed++;
    }
    this.hunters.update(draws, t, mine);
    if (Math.random() < dt * 6) this.fx.add({ x: (Math.random() - 0.5) * ARENA.W * 1.1, y: Math.random() * ARENA.TOP, vx: (Math.random() - 0.5) * 0.4, vy: 0.3 + Math.random() * 0.4, type: P.Spore, col: 0, size: 0.06 + Math.random() * 0.06, max: 4, drag: 0 });
    this.fx.update(dt);

    // --- camera shake
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.reducedMotion ? 0 : this.shake * this.shake * 0.35;
    this.view.camera.position.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, 50);
    // nothing is drawn until the paper's programs are linked; then only the paper until the titan's are
    // (a program used before it has linked blocks the main thread: that was the startup freeze)
    if (this.pageReady) {
      const r = this.view.renderer;
      if (this.paperSpec) this.page.bake(r, this.paperSpec);
      if (this.compiled) this.renderScene();
      else {
        const hidden: THREE.Object3D[] = [];
        for (const o of v.scene.children) if (o !== this.page.mesh && o.visible) (o.visible = false), hidden.push(o);
        r.render(v.scene, v.camera);
        for (const o of hidden) o.visible = true;
      }
    }

    // --- hud (10 Hz)
    this.hudT -= dt;
    if (this.hudT <= 0 && this.events.onHud) {
      this.hudT = 0.1;
      this.events.onHud({
        phase: this.phase,
        hits: h?.hits ?? 0,
        maxHits: MAX_HITS,
        resonance: h?.resonance ?? 0,
        surging: h?.surging ?? false,
        damage: h?.damage ?? 0,
        combo: h?.combo ?? 0,
        grazes: h?.grazeCount ?? 0,
        dashReady: h ? 1 - h.dashCd / h.aspect.dashCd : 1,
        stage,
        beat,
        phrase: Math.floor(beat / PHRASE_BEATS) % LOOP_PHRASES,
        time: h?.time ?? 0,
        coresOpen: coreOpenArr.filter(Boolean).length,
        surges: h?.surges ?? 0,
        bestCombo: h?.bestCombo ?? 0,
        clean: h?.cleanBest ?? 0,
      });
    }
  }

  /**
   * The death beat and what follows, from f0 to f seconds after the killing blow: flecks shaken off the body,
   * ink bleeding down the page, the slam (gold rings, a shake) as the stamp lands, and paper flecks as the plate
   * tears away. A few dozen particles a second; the body's own motion is in poseTitan.
   */
  private fallBeat(f0: number, f: number, ctx: TitanCtx) {
    const dy = this.drop;
    ctx.crack = 1;
    ctx.stage = 2;
    ctx.hurt = f < FALL.SLAM ? Math.min(1, 0.6 + Math.sin(f * 40) * 0.4) : Math.max(0, 0.6 - (f - FALL.SLAM) * 0.8);
    const dt = f - f0;
    if (f < FALL.SLAM && Math.random() < dt * 18) this.fx.burst((Math.random() - 0.5) * 14, 20 + Math.random() * 10 - dy, 5, { type: P.Fleck, size: 0.18, speed: 8, life: 1.3, g: -7 });
    // ink bleeding down the page from the wounds and the body
    if (f > 0.25 && f < FALL.SLAM + 1.6) {
      const n = Math.floor(dt * 46 + Math.random());
      for (let i = 0; i < n; i++)
        this.fx.add({ x: (Math.random() - 0.5) * 13, y: 20.4 + Math.random() * 7 - dy, vx: (Math.random() - 0.5) * 0.15, vy: -0.4 - Math.random() * 0.9, type: P.Drip, col: 3, size: 0.09 + Math.random() * 0.12, max: 1.5 + Math.random() * 1.2, drag: 0.5, g: -2.4 });
    }
    if (f0 < FALL.SLAM && f >= FALL.SLAM) {
      for (let i = 0; i < 12; i++) this.fx.ring((Math.random() - 0.5) * 12, 21 + Math.random() * 7 - dy, 4 + Math.random() * 4, 0, 0.9);
      this.fx.burst(0, 25 - dy, 140, { type: P.Fleck, size: 0.22, speed: 16, life: 2.2, g: -5 });
      this.shake = 1.4;
    }
    // the plate tears away: vellum flecks along a ragged seam across the body
    if (f0 < FALL.RELEASE && f >= FALL.RELEASE) {
      for (let i = 0; i < 40; i++) {
        const x = (Math.random() - 0.5) * 15;
        this.fx.burst(x, 24 + Math.sin(x * 1.7) * 1.2 - dy, 1, { type: P.Fleck, col: 4, size: 0.16, speed: 3, life: 1.2, g: -3 });
      }
    }
  }

  /** where a titan is drawn: lowered by the run's view, and in its death sagging and shuddering on the beat */
  private poseTitan(t: Titan | undefined, f: number) {
    if (!t) return;
    let x = 0,
      sag = 0;
    if (f >= 0 && !this.reducedMotion) {
      const beat = t.spec.beat;
      const env = f < FALL.SLAM ? 1 - (0.6 * f) / FALL.SLAM : 0;
      x = Math.sin(f * 57) * 0.17 * Math.pow(1 - ((f / beat) % 1), 3) * env;
      const k = Math.min(1, f / FALL.SLAM);
      sag = 0.8 * (1 - Math.pow(1 - k, 3));
      // the stamp's blow drives it down a little further, and it settles
      if (f >= FALL.SLAM && f < FALL.SLAM + 0.3) sag += 0.3 * Math.sin(((f - FALL.SLAM) / 0.3) * Math.PI);
      if (f > FALL.RELEASE) sag += 1.4 * Math.pow(Math.min(1, (f - FALL.RELEASE) / FALL.LIFT), 2);
    }
    t.group.position.set(x, -this.drop - sag, 0);
  }

  /**
   * Draw the scene. In the open book the titan is held to its own page: the paper first, then the titan with
   * a scissor at the page's edges (its towers never rise over the page top, its legs never step onto the
   * desk), then the ink, the hunters and the sparks over it, as before.
   */
  private renderScene() {
    const v = this.view;
    const r = v.renderer;
    const tg = this.titan?.group;
    if (!v.spread || !tg) {
      r.render(v.scene, v.camera);
      return;
    }
    const a = this.screenOf(-PAGE.W / 2, PAGE.Y1),
      b = this.screenOf(PAGE.W / 2, PAGE.Y0);
    const x0 = Math.max(0, Math.floor(a.x)),
      x1 = Math.min(this.cssW, Math.ceil(b.x));
    const top = Math.max(0, Math.floor(a.y));
    const kids = v.scene.children;
    const vis = kids.map((o) => o.visible);
    const kept = this.kept?.group;
    const isTitan = (o: THREE.Object3D) => o === tg || o === kept;
    const show = (f: (o: THREE.Object3D) => boolean) => kids.forEach((o, i) => (o.visible = vis[i] && f(o)));
    const auto = r.autoClear;
    try {
      show((o) => o === this.page.mesh);
      r.render(v.scene, v.camera);
      r.autoClear = false;
      show(isTitan);
      r.setScissor(x0, 0, Math.max(0, x1 - x0), Math.max(0, this.cssH - top));
      r.setScissorTest(true);
      r.render(v.scene, v.camera);
      r.setScissorTest(false);
      show((o) => o !== this.page.mesh && !isTitan(o));
      r.render(v.scene, v.camera);
    } finally {
      r.setScissorTest(false);
      r.autoClear = auto;
      kids.forEach((o, i) => (o.visible = vis[i]));
    }
  }

  /** separate frame buffer for when no run is active */
  private lobbyFrame = newFrame();

  /** Upcoming attacks for the titan's wind-up animations. */
  private cuesAt(beat: number, stage: Stage) {
    const out: TitanCtx["cues"] = [];
    const pa = Math.floor(beat / PHRASE_BEATS);
    for (const p of [pa, pa + 1]) {
      const plan = this.field.plan(((p % LOOP_PHRASES) + LOOP_PHRASES) % LOOP_PHRASES, stage);
      for (const v of plan.volleys) {
        const lead = p * PHRASE_BEATS + v.beat - beat;
        if (lead > 2.2 || lead < -0.6) continue;
        const x = v.p.ox ?? v.p.cx ?? v.p.tx ?? v.p.gapX ?? 0;
        const y = v.p.oy ?? v.p.cy ?? ARENA.TOP;
        out.push({ x, y, lead, heavy: v.heavy, kind: v.kind });
      }
    }
    return out;
  }
}

/** no ink in flight */
function clearFrame(f: FieldFrame) {
  f.bulletCount = f.beamCount = f.ringCount = f.zoneCount = f.markCount = 0;
}

/** the height of the screen's bottom safe area (the iPhone home bar), in CSS px */
function readSafeBottom() {
  try {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none";
    document.body.appendChild(d);
    const h = d.getBoundingClientRect().height;
    d.remove();
    return h || 0;
  } catch {
    return 0;
  }
}

export { THREE };

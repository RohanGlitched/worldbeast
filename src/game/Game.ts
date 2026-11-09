import * as THREE from "three";
import { ARENA, coreOpen, makeTitan, PHRASE_BEATS, LOOP_PHRASES, Stage, stageFor, TitanSpec } from "@/core/titan";
import { Field } from "@/core/field";
import { AspectId, Hunt, MAX_HITS } from "@/core/hunt";
import { createView, PAGE, resizeView, toScreen, View } from "./render/stage";
import { PageLayer } from "./render/page";
import { InkLayer } from "./render/ink";
import { Titan, TitanCtx } from "./render/titan/titan";
import { HunterDraw, HunterLayer } from "./render/hunters";
import { FxLayer, P } from "./render/fx";
import { Input } from "./input";
import { Bot } from "@/core/bot/bot";

// The conductor: one synced clock, one titan, your run, everyone else's sparks, the page.

export type Phase = "lobby" | "playing" | "down";

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
}

export interface GameEvents {
  onHud?(h: HudState): void;
  onHits?(dmg: number, core: number, beat: number): void; // local damage dealt (to send to the world)
  onDown?(summary: RunSummary): void;
  onSfx?(name: string, x?: number, strength?: number): void;
  onFloat?(text: string, x: number, y: number, kind: "dmg" | "graze" | "info"): void;
  onLayout?(l: Layout): void;
}

export interface Layout {
  spread: boolean;
  portrait: boolean;
  pxPerUnit: number;
  /** CSS-pixel rects of the leaves (left is null when not in spread mode) */
  left: { x: number; y: number; w: number; h: number } | null;
  right: { x: number; y: number; w: number; h: number };
  arena: { x: number; y: number; w: number; h: number };
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
  private lastBeatInt = -1;
  private frameTimes: number[] = [];
  private cssW = 1;
  private cssH = 1;
  /** seconds since this titan was first drawn: drives the engraving-in sequence */
  private revealT = 0;
  private ro: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.view = createView(canvas);
    this.page = new PageLayer(this.view.scene);
    this.ink = new InkLayer(this.view.scene);
    this.hunters = new HunterLayer(this.view.scene);
    this.fx = new FxLayer(this.view.scene);
    this.input = new Input(canvas, (dx, dy) => ({ x: dx * this.view.unitsPerPx, y: -dy * this.view.unitsPerPx }));
    this.reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.resize();
    window.addEventListener("resize", this.resize);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  setTitan(seed: number, number: number) {
    if (this.spec?.seed === seed) return;
    if (this.titan) {
      this.view.scene.remove(this.titan.group);
      this.titan.dispose();
    }
    this.spec = makeTitan(seed, number);
    this.field = new Field(this.spec);
    this.titan = new Titan(this.spec);
    this.titan.u.uReveal.value = 0;
    this.revealT = 0;
    this.view.scene.add(this.titan.group);
    this.resize();
    const p = this.spec.plate;
    this.page.setPlate(p);
    this.ink.setPlate(p);
    this.hunters.setGold(p.gold, p.ink);
    this.fx.setPlate(p.gold, p.accent, p.accent2, p.ink);
    this.coreHit = this.spec.cores.map(() => 0);
    this.hunt = null;
    this.phase = "lobby";
  }

  get revealing() {
    return this.revealT < 4.9;
  }
  skipReveal() {
    this.revealT = 6;
    if (this.titan) this.titan.u.uReveal.value = 3;
  }

  get stage(): Stage {
    return stageFor(this.hpFrac);
  }

  setAutopilot(on: boolean, greed = 0.6) {
    this.autopilot = on && this.field ? new Bot(this.field, 1, greed) : null;
  }

  start(aspect: AspectId) {
    this.hunt = new Hunt(this.spec, this.field, aspect);
    this.hunt.x = 0;
    this.hunt.y = 3;
    this.target = { x: 0, y: 3 };
    this.phase = "playing";
    this.path = [];
    this.pathAcc = 0;
    this.runStart = this.clock();
    this.lastHurt = 0;
    this.lastSurges = 0;
    this.events.onSfx?.("start");
  }

  run() {
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
      this.adaptQuality(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.ro.disconnect();
    this.input.dispose();
    this.view.renderer.dispose();
  }

  private resize = () => {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    resizeView(this.view, this.cssW, this.cssH, this.quality);
    this.events.onLayout?.(this.layout());
    // engraving lines: about one line every 4.5 device pixels, whatever the screen
    if (this.titan) this.titan.u.uPx.value = this.view.unitsPerPx / this.view.dpr;
  };

  private adaptQuality(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    if (avg > 1 / 45 && this.quality > 0.5) {
      this.quality = 0.5;
      this.resize();
    } else if (avg < 1 / 58 && this.quality < 1) {
      this.quality = 1;
      this.resize();
    }
  }

  layout(): Layout {
    const v = this.view;
    const rr = (x0: number, y0: number, x1: number, y1: number) => {
      const a = this.screenOf(x0, y1),
        b = this.screenOf(x1, y0);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    };
    return {
      spread: v.spread,
      portrait: v.portrait,
      pxPerUnit: 1 / v.unitsPerPx,
      left: v.leftLeaf ? rr(v.leftLeaf.x0, v.leftLeaf.y0, v.leftLeaf.x1, v.leftLeaf.y1) : null,
      right: rr(-PAGE.W / 2, PAGE.Y0, PAGE.W / 2, PAGE.Y1),
      arena: rr(-ARENA.W / 2, 0, ARENA.W / 2, ARENA.H),
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
          this.fx.burst(e.x, e.y, e.surge ? 6 : 3, { type: P.Fleck, size: 0.12, speed: 7, life: 0.6, g: -9 });
          this.events.onFloat?.(String(e.dmg), e.x + (Math.random() - 0.5) * 1.4, e.y + 0.6, "dmg");
          this.events.onHits?.(e.dmg, e.core, e.beat);
        }
        this.events.onSfx?.("strike", h.events[0].x, Math.min(1, sum / 60));
        h.events.length = 0;
      }
      // dart streaks
      for (const d of h.darts) this.fx.add({ x: d.x, y: d.y, vx: (d.tx - d.x) * 4, vy: (d.ty - d.y) * 4, type: P.Streak, col: d.surge ? 4 : 0, size: d.surge ? 0.16 : 0.11, max: 0.07, drag: 0 });
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
        this.events.onDown?.({ damage: h.damage, time: h.time, grazes: h.grazeCount, bestCombo: h.bestCombo, surges: h.surges, aspect: h.aspect.id, path: this.path.slice(), startT: this.runStart, stage });
      }
    } else {
      this.field.sample(t, stage, this.lobbyFrame);
    }
    const frame = h && this.phase === "playing" ? h.frame : this.lobbyFrame;

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
    const me = h && this.phase === "playing" ? { x: h.x, y: h.y } : { x: 0, y: 4 };
    const ctx: TitanCtx = { t, beat, player: me, cues, stage, crack: 1 - this.hpFrac, hurt: this.titanHurt, coreOpen: coreOpenArr, coreHit: this.coreHit };
    this.titan.update(ctx, dt);
    if (this.revealT < 6) {
      this.revealT += dt;
      const r = this.revealT;
      // lines cut in over 2.6 s, colour bleeds in over 1.3 s, gold settles over 1 s
      this.titan.u.uReveal.value = r < 2.6 ? (r / 2.6) : r < 3.9 ? 1 + (r - 2.6) / 1.3 : Math.min(3, 2 + (r - 3.9));
      if (this.revealT >= 6) this.titan.u.uReveal.value = 3;
    }

    // --- page, ink, hunters, fx
    const pulse = Math.pow(1 - (beat % 1), 8) * (beatInt % 4 === 0 ? 1 : 0.4);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.page.update(this.view.rect, t, stage, pulse, this.hurtFlash, this.view.leftLeaf);
    this.ink.update(frame, t);
    const draws: HunterDraw[] = this.others ? this.others.list(t) : [];
    if (h && this.phase === "playing") draws.push({ x: h.x, y: h.y, kind: 0, hue: 0.12, inv: h.invuln > 0 ? Math.min(1, h.invuln) : 0, dash: h.dashing ? 1 : 0, surge: h.surging ? 1 : 0, seed: 0.3 });
    this.hunters.update(draws, t, h && this.phase === "playing" ? { x: h.x, y: h.y, alive: h.alive } : null);
    if (Math.random() < dt * 6) this.fx.add({ x: (Math.random() - 0.5) * ARENA.W * 1.1, y: Math.random() * ARENA.TOP, vx: (Math.random() - 0.5) * 0.4, vy: 0.3 + Math.random() * 0.4, type: P.Spore, col: 0, size: 0.06 + Math.random() * 0.06, max: 4, drag: 0 });
    this.fx.update(dt);

    // --- camera shake
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.reducedMotion ? 0 : this.shake * this.shake * 0.35;
    this.view.camera.position.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, 50);
    this.view.renderer.render(this.view.scene, this.view.camera);

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
      });
    }
  }

  private lobbyFrame = (() => {
    // separate frame buffer for when no run is active
    return { bullets: new Float32Array(4096 * 7), bulletIds: new Uint32Array(4096), bulletCount: 0, beams: new Float32Array(64 * 7), beamCount: 0, rings: new Float32Array(64 * 9), ringCount: 0, zones: new Float32Array(128 * 5), zoneCount: 0, marks: new Float32Array(256 * 4), markCount: 0 };
  })();

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

export { THREE };

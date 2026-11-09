import * as THREE from "three";
import { ARENA, Plate } from "@/core/titan";
import { NOISE } from "./glsl";
import { PAGE, Rect } from "./stage";

// The vellum leaf, its ruling and margins, and the dark desk beyond it.

export class PageLayer {
  mesh!: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uRect: { value: new THREE.Vector4(-10, -10, 10, 10) },
        uPage: { value: new THREE.Vector4(-PAGE.W / 2, PAGE.Y0, PAGE.W / 2, PAGE.Y1) },
        uLeft: { value: new THREE.Vector4(0, 0, 0, 0) },
        uSpread: { value: 0 },
        uArena: { value: new THREE.Vector4(-ARENA.W / 2, 0, ARENA.W / 2, ARENA.TOP) },
        uVellum: { value: new THREE.Color("#efe4cc") },
        uInk: { value: new THREE.Color("#231c17") },
        uAccent: { value: new THREE.Color("#c8321f") },
        uAccent2: { value: new THREE.Color("#2b4a8b") },
        uGold: { value: new THREE.Color("#d6a531") },
        uStage: { value: 0 },
        uPulse: { value: 0 },
        uHurt: { value: 0 },
      },
      vertexShader: /* glsl */ `
        uniform vec4 uRect; varying vec2 vW;
        void main(){ vec2 w = mix(uRect.xy, uRect.zw, position.xy * .5 + .5); vW = w; gl_Position = projectionMatrix * modelViewMatrix * vec4(w, -40., 1.); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime, uStage, uPulse, uHurt, uSpread; uniform vec4 uPage, uArena, uLeft;
        uniform vec3 uVellum, uInk, uAccent, uAccent2, uGold;
        varying vec2 vW;
        ${NOISE}
        float rule(float v, float w){ float f = fwidth(v); return 1. - smoothstep(w - f, w + f, abs(v)); }
        void main(){
          vec2 p = vW;
          // --- desk (outside the page or the open spread)
          vec2 dq = max(uPage.xy - p, p - uPage.zw);
          float outside = max(dq.x, dq.y);
          if (uSpread > .5) {
            vec2 lq = max(uLeft.xy - p, p - uLeft.zw);
            float lo = max(lq.x, lq.y);
            vec2 gq = max(vec2(uLeft.z, uPage.y) - p, p - vec2(uPage.x, uPage.w));
            float go = max(gq.x, gq.y);
            outside = min(outside, min(lo, go));
          }
          float grain = fbm(vec2(p.x * .35, p.y * 3.2)) * .6 + fbm(p * 1.7) * .4;
          vec3 desk = mix(vec3(.10,.075,.055), vec3(.19,.13,.085), grain);
          desk *= .75 + .25 * smoothstep(30., 0., length(p - vec2(0., 15.)));
          // --- vellum
          float fib = fbm(p * vec2(2.6, 9.)) * .55 + fbm(p * .35 + 3.) * .45;
          float stain = smoothstep(.62, .9, fbm(p * .22 + 11.)) * .14;
          vec3 col = uVellum * (.93 + .1 * fib) - vec3(.06, .07, .09) * stain;
          // age toward the edges of the leaf
          float edge = min(min(p.x - uPage.x, uPage.z - p.x), min(p.y - uPage.y, uPage.w - p.y));
          if (uSpread > .5) {
            edge = min(min(p.x - uLeft.x, uPage.z - p.x), min(p.y - uPage.y, uPage.w - p.y));
            // the spine: both leaves curve down into the gutter
            float gx = (uLeft.z + uPage.x) * .5;
            float d = abs(p.x - gx);
            // leaves curl down into the binding: a soft shadow, a darker crease, a hint of thread
            col *= .78 + .22 * smoothstep(0., 2.6, d);
            col *= 1. - .22 * (1. - smoothstep(0., .5, d));
            float thread = (1. - smoothstep(.02, .05, d)) * step(.5, fract(p.y * .9));
            col = mix(col, uAccent * .8, thread * .25);
          }
          col *= .80 + .2 * smoothstep(0., 2.2, edge + fbm(p * 1.3) * .8);
          // ruling: faint dry-point lines across the arena, a double frame in lapis and vermilion
          float inA = step(uArena.x, p.x) * step(p.x, uArena.z) * step(uArena.y, p.y) * step(p.y, uArena.w);
          col = mix(col, col * .9, rule(fract(p.y / 1.25 + .5) - .5, .012) * .5 * inA);
          float fx = min(abs(p.x - uArena.x), abs(p.x - uArena.z));
          float fy = abs(p.y - uArena.y);
          float frameV = step(uArena.y - .25, p.y) * step(p.y, uArena.w + .2);
          float frameH = step(uArena.x - .25, p.x) * step(p.x, uArena.z + .25);
          float l1 = max(rule(fx - .18, .025) * frameV, rule(fy - .18, .025) * frameH);
          float l2 = max(rule(fx - .32, .045) * frameV, rule(fy - .34, .045) * frameH);
          col = mix(col, uAccent2 * .9, l1 * .65);
          col = mix(col, uAccent * .95, l2 * .55);
          float pageEdge = smoothstep(.0, .06, -outside);
          vec3 outc = mix(desk, col, pageEdge);
          // page shadow on the desk
          outc *= 1. - .45 * smoothstep(.9, .0, outside) * step(0., outside);
          gl_FragColor = vec4(outc, 1.);
          #include <colorspace_fragment>
        }
      `,
      depthWrite: false,
      depthTest: false,
    });
    // The expensive paper is baked once per layout, in world space, for both views: the open book (A) and
    // the run, with the leaf folded to a strip (B). The live layer samples them by world position, so the
    // camera can lean in and out with no re-bake, and a crease sweeps across the leaf as it folds.
    const geo = new THREE.PlaneGeometry(2, 2);
    this.bakeMesh = new THREE.Mesh(geo, this.mat);
    this.bakeMesh.frustumCulled = false;
    this.bakeScene.add(this.bakeMesh);
    // 8-bit sRGB storage: the GPU encodes on write and decodes on read, so the dark desk doesn't band
    const rtOpts = { depthBuffer: false, colorSpace: THREE.SRGBColorSpace };
    this.rtA = new THREE.WebGLRenderTarget(4, 4, rtOpts);
    this.rtB = new THREE.WebGLRenderTarget(4, 4, rtOpts);
    this.live = new THREE.ShaderMaterial({
      uniforms: {
        uTexA: { value: this.rtA.texture },
        uTexB: { value: this.rtB.texture },
        uU: { value: new THREE.Vector4(-10, -10, 10, 10) },
        uRect: { value: new THREE.Vector4(-10, -10, 10, 10) },
        uArena: this.mat.uniforms.uArena,
        uFold: { value: 0 },
        uCrease: { value: 1e4 },
        uLeafX0: { value: -1e4 },
        uLeafX1: { value: -1e4 },
        uLeafY: { value: new THREE.Vector2(0, 0) },
        uStage: { value: 0 },
        uPulse: { value: 0 },
        uHurt: { value: 0 },
        uGold: this.mat.uniforms.uGold,
        uAccent: this.mat.uniforms.uAccent,
      },
      vertexShader: /* glsl */ `
        uniform vec4 uRect; varying vec2 vW;
        void main(){ vec2 w = mix(uRect.xy, uRect.zw, position.xy * .5 + .5); vW = w; gl_Position = projectionMatrix * modelViewMatrix * vec4(w, -40., 1.); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uTexA, uTexB; uniform vec4 uU, uArena; uniform vec2 uLeafY;
        uniform float uStage, uPulse, uHurt, uFold, uCrease, uLeafX0, uLeafX1; uniform vec3 uGold, uAccent;
        varying vec2 vW;
        void main(){
          vec2 uv = (vW - uU.xy) / (uU.zw - uU.xy);
          // the part of the leaf not yet folded away still shows the open book; everything else the run's paper
          float inLeafY = step(uLeafY.x, vW.y) * step(vW.y, uLeafY.y);
          float leafPart = step(uCrease, vW.x) * step(vW.x, uLeafX1) * inLeafY;
          // the leaf's outer half folds over onto its inner half: the flap (its back, the same vellum
          // mirrored) lies from the crease to crease + w, and at the end exactly covers the strip
          float w = max(uCrease - uLeafX0, 0.);
          float on = step(.001, w);
          float fx0 = vW.x - uCrease;
          float onFlap = leafPart * step(fx0, w) * on;
          vec2 uvM = vec2((2. * uCrease - vW.x - uU.x) / (uU.z - uU.x), uv.y);
          // (the strip that stays settles into the run's paper over the last of the fold)
          float useB = uFold > 0. ? mix(1. - leafPart, 1., smoothstep(.85, 1., uFold)) : 0.;
          vec3 col = mix(texture2D(uTexA, mix(uv, uvM, onFlap)).rgb, texture2D(uTexB, uv).rgb, useB);
          // the flap is shaded toward the fold and catches the light along its free edge
          col *= 1. - onFlap * .3 * (1. - smoothstep(0., w * .8 + .01, fx0));
          col += onFlap * vec3(.07, .06, .04) * (1. - smoothstep(0., .22, w - fx0));
          // its shadow on the leaf beyond, and the fold's on the desk
          float past = fx0 - w;
          col *= 1. - .32 * leafPart * on * step(0., past) * (1. - smoothstep(0., 1.3, past)) * (1. - smoothstep(.85, 1., uFold));
          col *= 1. - .45 * inLeafY * on * step(fx0, 0.) * (1. - smoothstep(0., 1.2, -fx0)) * (1. - smoothstep(.85, 1., uFold));
          float inA = step(uArena.x, vW.x) * step(vW.x, uArena.z) * step(uArena.y, vW.y) * step(vW.y, uArena.w);
          col *= 1. - .05 * uStage * inA;
          col += uGold * .03 * uPulse * inA;
          // the double frame flashes gold on every beat, brightest on the bar (readable with the sound off)
          float fx = min(abs(vW.x - uArena.x), abs(vW.x - uArena.z));
          float fy = abs(vW.y - uArena.y);
          float onV = step(uArena.y - .3, vW.y) * step(vW.y, uArena.w + .2);
          float onH = step(uArena.x - .3, vW.x) * step(vW.x, uArena.z + .3);
          float fr = max((1. - smoothstep(.0, .09, abs(fx - .32))) * onV, (1. - smoothstep(.0, .09, abs(fy - .34))) * onH);
          col = mix(col, uGold * 1.15, fr * uPulse * .9);
          float edge = min(min(vW.x - uArena.x, uArena.z - vW.x), min(vW.y - uArena.y, uArena.w - vW.y));
          col = mix(col, uAccent, uHurt * (1. - smoothstep(.0, 7., edge)) * .5 * step(-.5, edge));
          gl_FragColor = vec4(col, 1.);
          #include <colorspace_fragment>
        }
      `,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(geo, this.live);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    scene.add(this.mesh);
  }
  private bakeScene = new THREE.Scene();
  private bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 200);
  private bakeMesh: THREE.Mesh;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private live: THREE.ShaderMaterial;
  private dirty = true;
  private key = "";
  /** how many papers have been baked (each is a full-screen noise pass) */
  bakes = 0;
  /** link the bake's program off the main thread (as the variant that renders into the paper target) */
  compileBake(renderer: THREE.WebGLRenderer): Promise<unknown> {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rtA);
    try {
      return renderer.compileAsync(this.bakeScene, this.bakeCam);
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  /**
   * Bake the papers if the layout or the plate changed: A, the open book at the lobby's density; B, the
   * leaf folded to its strip at the run's density. Both cover `u` (world units).
   */
  bake(renderer: THREE.WebGLRenderer, o: { u: Rect; densA: number; densB: number; leaf: Rect | null; strip: Rect | null; needB: boolean }) {
    const vel = this.mat.uniforms;
    const k = [o.u.x0, o.u.y0, o.u.x1, o.u.y1, o.densA, o.densB, o.leaf?.x0 ?? 0, o.strip?.x0 ?? 0].map((v) => v.toFixed(3)).join(",") + o.needB;
    if (!this.dirty && k === this.key) return false;
    this.key = k;
    this.dirty = false;
    const max = Math.min(4096, renderer.capabilities.maxTextureSize || 4096);
    const W = o.u.x1 - o.u.x0,
      H = o.u.y1 - o.u.y0;
    const size = (d: number) => {
      const s = Math.min(1, max / (W * d), max / (H * d));
      return [Math.max(4, Math.round(W * d * s)), Math.max(4, Math.round(H * d * s))];
    };
    (this.live.uniforms.uU.value as THREE.Vector4).set(o.u.x0, o.u.y0, o.u.x1, o.u.y1);
    vel.uRect.value.set(o.u.x0, o.u.y0, o.u.x1, o.u.y1);
    const c = this.bakeCam;
    c.left = o.u.x0;
    c.right = o.u.x1;
    c.bottom = o.u.y0;
    c.top = o.u.y1;
    c.position.set(0, 0, 50);
    c.updateProjectionMatrix();
    const prev = renderer.getRenderTarget();
    const pass = (rt: THREE.WebGLRenderTarget, d: number, leaf: Rect | null) => {
      const [w, h] = size(d);
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
      vel.uSpread.value = leaf ? 1 : 0;
      if (leaf) vel.uLeft.value.set(leaf.x0, leaf.y0, leaf.x1, leaf.y1);
      renderer.setRenderTarget(rt);
      renderer.render(this.bakeScene, c);
      this.bakes++;
    };
    pass(this.rtA, o.densA, o.leaf);
    if (o.needB) pass(this.rtB, o.densB, o.strip);
    renderer.setRenderTarget(prev);
    return true;
  }
  setPlate(p: Plate) {
    const u = this.mat.uniforms;
    u.uVellum.value.set(p.vellum);
    u.uInk.value.set(p.ink);
    u.uAccent.value.set(p.accent);
    u.uAccent2.value.set(p.accent2);
    u.uGold.value.set(p.gold);
    this.dirty = true;
  }
  /**
   * Per frame: the live layer covers the camera's rect. `fold` (0 the open book .. 1 the run's paper) and
   * the crease's x, sweeping across the open `leaf` toward its strip, drive the leaf folding away.
   */
  update(rect: Rect, stage: number, pulse: number, hurt: number, fold = 0, crease = 0, leaf: Rect | null = null) {
    const l = this.live.uniforms;
    // a little beyond the view, so camera shake never shows an edge
    (l.uRect.value as THREE.Vector4).set(rect.x0 - 1.5, rect.y0 - 1.5, rect.x1 + 1.5, rect.y1 + 1.5);
    l.uFold.value = fold;
    l.uCrease.value = leaf ? crease : 1e4;
    l.uLeafX0.value = leaf ? leaf.x0 : -1e4;
    l.uLeafX1.value = leaf ? leaf.x1 : -1e4;
    (l.uLeafY.value as THREE.Vector2).set(leaf ? leaf.y0 : 0, leaf ? leaf.y1 : 0);
    l.uStage.value = stage;
    l.uPulse.value = pulse;
    l.uHurt.value = hurt;
  }
}

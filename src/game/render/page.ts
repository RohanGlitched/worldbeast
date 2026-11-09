import * as THREE from "three";
import { ARENA, Plate } from "@/core/titan";
import { NOISE } from "./glsl";
import { PAGE } from "./stage";

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
    // the expensive paper is baked once per layout; the live layer only adds the beat, wrath and hurt
    const geo = new THREE.PlaneGeometry(2, 2);
    this.bakeMesh = new THREE.Mesh(geo, this.mat);
    this.bakeMesh.frustumCulled = false;
    this.bakeScene.add(this.bakeMesh);
    this.rt = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
    this.live = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: this.rt.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uRect: this.mat.uniforms.uRect,
        uArena: this.mat.uniforms.uArena,
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
        uniform sampler2D uTex; uniform vec2 uRes; uniform vec4 uArena;
        uniform float uStage, uPulse, uHurt; uniform vec3 uGold, uAccent;
        varying vec2 vW;
        void main(){
          vec3 col = texture2D(uTex, gl_FragCoord.xy / uRes).rgb;
          float inA = step(uArena.x, vW.x) * step(vW.x, uArena.z) * step(uArena.y, vW.y) * step(vW.y, uArena.w);
          col *= 1. - .05 * uStage * inA;
          col += uGold * .03 * uPulse * inA;
          float edge = min(min(vW.x - uArena.x, uArena.z - vW.x), min(vW.y - uArena.y, uArena.w - vW.y));
          col = mix(col, uAccent, uHurt * (1. - smoothstep(.0, 7., edge)) * .5 * step(-.5, edge));
          gl_FragColor = vec4(col, 1.);
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
  private bakeMesh: THREE.Mesh;
  private rt: THREE.WebGLRenderTarget;
  private live: THREE.ShaderMaterial;
  private dirty = true;
  private key = "";

  /** Re-bake the paper if the layout or the plate changed. */
  bake(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const u = this.mat.uniforms;
    const k = [size.x, size.y, u.uRect.value.toArray().map((v: number) => v.toFixed(3)).join(","), u.uSpread.value, u.uVellum.value.getHexString(), u.uAccent.value.getHexString()].join("|");
    if (!this.dirty && k === this.key) return;
    this.key = k;
    this.dirty = false;
    if (this.rt.width !== size.x || this.rt.height !== size.y) this.rt.setSize(size.x, size.y);
    (this.live.uniforms.uRes.value as THREE.Vector2).copy(size);
    renderer.setRenderTarget(this.rt);
    renderer.render(this.bakeScene, camera);
    renderer.setRenderTarget(null);
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
  update(rect: { x0: number; y0: number; x1: number; y1: number }, time: number, stage: number, pulse: number, hurt: number, left: { x0: number; y0: number; x1: number; y1: number } | null = null) {
    const u = this.mat.uniforms;
    u.uSpread.value = left ? 1 : 0;
    if (left) u.uLeft.value.set(left.x0, left.y0, left.x1, left.y1);
    u.uRect.value.set(rect.x0, rect.y0, rect.x1, rect.y1);
    u.uTime.value = time;
    const l = this.live.uniforms;
    l.uStage.value = stage;
    l.uPulse.value = pulse;
    l.uHurt.value = hurt;
  }
}

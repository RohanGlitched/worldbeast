import * as THREE from "three";
import { ARENA, Plate } from "@/core/titan";
import { NOISE } from "./glsl";
import { PAGE } from "./stage";

// The vellum leaf, its ruling and margins, and the dark desk beyond it.

export class PageLayer {
  mesh: THREE.Mesh;
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
          // the arena darkens a touch with the titan's wrath; a soft pulse on the downbeat
          col *= 1. - .05 * uStage * inA;
          col += uGold * .035 * uPulse * inA;
          // hurt flash: a vermilion wash at the edges
          float vig = smoothstep(.0, 9., edge);
          col = mix(col, uAccent, uHurt * (1. - vig) * .6);
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
    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    scene.add(this.mesh);
  }
  setPlate(p: Plate) {
    const u = this.mat.uniforms;
    u.uVellum.value.set(p.vellum);
    u.uInk.value.set(p.ink);
    u.uAccent.value.set(p.accent);
    u.uAccent2.value.set(p.accent2);
    u.uGold.value.set(p.gold);
  }
  update(rect: { x0: number; y0: number; x1: number; y1: number }, time: number, stage: number, pulse: number, hurt: number, left: { x0: number; y0: number; x1: number; y1: number } | null = null) {
    const u = this.mat.uniforms;
    u.uSpread.value = left ? 1 : 0;
    if (left) u.uLeft.value.set(left.x0, left.y0, left.x1, left.y1);
    u.uRect.value.set(rect.x0, rect.y0, rect.x1, rect.y1);
    u.uTime.value = time;
    u.uStage.value = stage;
    u.uPulse.value = pulse;
    u.uHurt.value = hurt;
  }
}

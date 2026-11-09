import * as THREE from "three";
import { COLUMN, FieldFrame, LANE, RAIL, STRIDE, TREAD } from "@/core/field";
import { Plate } from "@/core/titan";
import { NOISE } from "./glsl";

// Attacks drawn in the plate's own engraving: hatched and outlined drops, pen-stroke shockwaves,
// cross-hatched glyph floods, engraved beams, dry-point dotted guides. Everything is two instanced
// quads with small SDF shaders (one draw for the drops, one for every other shape).

const MAX_B = 4096;

/** Engraved line helpers shared by both shaders. Lines fade to their mean tone when they would alias. */
const ENGRAVE = /* glsl */ `
const vec3 PAPER = vec3(1., .95, .86);
// parallel lines: v in line units (1 line per unit), halfw = half the line's share of each period
float lines(float v, float halfw){
  float w = fwidth(v);
  float c = 1. - smoothstep(halfw - w, halfw + w, abs(fract(v) - .5));
  return mix(c, halfw * 2., smoothstep(.22, .5, w));
}
// a smooth band of half width h around 0 (distance d), anti-aliased
float band(float d, float h){ float w = fwidth(d) * .9 + .004; return 1. - smoothstep(h - w, h + w, d); }
`;

function colorUniforms() {
  return {
    uInk: { value: new THREE.Color("#231c17") },
    uA: { value: new THREE.Color("#c8321f") },
    uB: { value: new THREE.Color("#2b4a8b") },
    uGold: { value: new THREE.Color("#d6a531") },
    uTime: { value: 0 },
    uPage: { value: new THREE.Vector4(-8.6, -0.9, 8.6, 34.4) },
    uShow: { value: 1 },
  };
}

export class InkLayer {
  private blots: THREE.Mesh;
  private blotGeo: THREE.InstancedBufferGeometry;
  private aData: THREE.InstancedBufferAttribute; // x, y, r, ink
  private aMeta: THREE.InstancedBufferAttribute; // alpha, seed
  private shapes: THREE.Mesh; // beams, rings, zones and marks as instanced quads with an SDF shader
  private shapeGeo: THREE.InstancedBufferGeometry;
  private sA: THREE.InstancedBufferAttribute; // kind, x, y, a
  private sB: THREE.InstancedBufferAttribute; // b, c, d, e
  private sC: THREE.InstancedBufferAttribute; // f, g, ink, live
  readonly uniforms = colorUniforms();

  constructor(scene: THREE.Scene) {
    // --- drops
    const quad = new THREE.PlaneGeometry(2, 2);
    this.blotGeo = new THREE.InstancedBufferGeometry();
    this.blotGeo.index = quad.index;
    this.blotGeo.setAttribute("position", quad.getAttribute("position"));
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_B * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMeta = new THREE.InstancedBufferAttribute(new Float32Array(MAX_B * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.blotGeo.setAttribute("aData", this.aData);
    this.blotGeo.setAttribute("aMeta", this.aMeta);
    this.blotGeo.instanceCount = 0;
    const blotMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 aData; attribute vec4 aMeta;
        varying vec2 vUv; varying float vInk; varying float vAlpha; varying float vSeed; varying float vR; varying vec2 vWp; varying float vTail;
        void main(){
          vInk = aData.w; vAlpha = aMeta.x; vSeed = aMeta.y; vR = aData.z;
          // orient the drop along its flight; the quad grows a tail behind it
          vec2 vel = aMeta.zw; float sp = length(vel);
          vec2 dir = sp > .01 ? vel / sp : vec2(0., -1.);
          vec2 side = vec2(dir.y, -dir.x);
          vTail = clamp(sp * .16, 0., 1.8);
          float s = aData.z * 1.55 * 1.18;
          vec2 lp = position.xy;
          lp.y = lp.y < 0. ? lp.y * (1. + vTail) : lp.y;
          vUv = lp;
          vec2 w = aData.xy + (side * lp.x + dir * lp.y) * s;
          vec3 p = vec3(w, 1.); vWp = p.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uInk, uA, uB, uGold; uniform float uTime, uShow; uniform vec4 uPage;
        varying vec2 vUv; varying float vInk; varying float vAlpha; varying float vSeed; varying float vR; varying vec2 vWp; varying float vTail;
        ${NOISE}
        ${ENGRAVE}
        void main(){
          if (vWp.x < uPage.x || vWp.x > uPage.z || vWp.y < uPage.y || vWp.y > uPage.w) discard;
          vec2 p = vUv * 1.55; // in units of radius; +y is the direction of flight
          float ang = atan(p.y, p.x);
          float wob = (vnoise(vec2(ang * 2.2 + vSeed * 7., vSeed)) - .5) * .14;
          float head = length(p) - 1. - wob;
          // the tail: a tapering pen flick behind the drop
          float tl = vTail * 1.55;
          float ty = clamp(-p.y / max(tl, .001), 0., 1.);
          float tail = (p.y < 0. && tl > .05) ? abs(p.x) - (1. - ty) * .5 - .04 : 9.;
          float d = min(head, tail);
          float aa = fwidth(d) * 1.2;
          float body = 1. - smoothstep(-aa, aa, d);
          if (body < .01 && d > .5) discard;
          vec3 c = vInk < .5 ? uA : vInk < 1.5 ? uB : uGold;
          // engraved bead: a pale wash of the ink, contour hatching across the flight, an inked rim
          float tone = .5 + .5 * vnoise(vec2(vSeed * 13., 2.)); // no two drops cut quite alike
          vec3 wash = mix(PAPER, c, .55 + .2 * tone);
          float hatch = lines(p.y * 1.6 + p.x * .35 + vSeed * 3., .2 + .08 * tone) * step(head, -.18);
          vec3 col = mix(wash, mix(c * .55, uInk, .35), hatch * .85);
          float rim = smoothstep(-.34, -.06, d);
          col = mix(col, uInk * .9 + c * .15, rim);
          // the tail is one dry stroke of ink
          if (tail < head) col = mix(c * .7, uInk, .45);
          // a fleck of paper left uninked: the highlight
          col = mix(col, PAPER, (1. - smoothstep(.12, .2, length(p - vec2(-.34, .36)))) * .9);
          if (vInk > 2.5) col = mix(mix(uInk * .55, uGold * .6, hatch * .5), uGold * 1.1, smoothstep(-.3, -.04, head)); // hound: iron, gilt rim
          if (vInk > 1.5 && vInk < 2.5) col += uGold * .3 * (.5 + .5 * sin(uTime * 9. + vSeed * 20.));
          // a paper halo so drops read against busy ink
          float halo = (1. - smoothstep(0., .45, d)) * step(0., d) * .3;
          float a = max(body, halo) * vAlpha * uShow;
          vec3 outc = mix(PAPER, col, body);
          gl_FragColor = vec4(outc, a);
          #include <colorspace_fragment>
        }
      `,
    });
    this.blots = new THREE.Mesh(this.blotGeo, blotMat);
    this.blots.frustumCulled = false;
    this.blots.renderOrder = 20;
    scene.add(this.blots);

    // --- shapes
    this.shapeGeo = new THREE.InstancedBufferGeometry();
    this.shapeGeo.index = quad.index;
    this.shapeGeo.setAttribute("position", quad.getAttribute("position"));
    const N = 640;
    this.sA = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.sB = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.sC = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.shapeGeo.setAttribute("sA", this.sA);
    this.shapeGeo.setAttribute("sB", this.sB);
    this.shapeGeo.setAttribute("sC", this.sC);
    this.shapeGeo.instanceCount = 0;
    const shapeMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform vec4 uPage;
        attribute vec4 sA; attribute vec4 sB; attribute vec4 sC;
        varying vec2 vW; varying vec4 vA; varying vec4 vB; varying vec4 vC;
        void main(){
          vA = sA; vB = sB; vC = sC;
          float kind = sA.x;
          vec2 c; vec2 h;
          if (kind < .5) { // beam: x1,y1 (sA.yz), x2,y2 (sA.w, sB.x), width sB.y
            vec2 a = sA.yz, b = vec2(sA.w, sB.x); c = (a + b) * .5; h = abs(b - a) * .5 + vec2(sB.y + .7);
          } else if (kind < 1.5) { // ring: cx,cy (sA.yz), R sA.w, width sB.x
            c = sA.yz; h = vec2(sA.w + sB.x + .6);
          } else if (kind < 4.5) { // zone / mark / column: cx,cy, R
            c = sA.yz; h = vec2(sA.w * 1.25 + .5);
            if (kind > 2.5 && kind < 3.5) h = vec2(1.);
            if (kind > 3.5) h = vec2(sA.w + .5, 30.);
          } else { // lane: x, top y, half width; it runs down to the foot of the page
            float bot = uPage.y; c = vec2(sA.y, (sA.z + bot) * .5); h = vec2(sA.w + .4, (sA.z - bot) * .5 + .2);
          }
          vec2 w = c + position.xy * h; vW = w;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 2., 1.);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uInk, uA, uB, uGold; uniform float uTime, uShow; uniform vec4 uPage;
        varying vec2 vW; varying vec4 vA; varying vec4 vB; varying vec4 vC;
        ${NOISE}
        ${ENGRAVE}
        float angDist(float a, float b){ float d = mod(a - b + 3.14159, 6.28318) - 3.14159; return abs(d); }
        void main(){
          if (vW.x < uPage.x || vW.x > uPage.z || vW.y < uPage.y || vW.y > uPage.w) discard;
          float kind = vA.x;
          float ink = vC.z; float live = vC.w;
          vec3 c = ink < .5 ? uA : uB;
          vec3 dark = mix(c * .5, uInk, .45);
          float a = 0.; vec3 col = c;
          if (kind < .5) {
            vec2 p1 = vA.yz, p2 = vec2(vA.w, vB.x); float w = vB.y;
            vec2 dir = normalize(p2 - p1); vec2 nrm = vec2(-dir.y, dir.x);
            vec2 q = vW - p1; float s = dot(q, dir); float n = dot(q, nrm);
            float L = length(p2 - p1);
            float along = clamp(s, 0., L);
            float d = length(q - dir * along);
            if (live < .01) {
              // a hound's aim: a fine dashed dry-point line
              float dash = step(.5, fract(s * 1.6 - uTime * 2.));
              a = band(d, .03) * dash * .55;
              col = mix(uInk, c, .35);
            } else if (live < .999) {
              // beam warning, drawn like dry-point: a row of inked dots along the line it will strike
              // first (swelling as it nears), and for the last stretch its breadth as two dashed rules.
              // Nothing is filled, so a warning never reads as a live beam.
              float pr = clamp((live - .02) / .96, 0., 1.);
              float cell = fract(s * 1.6 - uTime * 1.2) - .5;
              float dotR = mix(.075, .14, pr);
              float dots = band(length(vec2(cell / 1.6, n)), dotR) * step(0., s);
              float late = step(0., s) * smoothstep(.5, .7, pr);
              float dashes = band(abs(abs(n) - w * .5), .028) * lines(s * 1.25 - uTime * .8, .2) * late;
              float pulse = .8 + .2 * sin(uTime * 14.);
              a = max(dots * (.6 + .35 * pr), dashes * .8 * pulse);
              col = mix(uInk, c, (.15 + .45 * pr) * dots);
              float halo = band(length(vec2(cell / 1.6, n)), dotR + .07) * step(0., s) * (1. - dots);
              a = max(a, halo * .3 * pr);
              col = mix(col, PAPER, halo);
            } else {
              // the beam: an engraved shaft, lines running its length, inked edges, a bright core
              float edge = (vnoise(vec2(s * 3., uTime * 2.)) - .5) * .06;
              float hw = w * .5 + edge;
              float body = band(d, hw);
              float coreL = 1. - smoothstep(0., w * .2, d);
              float strokes = lines(n * 9. + vnoise(vec2(s * .7, 1.)) * .6, .22);
              col = mix(mix(PAPER, c, .65), dark, strokes * .8);
              col = mix(col, mix(PAPER, uGold, .35), coreL);
              col = mix(col, uInk, smoothstep(hw - .07, hw - .01, d));
              float halo = (1. - smoothstep(hw, hw + .35, d)) * .25;
              a = max(body, halo);
              col = mix(PAPER, col, body);
            }
          } else if (kind < 1.5) {
            // shockwave: a pen stroke round the ring, swelling mid-arc and tapering to the gaps,
            // hatched across its breadth (it never draws thinner than what can strike you)
            vec2 cc = vA.yz; float R = vA.w, w = vB.x; float gA = vB.y, gW = vB.z, gB = vB.w;
            vec2 q = vW - cc; float r = length(q); float ang = atan(q.y, q.x);
            float da = min(angDist(ang, gA), angDist(ang, gB)) - gW * .5; // radians past the nearest gap edge
            float gap = 1. - smoothstep(-.03, .0, da);
            float arc = max(da, 0.) * R; // arc length from the gap's edge
            float swell = smoothstep(0., 1.2, arc);
            float wob = (vnoise(vec2(ang * 5., R)) - .5) * .06;
            float hw = w * .5 * (1. + .45 * swell) + wob;
            float d = abs(r - R);
            float body = band(d, hw) * (1. - gap);
            float ticks = lines(ang * R * 6., .2);
            col = mix(mix(PAPER, c, .6), dark, ticks * .85);
            col = mix(col, uInk, smoothstep(hw - .06, hw - .01, d));
            float halo = (1. - smoothstep(hw, hw + .4, d)) * .22 * (1. - gap);
            a = max(body, halo);
            col = mix(PAPER, col, body);
          } else if (kind < 2.5) {
            // zone: progress <1 a dry-point circle filling with hatch; >=1 a cross-hatched flood
            vec2 cc = vA.yz; float R = vA.w; float pr = vB.x; float tread = live;
            vec2 q = vW - cc; float r = length(q); float ang = atan(q.y, q.x);
            float wob = (vnoise(vec2(ang * 3. + R * 7., R)) - .5) * .06 * R;
            float h1 = lines(dot(vW, vec2(.707, .707)) * 4.2, .17);
            float h2 = lines(dot(vW, vec2(-.707, .707)) * 4.2, .15);
            float spokes = lines(ang * 2.55 * max(3., floor(R * 5.)), .14); // radial ticks: a footfall
            if (pr < 1.) {
              float ringO = band(abs(r - R - wob), .025);
              float dotsO = lines(ang / 6.28318 * floor(R * 18.) + uTime * .25, .3);
              float ringI = band(abs(r - R * .8), .014) * lines(ang / 6.28318 * floor(R * 10.), .25);
              float inside = 1. - smoothstep(R * pr - .05, R * pr, r);
              float fill = inside * mix(h1, max(h1, h2), smoothstep(.6, .9, pr));
              if (tread > .5) fill = max(fill, inside * spokes * step(R * .3, r));
              float last = smoothstep(.5, .6, pr); // the last beat: the outline inks in solid
              a = max(max(ringO * mix(dotsO, 1., last) * (.55 + .4 * pr), ringI * .5), fill * (.3 + .45 * pr));
              col = mix(uInk, c, .3 + .5 * pr);
              float halo = band(abs(r - R - wob), .1) * (1. - ringO) * last;
              a = max(a, halo * .3);
              col = mix(col, PAPER, halo * .7);
            } else {
              float k = clamp(pr - 1., 0., 1.);
              float edge = (fbm(vW * 1.4 + uTime * .5) - .5) * .25;
              float body = 1. - smoothstep(R - .05 + edge, R + .05 + edge, r);
              float hatch = max(h1, h2);
              if (tread > .5) hatch = max(hatch, spokes * step(R * .25, r));
              col = mix(mix(PAPER, c, .5), dark, hatch * .9);
              float contour = smoothstep(R - .13 + edge, R - .03 + edge, r);
              col = mix(col, uInk, contour);
              a = body * (.95 - .5 * k);
              col = mix(PAPER, col, body);
            }
          } else if (kind < 3.5) {
            vec2 q = vW - vA.yz; float pr = vB.x; float r = length(q); float ang = atan(q.y, q.x);
            if (live > .5) {
              if (abs(vA.y) > 8.1) {
                // side rail: an inked chevron pointing in, at the falling wall's height
                float sx = -sign(vA.y); vec2 u = vec2(q.x * sx, q.y);
                float tri = max(abs(u.y) * 1.1 + u.x * .8 - .5, -u.x - .3);
                a = 1. - smoothstep(-.02, .02, tri);
                float rim = 1. - smoothstep(.0, .06, abs(tri + .05));
                col = mix(uGold * 1.05, uInk, rim);
              } else {
                // a gap post riding the wall: a gilt upright, inked
                float post = max(abs(q.x) - .09, abs(q.y) - .5);
                a = 1. - smoothstep(-.015, .015, post);
                col = mix(uGold * 1.05, uInk, smoothstep(-.05, -.0, post));
              }
            } else {
              // origin sigil: an engraved star that blooms as the attack nears, in a dotted ring
              float petals = abs(cos(ang * 4. + uTime * 3.));
              float sd = r - (.2 + .32 * pr) * (.55 + .45 * petals);
              float star = 1. - smoothstep(-.015, .015, sd);
              float rim = 1. - smoothstep(.0, .045, abs(sd + .02));
              float hatchS = lines(dot(q, vec2(.707, -.707)) * 12., .2);
              float ringR = .9 - .5 * pr;
              float ringO = band(abs(r - ringR), .02) * lines(ang / 6.28318 * 20. - uTime, .3);
              a = max(max(star, rim), ringO * (1. - pr * .3)) * (.4 + .6 * pr);
              col = mix(mix(PAPER, c, .7), dark, hatchS);
              col = mix(col, uInk, max(rim, ringO * (1. - star)));
            }
          } else if (kind < 4.5) {
            // rain column: a faint dotted warning; in the last beat before the fall the dots swell,
            // ink in red and gain a paper halo; while the column rains, a ghost of it remains
            vec2 q = vW - vA.yz; float pr = vB.x;
            float cell = fract(vW.y * 1.6 + uTime * 3.) - .5;
            float raining = step(1., pr);
            float last = smoothstep(.45, .55, pr) * (1. - raining);
            float dotR = mix(.04, .085, last);
            float dots = band(length(vec2(q.x, cell / 1.6)), dotR);
            float line = band(abs(q.x), .01) * (1. - raining);
            float pulse = .8 + .2 * sin(uTime * 16.);
            float lvl = raining > .5 ? .2 * (1. - (pr - 1.) * .6) : mix(.32 + .25 * pr, .95 * pulse, last);
            a = max(dots * lvl, line * (.2 + .25 * pr));
            col = mix(uInk, c, last * .8);
            float halo = band(abs(q.x), .2) * (1. - dots) * last;
            a = max(a, halo * .32);
            col = mix(col, PAPER, halo * (1. - dots));
          } else {
            // a wall's safe lane: gilt hatching between dotted borders; it flares in the beat before
            // the wall drops, then stays faintly lit beneath the falling wall
            vec2 q = vW - vec2(vA.y, vA.z); float R = vA.w; float pr = vB.x;
            if (q.y > 0.) discard;
            float inside = 1. - smoothstep(R - .03, R, abs(q.x));
            float border = band(abs(abs(q.x) - R), .025) * lines(vW.y * 2.2 - uTime * 2., .28);
            float hatchL = lines((vW.x + vW.y) * 2.6, .12) * inside;
            float lastBeat = smoothstep(.45, .55, pr) * step(pr, .999);
            float flash = lastBeat * (.6 + .4 * sin(uTime * 18.));
            float lvl = pr < 1. ? .12 + .5 * flash : .2 * (1. - smoothstep(-2.5, 0., q.y) * .6);
            a = max(hatchL * lvl, border * (pr < 1. ? .35 + .55 * lastBeat : .45));
            a = max(a, inside * flash * .08);
            col = mix(uGold * .95, uInk, border * .55);
          }
          a *= uShow;
          if (a < .005) discard;
          gl_FragColor = vec4(col, a);
          #include <colorspace_fragment>
        }
      `,
    });
    this.shapes = new THREE.Mesh(this.shapeGeo, shapeMat);
    this.shapes.frustumCulled = false;
    this.shapes.renderOrder = 15;
    scene.add(this.shapes);
  }

  setPlate(p: Plate) {
    this.uniforms.uInk.value.set(p.ink);
    this.uniforms.uA.value.set(p.accent);
    this.uniforms.uB.value.set(p.accent2);
    this.uniforms.uGold.value.set(p.gold);
  }

  update(f: FieldFrame, time: number) {
    this.uniforms.uTime.value = time;
    const { B, BM, RG, ZN, MK } = STRIDE;
    const n = Math.min(f.bulletCount, MAX_B);
    const d = this.aData.array as Float32Array;
    const m = this.aMeta.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const o = i * B;
      d[i * 4] = f.bullets[o];
      d[i * 4 + 1] = f.bullets[o + 1];
      d[i * 4 + 2] = f.bullets[o + 2];
      d[i * 4 + 3] = f.bullets[o + 3];
      m[i * 4] = f.bullets[o + 4];
      if (f.bullets[o + 5] >= 12) d[i * 4 + 3] = 3; // hound
      m[i * 4 + 1] = (f.bulletIds[i] % 977) / 977;
      m[i * 4 + 2] = f.bullets[o + 6];
      m[i * 4 + 3] = f.bullets[o + 7];
    }
    this.aData.needsUpdate = true;
    this.aMeta.needsUpdate = true;
    this.aData.clearUpdateRanges();
    this.aData.addUpdateRange(0, n * 4);
    this.aMeta.clearUpdateRanges();
    this.aMeta.addUpdateRange(0, n * 4);
    this.blotGeo.instanceCount = n;

    const A = this.sA.array as Float32Array,
      Bq = this.sB.array as Float32Array,
      C = this.sC.array as Float32Array;
    let k = 0;
    const cap = A.length / 4;
    const put = (a0: number, a1: number, a2: number, a3: number, b0: number, b1: number, b2: number, b3: number, c0: number, c1: number, c2: number, c3: number) => {
      if (k >= cap) return;
      A[k * 4] = a0; A[k * 4 + 1] = a1; A[k * 4 + 2] = a2; A[k * 4 + 3] = a3;
      Bq[k * 4] = b0; Bq[k * 4 + 1] = b1; Bq[k * 4 + 2] = b2; Bq[k * 4 + 3] = b3;
      C[k * 4] = c0; C[k * 4 + 1] = c1; C[k * 4 + 2] = c2; C[k * 4 + 3] = c3;
      k++;
    };
    // guides first (lanes, columns), so hazards always draw over them
    for (let i = 0; i < f.zoneCount; i++) {
      const o = i * ZN;
      const ink = f.zones[o + 4];
      if (ink >= LANE) put(5, f.zones[o], f.zones[o + 1], f.zones[o + 2], f.zones[o + 3], 0, 0, 0, 0, 0, ink - LANE, 0);
      else if (ink >= COLUMN) put(4, f.zones[o], f.zones[o + 1], f.zones[o + 2], f.zones[o + 3], 0, 0, 0, 0, 0, ink - COLUMN, 0);
    }
    for (let i = 0; i < f.zoneCount; i++) {
      const o = i * ZN;
      const ink = f.zones[o + 4];
      if (ink >= COLUMN) continue;
      const tread = ink >= TREAD ? 1 : 0;
      put(2, f.zones[o], f.zones[o + 1], f.zones[o + 2], f.zones[o + 3], 0, 0, 0, 0, 0, tread ? ink - TREAD : ink, tread);
    }
    for (let i = 0; i < f.beamCount; i++) {
      const o = i * BM;
      put(0, f.beams[o], f.beams[o + 1], f.beams[o + 2], f.beams[o + 3], f.beams[o + 4], 0, 0, 0, 0, f.beams[o + 6], f.beams[o + 5]);
    }
    for (let i = 0; i < f.ringCount; i++) {
      const o = i * RG;
      put(1, f.rings[o], f.rings[o + 1], f.rings[o + 2], f.rings[o + 3], f.rings[o + 4], f.rings[o + 5], f.rings[o + 6], 0, 0, f.rings[o + 8], f.rings[o + 7]);
    }
    for (let i = 0; i < f.markCount; i++) {
      const o = i * MK;
      const ink = f.marks[o + 3];
      const rail = ink >= RAIL ? 1 : 0;
      put(3, f.marks[o], f.marks[o + 1], 1, f.marks[o + 2], 0, 0, 0, 0, 0, rail ? ink - RAIL : ink, rail);
    }
    this.sA.needsUpdate = this.sB.needsUpdate = this.sC.needsUpdate = true;
    this.shapeGeo.instanceCount = k;
  }
}

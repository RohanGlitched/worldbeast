import * as THREE from "three";
import { FieldFrame, STRIDE } from "@/core/field";
import { Plate } from "@/core/titan";
import { NOISE } from "./glsl";

// Attacks drawn as wet ink: blots, brush beams, ring strokes, glyph circles, origin sigils.

const MAX_B = 4096;

function colorUniforms() {
  return {
    uInk: { value: new THREE.Color("#231c17") },
    uA: { value: new THREE.Color("#c8321f") },
    uB: { value: new THREE.Color("#2b4a8b") },
    uGold: { value: new THREE.Color("#d6a531") },
    uTime: { value: 0 },
    uPage: { value: new THREE.Vector4(-8.6, -0.9, 8.6, 33.2) },
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
    // --- blots
    const quad = new THREE.PlaneGeometry(2, 2);
    this.blotGeo = new THREE.InstancedBufferGeometry();
    this.blotGeo.index = quad.index;
    this.blotGeo.setAttribute("position", quad.getAttribute("position"));
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_B * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMeta = new THREE.InstancedBufferAttribute(new Float32Array(MAX_B * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.blotGeo.setAttribute("aData", this.aData);
    this.blotGeo.setAttribute("aMeta", this.aMeta);
    this.blotGeo.instanceCount = 0;
    const blotMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 aData; attribute vec2 aMeta;
        varying vec2 vUv; varying float vInk; varying float vAlpha; varying float vSeed; varying float vR; varying vec2 vWp;
        void main(){
          vUv = position.xy; vInk = aData.w; vAlpha = aMeta.x; vSeed = aMeta.y; vR = aData.z;
          float s = aData.z * 1.55;
          vec3 p = vec3(aData.xy + position.xy * s, 1.); vWp = p.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uInk, uA, uB, uGold; uniform float uTime; uniform vec4 uPage;
        varying vec2 vUv; varying float vInk; varying float vAlpha; varying float vSeed; varying float vR; varying vec2 vWp;
        ${NOISE}
        void main(){
          if (vWp.x < uPage.x || vWp.x > uPage.z || vWp.y < uPage.y || vWp.y > uPage.w) discard;
          vec2 p = vUv * 1.55; // in units of radius
          float ang = atan(p.y, p.x);
          float wob = (vnoise(vec2(ang * 2.2 + vSeed * 7., vSeed)) - .5) * .16 + (vnoise(vec2(ang * 6. + vSeed, 3.)) - .5) * .06;
          float d = length(p) - 1. - wob;
          float aa = fwidth(d) * 1.2;
          float body = 1. - smoothstep(-aa, aa, d);
          if (body < .01 && d > .5) discard;
          vec3 c = vInk < .5 ? uA : vInk < 1.5 ? uB : uGold;
          // pooled pigment: darker rim, lighter wet centre, a tiny specular bead
          float rim = smoothstep(-.42, -.02, d);
          vec3 col = mix(c * 1.12, c * .55 + uInk * .25, rim);
          vec2 hl = p - vec2(-.32, .34);
          col += vec3(1.) * .35 * (1. - smoothstep(.0, .22, length(hl)));
          if (vInk > 1.5) col += uGold * .4 * (.5 + .5 * sin(uTime * 9. + vSeed * 20.));
          // soft halo so attacks read against busy ink
          float halo = (1. - smoothstep(0., .45, d)) * step(0., d) * .28;
          float a = max(body, halo) * vAlpha;
          vec3 outc = mix(vec3(1.,.96,.88), col, body);
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
    const N = 512;
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
        attribute vec4 sA; attribute vec4 sB; attribute vec4 sC;
        varying vec2 vW; varying vec4 vA; varying vec4 vB; varying vec4 vC;
        void main(){
          vA = sA; vB = sB; vC = sC;
          float kind = sA.x;
          vec2 c; vec2 h;
          if (kind < .5) { // beam: x1,y1 (sA.yz), x2,y2 (sA.w, sB.x), width sB.y
            vec2 a = sA.yz, b = vec2(sA.w, sB.x); c = (a + b) * .5; h = abs(b - a) * .5 + vec2(sB.y + .6);
          } else if (kind < 1.5) { // ring: cx,cy (sA.yz), R sA.w, width sB.x
            c = sA.yz; h = vec2(sA.w + sB.x + .6);
          } else { // zone / mark / column: cx,cy, R
            c = sA.yz; h = vec2(sA.w * 1.25 + .5);
            if (kind > 3.5) h = vec2(sA.w + .5, 30.);
          }
          vec2 w = c + position.xy * h; vW = w;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 2., 1.);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uInk, uA, uB, uGold; uniform float uTime; uniform vec4 uPage;
        varying vec2 vW; varying vec4 vA; varying vec4 vB; varying vec4 vC;
        ${NOISE}
        float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa,ba)/dot(ba,ba), 0., 1.); return length(pa - ba*h); }
        float angDist(float a, float b){ float d = mod(a - b + 3.14159, 6.28318) - 3.14159; return abs(d); }
        void main(){
          if (vW.x < uPage.x || vW.x > uPage.z || vW.y < uPage.y || vW.y > uPage.w) discard;
          float kind = vA.x;
          float ink = vC.z; float live = vC.w;
          vec3 c = ink < .5 ? uA : uB;
          float a = 0.; vec3 col = c;
          if (kind < .5) {
            vec2 p1 = vA.yz, p2 = vec2(vA.w, vB.x); float w = vB.y;
            float d = sdSeg(vW, p1, p2);
            if (live < .5) {
              // telegraph: a dashed dry-point guide that thickens as the strike nears
              vec2 dir = normalize(p2 - p1); float s = dot(vW - p1, dir);
              float dash = step(.5, fract(s * .9 - uTime * 2.));
              a = (1. - smoothstep(.04, .07, d)) * dash * .85;
              col = uInk;
            } else {
              float edge = (vnoise(vec2(dot(vW, vec2(1.3, .7)) * 3., uTime * 2.)) - .5) * .12;
              float body = 1. - smoothstep(w * .5 - .03 + edge, w * .5 + .03 + edge, d);
              float core = 1. - smoothstep(.0, w * .22, d);
              col = mix(c * .7, c * 1.15 + .1, core);
              float halo = (1. - smoothstep(w * .5, w * .5 + .35, d)) * .25;
              a = max(body, halo);
              col = mix(vec3(1., .95, .86), col, body);
            }
          } else if (kind < 1.5) {
            vec2 cc = vA.yz; float R = vA.w, w = vB.x; float gA = vB.y, gW = vB.z, gB = vB.w;
            vec2 q = vW - cc; float r = length(q); float ang = atan(q.y, q.x);
            float gap = max(1. - smoothstep(gW * .5 - .04, gW * .5, angDist(ang, gA)), 1. - smoothstep(gW * .5 - .04, gW * .5, angDist(ang, gB)));
            float d = abs(r - R);
            float wob = (vnoise(vec2(ang * 5., R)) - .5) * .1;
            float body = (1. - smoothstep(w * .5 - .03 + wob, w * .5 + .03 + wob, d)) * (1. - gap);
            float halo = (1. - smoothstep(w * .5, w * .5 + .4, d)) * .22 * (1. - gap);
            a = max(body, halo);
            col = mix(vec3(1., .95, .86), mix(c * .65, c * 1.1, 1. - d / (w * .5 + .001)), body);
          } else if (kind < 2.5) {
            // zone: progress <1 telegraph glyph (concentric rings filling), >=1 live wash
            vec2 cc = vA.yz; float R = vA.w; float pr = vB.x;
            float r = length(vW - cc); float ang = atan(vW.y - cc.y, vW.x - cc.x);
            if (pr < 1.) {
              float ringO = 1. - smoothstep(.02, .06, abs(r - R));
              float ringI = 1. - smoothstep(.015, .045, abs(r - R * .78));
              float ticks = step(.82, fract(ang / 6.28318 * 16. + uTime * .3)) * step(R * .8, r) * step(r, R * .97);
              float fill = (1. - smoothstep(R * pr - .05, R * pr, r)) * .22;
              a = max(max(ringO, ringI * .7), max(ticks * .8, fill));
              col = mix(uInk, c, .35 + .65 * pr);
            } else {
              float k = clamp(pr - 1., 0., 1.);
              float wob = (fbm(vW * 1.6 + uTime) - .5) * .35;
              float body = 1. - smoothstep(R - .05 + wob, R + .05 + wob, r);
              float pool = smoothstep(R * .2, R, r);
              col = mix(c * 1.1, c * .6, pool);
              a = body * (.92 - .55 * k);
              col = mix(vec3(1., .95, .86), col, body);
            }
          } else if (kind < 3.5) {
            // origin sigil: a small illuminated star that blooms as the attack nears
            vec2 q = vW - vA.yz; float pr = vB.x; float r = length(q); float ang = atan(q.y, q.x);
            float petals = abs(cos(ang * 4. + uTime * 3.));
            float star = 1. - smoothstep(.0, .05, r - (.22 + .35 * pr) * (.55 + .45 * petals));
            float ringO = (1. - smoothstep(.02, .05, abs(r - (.9 - .5 * pr)))) * (1. - pr * .3);
            a = max(star, ringO) * (.35 + .65 * pr);
            col = mix(uInk, c, star);
          } else {
            // rain column telegraph: a thin vertical guide with ticks
            vec2 q = vW - vA.yz; float pr = vB.x;
            float line = 1. - smoothstep(.02, .05, abs(q.x));
            float tick = step(.7, fract(vW.y * .8 - uTime * 4.)) * (1. - smoothstep(.1, .16, abs(q.x)));
            a = max(line * .55, tick * .7) * (.25 + .75 * pr);
            col = c;
          }
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
      m[i * 2] = f.bullets[o + 4];
      m[i * 2 + 1] = (f.bulletIds[i] % 977) / 977;
    }
    this.aData.needsUpdate = true;
    this.aMeta.needsUpdate = true;
    this.aData.clearUpdateRanges();
    this.aData.addUpdateRange(0, n * 4);
    this.aMeta.clearUpdateRanges();
    this.aMeta.addUpdateRange(0, n * 2);
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
    for (let i = 0; i < f.beamCount; i++) {
      const o = i * BM;
      put(0, f.beams[o], f.beams[o + 1], f.beams[o + 2], f.beams[o + 3], f.beams[o + 4], 0, 0, 0, 0, f.beams[o + 6], f.beams[o + 5]);
    }
    for (let i = 0; i < f.ringCount; i++) {
      const o = i * RG;
      put(1, f.rings[o], f.rings[o + 1], f.rings[o + 2], f.rings[o + 3], f.rings[o + 4], f.rings[o + 5], f.rings[o + 6], 0, 0, f.rings[o + 8], f.rings[o + 7]);
    }
    for (let i = 0; i < f.zoneCount; i++) {
      const o = i * ZN;
      const ink = f.zones[o + 4];
      if (ink >= 10) put(4, f.zones[o], f.zones[o + 1], f.zones[o + 2], f.zones[o + 3], 0, 0, 0, 0, 0, ink - 10, 0);
      else put(2, f.zones[o], f.zones[o + 1], f.zones[o + 2], f.zones[o + 3], 0, 0, 0, 0, 0, ink, 0);
    }
    for (let i = 0; i < f.markCount; i++) {
      const o = i * MK;
      put(3, f.marks[o], f.marks[o + 1], 1, f.marks[o + 2], 0, 0, 0, 0, 0, f.marks[o + 3], 0);
    }
    this.sA.needsUpdate = this.sB.needsUpdate = this.sC.needsUpdate = true;
    this.shapeGeo.instanceCount = k;
  }
}

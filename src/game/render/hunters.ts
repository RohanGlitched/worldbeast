import * as THREE from "three";
import { SPAWN_GRACE } from "@/core/hunt";
import { NOISE } from "./glsl";

// Hunters are engraved sigils. Your own is the gilded four-pointed star with a ribbon of gold ink
// behind it (and, while your grace lasts, a dotted ring that shrinks to nothing). Other hunters are
// drawn from the same three inks as the page (iron-gall black, vermilion, gold) in one of six cut
// glyphs, so every hunter is distinguishable without a rainbow. Echoes are pale dotted outlines.

export interface HunterDraw {
  x: number;
  y: number;
  kind: 0 | 1 | 2 | 3; // 0 you, 1 live hunter, 2 echo, 3 downed spark
  hue: number; // 0..1 sigil: picks the glyph and its ink
  inv: number; // 0..1 invulnerability blink
  dash: number; // 0..1
  surge: number; // 0..1
  seed: number;
  /** your own spark only: the fraction of spawn grace left (0..1). Inferred from `inv` when absent. */
  grace?: number;
}

const MAX = 128;
const TRAIL = 28;

export class HunterLayer {
  private geo: THREE.InstancedBufferGeometry;
  private a: THREE.InstancedBufferAttribute; // x, y, kind, hue (yours: grace left)
  private b: THREE.InstancedBufferAttribute; // inv, dash, surge, seed
  private mesh: THREE.Mesh;
  private trail: THREE.Mesh;
  private trailPos: Float32Array;
  private trailPts: Array<[number, number]> = [];
  private spawnAt = -1;
  private graceDone = true;
  private graceShown = 0;
  private lastTime = 0;
  readonly uniforms = {
    uTime: { value: 0 },
    uGold: { value: new THREE.Color("#d6a531") },
    uInk: { value: new THREE.Color("#231c17") },
    uRed: { value: new THREE.Color("#b3261e") },
  };
  constructor(scene: THREE.Scene) {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("hA", this.a);
    this.geo.setAttribute("hB", this.b);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 hA; attribute vec4 hB; varying vec2 vUv; varying vec4 vA; varying vec4 vB; varying float vGrow;
        void main(){ vA = hA; vB = hB;
          float s = hA.z < .5 ? 1.45 : hA.z < 1.5 ? 1.0 : hA.z < 2.5 ? .85 : 1.15;
          s *= 1. + hB.z * .5;
          // your own quad grows to hold the grace ring; the star keeps its size inside it
          vGrow = hA.z < .5 ? 1. + .9 * hA.w : 1.;
          vUv = position.xy * vGrow;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(hA.xy + position.xy * s * vGrow, 3., 1.); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime; uniform vec3 uGold, uInk, uRed;
        varying vec2 vUv; varying vec4 vA; varying vec4 vB; varying float vGrow;
        ${NOISE}
        const vec3 PAPER = vec3(1., .96, .86);
        float lines(float v, float halfw){ float w = fwidth(v); float c = 1. - smoothstep(halfw - w, halfw + w, abs(fract(v) - .5)); return mix(c, halfw * 2., smoothstep(.22, .5, w)); }
        mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
        // six cut glyphs, each about .5 across (distance-like: < 0 inside)
        float glyph(vec2 p, float g){
          float r = length(p), a = atan(p.y, p.x);
          if (g < .5) return r - (.14 + .36 * pow(abs(cos(a * 2.)), 10.) + .12 * pow(abs(cos(a * 2. + .785)), 14.)); // four-pointed star
          if (g < 1.5) return r - (.12 + .36 * pow(abs(cos(a * 3.)), 6.)); // six-rayed asterisk
          if (g < 2.5) { vec2 q = abs(p); if (q.y > q.x) q = q.yx; return max(q.y - (.06 + .3 * q.x), q.x - .46); } // cross pattee
          if (g < 3.5) return (abs(p.x) * .8 + abs(p.y)) * .9 - .38; // lozenge
          if (g < 4.5) { float d = 9.; for (int k = 0; k < 3; k++) { float t = 1.5708 + float(k) * 2.0944; d = min(d, length(p - .19 * vec2(cos(t), sin(t))) - .17); } return d; } // trefoil
          return min(r - .2, r - (.18 + .3 * pow(abs(cos(a * 4.)), 18.))); // sun in splendour
        }
        void main(){
          vec2 p = vUv; float r = length(p); float ang = atan(p.y, p.x);
          float kind = vA.z; float seed = vB.w;
          vec3 col; float a;
          if (kind < .5) {
            // you: a gilded four-pointed star around a bright hitbox pip, inside a warm halo
            float spin = uTime * .9 + seed * 6.;
            float a4 = ang + spin * .35;
            float rays = pow(abs(cos(a4 * 2.)), 10.);
            float rays2 = pow(abs(cos(a4 * 2. + .785)), 14.);
            float sd = r - (.16 + .38 * rays + .14 * rays2);
            float star = 1. - smoothstep(-.012, .012, sd);
            float edge = 1. - smoothstep(.0, .045, abs(sd));
            float ring = 1. - smoothstep(.01, .03, abs(r - .66 - .02 * sin(uTime * 4. + seed * 9.)));
            float halo = pow(1. - smoothstep(0., 1., r), 2.2);
            vec3 leaf = mix(uGold * .85, uGold * 1.25 + .08, smoothstep(-.3, .3, p.x * cos(spin) + p.y * sin(spin)));
            col = mix(PAPER, leaf, star);
            col = mix(col, uInk, edge * (1. - star * .55));
            a = max(star, edge);
            a = max(a, ring * .85);
            col = mix(col, uInk * 1.2, ring * (1. - star) * .6);
            a = max(a, halo * .5);
            float pip = 1. - smoothstep(.07, .095, r);
            float pipRing = 1. - smoothstep(.0, .03, abs(r - .11));
            col = mix(col, uInk, pipRing);
            col = mix(col, PAPER, pip);
            a = max(a, max(pip, pipRing));
            // grace: an engraved dotted ring that closes in on you; when it meets the star, you can be struck
            float g = vA.w;
            if (g > .001) {
              float gr = .66 + .9 * g;
              float circle = 1. - smoothstep(.015, .045, abs(r - gr));
              float dots = lines(ang / 6.28318 * 28. + uTime * .6, .3);
              float inner = 1. - smoothstep(.006, .022, abs(r - gr + .09));
              float gA = max(circle * dots, inner * .7) * smoothstep(.0, .08, g);
              col = mix(col, mix(uInk, uGold, dots * .6), gA * (1. - star));
              a = max(a, gA * .9);
              float paperHalo = (1. - smoothstep(.0, .12, abs(r - gr))) * (1. - circle) * .35 * smoothstep(.0, .08, g);
              col = mix(col, PAPER, paperHalo * (1. - star));
              a = max(a, paperHalo);
            }
          } else {
            // another hunter: one of six glyphs, in black, vermilion or gold, hatched and outlined
            float hue = fract(vA.w);
            float gi = floor(hue * 6.);
            float ii = floor(fract(hue * 6.) * 2.999);
            vec3 ink = ii < .5 ? uGold : ii < 1.5 ? uRed : uInk * 1.3;
            vec2 q = rot(uTime * .5 + seed * 6.) * p;
            float sd = glyph(q, gi);
            float aa = fwidth(sd) + .004;
            float body = 1. - smoothstep(-aa, aa, sd);
            float edge = 1. - smoothstep(.0, .035 + aa, abs(sd));
            float hatch = lines(dot(q, vec2(.6, .8)) * 14., .22) * step(sd, -.05);
            col = mix(mix(PAPER, ink, .82), ink * .55 + uInk * .3, hatch);
            if (ii > 1.5) col = mix(uInk * 1.5 + .06, PAPER * .8, hatch * .5); // black glyphs show their cut in paper
            col = mix(col, uInk, edge * (1. - body * .4));
            float ring = 1. - smoothstep(.01, .03, abs(r - .66 - .02 * sin(uTime * 4. + seed * 9.)));
            a = max(body, edge);
            a = max(a, ring * .4);
            col = mix(col, uInk, ring * (1. - body) * .7);
            float halo = pow(1. - smoothstep(0., 1., r), 2.2);
            a = max(a, halo * .2);
            col = mix(PAPER, col, max(body, max(edge, ring)));
            if (kind > 1.5 && kind < 2.5) { // echo: the glyph as a pale dotted outline, no glow
              float dots = step(.5, fract(ang / 6.28318 * 12. + uTime * .2));
              a = max(edge * .5, ring * dots * .45) + body * .12;
              col = mix(vec3(.55, .5, .45), ink, .3);
            }
            if (kind > 2.5) { // downed spark: a flickering ember waiting for a hunter to pass through
              float fl = .5 + .5 * sin(uTime * 10. + seed * 30.);
              a = max(body, ring) * (.35 + .4 * fl); col = mix(uGold, vec3(1., .5, .3), .4);
            }
          }
          // invulnerability blink and dash smear
          a *= 1. - vB.x * step(.5, fract(uTime * 12.)) * .65 * step(r, .8);
          col = mix(col, vec3(1.), vB.y * .5);
          if (a < .01) discard;
          gl_FragColor = vec4(col, a);
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    scene.add(this.mesh);

    // gold-ink ribbon behind your own spark
    this.trailPos = new Float32Array(TRAIL * 2 * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    const tAlpha = new Float32Array(TRAIL * 2);
    for (let i = 0; i < TRAIL; i++) tAlpha[i * 2] = tAlpha[i * 2 + 1] = 1 - i / TRAIL;
    tg.setAttribute("aT", new THREE.BufferAttribute(tAlpha, 1));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    tg.setIndex(idx);
    const tm = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform vec3 uGold; varying float vT; void main(){ gl_FragColor = vec4(uGold * (.8 + .4 * vT), vT * .75);
        #include <colorspace_fragment>
      }`,
    });
    this.trail = new THREE.Mesh(tg, tm);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 29;
    scene.add(this.trail);
  }

  setGold(hex: string, ink: string, red?: string) {
    this.uniforms.uGold.value.set(hex);
    this.uniforms.uInk.value.set(ink);
    if (red) this.uniforms.uRed.value.set(red);
  }

  /** The grace ring's size for your spark: the caller's `grace` if given, else inferred from spawn time and `inv`. */
  private graceOf(me: HunterDraw | undefined, time: number): number {
    if (!me) {
      this.spawnAt = -1;
      this.graceDone = false;
      this.graceShown = 0;
      return 0;
    }
    if (this.spawnAt < 0) this.spawnAt = time;
    let g = 0;
    if (me.grace !== undefined) g = me.grace;
    else if (!this.graceDone) {
      if (me.inv <= 0 && time - this.spawnAt > 0.3) this.graceDone = true;
      else {
        const left = me.inv < 1 ? me.inv : Math.max(1, SPAWN_GRACE - (time - this.spawnAt));
        g = Math.min(1, left / SPAWN_GRACE);
      }
    }
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.graceShown += (g - this.graceShown) * Math.min(1, dt * 12);
    if (g === 0 && this.graceShown < 0.01) this.graceShown = 0;
    return this.graceShown;
  }

  update(list: HunterDraw[], time: number, me: { x: number; y: number; alive: boolean } | null) {
    this.uniforms.uTime.value = time;
    const A = this.a.array as Float32Array,
      Bv = this.b.array as Float32Array;
    const n = Math.min(list.length, MAX);
    // draw others first, yourself last (on top)
    const sorted = list.slice(0, n).sort((p, q) => (p.kind === 0 ? 1 : 0) - (q.kind === 0 ? 1 : 0));
    const grace = this.graceOf(sorted.find((h) => h.kind === 0), time);
    this.lastTime = time;
    sorted.forEach((h, i) => {
      A[i * 4] = h.x;
      A[i * 4 + 1] = h.y;
      A[i * 4 + 2] = h.kind;
      A[i * 4 + 3] = h.kind === 0 ? grace : h.hue;
      Bv[i * 4] = h.inv;
      Bv[i * 4 + 1] = h.dash;
      Bv[i * 4 + 2] = h.surge;
      Bv[i * 4 + 3] = h.seed;
    });
    this.a.needsUpdate = this.b.needsUpdate = true;
    this.geo.instanceCount = n;
    // ribbon
    if (me && me.alive) {
      this.trailPts.unshift([me.x, me.y]);
      if (this.trailPts.length > TRAIL) this.trailPts.length = TRAIL;
    } else if (this.trailPts.length) this.trailPts.pop();
    const pts = this.trailPts;
    for (let i = 0; i < TRAIL; i++) {
      const p = pts[Math.min(i, pts.length - 1)] ?? [0, -50];
      const q = pts[Math.min(i + 1, pts.length - 1)] ?? p;
      let dx = p[0] - q[0],
        dy = p[1] - q[1];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L;
      dy /= L;
      const w = 0.16 * (1 - i / TRAIL) + 0.02;
      this.trailPos.set([p[0] - dy * w, p[1] + dx * w, 2.5, p[0] + dy * w, p[1] - dx * w, 2.5], i * 6);
    }
    (this.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.trail.visible = pts.length > 2;
  }
}

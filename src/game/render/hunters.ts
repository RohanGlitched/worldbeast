import * as THREE from "three";
import { NOISE } from "./glsl";

// Hunters are gilded sparks: your own is bright with a ribbon of gold ink behind it,
// live hunters are tinted with their sigil colour, echoes are pale and dotted.

export interface HunterDraw {
  x: number;
  y: number;
  kind: 0 | 1 | 2 | 3; // 0 you, 1 live hunter, 2 echo, 3 downed spark
  hue: number; // 0..1 sigil colour
  inv: number; // 0..1 invulnerability blink
  dash: number; // 0..1
  surge: number; // 0..1
  seed: number;
}

const MAX = 128;
const TRAIL = 28;

export class HunterLayer {
  private geo: THREE.InstancedBufferGeometry;
  private a: THREE.InstancedBufferAttribute; // x, y, kind, hue
  private b: THREE.InstancedBufferAttribute; // inv, dash, surge, seed
  private mesh: THREE.Mesh;
  private trail: THREE.Mesh;
  private trailPos: Float32Array;
  private trailPts: Array<[number, number]> = [];
  readonly uniforms = { uTime: { value: 0 }, uGold: { value: new THREE.Color("#d6a531") }, uInk: { value: new THREE.Color("#231c17") } };
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
        attribute vec4 hA; attribute vec4 hB; varying vec2 vUv; varying vec4 vA; varying vec4 vB;
        void main(){ vUv = position.xy; vA = hA; vB = hB;
          float s = hA.z < .5 ? 1.25 : hA.z < 1.5 ? .95 : hA.z < 2.5 ? .8 : 1.1;
          s *= 1. + hB.z * .5;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(hA.xy + position.xy * s, 3., 1.); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime; uniform vec3 uGold, uInk;
        varying vec2 vUv; varying vec4 vA; varying vec4 vB;
        ${NOISE}
        vec3 hue2rgb(float h){ return clamp(abs(mod(h * 6. + vec3(0., 4., 2.), 6.) - 3.) - 1., 0., 1.); }
        void main(){
          vec2 p = vUv; float r = length(p); float ang = atan(p.y, p.x);
          float kind = vA.z; float seed = vB.w;
          // a four-pointed illuminated star with a fine ring
          float spin = uTime * (kind < .5 ? 1.2 : .6) + seed * 6.;
          float star = abs(cos((ang + spin * .3) * 2.));
          float body = 1. - smoothstep(.0, .04, r - (.16 + .3 * pow(star, 6.)));
          float ring = 1. - smoothstep(.01, .035, abs(r - .52 - .03 * sin(uTime * 4. + seed * 9.)));
          float glow = (1. - smoothstep(0., .9, r)) * .45;
          vec3 tint = kind < .5 ? uGold : mix(uGold, hue2rgb(vA.w) * .85, .55);
          vec3 col = mix(tint * 1.15, vec3(1., .96, .82), body * .6);
          float a = max(body, ring * (kind < .5 ? .95 : .6));
          a = max(a, glow * (kind < .5 ? 1. : .5));
          col = mix(vec3(1., .94, .8), col, max(body, ring));
          // ink outline so the spark reads on pale vellum
          float outline = (1. - smoothstep(.0, .035, abs(r - (.18 + .3 * pow(star, 6.)) - .03))) * .9;
          col = mix(col, uInk, outline * (1. - body));
          a = max(a, outline);
          if (kind > 1.5 && kind < 2.5) { // echo: pale, dotted ring, no glow
            float dots = step(.5, fract(ang / 6.28318 * 12. + uTime * .2));
            a = max(body * .45, ring * dots * .5); col = mix(vec3(.55,.5,.45), uGold, .35);
          }
          if (kind > 2.5) { // downed spark: a flickering ember waiting for a hunter to pass through
            float fl = .5 + .5 * sin(uTime * 10. + seed * 30.);
            a = max(body, ring) * (.35 + .4 * fl); col = mix(uGold, vec3(1.,.5,.3), .4);
          }
          // invulnerability blink and dash smear
          a *= 1. - vB.x * step(.5, fract(uTime * 12.)) * .65;
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

  setGold(hex: string, ink: string) {
    this.uniforms.uGold.value.set(hex);
    this.uniforms.uInk.value.set(ink);
  }

  update(list: HunterDraw[], time: number, me: { x: number; y: number; alive: boolean } | null) {
    this.uniforms.uTime.value = time;
    const A = this.a.array as Float32Array,
      Bv = this.b.array as Float32Array;
    const n = Math.min(list.length, MAX);
    // draw others first, yourself last (on top)
    const sorted = list.slice(0, n).sort((p, q) => (p.kind === 0 ? 1 : 0) - (q.kind === 0 ? 1 : 0));
    sorted.forEach((h, i) => {
      A[i * 4] = h.x;
      A[i * 4 + 1] = h.y;
      A[i * 4 + 2] = h.kind;
      A[i * 4 + 3] = h.hue;
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

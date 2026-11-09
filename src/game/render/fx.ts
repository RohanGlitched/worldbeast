import * as THREE from "three";

// Particles: gold flecks from wounded cores, ink spatter when a hunter is struck, dart streaks,
// burst rings. Simulated on the CPU (a few hundred at most), drawn as one instanced mesh.

const MAX = 1200;
export const enum P {
  Fleck = 0,
  Ink = 1,
  Streak = 2,
  Ring = 3,
  Spore = 4,
  /** ink bleeding down the page (a felled titan): a droplet drawn out along its fall */
  Drip = 5,
}

interface Part {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  type: number;
  col: number; // 0 gold, 1 accent, 2 accent2, 3 ink, 4 white
  rot: number;
  drag: number;
  g: number;
}

export class FxLayer {
  private parts: Part[] = [];
  private geo: THREE.InstancedBufferGeometry;
  private a: THREE.InstancedBufferAttribute; // x, y, size, rot
  private b: THREE.InstancedBufferAttribute; // type, col, k (life 0..1), stretch
  readonly uniforms = {
    uGold: { value: new THREE.Color("#d6a531") },
    uA: { value: new THREE.Color("#c8321f") },
    uB: { value: new THREE.Color("#2b4a8b") },
    uInk: { value: new THREE.Color("#231c17") },
  };
  constructor(scene: THREE.Scene) {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("pA", this.a);
    this.geo.setAttribute("pB", this.b);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 pA; attribute vec4 pB; varying vec2 vUv; varying vec4 vB;
        void main(){ vUv = position.xy; vB = pB;
          float c = cos(pA.w), s = sin(pA.w);
          vec2 q = position.xy * vec2(pA.z * (1. + pB.w), pA.z);
          q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pA.xy + q, 4., 1.); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uGold, uA, uB, uInk; varying vec2 vUv; varying vec4 vB;
        void main(){
          float type = vB.x; float k = vB.z;
          vec3 c = vB.y < .5 ? uGold : vB.y < 1.5 ? uA : vB.y < 2.5 ? uB : vB.y < 3.5 ? uInk : vec3(1., .97, .88);
          float a = 0.; vec2 p = vUv; float r = length(p);
          if (type < .5) { // fleck: a diamond of leaf that glints as it turns
            float d = abs(p.x) + abs(p.y); a = 1. - smoothstep(.75, .85, d); c *= .8 + .6 * (1. - abs(p.x - p.y) * .5);
            a *= 1. - k * k;
          } else if (type < 1.5) { // ink droplet
            a = (1. - smoothstep(.7, .85, r)) * (1. - k);
          } else if (type < 2.5) { // streak
            a = (1. - smoothstep(.0, 1., abs(p.y))) * (1. - smoothstep(.3, 1., abs(p.x))) * (1. - k * .5);
            c = mix(c, vec3(1., .95, .8), 1. - abs(p.y));
          } else if (type < 3.5) { // burst ring
            a = (1. - smoothstep(.0, .08, abs(r - .9))) * (1. - k);
          } else if (type < 4.5) { // drifting spore / dust
            a = (1. - smoothstep(.2, 1., r)) * .5 * sin(k * 3.14159);
          } else { // a drip of ink: dark, a little glossy at its head, gone as it dries
            a = (1. - smoothstep(.62, .86, r)) * (1. - k * k) * .92;
            c = mix(c, vec3(.42, .36, .3), smoothstep(.1, -.6, p.x) * .25);
          }
          if (a < .01) discard;
          gl_FragColor = vec4(c, a);
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 40;
    scene.add(mesh);
  }

  setPlate(gold: string, a: string, b: string, ink: string) {
    this.uniforms.uGold.value.set(gold);
    this.uniforms.uA.value.set(a);
    this.uniforms.uB.value.set(b);
    this.uniforms.uInk.value.set(ink);
  }

  add(p: Partial<Part> & { x: number; y: number }) {
    if (this.parts.length >= MAX) this.parts.shift();
    this.parts.push({ vx: 0, vy: 0, life: 0, max: 0.6, size: 0.12, type: 0, col: 0, rot: 0, drag: 2, g: 0, ...p });
  }

  burst(x: number, y: number, n: number, opts: { type?: number; col?: number; speed?: number; size?: number; life?: number; g?: number; spread?: number; dir?: number } = {}) {
    const sp = opts.speed ?? 6;
    for (let i = 0; i < n; i++) {
      const a = opts.dir !== undefined ? opts.dir + (Math.random() - 0.5) * (opts.spread ?? 1.2) : Math.random() * Math.PI * 2;
      const v = sp * (0.35 + Math.random() * 0.8);
      this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, type: opts.type ?? P.Fleck, col: opts.col ?? 0, size: (opts.size ?? 0.13) * (0.6 + Math.random() * 0.8), max: (opts.life ?? 0.7) * (0.6 + Math.random() * 0.6), rot: Math.random() * 6, g: opts.g ?? -6, drag: 2.5 });
    }
  }

  ring(x: number, y: number, size: number, col = 0, life = 0.45) {
    this.add({ x, y, type: P.Ring, col, size, max: life, drag: 0 });
  }

  update(dt: number) {
    const A = this.a.array as Float32Array,
      B = this.b.array as Float32Array;
    let n = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      if (p.life >= p.max) {
        this.parts.splice(i, 1);
        continue;
      }
      p.vx *= Math.exp(-p.drag * dt);
      p.vy = p.vy * Math.exp(-p.drag * dt) + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.type === P.Fleck) p.rot += dt * 9;
    }
    for (const p of this.parts) {
      const k = p.life / p.max;
      let size = p.size,
        rot = p.rot,
        stretch = 0;
      if (p.type === P.Streak) {
        rot = Math.atan2(p.vy, p.vx);
        stretch = Math.min(6, Math.hypot(p.vx, p.vy) * 0.08);
      } else if (p.type === P.Drip) {
        rot = Math.atan2(p.vy, p.vx);
        stretch = Math.min(3.5, Math.hypot(p.vx, p.vy) * 0.7);
      }
      if (p.type === P.Ring) size = p.size * (0.3 + k * 1.2);
      A[n * 4] = p.x;
      A[n * 4 + 1] = p.y;
      A[n * 4 + 2] = size;
      A[n * 4 + 3] = rot;
      B[n * 4] = p.type;
      B[n * 4 + 1] = p.col;
      B[n * 4 + 2] = k;
      B[n * 4 + 3] = stretch;
      n++;
    }
    this.a.needsUpdate = this.b.needsUpdate = true;
    this.geo.instanceCount = n;
  }
}

import * as THREE from "three";
import { TitanSpec } from "@/core/titan";
import { rngFor, Rng } from "@/core/rng";
import { engraveMaterial, EngraveOpts, goldMaterial, outlineMaterial, titanUniforms, TitanUniforms } from "./material";
import { bowChain, eng, gothicArch, ik2, lathe, orb, Sweep } from "./geo";

// The living titan: procedural anatomy per archetype, engraved and hand-coloured, gilded,
// and animated to its song: wind-ups before every strike, eyes that follow you, a body that cracks gold.

export interface TitanCtx {
  t: number;
  beat: number;
  player: { x: number; y: number };
  cues: Array<{ x: number; y: number; lead: number; heavy: boolean; kind: string }>;
  stage: number;
  crack: number;
  hurt: number;
  coreOpen: boolean[];
  coreHit: number[];
}

interface Rig {
  update(c: TitanCtx): void;
}

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const ease = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** wind-up curve for a cue: rises over the 2 beats before the strike, snaps back after */
const windup = (lead: number) => (lead > 0 ? ease(clamp01(1 - lead / 2)) : clamp01(1 + lead * 2.5) * 0.35);

export class Titan {
  group = new THREE.Group();
  anatomy = new THREE.Group();
  u: TitanUniforms = titanUniforms();
  private rig!: Rig;
  private cores: Array<{ gem: THREE.Mesh; shell: THREE.Mesh[]; frame: THREE.Mesh; mat: THREE.ShaderMaterial; open: number; aura: THREE.Mesh }> = [];
  private eyes: Array<{ ball: THREE.Object3D; pupil: THREE.Object3D; r: number; lid: THREE.Object3D; look: number }> = [];
  private m: Record<string, THREE.ShaderMaterial> = {};
  private outlines: Record<number, THREE.ShaderMaterial> = {};
  private blinkT = 2.5;
  private wp = new THREE.Vector3();
  private r: Rng;

  constructor(public spec: TitanSpec) {
    const p = spec.plate;
    this.u.uInk.value.set(p.ink);
    this.u.uBody.value.set(p.body);
    this.u.uVellum.value.set(p.vellum);
    this.u.uGold.value.set(p.gold);
    this.u.uAccent.value.set(p.accent);
    this.r = rngFor("anatomy", spec.seed);
    const mk = (k: string, o: EngraveOpts) => (this.m[k] = engraveMaterial(this.u, o));
    mk("body", { wash: 0.78 });
    mk("dark", { wash: 0.9, tone: -0.22 });
    mk("light", { wash: 0.32, tone: 0.1 });
    mk("stone", { wash: 0.35, tone: 0.12, tint: "paper", cracks: 0.4 });
    mk("gilt", { wash: 0.2, tone: 0.05, gilt: 0.9, cracks: 0 });
    mk("accent", { wash: 0.72, tint: "accent" });
    mk("scales", { wash: 0.8, scales: 1 });
    mk("bone", { wash: 0.12, tone: 0.18, tint: "paper", cracks: 0.6 });
    mk("eye", { wash: 0.05, tone: 0.35, tint: "paper", cracks: 0 });
    mk("pupil", { wash: 0, tone: -0.9, gilt: 0.35, cracks: 0 });
    this.group.add(this.anatomy);
    switch (spec.archetype) {
      case "coil":
        this.rig = this.buildCoil();
        break;
      case "strider":
        this.rig = this.buildStrider();
        break;
      case "bloom":
        this.rig = this.buildBloom();
        break;
      case "throne":
        this.rig = this.buildThrone();
        break;
      default:
        this.rig = this.buildSwarm();
    }
    this.buildCores();
  }

  // ------------------------------------------------------------------ parts
  private outline(w: number) {
    const k = Math.round(w * 1000);
    return (this.outlines[k] ??= outlineMaterial(this.u, w));
  }
  private part(geo: THREE.BufferGeometry, mat: string | THREE.ShaderMaterial = "body", parent: THREE.Object3D = this.anatomy, ow = 0.08) {
    const material = typeof mat === "string" ? this.m[mat] : mat;
    const m = new THREE.Mesh(geo, material);
    if (ow > 0) m.add(new THREE.Mesh(geo, this.outline(ow)));
    parent.add(m);
    return m;
  }
  private orbPart(sx: number, sy: number, sz: number, pos: THREE.Vector3, mat: string = "body", parent: THREE.Object3D = this.anatomy, lump = 0.04, ow = 0.08) {
    const lu = Math.round(Math.max(sx, sz) * 9 + 10);
    const lv = Math.round(sy * 7 + 8);
    const m = this.part(orb(lu, lv, this.r.range(0, 9), lump), mat, parent, ow);
    m.scale.set(sx, sy, sz);
    m.position.copy(pos);
    return m;
  }
  private cyl(r0: number, r1: number, h: number, mat = "body", parent: THREE.Object3D = this.anatomy, ow = 0.06) {
    return this.part(eng(new THREE.CylinderGeometry(r0, r1, h, 24, 6), Math.round((r0 + r1) * 7 + 6), Math.round(h * 4)), mat, parent, ow);
  }
  private cone(r: number, h: number, mat = "gilt", parent: THREE.Object3D = this.anatomy, ow = 0.05) {
    return this.part(eng(new THREE.ConeGeometry(r, h, 12, 4), Math.round(r * 10 + 4), Math.round(h * 4 + 3)), mat, parent, ow);
  }
  private torus(R: number, tube: number, mat = "gilt", parent: THREE.Object3D = this.anatomy, arc = Math.PI * 2, ow = 0.04) {
    return this.part(eng(new THREE.TorusGeometry(R, tube, 10, Math.max(24, Math.round(R * 16)), arc), 6, Math.round(R * 14 + 8)), mat, parent, ow);
  }
  private capsule(r: number, len: number, mat = "body", parent: THREE.Object3D = this.anatomy, ow = 0.06) {
    return this.part(eng(new THREE.CapsuleGeometry(r, len, 8, 16), Math.round(r * 12 + 6), Math.round((len + r * 2) * 5)), mat, parent, ow);
  }
  /** an eye that follows the hunter; `look` scales how far the pupil travels */
  private eye(parent: THREE.Object3D, pos: THREE.Vector3, r: number, look = 1) {
    const ball = this.part(orb(16, 10, 1, 0), "eye", parent, Math.max(0.03, r * 0.12));
    ball.scale.setScalar(r);
    ball.position.copy(pos);
    const pupil = new THREE.Mesh(orb(10, 6, 2, 0), this.m.pupil);
    pupil.scale.set(0.42, 0.62, 0.3);
    pupil.position.z = 0.82;
    ball.add(pupil);
    const lid = new THREE.Group();
    ball.add(lid);
    const lidMesh = new THREE.Mesh(eng(new THREE.SphereGeometry(1.08, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), 14, 8), this.m.dark);
    lidMesh.rotation.x = -Math.PI / 2 + 0.25;
    lid.add(lidMesh);
    lid.scale.y = 0.2;
    this.eyes.push({ ball, pupil, r, lid, look });
    return ball;
  }
  private buildCores() {
    for (const c of this.spec.cores) {
      const mat = goldMaterial(this.u);
      const z = 7 + c.z * 0.2;
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.6, 1), mat);
      gem.scale.set(0.82, 1.2, 0.72);
      gem.position.set(c.x, c.y, z);
      gem.add(new THREE.Mesh(gem.geometry, this.outline(0.05)));
      const frame = this.torus(0.98, 0.13, "gilt", this.group, Math.PI * 2, 0.05);
      frame.position.set(c.x, c.y, z - 0.25);
      for (let k = 0; k < 4; k++) {
        const spike = this.cone(0.12, 0.6, "gilt", frame, 0.03);
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        spike.position.set(Math.cos(a) * 1.15, Math.sin(a) * 1.15, 0);
        spike.rotation.z = a - Math.PI / 2;
      }
      const shell: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const g = eng(new THREE.SphereGeometry(0.8, 18, 12, side < 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI, 0, Math.PI), 10, 8);
        const s = this.part(g, "dark", this.group, 0.04);
        s.position.set(c.x, c.y, z + 0.12);
        shell.push(s);
      }
      this.group.add(gem);
      const aura = new THREE.Mesh(
        new THREE.PlaneGeometry(5.2, 5.2),
        new THREE.ShaderMaterial({
          uniforms: { uTime: this.u.uTime, uGold: this.u.uGold, uOpen: { value: 0 }, uSeed: { value: c.id * 1.7 }, uReveal: this.u.uReveal },
          transparent: true,
          depthWrite: false,
          vertexShader: `varying vec2 vUv; void main(){ vUv = uv * 2. - 1.; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
          fragmentShader: `
            precision highp float; uniform float uTime, uOpen, uSeed, uReveal; uniform vec3 uGold; varying vec2 vUv;
            void main(){
              float r = length(vUv); float a = atan(vUv.y, vUv.x);
              float rays = pow(abs(sin(a * 8. + uTime * .6 + uSeed)), 6.) * smoothstep(1., .25, r);
              float glow = pow(smoothstep(1., 0., r), 2.5);
              float beat = .75 + .25 * sin(uTime * 7.);
              float k = (glow * .75 + rays * .55) * uOpen * beat * clamp(uReveal - 2., 0., 1.);
              gl_FragColor = vec4(mix(uGold, vec3(1., .93, .7), glow), k);
              #include <colorspace_fragment>
            }`,
        }),
      );
      aura.position.set(c.x, c.y, z - 0.6);
      this.group.add(aura);
      this.cores.push({ gem, shell, frame, mat, open: 0, aura });
    }
  }

  // ------------------------------------------------------------------ THRONE: the seated colossus
  private buildThrone(): Rig {
    const r = this.r;
    const A = this.anatomy;
    const arch = this.part(gothicArch(15.5, 15.2, 1.2, 3), "stone", A, 0.1);
    arch.position.set(0, 18.9, -6);
    for (const s of [-1, 1]) {
      const post = this.cyl(0.55, 0.7, 12, "stone", A);
      post.position.set(s * 7.4, 25, -4.5);
      const fin = this.cone(0.6, 2.2, "gilt", A);
      fin.position.set(s * 7.4, 32.1, -4.5);
      this.orbPart(0.75, 0.75, 0.75, V(s * 7.4, 31, -4.5), "gilt", A, 0, 0.05);
    }
    const halo = new THREE.Group();
    halo.position.set(0, 30.4, -2.4);
    A.add(halo);
    this.torus(3.3, 0.17, "gilt", halo);
    const halo2 = new THREE.Group();
    halo.add(halo2);
    this.torus(4.05, 0.08, "gilt", halo2);
    for (let i = 0; i < 24; i++) {
      const sp = this.cone(0.09, 1.1 + (i % 2) * 0.5, "gilt", halo2, 0.03);
      const a = (i / 24) * Math.PI * 2;
      sp.position.set(Math.cos(a) * (4.6 + (i % 2) * 0.25), Math.sin(a) * (4.6 + (i % 2) * 0.25), 0);
      sp.rotation.z = a - Math.PI / 2;
    }
    const robe = this.part(
      lathe(
        [
          [0.01, 19.2],
          [5.4, 19.3],
          [5.0, 20.3],
          [4.1, 21.8],
          [3.2, 23.2],
          [3.3, 24.4],
          [3.6, 25.8],
          [3.3, 27.0],
          [2.2, 27.9],
          [1.05, 28.3],
          [0.01, 28.4],
        ],
        52,
        36,
        72,
        11,
        0.07,
      ),
      "body",
      A,
      0.1,
    );
    robe.position.z = -0.4;
    robe.scale.z = 0.62;
    const belt = this.torus(3.25, 0.22, "gilt", A);
    belt.position.set(0, 23.25, -0.2);
    belt.rotation.x = Math.PI / 2;
    belt.scale.set(1, 0.62, 1);
    for (const s of [-1, 1]) {
      const stole = this.part(eng(new THREE.BoxGeometry(0.8, 6.4, 0.25, 2, 12, 1), 4, 22), "accent", A, 0.05);
      stole.position.set(s * 0.75, 23.9, 1.9);
      stole.rotation.z = s * 0.06;
    }
    for (const s of [-1, 1]) {
      const p = this.orbPart(1.9, 1.35, 1.6, V(s * 3.45, 27.05, 0.2), "dark", A, 0.03, 0.09);
      p.rotation.z = s * -0.35;
      const rim = this.torus(1.6, 0.12, "gilt", A);
      rim.position.set(s * 3.6, 26.35, 0.6);
      rim.rotation.set(Math.PI / 2.3, 0, s * -0.35);
    }
    const head = new THREE.Group();
    head.position.set(0, 28.2, 0.4);
    A.add(head);
    const neck = this.cyl(0.85, 1.05, 1.0, "body", head);
    neck.position.set(0, 0.2, -0.2);
    const mask = this.part(
      lathe(
        [
          [0.01, 0],
          [0.9, 0.15],
          [1.25, 0.8],
          [1.42, 1.6],
          [1.38, 2.4],
          [1.12, 3.1],
          [0.6, 3.5],
          [0.01, 3.6],
        ],
        30,
        26,
        48,
      ),
      "light",
      head,
      0.07,
    );
    mask.position.set(0, 0.45, 0);
    mask.scale.z = 0.92;
    const brow = this.part(eng(new THREE.BoxGeometry(2.1, 0.18, 0.6), 6, 3), "dark", head, 0.04);
    brow.position.set(0, 2.45, 1.05);
    for (const s of [-1, 1]) {
      this.orbPart(0.42, 0.3, 0.22, V(s * 0.55, 2.15, 1.12), "dark", head, 0, 0.03);
      this.eye(head, V(s * 0.55, 2.15, 1.25), 0.24, 0.8);
    }
    const nose = this.part(eng(new THREE.BoxGeometry(0.2, 0.9, 0.3), 3, 5), "light", head, 0.03);
    nose.position.set(0, 1.65, 1.32);
    const mouth = this.part(eng(new THREE.BoxGeometry(0.85, 0.07, 0.15), 4, 2), "dark", head, 0.03);
    mouth.position.set(0, 1.05, 1.28);
    const beard: Array<{ sw: Sweep; x: number }> = [];
    for (let i = 0; i < 5; i++) {
      const sw = new Sweep(10, 6, 6, 14);
      this.part(sw.geo, i % 2 ? "gilt" : "dark", head, 0.03);
      beard.push({ sw, x: (i - 2) * 0.32 });
    }
    const crown = new THREE.Group();
    crown.position.set(0, 3.7, 0);
    head.add(crown);
    const circlet = this.torus(1.25, 0.16, "gilt", crown);
    circlet.rotation.x = Math.PI / 2;
    const spikes = r.int(5, 7);
    for (let i = 0; i < spikes; i++) {
      const t = i / (spikes - 1) - 0.5;
      const h = 1.3 + (1 - Math.abs(t) * 1.7) * 1.4;
      const sp = this.cone(0.22, h, "gilt", crown, 0.04);
      sp.position.set(t * 2.3, h / 2 - 0.05, 0.4 - Math.abs(t) * 0.8);
      sp.rotation.z = -t * 0.5;
      this.orbPart(0.16, 0.16, 0.16, V(t * 2.3, 0.15, 0.62 - Math.abs(t) * 0.8), "accent", crown, 0, 0.02);
    }
    const arms = [-1, 1].map((side) => {
      const shoulder = V(side * 4.1, 26.6, 0.4);
      const upper = new Sweep(12, 12, 16, 16);
      const fore = new Sweep(12, 12, 16, 16);
      this.part(upper.geo, "body", A, 0.09);
      this.part(fore.geo, "dark", A, 0.09);
      const cuff = this.torus(0.85, 0.16, "gilt", A);
      const hand = new THREE.Group();
      A.add(hand);
      this.orbPart(1.0, 0.75, 0.72, V(0, 0, 0), "light", hand, 0.05, 0.06);
      const fingers: THREE.Mesh[] = [];
      for (let f = 0; f < 4; f++) {
        const fing = this.capsule(0.17, 0.75, "light", hand, 0.035);
        fing.position.set((f - 1.5) * 0.43 * side, -0.85, 0.32);
        fing.rotation.z = (f - 1.5) * 0.08 * side;
        if (f === 1) {
          const ring = this.torus(0.2, 0.06, "gilt", fing);
          ring.rotation.x = Math.PI / 2;
          ring.position.y = 0.1;
        }
        fingers.push(fing);
      }
      const thumb = this.capsule(0.2, 0.6, "light", hand, 0.035);
      thumb.position.set(-side * 0.95, -0.25, 0.3);
      thumb.rotation.z = side * 0.9;
      return { side, shoulder, upper, fore, cuff, hand, fingers, rest: V(side * 5.6, 20.9, 1.5), pts: [] as THREE.Vector3[], pts2: [] as THREE.Vector3[], lift: 0 };
    });
    const elbow = V(),
      handPos = V(),
      bow = V();
    const sleeveR = (n: number, a: number, b: number) => Array.from({ length: n }, (_, i) => a + (b - a) * (i / (n - 1)) + Math.sin((i / (n - 1)) * Math.PI) * 0.15);
    return {
      update: (c) => {
        const breath = Math.sin(c.t * 1.25);
        robe.scale.set(1 + breath * 0.012, 1 + breath * 0.008, 0.62);
        head.position.y = 28.2 + breath * 0.05 - c.hurt * 0.2;
        head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, -c.player.x * 0.02, 0.04);
        head.rotation.x = 0.05 + Math.sin(c.t * 0.6) * 0.03 - c.hurt * 0.12;
        halo.rotation.z += 0.0015 + c.stage * 0.003;
        halo2.rotation.z -= 0.004 + c.stage * 0.006;
        beard.forEach((b, i) => {
          const pts = bowChain(V(b.x, 0.5, 1.15), V(b.x * 1.6 + Math.sin(c.t * 1.6 + i) * 0.15, -1.6 - (i % 2) * 0.4, 1.4), V(0, 0, 0.3), 10);
          b.sw.update(pts, pts.map((_, k) => 0.09 - k * 0.004));
        });
        for (const a of arms) {
          let lift = 0,
            reach = 0;
          for (const q of c.cues) {
            if (q.x * a.side < -1) continue;
            const k = windup(q.lead) * (q.heavy ? 1 : 0.7);
            if (k > lift) {
              lift = k;
              reach = THREE.MathUtils.clamp(q.x, -7, 7);
            }
          }
          a.lift += (lift - a.lift) * 0.25;
          const L = a.lift;
          handPos.set(THREE.MathUtils.lerp(a.rest.x, reach * 0.8, L * 0.35), a.rest.y + L * 4.2 + Math.sin(c.t * 1.05 + a.side) * 0.12, a.rest.z + L * 2.4);
          ik2(a.shoulder, handPos, 3.9, 3.9, a.side > 0 ? -1 : 1, elbow);
          elbow.x += a.side * 0.6;
          bowChain(a.shoulder, elbow, bow.set(0, 0, 0.2), 12, a.pts);
          bowChain(elbow, handPos, bow.set(0, 0, 0.2), 12, a.pts2);
          a.upper.update(a.pts, sleeveR(12, 1.0, 0.85));
          a.fore.update(a.pts2, sleeveR(12, 0.8, 0.6));
          a.cuff.position.copy(a.pts2[10]);
          a.cuff.quaternion.setFromUnitVectors(V(0, 0, 1), V().subVectors(a.pts2[11], a.pts2[9]).normalize());
          a.hand.position.copy(handPos).add(V(0, -0.35, 0));
          a.hand.rotation.z = a.side * (0.15 - L * 0.6);
          a.fingers.forEach((f, i) => (f.rotation.x = -L * 0.9 - Math.sin(c.t * 2 + i) * 0.04));
        }
      },
    };
  }

  // ------------------------------------------------------------------ COIL: the leviathan
  private buildCoil(): Rig {
    const r = this.r;
    const A = this.anatomy;
    const N = 64;
    const body = new Sweep(N, 16, 22, 90);
    this.part(body.geo, "scales", A, 0.11);
    const belly = new Sweep(N, 10, 10, 70);
    this.part(belly.geo, "light", A, 0.05);
    const pts = Array.from({ length: N }, () => V());
    const bpts = Array.from({ length: N }, () => V());
    const radii = Array.from({ length: N }, (_, i) => {
      const t = i / (N - 1);
      return 0.04 + 1.55 * Math.pow(Math.sin(Math.min(1, t * 1.05) * Math.PI * 0.93), 0.6);
    });
    const fins: THREE.Mesh[] = [];
    for (let i = 0; i < 14; i++) fins.push(this.cone(0.38, 1.7, i % 3 ? "dark" : "gilt", A, 0.04));
    const head = new THREE.Group();
    A.add(head);
    // the frill: webbed vanes fanned behind the skull, each tipped with a gilded spine
    const frill = new THREE.Group();
    frill.position.set(0, 0.4, -1.2);
    head.add(frill);
    const vanes = 9;
    for (let i = 0; i < vanes; i++) {
      const a = Math.PI * (0.06 + (i / (vanes - 1)) * 0.88);
      const g = new THREE.Group();
      g.rotation.z = a - Math.PI / 2;
      frill.add(g);
      const len = 3.4 + Math.sin((i / (vanes - 1)) * Math.PI) * 1.4;
      const vane = this.part(lathe([[0.01, 0], [0.75, 0.5], [0.95, len * 0.45], [0.55, len * 0.85], [0.01, len]], 14, 16, 20), i % 2 ? "accent" : "body", g, 0.07);
      vane.scale.z = 0.18;
      const spine = this.cone(0.09, len * 0.95, "gilt", g, 0.03);
      spine.position.set(0, len * 0.5, 0.18);
    }
    this.orbPart(1.9, 1.15, 1.45, V(0, 0.2, 0.5), "body", head, 0.03, 0.09);
    this.orbPart(1.25, 0.62, 1.15, V(0, -0.55, 1.35), "light", head, 0.02, 0.06);
    const jaw = new THREE.Group();
    jaw.position.set(0, -0.75, 0.6);
    head.add(jaw);
    this.orbPart(1.3, 0.45, 1.1, V(0, -0.35, 0.6), "dark", jaw, 0.02, 0.06);
    for (let i = 0; i < 4; i++) {
      const fx = (i < 2 ? -1 : 1) * (0.45 + (i % 2) * 0.4);
      const up = this.cone(0.11, 0.7, "bone", head, 0.025);
      up.position.set(fx, -1.05, 1.75 - (i % 2) * 0.3);
      up.rotation.z = Math.PI;
      const dn = this.cone(0.1, 0.55, "bone", jaw, 0.025);
      dn.position.set(fx * 0.85, 0.15, 1.3 - (i % 2) * 0.3);
    }
    const whiskers: Array<{ sw: Sweep; s: number }> = [];
    for (const s of [-1, 1]) {
      this.eye(head, V(s * 1.05, 0.55, 1.45), 0.26, 0.9);
      const hornPts = bowChain(V(s * 1.2, 1.0, 0.2), V(s * 3.2, 3.6, -0.5), V(s * 0.6, -0.6, 0), 12);
      const horn = new Sweep(12, 10, 10, 18);
      horn.update(hornPts, hornPts.map((_, i) => 0.36 * (1 - i / 12) + 0.04));
      this.part(horn.geo, "bone", head, 0.05);
      const whisker = new Sweep(14, 5, 4, 20);
      this.part(whisker.geo, "gilt", head, 0.025);
      whiskers.push({ sw: whisker, s });
    }
    const phase = r.range(0, 6);
    const amp = r.range(0.85, 1.25);
    const lean = r.chance(0.5) ? 1 : -1;
    let mouth = 0;
    return {
      update: (c) => {
        let mx = 0,
          cue = 0;
        for (const q of c.cues) {
          const k = windup(q.lead);
          if (k > cue) {
            cue = k;
            mx = THREE.MathUtils.clamp(q.x, -5, 5);
          }
        }
        mouth += (cue - mouth) * 0.2;
        const hx = mx * 0.45 + Math.sin(c.t * 0.45 + phase) * 1.1;
        const hy = 27.6 + Math.sin(c.t * 0.85) * 0.35 - mouth * 1.3 - c.hurt * 0.4;
        head.position.set(hx, hy, 1.2);
        head.rotation.z = (c.player.x - hx) * -0.015 + Math.sin(c.t * 0.7) * 0.04;
        head.rotation.x = -0.1 + mouth * 0.3;
        jaw.rotation.x = -0.12 - mouth * 0.8;
        for (let i = 0; i < N; i++) {
          const t = i / (N - 1);
          const s = t * 5.2 + phase;
          const wave = Math.sin(c.t * 1.1 - t * 8) * 0.5 * amp;
          // a great S across the top of the page: the tail trails off one margin, the coils sweep behind
          const sweep = Math.sin(t * Math.PI * 2.1 + phase * 0.3);
          let x = lean * (11 - t * 14) * (1 - t * 0.35) + sweep * 3.2 * (1 - t) + wave;
          let y = 21.4 + t * 6.5 + Math.sin(t * Math.PI * 3 + phase) * 2.2 * (1 - t * 0.8);
          let z = -3.6 + Math.cos(t * Math.PI * 3 + phase) * 2.4 * (1 - t);
          const k = ease(Math.max(0, (t - 0.74) / 0.26));
          x = THREE.MathUtils.lerp(x, hx, k);
          y = THREE.MathUtils.lerp(y, hy - 0.4, k);
          z = THREE.MathUtils.lerp(z, 0.2, k);
          pts[i].set(x, y, z);
          bpts[i].set(x, y - radii[i] * 0.35, z + radii[i] * 0.55);
        }
        body.update(pts, radii);
        belly.update(bpts, radii.map((q) => q * 0.62));
        fins.forEach((f, k) => {
          const i = 6 + k * 3;
          const a = pts[i],
            b = pts[i + 1];
          const tx = b.x - a.x,
            ty = b.y - a.y;
          const L = Math.hypot(tx, ty) || 1;
          f.position.set(a.x - (ty / L) * radii[i] * 1.05, a.y + (tx / L) * radii[i] * 1.05, a.z - 0.2);
          f.rotation.z = Math.atan2(-ty, -tx) + Math.PI / 2 + Math.PI + Math.sin(c.t * 2 + k) * 0.12;
          f.scale.setScalar(0.6 + radii[i] * 0.35);
        });
        for (const w of whiskers) {
          const wp = bowChain(V(w.s * 0.9, -0.55, 1.9), V(w.s * (3.2 + Math.sin(c.t * 1.3) * 0.3), -2.6 - Math.sin(c.t * 1.7 + w.s) * 0.4, 1.4), V(w.s * 0.4, 0.6, 0), 14);
          w.sw.update(wp, wp.map((_, i) => 0.07 * (1 - i / 15) + 0.02));
        }
      },
    };
  }

  // ------------------------------------------------------------------ STRIDER: the long-legged colossus
  private buildStrider(): Rig {
    const r = this.r;
    const A = this.anatomy;
    const pivot = new THREE.Group();
    pivot.position.set(0, 27.4, -1);
    A.add(pivot);
    const shell = this.part(lathe([[0.01, -2.2], [3.6, -2.0], [5.6, -0.8], [5.9, 0.4], [5.0, 1.6], [3.2, 2.5], [0.01, 2.9]], 64, 26, 64, 9, 0.05), "dark", pivot, 0.11);
    shell.scale.z = 0.62;
    for (let i = 0; i < 7; i++) {
      const t = i / 6 - 0.5;
      const plate = this.orbPart(1.25, 0.75, 0.9, V(t * 8.2, 1.55 + (0.5 - Math.abs(t)) * 1.5, 2.1), i % 2 ? "gilt" : "scales", pivot, 0.03, 0.06);
      plate.rotation.z = -t * 1.2;
    }
    const ridge = this.torus(5.7, 0.16, "gilt", pivot, Math.PI);
    ridge.scale.set(1, 0.5, 1);
    ridge.position.set(0, -0.3, 1.6);
    const head = new THREE.Group();
    head.position.set(0, -2.2, 2.1);
    pivot.add(head);
    this.orbPart(1.9, 1.35, 1.4, V(0, 0, 0), "body", head, 0.04, 0.08);
    const mand: THREE.Mesh[] = [];
    for (const s of [-1, 1]) {
      const m = this.cone(0.3, 1.8, "bone", head, 0.04);
      m.position.set(s * 0.8, -1.6, 0.7);
      m.rotation.z = Math.PI + s * 0.35;
      mand.push(m);
    }
    const eyeCount = r.int(4, 7);
    for (let i = 0; i < eyeCount; i++) {
      const t = eyeCount === 1 ? 0 : i / (eyeCount - 1) - 0.5;
      const rr = 0.2 + (1 - Math.abs(t) * 1.6) * 0.14;
      this.eye(head, V(t * 2.4, 0.35 - Math.abs(t) * 0.9 + (i % 2) * 0.28, 1.25 - Math.abs(t) * 0.5), rr, 0.7);
    }
    const perSide = Math.max(2, Math.min(3, Math.round(this.spec.limbs / 2)));
    const legs: Array<{ side: number; idx: number; hip: THREE.Vector3; rest: THREE.Vector3; thigh: Sweep; shin: Sweep; claw: THREE.Mesh; joint: THREE.Mesh; lift: number; tx: number; pa: THREE.Vector3[]; pb: THREE.Vector3[] }> = [];
    for (const side of [-1, 1])
      for (let i = 0; i < perSide; i++) {
        const thigh = new Sweep(12, 10, 12, 20);
        const shin = new Sweep(16, 10, 12, 30);
        this.part(thigh.geo, "body", A, 0.08);
        this.part(shin.geo, "scales", A, 0.08);
        const claw = this.cone(0.32, 1.3, "bone", A, 0.04);
        const joint = this.orbPart(0.62, 0.62, 0.62, V(), "gilt", A, 0, 0.05);
        legs.push({ side, idx: i, hip: V(side * (3 + i * 1.3), 26.8 - i * 0.35, -0.6 + i * 0.6), rest: V(side * (2.4 + i * 2.5), 19.6, 0.9 + i * 0.3), thigh, shin, claw, joint, lift: 0, tx: side * (2.4 + i * 2.5), pa: [], pb: [] });
      }
    const knee = V(),
      foot = V(),
      bow = V();
    return {
      update: (c) => {
        const bob = Math.sin(c.beat * Math.PI) * 0.12;
        pivot.position.y = 27.4 + bob - c.hurt * 0.45;
        pivot.rotation.z = Math.sin(c.t * 0.55) * 0.035 - c.player.x * 0.005;
        head.rotation.z = c.player.x * -0.012;
        mand.forEach((m, k) => (m.rotation.z = Math.PI + (k ? 1 : -1) * (0.35 + Math.sin(c.t * 3) * 0.06 + c.hurt * 0.3)));
        for (const L of legs) {
          let lift = 0,
            tx = L.rest.x;
          for (const q of c.cues) {
            if (!(q.kind === "slam" || q.kind === "rain" || q.kind === "glyph" || q.kind === "wall")) continue;
            if (Math.sign(q.x || 1e-3) !== L.side && Math.abs(q.x) > 0.5) continue;
            if (Math.floor(Math.abs(q.x) / 2.6) % perSide !== L.idx) continue;
            const k = windup(q.lead);
            if (k > lift) {
              lift = k;
              tx = THREE.MathUtils.clamp(q.x, -7.6, 7.6);
            }
          }
          L.lift += (lift - L.lift) * 0.3;
          L.tx += (tx - L.tx) * 0.12;
          const hip = V(L.hip.x, L.hip.y + bob, L.hip.z);
          foot.set(THREE.MathUtils.lerp(L.rest.x, L.tx, L.lift), L.rest.y + L.lift * 4.2, L.rest.z + L.lift * 1.6);
          knee.set(L.side * (7.6 + L.idx * 1.2), 31 + L.lift * 1.2 - L.idx * 0.5, -0.4);
          bowChain(hip, knee, bow.set(0, 0.5, 0), 12, L.pa);
          bowChain(knee, foot, bow.set(L.side * 0.5, 0, 0.3), 16, L.pb);
          L.thigh.update(L.pa, L.pa.map((_, i) => 0.7 - i * 0.022));
          L.shin.update(L.pb, L.pb.map((_, i) => 0.5 - i * 0.022));
          L.joint.position.copy(knee);
          L.claw.position.copy(foot).add(V(0, -0.35, 0));
          L.claw.rotation.z = Math.PI - L.side * 0.1;
        }
      },
    };
  }

  // ------------------------------------------------------------------ BLOOM: the drifting crown
  private buildBloom(): Rig {
    const r = this.r;
    const A = this.anatomy;
    const crown = new THREE.Group();
    crown.position.set(0, 26.2, -2);
    A.add(crown);
    const n = Math.min(12, this.spec.limbs + 4);
    const petals: Array<{ m: THREE.Mesh; a: number; layer: number }> = [];
    for (let layer = 0; layer < 2; layer++)
      for (let i = 0; i < n; i++) {
        const a = ((i + layer * 0.5) / n) * Math.PI * 2 + r.range(-0.08, 0.08);
        const g = new THREE.Group();
        g.rotation.z = a;
        crown.add(g);
        const len = layer ? 3.4 : 4.6;
        const prof: Array<[number, number]> = [[0.01, 0], [0.55, 0.6], [0.95, 1.8], [0.9, 3.0], [0.5, 4.0], [0.01, 4.6]];
        const petal = this.part(lathe(prof.map(([q, y]) => [q, (y * len) / 4.6] as [number, number]), 18, 20, 24), layer ? "accent" : i % 3 === 0 ? "gilt" : "body", g, 0.08);
        petal.scale.z = 0.25;
        petal.position.set(0, 1.6 + layer * 0.3, layer ? 0.6 : 0);
        petals.push({ m: petal, a, layer });
      }
    this.orbPart(2.7, 2.6, 2.2, V(0, 26.2, 0.4), "body", A, 0.05, 0.1);
    const ruff = this.torus(2.7, 0.22, "gilt", A);
    ruff.position.set(0, 26.2, 1.2);
    this.eye(A, V(0, 26.3, 2.25), 1.2, 0.6);
    const tendrils: Array<{ sw: Sweep; root: THREE.Vector3; tip: THREE.Vector3; ph: number; bud: THREE.Mesh; lift: number; pts: THREE.Vector3[] }> = [];
    for (const o of this.spec.origins) {
      const sw = new Sweep(18, 10, 10, 26);
      this.part(sw.geo, "scales", A, 0.06);
      const bud = this.orbPart(0.55, 0.7, 0.5, V(), "accent", A, 0.05, 0.05);
      tendrils.push({ sw, root: V(o.x * 0.32, 24.2, 0.6), tip: V(o.x, 20.3, 1.4), ph: r.range(0, 6), bud, lift: 0, pts: [] });
    }
    const bow = V();
    return {
      update: (c) => {
        const open = 0.94 + Math.sin(c.t * 0.8) * 0.05 + c.stage * 0.04;
        crown.rotation.z = Math.sin(c.t * 0.22) * 0.1;
        crown.scale.setScalar(open * (1 - c.hurt * 0.06));
        petals.forEach((p, i) => {
          p.m.rotation.x = Math.sin(c.t * 1.2 + i * 0.7) * 0.18 - c.hurt * 0.35;
          p.m.position.y = 1.6 + p.layer * 0.3 + Math.sin(c.t * 1.2 + i) * 0.08;
        });
        ruff.rotation.z = c.t * 0.2;
        for (const T of tendrils) {
          let k = 0;
          for (const q of c.cues) if (Math.abs(q.x - T.tip.x) < 1.8) k = Math.max(k, windup(q.lead));
          T.lift += (k - T.lift) * 0.25;
          const tip = V(T.tip.x + Math.sin(c.t * 1.2 + T.ph) * 0.55, T.tip.y + T.lift * 2.2 + Math.sin(c.t * 1.9 + T.ph) * 0.2, T.tip.z + T.lift);
          bowChain(T.root, tip, bow.set(Math.sin(c.t * 0.9 + T.ph) * 1.6, 0.8, 0.9), 18, T.pts);
          T.sw.update(T.pts, T.pts.map((_, i) => 0.48 * (1 - i / 19) + 0.08));
          T.bud.position.copy(tip);
          T.bud.scale.setScalar(0.55 + T.lift * 0.4);
        }
      },
    };
  }

  // ------------------------------------------------------------------ SWARMHEART: the hollow heart
  private buildSwarm(): Rig {
    const r = this.r;
    const A = this.anatomy;
    const heart = this.part(orb(44, 30, r.range(0, 9), 0.16, 64, 40), "body", A, 0.12);
    heart.scale.set(3.3, 3.5, 2.6);
    heart.position.set(0, 26, -0.5);
    const veins: Sweep[] = [];
    for (let i = 0; i < 6; i++) {
      const sw = new Sweep(14, 6, 5, 18);
      this.part(sw.geo, i % 2 ? "gilt" : "accent", A, 0.04);
      veins.push(sw);
    }
    const ribs: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const rib = this.torus(4.2 + i * 0.35, 0.15, i % 2 ? "gilt" : "bone", A, Math.PI * 1.3, 0.05);
      rib.position.set(0, 26, -0.5);
      rib.rotation.set(r.range(-0.9, 0.9), r.range(-0.9, 0.9), r.range(0, 6));
      ribs.push(rib);
    }
    this.eye(heart, V(-0.3, 0.12, 0.92), 0.17, 0.5);
    this.eye(heart, V(0.3, 0.12, 0.92), 0.17, 0.5);
    this.eye(heart, V(0, -0.22, 0.96), 0.13, 0.5);
    const shards: Array<{ m: THREE.Mesh; R: number; sp: number; ph: number; tilt: number }> = [];
    for (let i = 0; i < 30; i++) {
      const g = eng(new THREE.OctahedronGeometry(r.range(0.25, 0.55), 0), 6, 6);
      const m = this.part(g, i % 4 === 0 ? "gilt" : i % 3 === 0 ? "accent" : "dark", A, 0.04);
      shards.push({ m, R: r.range(4.6, 9.5), sp: r.range(0.22, 0.6) * (r.chance(0.5) ? 1 : -1), ph: r.range(0, 6.3), tilt: r.range(-0.7, 0.7) });
    }
    const veinEnds = Array.from({ length: 6 }, (_, i) => ({ a: (i / 6) * Math.PI * 2 + 0.3, len: r.range(4, 6.5) }));
    return {
      update: (c) => {
        const ph = ((c.beat % 1) + 1) % 1;
        const pulse = 1 + Math.pow(1 - ph, 7) * 0.07 + (ph > 0.45 && ph < 0.6 ? 0.025 : 0);
        heart.scale.set(3.3 * pulse, 3.5 * pulse, 2.6 * pulse);
        ribs.forEach((rb, i) => (rb.rotation.z += 0.0018 * (i + 1) * (1 + c.stage * 0.7) * (i % 2 ? 1 : -1)));
        veinEnds.forEach((v, i) => {
          const a = v.a + Math.sin(c.t * 0.4 + i) * 0.1;
          const p0 = V(Math.cos(a) * 2.6, 26 + Math.sin(a) * 2.7, 1.2);
          const p1 = V(Math.cos(a) * v.len, 26 + Math.sin(a) * v.len * 0.8, 0);
          const pts = bowChain(p0, p1, V(Math.sin(c.t + i) * 0.6, 0.3, 0), 14);
          veins[i].update(pts, pts.map((_, k) => 0.16 - k * 0.008));
        });
        for (const s of shards) {
          const a = s.ph + c.t * s.sp * (1 + c.stage * 0.35);
          s.m.position.set(Math.cos(a) * s.R, 26 + Math.sin(a) * s.R * 0.55 + Math.sin(a * 2) * s.tilt, Math.sin(a) * 2.5 - 1);
          s.m.rotation.set(c.t * s.sp, c.t * 0.6, a);
        }
      },
    };
  }

  // ------------------------------------------------------------------ per frame
  update(c: TitanCtx, dt = 1 / 60) {
    this.u.uTime.value = c.t;
    this.u.uCrack.value = c.crack;
    this.u.uWrath.value = c.stage / 2;
    this.u.uFlash.value = c.hurt * 0.45;
    this.rig.update(c);
    this.blinkT -= dt;
    const blink = this.blinkT < 0.13;
    if (this.blinkT < 0) this.blinkT = 2 + Math.random() * 4;
    for (const e of this.eyes) {
      e.ball.getWorldPosition(this.wp);
      const dx = THREE.MathUtils.clamp((c.player.x - this.wp.x) * 0.07, -0.42, 0.42) * e.look;
      const dy = THREE.MathUtils.clamp((c.player.y - this.wp.y) * 0.035, -0.45, 0.2) * e.look;
      e.pupil.position.set(dx, dy, 0.82);
      e.lid.scale.y = blink ? 1 : 0.2 + c.hurt * 0.5;
    }
    this.spec.cores.forEach((core, i) => {
      const m = this.cores[i];
      m.open += ((c.coreOpen[i] ? 1 : 0) - m.open) * 0.18;
      const u = m.mat.uniforms as unknown as { uOpen: { value: number }; uHit: { value: number } };
      u.uOpen.value = m.open;
      u.uHit.value = c.coreHit[i] ?? 0;
      (m.aura.material as THREE.ShaderMaterial).uniforms.uOpen.value = m.open;
      m.aura.scale.setScalar(1 + (c.coreHit[i] ?? 0) * 0.25);
      const k = m.open;
      m.shell[0].position.x = core.x - k * 0.8;
      m.shell[1].position.x = core.x + k * 0.8;
      m.shell[0].rotation.y = -k * 1.1;
      m.shell[1].rotation.y = k * 1.1;
      m.gem.rotation.y = c.t * (0.5 + k * 2.6);
      const s = 1 + (c.coreHit[i] ?? 0) * 0.28 + k * Math.sin(c.t * 7) * 0.05;
      m.gem.scale.set(0.82 * s, 1.2 * s, 0.72 * s);
      m.frame.rotation.z = c.t * 0.35 * (i % 2 ? 1 : -1) * (0.3 + k);
    });
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const k in this.m) this.m[k].dispose();
  }
}

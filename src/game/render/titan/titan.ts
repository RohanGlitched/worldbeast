import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TitanSpec } from "@/core/titan";
import { rngFor, Rng } from "@/core/rng";
import { engraveMaterial, EngraveOpts, goldMaterial, outlineMaterial, titanUniforms, TitanUniforms } from "./material";
import { bowChain, eng, gothicArch, ik2, lathe, orb, smoothProfile, Sweep } from "./geo";
import { titanForm, TitanForm } from "./form";

// The living titan: procedural anatomy per archetype, engraved and hand-coloured, gilded,
// and animated to its song: wind-ups before every strike, eyes that follow you, a body that cracks gold.
// Within an archetype the seed's form (form.ts) picks proportions, pose, ornament sets and a second
// pigment; the gameplay anchors (cores at spec.cores, attack origins at spec.origins, the hands, feet
// and tendril tips that wind up toward attacks) never move with the form.

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
  coreSoon?: boolean[];
}

interface Rig {
  update(c: TitanCtx): void;
}

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const ease = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** wind-up curve for a cue: rises over the 2 beats before the strike, snaps back after */
const windup = (lead: number) => (lead > 0 ? ease(clamp01(1 - lead / 2)) : clamp01(1 + lead * 2.5) * 0.35);
/** a transform for merging static ornament into one mesh */
const M = (p: THREE.Vector3, rz = 0, s: number | THREE.Vector3 = 1, rx = 0, ry = 0) =>
  new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), typeof s === "number" ? V(s, s, s) : s);

// engraved geometry (not yet parts); round things start their uv at the back so the seam is never seen
const gCone = (r: number, h: number, radial = 12) => eng(new THREE.ConeGeometry(r, h, radial, 4, false, Math.PI), r * 10 + 4, h * 4 + 3, false, true);
const gCyl = (r0: number, r1: number, h: number) => eng(new THREE.CylinderGeometry(r0, r1, h, 20, 4, false, Math.PI), (r0 + r1) * 7 + 6, h * 4, false, true);
const gTorus = (R: number, tube: number, arc = Math.PI * 2) => eng(new THREE.TorusGeometry(R, tube, 10, Math.max(24, Math.round(R * 16 * (arc / 6.283) + 8)), arc), 10, R * 26 + 10);
const gOrb = (lu = 16, lv = 10) => orb(lu, lv, 1, 0, 20, 14);
const gBox = (w: number, h: number, d: number) => eng(new THREE.BoxGeometry(w, h, d, 1, 2, 1), 8, h * 6);

export class Titan {
  group = new THREE.Group();
  anatomy = new THREE.Group();
  u: TitanUniforms = titanUniforms();
  form: TitanForm;
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
    this.form = titanForm(spec);
    this.u.uInk.value.set(p.ink);
    this.u.uBody.value.set(p.body);
    this.u.uVellum.value.set(p.vellum);
    this.u.uGold.value.set(p.gold);
    this.u.uAccent.value.set(p.accent);
    this.u.uWash2.value.set(this.form.pigment);
    this.r = rngFor("anatomy", spec.seed);
    const w = this.form.wash;
    const mk = (k: string, o: EngraveOpts) => (this.m[k] = engraveMaterial(this.u, o));
    mk("body", { wash: 0.55 * w });
    mk("dark", { wash: 0.62 * w, tone: -0.2 });
    mk("light", { wash: 0.2 * w, tone: 0.1 });
    // painted stone flesh takes the second pigment only when it is a warm earth; otherwise plain stone
    mk("flesh", this.form.warm ? { wash: 0.4 * w, tone: 0.1, tint: "wash2", cracks: 0.5 } : { wash: 0.28, tone: 0.12, tint: "paper", cracks: 0.5 });
    mk("wash2", { wash: 0.6 * w, tint: "wash2" });
    mk("stone", { wash: 0.35, tone: 0.12, tint: "paper", cracks: 0.4 });
    mk("masonry", { wash: 0.3, tone: 0.16, tint: "paper", cracks: 0.4, ashlar: 0.75, pitch: 1.3, ink: 0.8 });
    mk("gilt", { wash: 0.2, tone: 0.05, gilt: 0.9, cracks: 0 });
    mk("accent", { wash: 0.5 * w, tint: "accent" });
    mk("scales", { wash: 0.55 * w, scales: 1 });
    mk("bone", { wash: 0.12, tone: 0.18, tint: "paper", cracks: 0.6 });
    mk("eye", { wash: 0.05, tone: 0.35, tint: "paper", cracks: 0 });
    mk("pupil", { wash: 0, tone: -0.9, gilt: 0.35, cracks: 0 });
    mk("void", { wash: 0, tone: -1, gilt: 0, cracks: 0 });
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
  /** static ornament baked into one mesh (one draw, one outline) */
  private merged(items: Array<[THREE.BufferGeometry, THREE.Matrix4]>, mat = "gilt", parent: THREE.Object3D = this.anatomy, ow = 0.04) {
    const gs = items.map(([g, m]) => g.clone().applyMatrix4(m));
    const indexed = gs.every((g) => g.index);
    const geo = mergeGeometries(indexed ? gs : gs.map((g) => (g.index ? g.toNonIndexed() : g)), false)!;
    for (const g of gs) g.dispose();
    for (const [g] of items) g.dispose();
    return this.part(geo, mat, parent, ow);
  }
  /** many moving copies of one small shape: one draw for the parts, one for their outlines */
  private instanced(geo: THREE.BufferGeometry, mat: string, count: number, parent: THREE.Object3D = this.anatomy, ow = 0.04) {
    const im = new THREE.InstancedMesh(geo, this.m[mat], count);
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    parent.add(im);
    if (ow > 0) {
      const o = new THREE.InstancedMesh(geo, this.outline(ow), count);
      o.instanceMatrix = im.instanceMatrix;
      o.frustumCulled = false;
      im.add(o);
    }
    return im;
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
    return this.part(eng(new THREE.CylinderGeometry(r0, r1, h, 24, 6, false, Math.PI), Math.round((r0 + r1) * 7 + 6), Math.round(h * 4), false, true), mat, parent, ow);
  }
  private cone(r: number, h: number, mat = "gilt", parent: THREE.Object3D = this.anatomy, ow = 0.05) {
    return this.part(gCone(r, h), mat, parent, ow);
  }
  private torus(R: number, tube: number, mat = "gilt", parent: THREE.Object3D = this.anatomy, arc = Math.PI * 2, ow = 0.04) {
    return this.part(gTorus(R, tube, arc), mat, parent, ow);
  }
  private capsule(r: number, len: number, mat = "body", parent: THREE.Object3D = this.anatomy, ow = 0.06) {
    return this.part(eng(new THREE.CapsuleGeometry(r, len, 8, 16).rotateY(Math.PI), Math.round(r * 12 + 6), Math.round((len + r * 2) * 5), false, true), mat, parent, ow);
  }
  /** a static tube along a bowed chain (horns, tusks, vessels) */
  private gTube(pts: THREE.Vector3[], r0: number, r1: number, radial = 10) {
    const sw = new Sweep(pts.length, radial, 10, pts.length * 1.6);
    sw.update(pts, pts.map((_, i) => r0 + (r1 - r0) * (i / (pts.length - 1))));
    return sw.geo;
  }
  /** an eye that follows the hunter; `look` scales how far the pupil travels */
  private eye(parent: THREE.Object3D, pos: THREE.Vector3, r: number, look = 1, iris = false) {
    const ball = this.part(orb(16, 10, 1, 0), "eye", parent, Math.max(0.03, r * 0.12));
    ball.scale.setScalar(r);
    ball.position.copy(pos);
    let pupil: THREE.Object3D;
    if (iris) {
      // a great gilt iris around a black slit with a molten gold core (the bloom's single eye)
      pupil = new THREE.Group();
      const disc = this.part(orb(20, 10, 3, 0), "gilt", pupil, 0.025);
      disc.scale.set(0.74, 0.74, 0.2);
      const slit = this.part(orb(12, 10, 4, 0), "void", pupil, 0.02);
      slit.scale.set(0.2, 0.62, 0.26);
      slit.position.z = 0.03;
      const core = new THREE.Mesh(orb(8, 8, 5, 0), this.m.gilt);
      core.scale.set(0.03, 0.36, 0.28);
      core.position.z = 0.06;
      pupil.add(core);
    } else {
      pupil = new THREE.Mesh(orb(10, 6, 2, 0), this.m.pupil);
      pupil.scale.set(0.42, 0.62, 0.3);
    }
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
      // four spikes, baked into one mesh that turns with the frame
      this.merged(
        [0, 1, 2, 3].map((k) => {
          const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
          return [gCone(0.12, 0.6), M(V(Math.cos(a) * 1.15, Math.sin(a) * 1.15, 0), a - Math.PI / 2)] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        "gilt",
        frame,
        0.03,
      );
      // an iris of engraved iron blades closes over the wound; it opens on the titan's beat
      const shell: THREE.Mesh[] = [];
      const blades = 6;
      for (let k = 0; k < blades; k++) {
        const sh = new THREE.Shape();
        sh.moveTo(0, 0);
        sh.lineTo(0.95, -0.12);
        sh.quadraticCurveTo(0.9, 0.45, 0.32, 0.62);
        sh.lineTo(0, 0);
        const g = eng(new THREE.ExtrudeGeometry(sh, { depth: 0.06, bevelEnabled: false, curveSegments: 6 }), 8, 8);
        const pivot = new THREE.Group();
        pivot.position.set(c.x, c.y, z + 0.18 + k * 0.004);
        pivot.rotation.z = (k / blades) * Math.PI * 2;
        const blade = this.part(g, "dark", pivot, 0.025);
        blade.position.set(0, 0, 0);
        (blade.userData as { base: number }).base = 0;
        this.group.add(pivot);
        shell.push(blade);
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
    const F = this.form.throne;
    const A = this.anatomy;
    const sh = F.shoulders;
    // the seat of judgement behind it: a gothic arch, a round apse, or a turning rose wheel
    let wheel: THREE.Object3D | null = null;
    if (F.back === "wheel") {
      wheel = new THREE.Group();
      wheel.position.set(0, 27.4, -5.6);
      A.add(wheel);
      const spokes = 16;
      const stone: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [[gTorus(7.1, 0.34), M(V())], [gTorus(6.3, 0.12), M(V())]];
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        stone.push([gCyl(0.13, 0.17, 4.2), M(V(Math.cos(a) * 4.7, Math.sin(a) * 4.7, 0), a - Math.PI / 2)]);
      }
      this.merged(stone, "stone", wheel, 0.08);
      const gold: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [[gTorus(2.55, 0.2), M(V())]];
      for (let i = 0; i < spokes; i++) {
        const a = ((i + 0.5) / spokes) * Math.PI * 2;
        gold.push([gOrb(), M(V(Math.cos(a) * 6.7, Math.sin(a) * 6.7, 0.1), 0, 0.22)]);
        gold.push([gCone(0.1, 0.9), M(V(Math.cos(a) * 7.8, Math.sin(a) * 7.8, 0), a - Math.PI / 2)]);
      }
      this.merged(gold, "gilt", wheel, 0.03);
      const rose: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        rose.push([gOrb(), M(V(Math.cos(a) * 3.6, Math.sin(a) * 3.6, -0.1), 0, V(0.7, 0.7, 0.2))]);
      }
      this.merged(rose, "wash2", wheel, 0.05);
    } else {
      const arch = this.part(gothicArch(15.5, 15.2, 1.2, F.windows, F.back === "gothic"), "masonry", A, 0.1);
      arch.position.set(0, 18.9, -6);
    }
    const fin: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
    for (const s of [-1, 1]) {
      const tall = F.back === "wheel" ? 8.5 : 12;
      const post = this.cyl(0.55, 0.7, tall, "stone", A);
      post.position.set(s * 7.4, 19 + tall / 2, -4.5);
      const top = 19 + tall;
      if (F.back === "gothic") {
        fin.push([gCone(0.6, 2.2), M(V(s * 7.4, top + 1.1, -4.5))]);
        fin.push([gOrb(), M(V(s * 7.4, top, -4.5), 0, 0.75)]);
      } else {
        fin.push([gTorus(0.75, 0.16), M(V(s * 7.4, top - 0.2, -4.5), 0, 1, Math.PI / 2)]);
        fin.push([gOrb(), M(V(s * 7.4, top + 0.55, -4.5), 0, 0.8)]);
        fin.push([gCone(0.12, 1.1), M(V(s * 7.4, top + 1.7, -4.5))]);
      }
    }
    this.merged(fin, "gilt", A, 0.05);
    // the glory behind the head
    const halo = new THREE.Group();
    halo.position.set(0, 30.4, -2.4);
    A.add(halo);
    const halo2 = new THREE.Group();
    halo.add(halo2);
    if (F.halo !== "none") this.torus(3.3, 0.17, "gilt", halo);
    if (F.halo === "spikes") {
      this.torus(4.05, 0.08, "gilt", halo2);
      const n = 12 + F.spikes * 2;
      this.merged(
        Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2;
          const R = 4.6 + (i % 2) * 0.25;
          return [gCone(0.09, 1.1 + (i % 2) * 0.5, 8), M(V(Math.cos(a) * R, Math.sin(a) * R, 0), a - Math.PI / 2)] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        "gilt",
        halo2,
        0.03,
      );
    } else if (F.halo === "beads") {
      const n = 22;
      const items: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [[gTorus(4.15, 0.05), M(V())]];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        items.push([gOrb(), M(V(Math.cos(a) * 4.15, Math.sin(a) * 4.15, 0.05), 0, i % 2 ? 0.17 : 0.27)]);
      }
      this.merged(items, "gilt", halo2, 0.03);
    } else if (F.halo === "rays") {
      const n = 40;
      this.merged(
        Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2;
          const len = i % 2 ? 1.4 : 2.6 + (i % 4 === 0 ? 0.6 : 0);
          const R = 3.55 + len / 2;
          return [gCone(0.07, len, 6), M(V(Math.cos(a) * R, Math.sin(a) * R, 0), a - Math.PI / 2)] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        "gilt",
        halo2,
        0.025,
      );
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
    const belt = this.torus(3.25, 0.22, "gilt", A);
    belt.position.set(0, 23.25, -0.2);
    belt.rotation.x = Math.PI / 2;
    belt.scale.set(sh, 0.62, 1);
    const stoleMat = F.face === "gilt" ? "accent" : "wash2";
    for (const s of [-1, 1]) {
      const stole = this.part(eng(new THREE.BoxGeometry(0.8, 6.4, 0.25, 2, 12, 1), 4, 22), stoleMat, A, 0.05);
      stole.position.set(s * 0.75, 23.9, 1.9);
      stole.rotation.z = s * 0.06;
    }
    // pauldrons: a great orb, a stack of lames, or a spiked orb
    const trim: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
    for (const s of [-1, 1]) {
      const x = s * 3.45 * sh;
      if (F.pauldron === "lames") {
        const lames: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
        [
          [1.95, 1.0, 1.55, 0, 27.35],
          [1.75, 0.82, 1.42, 0.3, 26.65],
          [1.5, 0.66, 1.25, 0.55, 26.05],
        ].forEach(([a, b, c, dx, y], k) => {
          lames.push([orb(32, 16, 2 + k, 0.02, 32, 16), M(V(x + s * dx, y, 0.2 + k * 0.15), s * -0.35, V(a, b, c))]);
          trim.push([gTorus(1, 0.06), M(V(x + s * dx, y - b * 0.55, 0.3 + k * 0.15), s * -0.35, V(a * 0.92, c * 0.9, 1), Math.PI / 2.2)]);
        });
        this.merged(lames, "dark", A, 0.08);
      } else {
        const p = this.orbPart(1.9, 1.35, 1.6, V(x, 27.05, 0.2), "dark", A, 0.03, 0.09);
        p.rotation.z = s * -0.35;
        trim.push([gTorus(1.6, 0.12), M(V(s * 3.6 * sh, 26.35, 0.6), s * -0.35, 1, Math.PI / 2.3)]);
        if (F.pauldron === "spiked")
          for (let k = 0; k < 3; k++) {
            const a = s * (0.25 + k * 0.42);
            trim.push([gCone(0.2, 1.5), M(V(x + Math.sin(a) * 1.75, 27.05 + Math.cos(a) * 1.25, 0.3), -a)]);
          }
      }
    }
    this.merged(trim, "gilt", A, 0.04);
    const { head, beard } = this.throneHead(F);
    const arms = [-1, 1].map((side) => {
      const shoulder = V(side * 4.1 * sh, 26.6, 0.4);
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
      // regalia: a sceptre in the right hand, an orb of dominion in the left
      if (side > 0 && (F.attribute === "sceptre" || F.attribute === "both")) {
        const items: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [[gCyl(0.1, 0.12, 6.6), M(V(0, 3.0, 0.9))]];
        items.push([gOrb(), M(V(0, 6.45, 0.9), 0, 0.34)], [gTorus(0.22, 0.07), M(V(0, 5.9, 0.9), 0, 1, Math.PI / 2)]);
        items.push([gCone(0.16, 1.1), M(V(0, 7.25, 0.9))], [gCone(0.11, 0.8), M(V(-0.34, 7.0, 0.9), 0.75)], [gCone(0.11, 0.8), M(V(0.34, 7.0, 0.9), -0.75)]);
        const sc = this.merged(items, "gilt", hand, 0.035);
        sc.rotation.z = 0.1;
      }
      if (side < 0 && (F.attribute === "orb" || F.attribute === "both")) {
        const items: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [[orb(24, 16, 1, 0, 24, 16), M(V(0, 1.15, 0.55), 0, 0.82)]];
        items.push([gTorus(0.84, 0.07), M(V(0, 1.15, 0.55), 0, 1, Math.PI / 2)], [gTorus(0.84, 0.06, Math.PI), M(V(0, 1.15, 0.55), 0, 1, 0, Math.PI / 2)]);
        items.push([gBox(0.13, 0.9, 0.13), M(V(0, 2.3, 0.55))], [gBox(0.55, 0.13, 0.13), M(V(0, 2.42, 0.55))]);
        this.merged(items, "gilt", hand, 0.035);
      }
      // pose: an orb of dominion is held up before the chest, a sceptre planted a little inward
      const holdsOrb = side < 0 && (F.attribute === "orb" || F.attribute === "both");
      const holdsSceptre = side > 0 && (F.attribute === "sceptre" || F.attribute === "both");
      const rest = holdsOrb ? V(-4.3, 22.5, 2.6) : holdsSceptre ? V(5.2, 21.3, 1.8) : V(side * 5.6, 20.9, 1.5);
      return { side, shoulder, upper, fore, cuff, hand, fingers, rest, pts: [] as THREE.Vector3[], pts2: [] as THREE.Vector3[], lift: 0 };
    });
    const elbow = V(),
      handPos = V(),
      bow = V();
    const sleeveR = (n: number, a: number, b: number) => Array.from({ length: n }, (_, i) => a + (b - a) * (i / (n - 1)) + Math.sin((i / (n - 1)) * Math.PI) * 0.15);
    void r;
    return {
      update: (c) => {
        const breath = Math.sin(c.t * 1.25);
        robe.scale.set(sh * (1 + breath * 0.012), 1 + breath * 0.008, 0.62);
        head.position.y = 28.2 + breath * 0.05 - c.hurt * 0.2;
        head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, F.tilt - c.player.x * 0.02, 0.04);
        head.rotation.x = 0.05 + Math.sin(c.t * 0.6) * 0.03 - c.hurt * 0.12;
        halo.rotation.z += 0.0015 + c.stage * 0.003;
        halo2.rotation.z -= 0.004 + c.stage * 0.006;
        if (wheel) wheel.rotation.z -= 0.0012 + c.stage * 0.002;
        beard.forEach((b, i) => {
          const pts = bowChain(V(b.x, b.y0, 1.15), V(b.x * b.fan + Math.sin(c.t * 1.6 + i) * 0.15, b.y1 - (i % 2) * 0.4, 1.4), V(0, 0, 0.3), 10);
          b.sw.update(pts, pts.map((_, k) => b.r - k * b.r * 0.06));
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

  /** The throne's face: a gilt mask, a bearded stone king, or a king behind a veil of pearls; and its crown. */
  private throneHead(F: TitanForm["throne"]) {
    const A = this.anatomy;
    const head = new THREE.Group();
    head.position.set(0, 28.2, 0.4);
    head.scale.setScalar(F.head);
    A.add(head);
    const faceMat = F.face === "gilt" ? "gilt" : "flesh";
    const neck = this.cyl(0.85, 1.05, 1.0, "body", head);
    neck.position.set(0, 0.2, -0.2);
    const mask = this.part(
      lathe(smoothProfile([[0.01, 0], [0.42, 0.04], [0.78, 0.32], [1.06, 0.88], [1.28, 1.6], [1.38, 2.25], [1.33, 2.9], [1.08, 3.4], [0.6, 3.68], [0.01, 3.76]], 26), 30, 26, 48),
      faceMat,
      head,
      0.07,
    );
    mask.position.set(0, 0.45, 0);
    mask.scale.z = 0.92;
    // deep almond sockets under a stern brow: the eyes read at any size
    const ey = 2.2,
      ex = 0.52;
    this.merged(
      [-1, 1].map((s) => [orb(16, 10, 1, 0, 20, 12), M(V(s * ex, ey - 0.03, 1.04), s * 0.14, V(0.5, 0.25, 0.3))] as [THREE.BufferGeometry, THREE.Matrix4]),
      "void",
      head,
      0,
    );
    for (const s of [-1, 1]) {
      const e = this.eye(head, V(s * ex, ey, 1.2), 0.2, 0.6);
      e.scale.set(0.3, 0.13, 0.2); // long almond eyes under heavy lids
      e.rotation.z = s * 0.14;
    }
    const browArc = 1.7;
    this.merged(
      [-1, 1].map((s) => [gTorus(0.56, 0.085, browArc), M(V(s * ex, ey - 0.3, 1.18), Math.PI / 2 - browArc / 2 + s * 0.2, V(1, 1, 0.6))] as [THREE.BufferGeometry, THREE.Matrix4]),
      F.face === "gilt" ? "dark" : "gilt",
      head,
      0.025,
    );
    // a long straight nose, a carved mouth
    // a long straight nose: a three-sided prism with its ridge toward us (a lit flank, a shaded flank)
    const nose = this.merged(
      [
        [eng(new THREE.CylinderGeometry(0.07, 0.24, 1.25, 3, 1), 8, 8), M(V(0, 1.62, 1.22), 0, V(1, 1, 1.25))],
        [gOrb(), M(V(0, 1.02, 1.3), 0, V(0.3, 0.13, 0.17))],
      ],
      faceMat,
      head,
      0.03,
    );
    void nose;
    const lips: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [
      [gOrb(), M(V(0, 0.93, 1.2), 0, V(0.42, 0.065, 0.12))],
      [gOrb(), M(V(0, 0.8, 1.18), 0, V(0.27, 0.075, 0.11))],
    ];
    this.merged(lips, F.face === "gilt" ? "dark" : "accent", head, 0.02);
    const beard: Array<{ sw: Sweep; x: number; y0: number; y1: number; fan: number; r: number }> = [];
    if (F.face === "gilt") {
      this.orbPart(0.15, 0.22, 0.1, V(0, 2.82, 1.2), "accent", head, 0, 0.02); // a jewel on the brow
      for (let i = 0; i < 5; i++) {
        const sw = new Sweep(10, 6, 6, 14);
        this.part(sw.geo, i % 2 ? "gilt" : "dark", head, 0.03);
        beard.push({ sw, x: (i - 2) * 0.32, y0: 0.5, y1: -1.6, fan: 1.6, r: 0.09 });
      }
    } else if (F.face === "bearded") {
      // moustache and a long braided beard, Assyrian-fashion
      this.merged(
        [-1, 1].map((s) => [this.gTube(bowChain(V(s * 0.12, 1.08, 1.3), V(s * 0.85, 0.42, 1.08), V(s * 0.2, -0.05, 0.05), 10), 0.1, 0.035, 6), M(V())] as [THREE.BufferGeometry, THREE.Matrix4]),
        "gilt",
        head,
        0.025,
      );
      for (let i = 0; i < 7; i++) {
        const sw = new Sweep(10, 8, 8, 16);
        this.part(sw.geo, i % 2 ? "gilt" : "dark", head, 0.03);
        beard.push({ sw, x: (i - 3) * 0.24, y0: 0.62 - Math.abs(i - 3) * 0.06, y1: -2.3 + Math.abs(i - 3) * 0.25, fan: 1.35, r: 0.14 });
      }
    } else {
      // veiled: strands of pearls hang from a gilt band across the face below the eyes
      const items: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [[gTorus(1.28, 0.07, Math.PI * 0.62), M(V(0, 1.86, 0.02), Math.PI * 0.19, V(1, 1, 0.95), Math.PI / 2 - 0.12)]];
      for (let i = 0; i < 9; i++) {
        const x = (i - 4) * 0.25;
        const z = 1.36 - x * x * 0.3;
        const len = 1.55 - Math.abs(i - 4) * 0.07;
        items.push([gCyl(0.025, 0.025, len), M(V(x, 1.86 - len / 2, z))]);
        for (let k = 1; k <= 4; k++) items.push([gOrb(8, 6), M(V(x, 1.86 - (k / 4) * len, z + 0.02), 0, k === 4 ? 0.1 : 0.075)]);
      }
      this.merged(items, "gilt", head, 0.02);
    }
    // the crown
    const crown = new THREE.Group();
    crown.position.set(0, 3.7, 0);
    head.add(crown);
    const circlet = this.torus(1.25, 0.16, "gilt", crown);
    circlet.rotation.x = Math.PI / 2;
    if (F.crown === "spikes") {
      const n = Math.min(7, F.spikes);
      const spikes: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [],
        gems: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1) - 0.5;
        const h = 1.3 + (1 - Math.abs(t) * 1.7) * 1.4;
        spikes.push([gCone(0.22, h), M(V(t * 2.3, h / 2 - 0.05, 0.4 - Math.abs(t) * 0.8), -t * 0.5)]);
        gems.push([gOrb(), M(V(t * 2.3, 0.15, 0.62 - Math.abs(t) * 0.8), 0, 0.16)]);
      }
      this.merged(spikes, "gilt", crown, 0.04);
      this.merged(gems, "accent", crown, 0.02);
    } else if (F.crown === "mitre") {
      const mitre = this.part(lathe(smoothProfile([[1.16, 0], [1.22, 0.7], [1.08, 1.6], [0.66, 2.55], [0.01, 3.1]], 14), 24, 20, 32), "wash2", crown, 0.05);
      mitre.scale.z = 0.5;
      this.merged(
        [
          [gBox(0.26, 2.7, 0.08), M(V(0, 1.3, 0.62))],
          [gBox(1.9, 0.24, 0.08), M(V(0, 0.75, 0.6))],
          [gOrb(), M(V(0, 3.15, 0), 0, 0.2)],
        ],
        "gilt",
        crown,
        0.025,
      );
    } else if (F.crown === "tiara") {
      const dome = this.part(lathe(smoothProfile([[1.12, 0], [1.08, 0.9], [0.78, 1.65], [0.01, 1.95]], 12), 20, 16, 32), "accent", crown, 0.04);
      dome.scale.z = 0.9;
      this.merged(
        [
          [gTorus(1.2, 0.15), M(V(0, 0.55, 0), 0, 1, Math.PI / 2)],
          [gTorus(1.0, 0.14), M(V(0, 1.15, 0), 0, 1, Math.PI / 2)],
          [gOrb(), M(V(0, 2.05, 0), 0, 0.26)],
          [gBox(0.12, 0.85, 0.12), M(V(0, 2.65, 0))],
          [gBox(0.5, 0.12, 0.12), M(V(0, 2.75, 0))],
        ],
        "gilt",
        crown,
        0.03,
      );
    } else {
      // horns of an older, stranger kingship
      this.merged(
        [-1, 1].map((s) => [this.gTube(bowChain(V(s * 0.95, 0.15, 0), V(s * 3.0, 2.9, -0.5), V(s * 0.9, -0.7, 0), 14), 0.36, 0.04), M(V())] as [THREE.BufferGeometry, THREE.Matrix4]),
        "bone",
        crown,
        0.05,
      );
      this.merged(
        [-1, 0, 1].map((k) => [gCone(0.18, k ? 1.0 : 1.5), M(V(k * 0.7, k ? 0.5 : 0.75, 0.95 - Math.abs(k) * 0.25), -k * 0.3)] as [THREE.BufferGeometry, THREE.Matrix4]),
        "gilt",
        crown,
        0.03,
      );
    }
    return { head, beard };
  }

  // ------------------------------------------------------------------ COIL: the leviathan
  private buildCoil(): Rig {
    const r = this.r;
    const F = this.form.coil;
    const A = this.anatomy;
    const N = 64;
    const body = new Sweep(N, 16, 22, 90);
    this.part(body.geo, "scales", A, 0.11);
    const belly = new Sweep(N, 10, 10, 70);
    this.part(belly.geo, F.bands ? "wash2" : "light", A, 0.05);
    const pts = Array.from({ length: N }, () => V());
    const bpts = Array.from({ length: N }, () => V());
    const radii = Array.from({ length: N }, (_, i) => {
      const t = i / (N - 1);
      return 0.04 + 1.55 * Math.pow(Math.sin(Math.min(1, t * 1.05) * Math.PI * 0.93), 0.6);
    });
    // dorsal fins: gilt-tipped spines, webbed sails, or a smooth back
    const fins: THREE.Mesh[] = [];
    if (F.fins === "cones") for (let i = 0; i < 14; i++) fins.push(this.cone(0.38, 1.7, i % 3 ? "dark" : "gilt", A, 0.04));
    else if (F.fins === "sails")
      for (let i = 0; i < 11; i++) {
        const f = this.part(lathe(smoothProfile([[0.01, -0.2], [0.6, 0.3], [0.7, 1.2], [0.3, 2.1], [0.01, 2.4]], 10), 12, 12, 16), i % 2 ? "accent" : "wash2", A, 0.04);
        f.scale.z = 0.2;
        fins.push(f);
      }
    // gilt bands ring the body at intervals
    const bands: THREE.Mesh[] = [];
    if (F.bands) for (let i = 0; i < 9; i++) bands.push(this.torus(1, 0.075, "gilt", A, Math.PI * 2, 0.03));
    const head = new THREE.Group();
    A.add(head);
    const frill = new THREE.Group();
    frill.position.set(0, 0.4, -1.2);
    head.add(frill);
    if (F.frill === "fan") {
      // webbed vanes fanned behind the skull, each tipped with a gilded spine
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
    } else if (F.frill === "spines") {
      // a crest of long spines swept back from the skull
      const n = 7;
      const sp: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [],
        knobs: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      for (let i = 0; i < n; i++) {
        const a = Math.PI * (0.18 + (i / (n - 1)) * 0.64);
        const len = 2.6 + Math.sin((i / (n - 1)) * Math.PI) * 2.2;
        const d = V(Math.cos(a), Math.sin(a), 0);
        sp.push([gCone(0.3, len), M(d.clone().multiplyScalar(0.9 + len / 2), a - Math.PI / 2)]);
        knobs.push([gOrb(), M(d.clone().multiplyScalar(0.95), 0, 0.32)]);
      }
      this.merged(sp, "bone", frill, 0.05);
      this.merged(knobs, "gilt", frill, 0.03);
    } else {
      // antlers, like a qilin's
      const tubes: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      for (const s of [-1, 1]) {
        const beam = bowChain(V(s * 0.8, 0.5, 0), V(s * 3.4, 4.6, -0.3), V(s * 0.9, -0.4, 0), 14);
        tubes.push([this.gTube(beam, 0.26, 0.06), M(V())]);
        for (const k of [5, 9]) {
          const b = beam[k];
          tubes.push([this.gTube(bowChain(b, V(b.x + s * (k === 5 ? 1.5 : 1.1), b.y + 1.2, b.z), V(s * 0.1, -0.3, 0), 8), 0.16, 0.04, 8), M(V())]);
        }
        const inner = beam[7];
        tubes.push([this.gTube(bowChain(inner, V(inner.x - s * 0.5, inner.y + 1.5, inner.z), V(0, 0, 0), 8), 0.15, 0.04, 8), M(V())]);
      }
      this.merged(tubes, "bone", frill, 0.05);
    }
    const snout = F.snout;
    this.orbPart(1.9, 1.15, 1.45, V(0, 0.2, 0.5), "body", head, 0.03, 0.09);
    this.orbPart(1.25 * snout, 0.62, 1.15, V(0, -0.55, 1.35), "light", head, 0.02, 0.06);
    const jaw = new THREE.Group();
    jaw.position.set(0, -0.75, 0.6);
    head.add(jaw);
    this.orbPart(1.3 * snout, 0.45, 1.1, V(0, -0.35, 0.6), "dark", jaw, 0.02, 0.06);
    const upT: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [],
      dnT: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
    for (let i = 0; i < 4; i++) {
      const fx = (i < 2 ? -1 : 1) * (0.45 + (i % 2) * 0.4) * snout;
      upT.push([gCone(0.11, 0.7), M(V(fx, -1.05, 1.75 - (i % 2) * 0.3), Math.PI)]);
      dnT.push([gCone(0.1, 0.55), M(V(fx * 0.85, 0.15, 1.3 - (i % 2) * 0.3))]);
    }
    this.merged(upT, "bone", head, 0.025);
    this.merged(dnT, "bone", jaw, 0.025);
    const whiskers: Array<{ sw: Sweep; s: number }> = [];
    const horns: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
    for (const s of [-1, 1]) {
      this.eye(head, V(s * 1.05, 0.55, 1.45), 0.26, 0.9);
      if (F.horns === "swept") {
        const hornPts = bowChain(V(s * 1.2, 1.0, 0.2), V(s * 3.2, 3.6, -0.5), V(s * 0.6, -0.6, 0), 12);
        horns.push([this.gTube(hornPts, 0.4, 0.04), M(V())]);
      } else if (F.horns === "ram") {
        const n = 22;
        const ram = Array.from({ length: n }, (_, i) => {
          const t = i / (n - 1);
          const phi = Math.PI * 0.85 - t * 4.8;
          const R = 1.15 * (1 - 0.55 * t);
          return V(s * (1.95 + Math.cos(phi) * R), 1.25 + Math.sin(phi) * R, -0.1 - t * 0.5);
        });
        horns.push([this.gTube(ram, 0.42, 0.1), M(V())]);
      }
      if (F.barbels) {
        const whisker = new Sweep(14, 5, 4, 20);
        this.part(whisker.geo, "gilt", head, 0.025);
        whiskers.push({ sw: whisker, s });
      }
    }
    if (horns.length) this.merged(horns, "bone", head, 0.05);
    const phase = r.range(0, 6);
    const amp = r.range(0.85, 1.25);
    const lean = r.chance(0.5) ? 1 : -1;
    let mouth = 0;
    const along = (i: number, k: number) => {
      const a = pts[i],
        b = pts[i + 1];
      const tx = b.x - a.x,
        ty = b.y - a.y;
      const L = Math.hypot(tx, ty) || 1;
      return { a, tx, ty, L, k };
    };
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
        const stride = F.fins === "sails" ? 4 : 3;
        fins.forEach((f, k) => {
          const i = 6 + k * stride;
          const { a, tx, ty, L } = along(i, k);
          f.position.set(a.x - (ty / L) * radii[i] * 1.05, a.y + (tx / L) * radii[i] * 1.05, a.z - 0.2);
          f.rotation.z = Math.atan2(-ty, -tx) + Math.PI / 2 + Math.PI + Math.sin(c.t * 2 + k) * 0.12;
          f.scale.setScalar(0.6 + radii[i] * 0.35);
        });
        bands.forEach((b, k) => {
          const i = 7 + k * 6;
          const d = V().subVectors(pts[i + 1], pts[i - 1]).normalize();
          b.position.copy(pts[i]);
          b.quaternion.setFromUnitVectors(V(0, 0, 1), d);
          b.scale.setScalar(radii[i] * 1.03);
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
    const F = this.form.strider;
    const A = this.anatomy;
    const pivot = new THREE.Group();
    pivot.position.set(0, 27.4, -1);
    A.add(pivot);
    const raw: Record<typeof F.shell, Array<[number, number]>> = {
      dome: [[0.01, -2.2], [3.6, -2.0], [5.6, -0.8], [5.9, 0.4], [5.0, 1.6], [3.2, 2.5], [0.01, 2.9]],
      saucer: [[0.01, -1.6], [4.2, -1.5], [6.2, -0.55], [6.5, 0.15], [5.5, 0.95], [3.1, 1.6], [0.01, 1.85]],
      bell: [[0.01, -2.2], [3.0, -2.1], [4.8, -1.1], [5.0, 0.5], [4.3, 2.1], [2.7, 3.3], [0.01, 3.8]],
    };
    const prof = smoothProfile(raw[F.shell], 30);
    const maxR = Math.max(...prof.map((q) => q[0]));
    const iMax = prof.findIndex((q) => q[0] === maxR);
    /** height of the shell's upper surface above a given radius (for ornaments that stand on it) */
    const topY = (x: number) => {
      const ax = Math.min(Math.abs(x), maxR - 0.01);
      for (let i = iMax; i < prof.length - 1; i++) {
        const [r0, y0] = prof[i],
          [r1, y1] = prof[i + 1];
        if ((ax <= r0 && ax >= r1) || (ax >= r0 && ax <= r1)) return y0 + ((ax - r0) / (r1 - r0 || 1)) * (y1 - y0);
      }
      return prof[prof.length - 1][1];
    };
    const shell = this.part(lathe(prof, 64, 26, 96, F.folds, 0.045), "dark", pivot, 0.11);
    shell.scale.z = 0.62;
    const bottom = prof[0][1];
    if (F.back === "plates") {
      const gilt: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [],
        sc: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      for (let i = 0; i < 7; i++) {
        const t = i / 6 - 0.5;
        const x = t * (maxR * 1.4);
        (i % 2 ? gilt : sc).push([orb(20, 14, i, 0.03, 24, 16), M(V(x, topY(x) - 0.75 + 0.15, 1.6 + (0.5 - Math.abs(t)) * 0.6), -t * 1.2, V(1.25, 0.75, 0.9))]);
      }
      this.merged(gilt, "gilt", pivot, 0.06);
      this.merged(sc, "scales", pivot, 0.06);
    } else if (F.back === "spires") {
      // it carries a walled city on its back
      const towers: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [],
        roofs: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [],
        gilt: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      const xs = [-0.66, -0.36, 0, 0.36, 0.66];
      xs.forEach((u, i) => {
        const x = u * maxR;
        const h = [1.6, 2.5, 3.6, 2.5, 1.6][i];
        const rr = [0.48, 0.55, 0.7, 0.55, 0.48][i];
        const y0 = topY(x) - 0.5;
        towers.push([gCyl(rr, rr * 1.08, h), M(V(x, y0 + h / 2, 0.2))]);
        roofs.push([gCone(rr * 1.35, rr * 2.4), M(V(x, y0 + h + rr * 1.2, 0.2))]);
        gilt.push([gOrb(), M(V(x, y0 + h + rr * 2.45, 0.2), 0, 0.16)], [gTorus(rr * 1.12, 0.07), M(V(x, y0 + h - 0.05, 0.2), 0, 1, Math.PI / 2)]);
      });
      // a curtain wall between the towers
      towers.push([gBox(maxR * 1.3, 0.9, 0.5), M(V(0, topY(0) - 0.15, 0.1))]);
      this.merged(towers, "stone", pivot, 0.05);
      this.merged(roofs, "accent", pivot, 0.04);
      this.merged(gilt, "gilt", pivot, 0.025);
    } else {
      // a ridge of bone spines
      const sp: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      const n = 11;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1) - 0.5;
        const x = u * maxR * 1.55;
        const y = topY(x);
        const a = -u * 1.3;
        const len = 1.4 + (0.5 - Math.abs(u)) * 2.4;
        sp.push([gCone(0.3, len), M(V(x + Math.sin(-a) * len * 0.35, y + Math.cos(a) * len * 0.35 - 0.2, 0.3), a)]);
      }
      this.merged(sp, "bone", pivot, 0.05);
    }
    const ridge = this.torus(maxR - 0.2, 0.16, "gilt", pivot, Math.PI);
    ridge.scale.set(1, 0.5, 1);
    ridge.position.set(0, -0.3, 1.6);
    const head = new THREE.Group();
    head.position.set(0, bottom, 2.1);
    pivot.add(head);
    this.orbPart(1.9, 1.35, 1.4, V(0, 0, 0), "body", head, 0.04, 0.08);
    const mand: THREE.Mesh[] = [];
    let trunk: { sw: Sweep; pts: THREE.Vector3[] } | null = null;
    if (F.head === "mandibles")
      for (const s of [-1, 1]) {
        const m = this.cone(0.3, 1.8, "bone", head, 0.04);
        m.position.set(s * 0.8, -1.6, 0.7);
        m.rotation.z = Math.PI + s * 0.35;
        mand.push(m);
      }
    else if (F.head === "tusks")
      this.merged(
        [-1, 1].map((s) => [this.gTube(bowChain(V(s * 0.95, -0.7, 0.9), V(s * 1.05, -3.7, 1.6), V(s * 1.0, 0.2, 0), 14), 0.34, 0.05), M(V())] as [THREE.BufferGeometry, THREE.Matrix4]),
        "bone",
        head,
        0.04,
      );
    else {
      const sw = new Sweep(16, 10, 10, 26);
      this.part(sw.geo, "scales", head, 0.05);
      trunk = { sw, pts: [] };
    }
    const n = F.eyes;
    const rows = F.eyeRows;
    for (let i = 0; i < n; i++) {
      const row = rows === 2 && i >= Math.ceil(n / 2) ? 1 : 0;
      const inRow = rows === 2 ? (row ? n - Math.ceil(n / 2) : Math.ceil(n / 2)) : n;
      const j = row ? i - Math.ceil(n / 2) : i;
      const t = inRow === 1 ? 0 : j / (inRow - 1) - 0.5;
      const rr = (0.2 + (1 - Math.abs(t) * 1.6) * 0.14) * (row ? 0.75 : 1);
      const y = row ? -0.32 : 0.35 - Math.abs(t) * 0.9 * (rows === 2 ? 0.5 : 1) + (rows === 2 ? 0.1 : (i % 2) * 0.28);
      this.eye(head, V(t * (row ? 1.7 : 2.4), y, 1.25 - Math.abs(t) * 0.5), rr, 0.7);
    }
    const perSide = Math.max(2, Math.min(3, Math.round(this.spec.limbs / 2)));
    const lw = F.leg;
    const legs: Array<{ side: number; idx: number; hip: THREE.Vector3; rest: THREE.Vector3; thigh: Sweep; shin: Sweep; claw: THREE.Mesh; joint: THREE.Mesh; lift: number; tx: number; pa: THREE.Vector3[]; pb: THREE.Vector3[] }> = [];
    for (const side of [-1, 1])
      for (let i = 0; i < perSide; i++) {
        const thigh = new Sweep(12, 10, 12, 20);
        const shin = new Sweep(16, 10, 12, 30);
        this.part(thigh.geo, "body", A, 0.08);
        this.part(shin.geo, "scales", A, 0.08);
        const claw = this.cone(0.32, 1.3, "bone", A, 0.04);
        const joint =
          F.knee === "orb"
            ? this.orbPart(0.62, 0.62, 0.62, V(), "gilt", A, 0, 0.05)
            : this.merged([[gOrb(), M(V(), 0, 0.46)], [gCone(0.24, 1.6), M(V(0, 0.95, 0))], [gTorus(0.5, 0.07), M(V(0, -0.1, 0), 0, 1, Math.PI / 2)]], "gilt", A, 0.04);
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
        if (trunk) {
          const sway = Math.sin(c.t * 1.3) * 0.5 + (c.player.x - head.position.x) * 0.03;
          bowChain(V(0, -0.9, 1.1), V(sway + 0.3, -4.3 - c.hurt * 0.5, 1.7), V(Math.sin(c.t * 0.9) * 0.6 - 0.3, 0.2, 0.4), 16, trunk.pts);
          trunk.sw.update(trunk.pts, trunk.pts.map((_, i) => 0.4 * (1 - i / 17) + 0.07));
        }
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
          knee.set(L.side * (7.6 + L.idx * 1.2), 31 + F.kneeLift + L.lift * 1.2 - L.idx * 0.5, -0.4);
          bowChain(hip, knee, bow.set(0, 0.5, 0), 12, L.pa);
          bowChain(knee, foot, bow.set(L.side * 0.5, 0, 0.3), 16, L.pb);
          L.thigh.update(L.pa, L.pa.map((_, i) => (0.7 - i * 0.022) * lw));
          L.shin.update(L.pb, L.pb.map((_, i) => (0.5 - i * 0.022) * lw));
          L.joint.position.copy(knee);
          L.joint.rotation.z = -L.side * 0.45;
          L.claw.position.copy(foot).add(V(0, -0.35, 0));
          L.claw.rotation.z = Math.PI - L.side * 0.1;
        }
      },
    };
  }

  // ------------------------------------------------------------------ BLOOM: the drifting crown
  private buildBloom(): Rig {
    const r = this.r;
    const F = this.form.bloom;
    const A = this.anatomy;
    const crown = new THREE.Group();
    crown.position.set(0, 26.2, -2);
    A.add(crown);
    const base = Math.min(12, this.spec.limbs + 4);
    const n = F.petal === "thistle" ? Math.min(14, base + 3) : base;
    const shapes: Record<typeof F.petal, Array<[number, number]>> = {
      lancet: [[0.01, 0], [0.55, 0.6], [0.95, 1.8], [0.9, 3.0], [0.5, 4.0], [0.01, 4.6]],
      round: [[0.01, 0], [0.7, 0.45], [1.25, 1.6], [1.3, 2.8], [0.95, 3.85], [0.01, 4.3]],
      thistle: [[0.01, 0], [0.32, 0.5], [0.52, 2.0], [0.42, 3.4], [0.16, 4.5], [0.01, 5.0]],
    };
    const prof = smoothProfile(shapes[F.petal], 12);
    const petal = (len: number) => lathe(prof.map(([q, y]) => [q, (y * len) / 4.6] as [number, number]), 18, 20, 20);
    // the outer ring flutters petal by petal; the inner rings are baked and turn as one
    const petals: Array<{ m: THREE.Mesh; a: number }> = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.range(-0.08, 0.08);
      const g = new THREE.Group();
      g.rotation.z = a;
      crown.add(g);
      const p = this.part(petal(4.6), i % 3 === 0 ? "gilt" : "body", g, 0.08);
      p.scale.z = 0.25;
      p.position.set(0, 1.6, 0);
      petals.push({ m: p, a });
    }
    const inner: THREE.Object3D[] = [];
    for (let layer = 1; layer < F.layers; layer++) {
      const len = layer === 1 ? 3.4 : 2.3;
      const g = new THREE.Group();
      g.position.z = layer * 0.6;
      crown.add(g);
      this.merged(
        Array.from({ length: n }, (_, i) => {
          const a = ((i + layer * 0.5) / n) * Math.PI * 2;
          const pos = V(-Math.sin(a) * (1.6 + layer * 0.3), Math.cos(a) * (1.6 + layer * 0.3), 0);
          return [petal(len), M(pos, a, V(1, 1, 0.25))] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        layer === 1 ? "accent" : "wash2",
        g,
        0.07,
      );
      inner.push(g);
    }
    if (F.leaves) {
      for (const s of [-1, 1]) {
        const leaf = this.part(lathe(smoothProfile([[0.01, 0], [0.9, 1.2], [1.15, 3.0], [0.6, 4.6], [0.01, 5.5]], 14), 16, 20, 20), "wash2", A, 0.07);
        leaf.scale.z = 0.2;
        leaf.position.set(s * 1.8, 25.0, -2.8);
        leaf.rotation.z = -s * 2.2;
      }
    }
    this.orbPart(2.7, 2.6, 2.2, V(0, 26.2, 0.4), "body", A, 0.05, 0.1);
    const ruff = new THREE.Group();
    ruff.position.set(0, 26.2, 1.2);
    A.add(ruff);
    this.torus(2.7, F.ruff === "torus" ? 0.22 : 0.12, "gilt", ruff);
    if (F.ruff === "beads")
      this.merged(
        Array.from({ length: 18 }, (_, i) => {
          const a = (i / 18) * Math.PI * 2;
          return [gOrb(), M(V(Math.cos(a) * 2.7, Math.sin(a) * 2.7, 0.15), 0, i % 2 ? 0.2 : 0.3)] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        "gilt",
        ruff,
        0.03,
      );
    else if (F.ruff === "thorns")
      this.merged(
        Array.from({ length: 16 }, (_, i) => {
          const a = (i / 16) * Math.PI * 2;
          return [gCone(0.13, 0.85, 8), M(V(Math.cos(a) * 3.05, Math.sin(a) * 3.05, 0), a - Math.PI / 2)] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        "gilt",
        ruff,
        0.03,
      );
    this.eye(A, V(0, 26.3, 2.25), 1.7, 0.45, true);
    if (F.lashes)
      this.merged(
        Array.from({ length: 13 }, (_, i) => {
          const a = Math.PI * (0.12 + (i / 12) * 0.76);
          return [gCone(0.06, 0.9, 6), M(V(Math.cos(a) * 1.95, 26.3 + Math.sin(a) * 1.95, 2.6), a - Math.PI / 2)] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        "void",
        A,
        0,
      );
    const tendrils: Array<{ sw: Sweep; root: THREE.Vector3; tip: THREE.Vector3; ph: number; bud: THREE.Mesh; lift: number; pts: THREE.Vector3[] }> = [];
    for (const o of this.spec.origins) {
      const sw = new Sweep(18, 10, 10, 26);
      this.part(sw.geo, "scales", A, 0.06);
      let bud: THREE.Mesh;
      if (F.bud === "orb") bud = this.orbPart(0.55, 0.7, 0.5, V(), "accent", A, 0.05, 0.05);
      else if (F.bud === "bell") {
        bud = this.merged(
          [
            [lathe(smoothProfile([[0.12, 0.75], [0.42, 0.55], [0.6, 0.0], [0.82, -0.6], [0.66, -0.72]], 10), 12, 10, 20), M(V())],
            [gOrb(), M(V(0, -0.55, 0), 0, 0.2)],
          ],
          "accent",
          A,
          0.04,
        );
      } else bud = this.merged([[gCone(0.3, 1.3), M(V(0, -0.5, 0), Math.PI)], [gOrb(), M(V(0, 0.2, 0), 0, V(0.45, 0.5, 0.4))]], "bone", A, 0.04);
      tendrils.push({ sw, root: V(o.x * 0.32, 24.2, 0.6), tip: V(o.x, 20.3, 1.4), ph: r.range(0, 6), bud, lift: 0, pts: [] });
    }
    const bow = V();
    return {
      update: (c) => {
        const open = (0.94 + Math.sin(c.t * 0.8) * 0.05 + c.stage * 0.04) * F.spread;
        crown.rotation.z = Math.sin(c.t * 0.22) * 0.1;
        crown.scale.setScalar(open * (1 - c.hurt * 0.06));
        petals.forEach((p, i) => {
          p.m.rotation.x = Math.sin(c.t * 1.2 + i * 0.7) * 0.18 - c.hurt * 0.35;
          p.m.position.y = 1.6 + Math.sin(c.t * 1.2 + i) * 0.08;
        });
        inner.forEach((g, k) => {
          g.rotation.z = Math.sin(c.t * (0.5 + k * 0.2) + k) * 0.06;
          g.rotation.x = -c.hurt * 0.25;
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
    const F = this.form.swarm;
    const A = this.anatomy;
    // the heart itself: an iron-bound egg, a sacred heart, an anatomical heart, or a cut geode
    const hs = F.heart === "sacred" ? V(2.75, 2.75, 2.4) : F.heart === "geode" ? V(3.1, 3.4, 2.5) : V(3.3, 3.5, 2.6);
    let heartGeo: THREE.BufferGeometry;
    if (F.heart === "sacred") {
      const sh = new THREE.Shape();
      sh.moveTo(0, -1.05);
      sh.bezierCurveTo(-0.3, -0.72, -1.05, -0.22, -1.05, 0.36);
      sh.bezierCurveTo(-1.05, 0.84, -0.62, 1.08, -0.38, 1.05);
      sh.bezierCurveTo(-0.15, 1.02, 0, 0.86, 0, 0.62);
      sh.bezierCurveTo(0, 0.86, 0.15, 1.02, 0.38, 1.05);
      sh.bezierCurveTo(0.62, 1.08, 1.05, 0.84, 1.05, 0.36);
      sh.bezierCurveTo(1.05, -0.22, 0.3, -0.72, 0, -1.05);
      const ex = new THREE.ExtrudeGeometry(sh, { depth: 0.4, bevelEnabled: true, bevelThickness: 0.42, bevelSize: 0.3, bevelSegments: 8, curveSegments: 28 }).translate(0, 0, -0.2);
      ex.deleteAttribute("normal");
      heartGeo = mergeVertices(ex, 1e-4);
      heartGeo.computeVertexNormals(); // a smooth pillowed heart, not a faceted one
      eng(heartGeo, 24, 24);
    } else if (F.heart === "anatomical")
      heartGeo = lathe(smoothProfile([[0.01, -1.15], [0.3, -0.95], [0.62, -0.55], [0.86, -0.05], [0.96, 0.35], [0.86, 0.7], [0.55, 0.93], [0.01, 1.0]], 26), 44, 30, 64, 5, 0.04).rotateZ(-0.32);
    else if (F.heart === "geode") heartGeo = eng(new THREE.IcosahedronGeometry(1, 1), 24, 24);
    else heartGeo = orb(44, 30, r.range(0, 9), 0.16, 64, 40);
    const heart = this.part(heartGeo, F.ink, A, 0.12);
    heart.scale.copy(hs);
    heart.position.set(0, 26, -0.5);
    const eyeZ = F.heart === "sacred" ? 0.66 : F.heart === "anatomical" ? 0.9 : 0.93;
    if (F.heart === "anatomical") {
      // atria, and the arch of the great vessel with its branches, drawn dark
      this.merged(
        [
          [orb(24, 16, 2, 0.05, 28, 18), M(V(-0.42, 0.82, -0.2), 0.3, V(0.36, 0.3, 0.34))],
          [orb(24, 16, 3, 0.05, 28, 18), M(V(0.4, 0.78, -0.25), -0.3, V(0.32, 0.27, 0.3))],
        ],
        F.ink === "wash2" ? "accent" : "wash2",
        heart,
        0.03,
      );
      const arch = bowChain(V(0.02, 0.8, 0.0), V(0.62, 1.02, -0.3), V(0, 0.5, 0), 14);
      this.merged(
        [
          [this.gTube(arch, 0.1, 0.08), M(V())],
          [this.gTube(bowChain(V(0.2, 1.18, -0.12), V(0.12, 1.45, -0.12), V(0, 0, 0), 6), 0.04, 0.035, 8), M(V())],
          [this.gTube(bowChain(V(0.38, 1.2, -0.18), V(0.44, 1.46, -0.18), V(0, 0, 0), 6), 0.04, 0.035, 8), M(V())],
          [this.gTube(bowChain(V(-0.3, 0.98, -0.12), V(-0.6, 1.36, -0.22), V(0, 0.08, 0), 8), 0.07, 0.05, 8), M(V())],
        ],
        "dark",
        heart,
        0.02,
      );
    }
    // meridian bands and rivets: an iron-bound heart (baked: two draws, not seven)
    const bandsG: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [],
      bandsD: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
    if (F.heart === "sacred") {
      // a sacred heart wears a gilt wound instead of iron bands
      bandsG.push([gOrb(), M(V(-0.5, 0.4, 0.6), 1.0, V(0.22, 0.06, 0.08))]);
    } else {
      for (let i = 0; i < F.bands; i++) (i % 2 ? bandsG : bandsD).push([gTorus(1, 0.035), M(V(), 0, 1.02, 0, (i / F.bands) * Math.PI)]);
      bandsG.push([gTorus(1, 0.05), M(V(), 0, 1.03, Math.PI / 2)]);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        bandsG.push([gOrb(8, 6), M(V(Math.cos(a) * 1.02, 0, Math.sin(a) * 1.02), 0, 0.06)]);
      }
    }
    this.merged(bandsG, "gilt", heart, 0.012);
    if (bandsD.length) this.merged(bandsD, "dark", heart, 0.012);
    const veins: Sweep[] = [];
    for (let i = 0; i < 6; i++) {
      const sw = new Sweep(14, 6, 5, 18);
      this.part(sw.geo, i % 2 ? "gilt" : "accent", A, 0.04);
      veins.push(sw);
    }
    // the cage: an armillary of broken ribs, a gyre of whole rings, or a crown of thorns
    const ribs: THREE.Mesh[] = [];
    const gyre: Array<{ g: THREE.Object3D; ax: THREE.Vector3; sp: number }> = [];
    let thorns: THREE.Object3D | null = null;
    if (F.cage === "armillary" || F.cage === "thorns")
      for (let i = 0; i < (F.cage === "thorns" ? 3 : 6); i++) {
        const rib = this.torus(4.2 + i * 0.35 + (F.cage === "thorns" ? 1.2 : 0), 0.15, i % 2 ? "gilt" : "bone", A, Math.PI * 1.3, 0.05);
        rib.position.set(0, 26, -0.5);
        rib.rotation.set(r.range(-0.9, 0.9), r.range(-0.9, 0.9), r.range(0, 6));
        ribs.push(rib);
      }
    if (F.cage === "gyre")
      for (let i = 0; i < 3; i++) {
        const g = new THREE.Group();
        g.position.set(0, 26, -0.5);
        A.add(g);
        const R = 4.4 + i * 0.75;
        const items: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [[gTorus(R, 0.13 - i * 0.02), M(V())]];
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + i;
          items.push([gOrb(), M(V(Math.cos(a) * R, Math.sin(a) * R, 0), 0, 0.26)]);
        }
        this.merged(items, i === 1 ? "bone" : "gilt", g, 0.04);
        g.rotation.set(r.range(-1.2, 1.2), r.range(-1.2, 1.2), 0);
        gyre.push({ g, ax: V(r.range(-1, 1), r.range(-1, 1), r.range(-0.3, 0.3)).normalize(), sp: r.range(0.003, 0.007) * (i % 2 ? -1 : 1) });
      }
    if (F.cage === "thorns") {
      thorns = new THREE.Group();
      thorns.position.set(0, 26, 0.2);
      thorns.rotation.set(1.15, 0, 0.12);
      A.add(thorns);
      // two briars braided around a ring
      const items: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
      for (let k = 0; k < 2; k++) {
        const n = 120;
        const pts = Array.from({ length: n }, (_, i) => {
          const th = (i / (n - 1)) * Math.PI * 2;
          const w = th * 9 + k * Math.PI;
          const R = 3.75 + Math.cos(w) * 0.17;
          return V(Math.cos(th) * R, Math.sin(th) * R, Math.sin(w) * 0.17);
        });
        items.push([this.gTube(pts, 0.1, 0.1, 6), M(V())]);
      }
      this.merged(items, "bone", thorns, 0.04);
      this.merged(
        Array.from({ length: 26 }, (_, i) => {
          const a = (i / 26) * Math.PI * 2;
          const up = i % 2 ? 0.5 : -0.5;
          return [gCone(0.08, 0.8, 6), M(V(Math.cos(a) * 4.1, Math.sin(a) * 4.1, up * 0.3), a - Math.PI / 2 + up, 1)] as [THREE.BufferGeometry, THREE.Matrix4];
        }),
        "dark",
        thorns,
        0.02,
      );
    }
    // a sacred heart's flames
    const flames: THREE.Mesh[] = [];
    if (F.flames) {
      const fp = smoothProfile([[0.01, 0], [0.5, 0.35], [0.62, 1.0], [0.36, 1.85], [0.01, 2.7]], 12);
      for (let i = 0; i < 3; i++) {
        // a tongue of flame: the lathe is bent into an S that licks to one side
        const g = lathe(fp, 12, 16, 20);
        const pos = g.attributes.position as THREE.BufferAttribute;
        for (let k = 0; k < pos.count; k++) {
          const y = pos.getY(k);
          pos.setX(k, pos.getX(k) + Math.sin(y * 2.3 + i) * 0.22 * (y / 2.7) * (i === 0 ? -1 : 1));
        }
        g.computeVertexNormals();
        const f = this.part(g, i === 1 ? "gilt" : "accent", A, 0.05);
        f.position.set((i - 1) * 0.95, 26 + hs.y * 0.8 - Math.abs(i - 1) * 0.3, -0.3);
        f.rotation.z = -(i - 1) * 0.4;
        f.scale.set(i === 1 ? 1.25 : 0.9, i === 1 ? 1.5 : 1.05, 0.45);
        flames.push(f);
      }
    }
    const slit = this.eye(heart, V(0, 0.08, eyeZ), 0.24, 0.45);
    slit.scale.set(0.2, 0.3, 0.12); // a tall, narrow eye
    (slit.children.find((c) => c instanceof THREE.Mesh && c.material === this.m.pupil) as THREE.Mesh | undefined)?.scale.set(0.18, 0.9, 0.3);
    if (F.eyes === 3)
      for (const s of [-1, 1]) {
        const e = this.eye(heart, V(s * 0.42, 0.2, eyeZ - 0.07), 0.14, 0.45);
        e.scale.set(0.13, 0.18, 0.1);
        e.rotation.z = s * 0.25;
      }
    // the swarm: shards of iron and gold, moths, or lidless eyes, each kind one instanced draw
    type Mote = { R: number; sp: number; ph: number; tilt: number; s: number; im: THREE.InstancedMesh; k: number };
    const motes: Mote[] = [];
    const pupils: { im: THREE.InstancedMesh | null } = { im: null };
    const add = (im: THREE.InstancedMesh, count: number, s0: number, s1: number) => {
      for (let k = 0; k < count; k++) motes.push({ R: r.range(4.6, 9.5), sp: r.range(0.22, 0.6) * (r.chance(0.5) ? 1 : -1), ph: r.range(0, 6.3), tilt: r.range(-0.7, 0.7), s: r.range(s0, s1), im, k });
    };
    if (F.swarm === "shards") {
      const g = () => eng(new THREE.OctahedronGeometry(1, 0), 8, 8);
      add(this.instanced(g(), "gilt", 8), 8, 0.25, 0.55);
      add(this.instanced(g(), "accent", 7), 7, 0.25, 0.55);
      add(this.instanced(g(), "dark", 15), 15, 0.25, 0.55);
    } else if (F.swarm === "moths") {
      const wings = () => {
        const geos: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [
          [orb(10, 8, 1, 0, 12, 8), M(V(-0.55, 0.1, 0), 0.5, V(0.62, 0.34, 0.08))],
          [orb(10, 8, 2, 0, 12, 8), M(V(0.55, 0.1, 0), -0.5, V(0.62, 0.34, 0.08))],
          [orb(10, 8, 3, 0, 12, 8), M(V(-0.38, -0.3, 0), -0.4, V(0.36, 0.24, 0.08))],
          [orb(10, 8, 4, 0, 12, 8), M(V(0.38, -0.3, 0), 0.4, V(0.36, 0.24, 0.08))],
          [orb(8, 8, 5, 0, 10, 8), M(V(0, -0.05, 0.05), 0, V(0.1, 0.42, 0.1))],
        ];
        const gs = geos.map(([g, m]) => g.applyMatrix4(m));
        return mergeGeometries(gs, false)!;
      };
      add(this.instanced(wings(), "dark", 16, A, 0.03), 16, 0.7, 1.1);
      add(this.instanced(wings(), "wash2", 10, A, 0.03), 10, 0.7, 1.1);
    } else {
      const balls = this.instanced(orb(12, 8, 1, 0, 16, 12), "eye", 14, A, 0.03);
      add(balls, 14, 0.32, 0.6);
      pupils.im = this.instanced(orb(8, 6, 2, 0, 10, 8), "pupil", 14, A, 0);
    }
    const veinEnds = Array.from({ length: 6 }, (_, i) => ({ a: (i / 6) * Math.PI * 2 + 0.3, len: r.range(4, 6.5) }));
    const dummy = new THREE.Object3D();
    const q = new THREE.Quaternion();
    return {
      update: (c) => {
        const ph = ((c.beat % 1) + 1) % 1;
        const pulse = 1 + Math.pow(1 - ph, 7) * 0.07 + (ph > 0.45 && ph < 0.6 ? 0.025 : 0);
        heart.scale.copy(hs).multiplyScalar(pulse);
        ribs.forEach((rb, i) => (rb.rotation.z += 0.0018 * (i + 1) * (1 + c.stage * 0.7) * (i % 2 ? 1 : -1)));
        for (const G of gyre) G.g.quaternion.multiply(q.setFromAxisAngle(G.ax, G.sp * (1 + c.stage * 0.6)));
        if (thorns) thorns.rotation.z += 0.002 * (1 + c.stage);
        flames.forEach((f, i) => {
          const k = 1 + Math.sin(c.t * (5 + i) + i * 2) * 0.08 + Math.pow(1 - ph, 5) * 0.12;
          f.scale.y = (i === 1 ? 1.5 : 1.05) * k;
          f.rotation.z = -(i - 1) * 0.4 + Math.sin(c.t * 3.1 + i) * 0.06;
        });
        veinEnds.forEach((v, i) => {
          const a = v.a + Math.sin(c.t * 0.4 + i) * 0.1;
          const p0 = V(Math.cos(a) * 2.6, 26 + Math.sin(a) * 2.7, 1.2);
          const p1 = V(Math.cos(a) * v.len, 26 + Math.sin(a) * v.len * 0.8, 0);
          const pts = bowChain(p0, p1, V(Math.sin(c.t + i) * 0.6, 0.3, 0), 14);
          veins[i].update(pts, pts.map((_, k) => 0.16 - k * 0.008));
        });
        const ims = new Set<THREE.InstancedMesh>();
        for (const s of motes) {
          const a = s.ph + c.t * s.sp * (1 + c.stage * 0.35);
          dummy.position.set(Math.cos(a) * s.R, 26 + Math.sin(a) * s.R * 0.55 + Math.sin(a * 2) * s.tilt, Math.sin(a) * 2.5 - 1);
          if (F.swarm === "shards") {
            dummy.rotation.set(c.t * s.sp, c.t * 0.6, a);
            dummy.scale.setScalar(s.s);
          } else if (F.swarm === "moths") {
            dummy.rotation.set(0.3, 0, Math.atan2(Math.cos(a) * s.sp, -Math.sin(a) * s.sp) - Math.PI / 2);
            dummy.scale.set(s.s * (0.35 + 0.65 * Math.abs(Math.sin(c.t * 9 + s.ph * 3))), s.s, s.s);
          } else {
            dummy.rotation.set(0, 0, 0);
            dummy.scale.setScalar(s.s);
          }
          dummy.updateMatrix();
          s.im.setMatrixAt(s.k, dummy.matrix);
          ims.add(s.im);
          if (pupils.im) {
            // lidless eyes all turn to the hunter
            const dx = THREE.MathUtils.clamp((c.player.x - dummy.position.x) * 0.06, -0.45, 0.45),
              dy = THREE.MathUtils.clamp((c.player.y - dummy.position.y) * 0.03, -0.45, 0.2);
            dummy.position.add(V(dx * s.s, dy * s.s, 0.85 * s.s));
            dummy.scale.set(0.42 * s.s, 0.62 * s.s, 0.3 * s.s);
            dummy.updateMatrix();
            pupils.im.setMatrixAt(s.k, dummy.matrix);
          }
        }
        ims.forEach((im) => (im.instanceMatrix.needsUpdate = true));
        if (pupils.im) pupils.im.instanceMatrix.needsUpdate = true;
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
      const soon = c.coreSoon?.[i] ? 0.28 + 0.22 * Math.sin(c.t * 18) : 0;
      (m.aura.material as THREE.ShaderMaterial).uniforms.uOpen.value = Math.max(m.open, soon);
      m.aura.scale.setScalar(1 + (c.coreHit[i] ?? 0) * 0.25);
      const k = m.open;
      // blades swing outward like an aperture, and shrink back into the frame
      for (const b of m.shell) {
        b.rotation.z = -k * 1.25;
        b.position.set(k * 0.35, 0, 0);
        b.scale.setScalar(1 - k * 0.55);
      }
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
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    for (const k in this.m) this.m[k].dispose();
  }
}

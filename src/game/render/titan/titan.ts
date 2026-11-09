import * as THREE from "three";
import { TitanSpec } from "@/core/titan";
import { rngFor } from "@/core/rng";
import { engraveMaterial, goldMaterial, outlineMaterial, titanUniforms, TitanUniforms } from "./material";
import { bowChain, lumpySphere, Sweep } from "./geo";

// The living titan: procedural anatomy per archetype, engraved, gilded, and animated to its song.

export interface TitanCtx {
  t: number; // seconds since wake
  beat: number; // absolute beats
  player: { x: number; y: number };
  cues: Array<{ x: number; y: number; lead: number; heavy: boolean; kind: string }>; // upcoming attacks (lead in beats, 0 = now)
  stage: number;
  crack: number; // 0..1
  hurt: number; // 0..1 recent damage flinch
  coreOpen: boolean[];
  coreHit: number[]; // 0..1 per core
}

interface Rig {
  update(c: TitanCtx): void;
}

const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
const ease = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class Titan {
  group = new THREE.Group();
  /** anatomy is drawn larger than the page so the titan bursts out of its margins; cores stay at their true positions */
  body = new THREE.Group();
  u: TitanUniforms = titanUniforms();
  private rig!: Rig;
  private coreMeshes: Array<{ gem: THREE.Mesh; shell: THREE.Mesh[]; ring: THREE.Mesh; mat: THREE.ShaderMaterial }> = [];
  private eyes: Array<{ ball: THREE.Object3D; pupil: THREE.Object3D; r: number; lid: THREE.Mesh }> = [];
  private bodyMat: THREE.ShaderMaterial;
  private bodyDark: THREE.ShaderMaterial;
  private bodyLight: THREE.ShaderMaterial;
  private gilt: THREE.ShaderMaterial;
  private outline: THREE.ShaderMaterial;
  private outlineThin: THREE.ShaderMaterial;
  private blinkT = 2;
  private anatomy!: THREE.Group;
  constructor(public spec: TitanSpec) {
    const p = spec.plate;
    this.u.uInk.value.set(p.ink);
    this.u.uBody.value.set(p.body);
    this.u.uVellum.value.set(p.vellum);
    this.u.uGold.value.set(p.gold);
    this.u.uAccent.value.set(p.accent);
    this.bodyMat = engraveMaterial(this.u, { wash: 0.62 });
    this.bodyDark = engraveMaterial(this.u, { wash: 0.72, tone: -0.18 });
    this.bodyLight = engraveMaterial(this.u, { wash: 0.25, tone: 0.12 });
    this.gilt = engraveMaterial(this.u, { wash: 0.2, tone: 0.05, gilt: 0.85 });
    this.outline = outlineMaterial(this.u, 0.09);
    this.outlineThin = outlineMaterial(this.u, 0.045);
    this.group.renderOrder = 5;
    this.group.add(this.body);
    this.body.position.set(0, 19.6, 0);
    this.body.scale.setScalar(1.22);
    const inner = new THREE.Group();
    inner.position.set(0, -19.6, 0);
    this.body.add(inner);
    this.anatomy = inner;
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
    this.group.scale.setScalar(1);
    this.buildCores();
  }

  // ------------------------------------------------------------------ parts
  private part(geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial = this.bodyMat, thin = false, parent: THREE.Object3D = this.anatomy) {
    const m = new THREE.Mesh(geo, mat);
    const o = new THREE.Mesh(geo, thin ? this.outlineThin : this.outline);
    m.add(o);
    parent.add(m);
    return m;
  }
  private sphere(r: number, sx: number, sy: number, sz: number, pos: THREE.Vector3, mat?: THREE.ShaderMaterial, parent?: THREE.Object3D, detail = 3, seed = 1, lump = 0.08) {
    const m = this.part(lumpySphere(r, detail, seed, lump), mat, false, parent);
    m.scale.set(sx, sy, sz);
    m.position.copy(pos);
    return m;
  }
  private eye(parent: THREE.Object3D, pos: THREE.Vector3, r: number) {
    const ball = this.part(new THREE.SphereGeometry(r, 20, 14), this.bodyLight, true, parent);
    ball.position.copy(pos);
    const pupilMat = engraveMaterial(this.u, { wash: 0, tone: -0.9, gilt: 0.55 });
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(r * 0.48, 16, 10), pupilMat);
    pupil.position.z = r * 0.7;
    ball.add(pupil);
    const lid = new THREE.Mesh(new THREE.SphereGeometry(r * 1.06, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.bodyDark);
    lid.rotation.x = -Math.PI / 2 + 0.2;
    lid.scale.y = 0.15;
    ball.add(lid);
    this.eyes.push({ ball, pupil, r, lid });
    return ball;
  }
  private buildCores() {
    for (const c of this.spec.cores) {
      const mat = goldMaterial(this.u);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), mat);
      gem.scale.set(0.8, 1.15, 0.7);
      gem.position.set(c.x, c.y, 6 + c.z * 0.2);
      gem.add(new THREE.Mesh(gem.geometry, this.outlineThin));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.12, 8, 28), this.gilt);
      ring.position.copy(gem.position).setZ(gem.position.z - 0.2);
      ring.add(new THREE.Mesh(ring.geometry, this.outlineThin));
      const shell: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.78, 16, 10, side < 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI, 0, Math.PI), this.bodyDark);
        s.position.copy(gem.position).setZ(gem.position.z + 0.15);
        s.add(new THREE.Mesh(s.geometry, this.outlineThin));
        shell.push(s);
        this.group.add(s);
      }
      this.group.add(ring, gem);
      this.coreMeshes.push({ gem, shell, ring, mat });
    }
  }

  // ------------------------------------------------------------------ archetypes
  private buildThrone(): Rig {
    const r = rngFor("throne", this.spec.seed);
    const g = this.anatomy;
    const back = this.part(new THREE.CylinderGeometry(6.2, 6.8, 13, 24, 1, false, -Math.PI / 2, Math.PI), this.bodyDark);
    back.position.set(0, 25.2, -4);
    back.scale.z = 0.35;
    const halo = new THREE.Group();
    halo.position.set(0, 29.4, -1.8);
    g.add(halo);
    const haloRing = this.part(new THREE.TorusGeometry(2.9, 0.16, 8, 64), this.gilt, true, halo);
    void haloRing;
    for (let i = 0; i < 16; i++) {
      const spoke = this.part(new THREE.CylinderGeometry(0.05, 0.12, 1.3, 6), this.gilt, true, halo);
      const a = (i / 16) * Math.PI * 2;
      spoke.position.set(Math.cos(a) * 3.55, Math.sin(a) * 3.55, 0);
      spoke.rotation.z = a - Math.PI / 2;
    }
    const torso = this.sphere(1, 3.1, 3.7, 2.2, V(0, 25.4, 0), this.bodyMat, g, 4, r.range(0, 9), 0.06);
    const lap = this.sphere(1, 4.2, 1.7, 2.6, V(0, 21.5, 0.4), this.bodyMat, g, 3, r.range(0, 9), 0.08);
    void lap;
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 28.4, 0.6);
    g.add(headPivot);
    const head = this.sphere(1, 1.45, 1.75, 1.35, V(0, 1.1, 0), this.bodyLight, headPivot, 3, 3, 0.05);
    void head;
    const crown = new THREE.Group();
    crown.position.set(0, 2.6, 0);
    headPivot.add(crown);
    const spikes = r.int(5, 7);
    for (let i = 0; i < spikes; i++) {
      const t = i / (spikes - 1) - 0.5;
      const h = 1.1 + (1 - Math.abs(t) * 1.6) * 0.9;
      const s = this.part(new THREE.ConeGeometry(0.22, h, 6), this.gilt, true, crown);
      s.position.set(t * 2.4, h / 2 - 0.2, 0.3 - Math.abs(t) * 0.4);
      s.rotation.z = -t * 0.6;
    }
    this.eye(headPivot, V(-0.55, 1.25, 1.05), 0.24);
    this.eye(headPivot, V(0.55, 1.25, 1.05), 0.24);
    const mouth = this.part(new THREE.BoxGeometry(0.9, 0.08, 0.2), this.bodyDark, true, headPivot);
    mouth.position.set(0, 0.45, 1.2);
    // arms: shoulder -> elbow -> hand, hands rest near the arena's top edge
    const arms: Array<{ side: number; shoulder: THREE.Vector3; upper: THREE.Mesh; fore: THREE.Mesh; hand: THREE.Mesh; base: THREE.Vector3 }> = [];
    for (const side of [-1, 1]) {
      const shoulder = V(side * 3.3, 27.4, 0.5);
      this.sphere(1, 1.35, 1.25, 1.2, shoulder, this.bodyDark, g, 2, side + 5, 0.1);
      const upper = this.part(new THREE.CapsuleGeometry(0.7, 3.2, 6, 12));
      const fore = this.part(new THREE.CapsuleGeometry(0.6, 3.4, 6, 12));
      const hand = this.sphere(1, 0.95, 0.75, 0.8, V(), this.bodyLight, g, 2, side + 9, 0.12);
      for (let f = 0; f < 4; f++) {
        const fing = this.part(new THREE.CapsuleGeometry(0.16, 0.6, 4, 8), this.bodyLight, true, hand);
        fing.position.set((f - 1.5) * 0.42, -0.75, 0.3);
      }
      arms.push({ side, shoulder, upper, fore, hand, base: V(side * 5.2, 20.9, 1.2) });
    }
    const tmpA = V(0, 0),
      tmpB = V(0, 0),
      elbow = V(0, 0);
    const placeLimb = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
      m.position.lerpVectors(a, b, 0.5);
      const d = tmpA.subVectors(b, a);
      const len = d.length();
      m.scale.set(1, len / 4.6, 1);
      m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
    };
    return {
      update: (c) => {
        const breath = Math.sin(c.t * 1.3) * 0.04;
        torso.scale.set(3.1 * (1 + breath * 0.5), 3.7 * (1 + breath), 2.2);
        headPivot.rotation.z = THREE.MathUtils.lerp(headPivot.rotation.z, -c.player.x * 0.025, 0.05);
        headPivot.rotation.x = 0.08 + Math.sin(c.t * 0.7) * 0.03 - c.hurt * 0.15;
        halo.rotation.z += 0.002 + c.stage * 0.004;
        for (const a of arms) {
          // the hand nearest an upcoming attack rises, then strikes down on the beat
          let lift = 0;
          for (const q of c.cues) {
            if (Math.sign(q.x) !== a.side && Math.abs(q.x) > 1.2) continue;
            const k = q.lead > 0 ? clamp01(1 - q.lead / 2) : clamp01(1 + q.lead * 3);
            lift = Math.max(lift, q.lead > 0 ? ease(k) : k * 0.4);
          }
          const hand = tmpB.copy(a.base).add(V(-a.side * 0.4 * lift, lift * 3.2 + Math.sin(c.t * 1.1 + a.side) * 0.12, lift * 1.5));
          elbow.set(a.side * 5.9, 24.6 + lift * 1.4, 0.4);
          placeLimb(a.upper, a.shoulder, elbow);
          placeLimb(a.fore, elbow, hand);
          a.hand.position.copy(hand);
          a.hand.rotation.z = a.side * (0.2 - lift * 0.5);
        }
      },
    };
  }

  private buildCoil(): Rig {
    const r = rngFor("coil", this.spec.seed);
    const N = 46;
    const sweep = new Sweep(N, 14);
    this.part(sweep.geo, this.bodyMat);
    const pts = Array.from({ length: N }, () => V(0, 0));
    const radii = Array.from({ length: N }, (_, i) => {
      const t = i / (N - 1);
      return 0.35 + 1.25 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.92) ** 0.6;
    });
    // gilded bands every few vertebrae
    const bands: THREE.Mesh[] = [];
    for (let i = 4; i < N - 4; i += 4) {
      const b = this.part(new THREE.TorusGeometry(1, 0.11, 6, 24), this.gilt, true);
      bands.push(b);
      (b.userData as { i: number }).i = i;
    }
    const headPivot = new THREE.Group();
    this.anatomy.add(headPivot);
    const skull = this.sphere(1, 1.75, 1.15, 1.25, V(0, 0.3, 0), this.bodyLight, headPivot, 3, 4, 0.05);
    void skull;
    const jawU = this.sphere(1, 1.5, 0.45, 1.1, V(0, -0.55, 0.35), this.bodyMat, headPivot, 2, 6, 0.04);
    const jawL = new THREE.Group();
    headPivot.add(jawL);
    jawL.position.set(0, -0.6, 0.2);
    this.sphere(1, 1.3, 0.38, 1.0, V(0, -0.35, 0.2), this.bodyDark, jawL, 2, 7, 0.04);
    for (let i = 0; i < 6; i++) {
      const f = this.part(new THREE.ConeGeometry(0.11, 0.55, 5), this.bodyLight, true, i < 3 ? jawU : jawL);
      const x = (i % 3 - 1) * 0.45;
      f.position.set(x / (i < 3 ? 1.5 : 1.3), i < 3 ? -0.9 : 0.6, 0.6);
      f.rotation.z = i < 3 ? Math.PI : 0;
    }
    for (const s of [-1, 1]) {
      this.eye(headPivot, V(s * 0.75, 0.65, 0.95), 0.22);
      const horn = this.part(new THREE.ConeGeometry(0.28, 2.4, 7), this.gilt, true, headPivot);
      horn.position.set(s * 1.2, 1.4, -0.3);
      horn.rotation.z = -s * 0.7;
    }
    const fins: THREE.Mesh[] = [];
    for (let i = 0; i < 9; i++) {
      const f = this.part(new THREE.ConeGeometry(0.35, 1.5, 4), this.bodyDark, true);
      fins.push(f);
    }
    const phase = r.range(0, 6);
    const amp = r.range(0.8, 1.3);
    return {
      update: (c) => {
        // the body enters from the lower left, loops behind, and raises its head over the arena
        let headX = 0,
          headY = 26.2;
        let mouthCue = 0;
        for (const q of c.cues) {
          const k = q.lead > 0 ? clamp01(1 - q.lead / 2) : clamp01(1 + q.lead * 2);
          if (k > mouthCue) {
            mouthCue = k;
            headX = THREE.MathUtils.clamp(q.x, -5, 5) * 0.6;
          }
        }
        headX += Math.sin(c.t * 0.5 + phase) * 0.8;
        headY += Math.sin(c.t * 0.9) * 0.3 - mouthCue * 1.4;
        for (let i = 0; i < N; i++) {
          const t = i / (N - 1);
          const s = t * 4.2 + phase;
          const wave = Math.sin(c.t * 1.2 - t * 7) * 0.45 * amp;
          const x = Math.sin(s * 1.3) * (7.4 - t * 3.3) * (1 - t * 0.55) + wave;
          const y = 19.4 + t * 11.2 + Math.cos(s * 1.6) * 1.2 * (1 - t);
          const z = -3 + Math.sin(s * 1.3 + 1.6) * 2.4 * (1 - t);
          // bend the last stretch toward the head
          const k = Math.max(0, (t - 0.72) / 0.28);
          pts[i].set(THREE.MathUtils.lerp(x, headX, ease(k)), THREE.MathUtils.lerp(y, headY + 1.6, ease(k) * 0.9), THREE.MathUtils.lerp(z, 0.4, k));
        }
        // the head rides the end of the spine
        const tip = pts[N - 1];
        headPivot.position.set(headX, headY, 0.9);
        pts[N - 1].lerp(headPivot.position, 0.5);
        sweep.update(pts, radii.map((rr) => rr * (1 + Math.sin(c.t * 1.3) * 0.02)));
        void tip;
        jawL.rotation.x = -0.15 - mouthCue * 0.75;
        headPivot.rotation.z = (c.player.x - headX) * -0.02 + Math.sin(c.t * 0.8) * 0.05;
        headPivot.rotation.x = -0.15 + mouthCue * 0.35 - c.hurt * 0.2;
        for (const b of bands) {
          const i = (b.userData as { i: number }).i;
          const a = pts[i],
            bb = pts[i + 1];
          b.position.copy(a);
          b.quaternion.setFromUnitVectors(V(0, 0, 1), V().subVectors(bb, a).normalize());
          b.scale.setScalar(radii[i] * 1.02);
        }
        fins.forEach((f, k) => {
          const i = 8 + k * 4;
          const a = pts[Math.min(N - 2, i)];
          f.position.set(a.x, a.y + radii[i] * 0.95, a.z);
          f.rotation.z = Math.sin(c.t * 2 + k) * 0.15;
        });
      },
    };
  }

  private buildStrider(): Rig {
    const r = rngFor("strider", this.spec.seed);
    const g = this.anatomy;
    const bodyPivot = new THREE.Group();
    bodyPivot.position.set(0, 26.6, -1);
    g.add(bodyPivot);
    const shell = this.sphere(1, 5.2, 2.7, 3.2, V(0, 0, 0), this.bodyMat, bodyPivot, 4, r.range(0, 9), 0.07);
    void shell;
    for (let i = 0; i < 5; i++) {
      const plate = this.sphere(1, 1.6, 0.9, 1.2, V((i - 2) * 1.9, 1.7 + (2 - Math.abs(i - 2)) * 0.35, 1.2), i % 2 ? this.gilt : this.bodyDark, bodyPivot, 2, i, 0.05);
      plate.rotation.z = (i - 2) * -0.25;
    }
    const head = this.sphere(1, 1.6, 1.2, 1.4, V(0, -2.4, 1.6), this.bodyLight, bodyPivot, 3, 2, 0.05);
    void head;
    const eyeCount = r.int(3, 6);
    for (let i = 0; i < eyeCount; i++) {
      const t = eyeCount === 1 ? 0 : i / (eyeCount - 1) - 0.5;
      this.eye(bodyPivot, V(t * 2, -2.1 - Math.abs(t) * 0.6, 2.75 - Math.abs(t) * 0.5), 0.18 + (1 - Math.abs(t)) * 0.1);
    }
    const legs: Array<{ hip: THREE.Vector3; foot: THREE.Vector3; side: number; idx: number; thigh: Sweep; shin: Sweep }> = [];
    const perSide = Math.max(2, Math.round(this.spec.limbs / 2));
    for (const side of [-1, 1])
      for (let i = 0; i < perSide; i++) {
        const thigh = new Sweep(10, 8);
        const shin = new Sweep(12, 8);
        this.part(thigh.geo, this.bodyDark);
        this.part(shin.geo, this.bodyMat);
        legs.push({ hip: V(side * (2.5 + i * 1.1), 26 - i * 0.3, -1 + i * 0.4), foot: V(side * (2.5 + i * 2.2), 19.6, 0.6), side, idx: i, thigh, shin });
      }
    const knee = V(0, 0),
      foot = V(0, 0),
      bow = V(0, 0);
    const thighPts: THREE.Vector3[] = [],
      shinPts: THREE.Vector3[] = [];
    return {
      update: (c) => {
        const bob = Math.sin((c.beat % 2) * Math.PI) * 0.15;
        bodyPivot.position.y = 26.6 + bob - c.hurt * 0.4;
        bodyPivot.rotation.z = Math.sin(c.t * 0.6) * 0.04 - c.player.x * 0.006;
        for (const L of legs) {
          let lift = 0,
            tx = L.foot.x;
          for (const q of c.cues) {
            if (Math.sign(q.x || L.side) !== L.side) continue;
            if (q.kind !== "slam" && q.kind !== "rain" && q.kind !== "glyph") continue;
            const k = q.lead > 0 ? ease(clamp01(1 - q.lead / 2)) : clamp01(1 + q.lead * 4) * 0.3;
            if (k > lift && L.idx === (Math.abs(Math.round(q.x)) % perSide)) {
              lift = k;
              tx = THREE.MathUtils.clamp(q.x, -7.5, 7.5);
            }
          }
          const hip = V(L.hip.x, L.hip.y + bob, L.hip.z);
          foot.set(THREE.MathUtils.lerp(L.foot.x, tx, lift * 0.6), 19.6 + lift * 3.4, L.foot.z + lift);
          knee.set(L.side * (6.5 + L.idx * 0.9), 29.2 + lift * 0.8 - L.idx * 0.4, -0.5);
          bowChain(hip, knee, bow.set(0, 0.4, 0), 10, thighPts);
          bowChain(knee, foot, bow.set(L.side * 0.3, 0, 0), 12, shinPts);
          L.thigh.update(thighPts, thighPts.map((_, i) => 0.62 - i * 0.025));
          L.shin.update(shinPts, shinPts.map((_, i) => 0.42 - i * 0.022 + (i === 11 ? 0.12 : 0)));
        }
      },
    };
  }

  private buildBloom(): Rig {
    const r = rngFor("bloom", this.spec.seed);
    const g = this.anatomy;
    const crown = new THREE.Group();
    crown.position.set(0, 25.6, -1);
    g.add(crown);
    const petals: THREE.Mesh[] = [];
    const n = this.spec.limbs + 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.range(-0.1, 0.1);
      const p = new THREE.Group();
      p.rotation.z = a;
      crown.add(p);
      const petal = this.sphere(1, 1.25, 3.4, 0.45, V(0, 3.4, -0.6), i % 3 === 0 ? this.gilt : i % 2 ? this.body : this.bodyDark, p, 3, i, 0.06);
      petals.push(petal);
    }
    const bulb = this.sphere(1, 2.5, 2.5, 2.2, V(0, 25.4, 0.6), this.bodyLight, g, 4, 3, 0.06);
    void bulb;
    // one great eye
    const big = this.eye(g, V(0, 25.6, 2.6), 1.05);
    void big;
    const tendrils: Array<{ sweep: Sweep; root: THREE.Vector3; tip: THREE.Vector3; ph: number }> = [];
    for (const o of this.spec.origins) {
      const sw = new Sweep(16, 8);
      this.part(sw.geo, this.bodyDark);
      tendrils.push({ sweep: sw, root: V(o.x * 0.25, 23.6, 0.2), tip: V(o.x, 19.8, 1.2), ph: r.range(0, 6) });
    }
    const pts: THREE.Vector3[] = [];
    const bow = V(0, 0);
    return {
      update: (c) => {
        const open = 0.92 + Math.sin(c.t * 0.9) * 0.06 + c.stage * 0.04;
        crown.rotation.z = Math.sin(c.t * 0.25) * 0.08;
        crown.scale.setScalar(open);
        petals.forEach((p, i) => (p.rotation.x = Math.sin(c.t * 1.4 + i) * 0.12 - c.hurt * 0.3));
        for (const T of tendrils) {
          let k = 0;
          for (const q of c.cues) if (Math.abs(q.x - T.tip.x) < 1.6) k = Math.max(k, q.lead > 0 ? ease(clamp01(1 - q.lead / 2)) : 0);
          const tip = V(T.tip.x + Math.sin(c.t * 1.3 + T.ph) * 0.5, T.tip.y + k * 1.8 + Math.sin(c.t * 2 + T.ph) * 0.2, T.tip.z);
          bowChain(T.root, tip, bow.set(Math.sin(c.t + T.ph) * 1.4, 0.6, 0.8), 16, pts);
          T.sweep.update(pts, pts.map((_, i) => 0.42 * (1 - i / 17) + 0.06 + (i === 15 ? 0.12 * k : 0)));
        }
      },
    };
  }

  private buildSwarm(): Rig {
    const r = rngFor("swarm", this.spec.seed);
    const g = this.anatomy;
    const heart = this.part(lumpySphere(3, 4, r.range(0, 9), 0.18), this.bodyMat);
    heart.position.set(0, 25.4, -0.5);
    const ribs: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      const rib = this.part(new THREE.TorusGeometry(3.6 + i * 0.25, 0.14, 8, 48, Math.PI * 1.4), i % 2 ? this.gilt : this.bodyDark, true);
      rib.position.copy(heart.position);
      rib.rotation.set(r.range(-1, 1), r.range(-1, 1), r.range(0, 6));
      ribs.push(rib);
    }
    this.eye(heart, V(-0.9, 0.5, 2.7), 0.38);
    this.eye(heart, V(0.9, 0.5, 2.7), 0.38);
    this.eye(heart, V(0, -0.7, 2.85), 0.3);
    const shards: Array<{ m: THREE.Mesh; R: number; sp: number; ph: number; tilt: number }> = [];
    for (let i = 0; i < 26; i++) {
      const m = this.part(new THREE.TetrahedronGeometry(r.range(0.3, 0.6), 0), i % 4 === 0 ? this.gilt : this.bodyDark, true);
      shards.push({ m, R: r.range(4.4, 8), sp: r.range(0.25, 0.7) * (r.chance(0.5) ? 1 : -1), ph: r.range(0, 6.3), tilt: r.range(-0.6, 0.6) });
    }
    return {
      update: (c) => {
        const beatK = 1 - ((c.beat % 1) + 1) % 1;
        const pulse = 1 + Math.pow(beatK, 6) * 0.06;
        heart.scale.setScalar(pulse * (1 - c.hurt * 0.05));
        ribs.forEach((rb, i) => (rb.rotation.z += 0.002 * (i + 1) * (1 + c.stage)));
        for (const s of shards) {
          const a = s.ph + c.t * s.sp * (1 + c.stage * 0.4);
          s.m.position.set(Math.cos(a) * s.R, 25.4 + Math.sin(a) * s.R * 0.55 + Math.sin(a * 2) * s.tilt, Math.sin(a) * 2 - 1);
          s.m.rotation.set(c.t * s.sp, c.t * 0.7, a);
        }
      },
    };
  }

  // ------------------------------------------------------------------ per frame
  update(c: TitanCtx) {
    this.u.uTime.value = c.t;
    this.u.uCrack.value = c.crack;
    this.u.uWrath.value = c.stage / 2;
    this.u.uFlash.value = c.hurt * 0.6;
    this.rig.update(c);
    // eyes follow the hunter; blink now and then
    this.blinkT -= 1 / 60;
    const blink = this.blinkT < 0.12 ? 1 : 0;
    if (this.blinkT < 0) this.blinkT = 2 + Math.random() * 4;
    for (const e of this.eyes) {
      const wp = new THREE.Vector3();
      e.ball.getWorldPosition(wp);
      const dx = THREE.MathUtils.clamp((c.player.x - wp.x) * 0.06, -0.45, 0.45);
      const dy = THREE.MathUtils.clamp((c.player.y - wp.y) * 0.03, -0.5, 0.2);
      e.pupil.position.set(dx * e.r, dy * e.r, e.r * 0.72);
      e.lid.scale.y = blink ? 1 : 0.15 + c.hurt * 0.4;
    }
    this.spec.cores.forEach((core, i) => {
      const m = this.coreMeshes[i];
      const open = c.coreOpen[i] ? 1 : 0;
      const u = m.mat.uniforms as { uOpen: { value: number }; uHit: { value: number } };
      u.uOpen.value = THREE.MathUtils.lerp(u.uOpen.value, open, 0.2);
      u.uHit.value = c.coreHit[i] ?? 0;
      const k = u.uOpen.value;
      m.shell[0].position.x = core.x - k * 0.75;
      m.shell[1].position.x = core.x + k * 0.75;
      m.shell[0].rotation.y = -k * 0.9;
      m.shell[1].rotation.y = k * 0.9;
      m.gem.rotation.y = c.t * (0.6 + k * 2.4);
      const s = 1 + (c.coreHit[i] ?? 0) * 0.25 + k * Math.sin(c.t * 8) * 0.04;
      m.gem.scale.set(0.8 * s, 1.15 * s, 0.7 * s);
      m.ring.rotation.z = c.t * 0.3 * (i % 2 ? 1 : -1);
    });
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}

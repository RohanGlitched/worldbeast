import * as THREE from "three";

// Geometry helpers for titan anatomy. Every part gets `aLines`: how many engraved lines run
// along u and v of its surface, so line spacing reads the same on big and small parts.

export function eng<T extends THREE.BufferGeometry>(geo: T, lu: number, lv: number): T {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[i * 2] = lu;
    a[i * 2 + 1] = lv;
  }
  geo.setAttribute("aLines", new THREE.BufferAttribute(a, 2));
  if (!geo.attributes.uv) {
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

/** UV sphere with gentle organic displacement (keeps clean uv for engraving). */
export function orb(lu = 48, lv = 30, seed = 1, lump = 0.05, ws = 48, hs = 32) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  if (lump > 0) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = Math.sin(v.x * 2.3 + seed) * Math.sin(v.y * 1.9 + seed * 2) * Math.sin(v.z * 2.1 + seed * 3);
      v.multiplyScalar(1 + n * lump);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
  }
  return eng(g, lu, lv);
}

/** Lathe from a profile of [radius, y] pairs, with optional radial folds (robes, petals). */
export function lathe(profile: Array<[number, number]>, lu: number, lv: number, segments = 64, folds = 0, foldAmt = 0, phiLength = Math.PI * 2, phiStart = 0) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  if (folds > 0) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const ys = profile.map((q) => q[1]);
    const y0 = Math.min(...ys),
      y1 = Math.max(...ys);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        y = p.getY(i),
        z = p.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 - (y - y0) / (y1 - y0 || 1); // folds strongest at the hem
      const s = 1 + Math.sin(a * folds) * foldAmt * k;
      p.setXYZ(i, x * s, y, z * s);
    }
    g.computeVertexNormals();
  }
  return eng(g, lu, lv);
}

/** Pointed gothic arch (with lancet windows cut through), extruded. */
export function gothicArch(w: number, h: number, depth: number, windows = 3) {
  const s = new THREE.Shape();
  const hw = w / 2;
  const spring = h - hw * 1.1;
  s.moveTo(-hw, 0);
  s.lineTo(-hw, spring);
  s.quadraticCurveTo(-hw, h - hw * 0.15, 0, h);
  s.quadraticCurveTo(hw, h - hw * 0.15, hw, spring);
  s.lineTo(hw, 0);
  s.lineTo(-hw, 0);
  for (let i = 0; i < windows; i++) {
    const cx = (i - (windows - 1) / 2) * (w / (windows + 0.6));
    const ww = w / (windows + 1) * 0.42;
    const top = spring + (i === (windows - 1) / 2 ? hw * 0.55 : hw * 0.25);
    const bot = h * 0.38;
    const hole = new THREE.Path();
    hole.moveTo(cx - ww, bot);
    hole.lineTo(cx - ww, top - ww * 1.4);
    hole.quadraticCurveTo(cx - ww, top - ww * 0.2, cx, top);
    hole.quadraticCurveTo(cx + ww, top - ww * 0.2, cx + ww, top - ww * 1.4);
    hole.lineTo(cx + ww, bot);
    hole.lineTo(cx - ww, bot);
    s.holes.push(hole);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.25, bevelSize: 0.22, bevelSegments: 3, curveSegments: 18 });
  // planar uv in world-ish units so the stone gets horizontal coursing lines
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) + hw) / w;
    uv[i * 2 + 1] = p.getY(i) / h;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return eng(g, w * 2.2, h * 2.4);
}

/** A tube with a radius per point, rebuilt in place when the spine moves. */
export class Sweep {
  geo: THREE.BufferGeometry;
  private n: number;
  private radial: number;
  private pos: Float32Array;
  private nor: Float32Array;
  constructor(points: number, radial = 12, lu = 40, lv = 10) {
    this.n = points;
    this.radial = radial;
    const vCount = points * (radial + 1);
    this.pos = new Float32Array(vCount * 3);
    this.nor = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx: number[] = [];
    for (let i = 0; i < points; i++)
      for (let j = 0; j <= radial; j++) {
        // u runs around the tube (rings follow v = along the body, which is the primary line family)
        uv[(i * (radial + 1) + j) * 2] = j / radial;
        uv[(i * (radial + 1) + j) * 2 + 1] = i / (points - 1);
        if (i < points - 1 && j < radial) {
          const a = i * (radial + 1) + j,
            b = a + radial + 1;
          idx.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("normal", new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    eng(this.geo, lu, lv);
  }
  private t = new THREE.Vector3();
  private nrm = new THREE.Vector3();
  private bin = new THREE.Vector3();
  private up = new THREE.Vector3(0, 0, 1);
  update(pts: THREE.Vector3[], radii: number[]) {
    const { n, radial } = this;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)],
        b = pts[Math.min(n - 1, i + 1)];
      this.t.subVectors(b, a).normalize();
      this.bin.crossVectors(this.t, this.up);
      if (this.bin.lengthSq() < 1e-6) this.bin.set(1, 0, 0);
      this.bin.normalize();
      this.nrm.crossVectors(this.bin, this.t).normalize();
      const r = radii[i];
      for (let j = 0; j <= radial; j++) {
        const ang = (j / radial) * Math.PI * 2;
        const c = Math.cos(ang),
          s = Math.sin(ang);
        const nx = this.nrm.x * c + this.bin.x * s,
          ny = this.nrm.y * c + this.bin.y * s,
          nz = this.nrm.z * c + this.bin.z * s;
        const o = (i * (radial + 1) + j) * 3;
        this.pos[o] = p.x + nx * r;
        this.pos[o + 1] = p.y + ny * r;
        this.pos[o + 2] = p.z + nz * r;
        this.nor[o] = nx;
        this.nor[o + 1] = ny;
        this.nor[o + 2] = nz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}

/** Points along a bowed chain between a and b (limbs, tendrils). */
export function bowChain(a: THREE.Vector3, b: THREE.Vector3, bow: THREE.Vector3, n: number, out: THREE.Vector3[] = []) {
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = out[i] ?? new THREE.Vector3();
    p.lerpVectors(a, b, t).addScaledVector(bow, 4 * t * (1 - t));
    out[i] = p;
  }
  return out;
}

/** Two-segment limb IK in the view plane: returns the elbow/knee for a chain of lengths l1, l2. */
export function ik2(root: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, bendSign: number, out = new THREE.Vector3()) {
  const d = new THREE.Vector3().subVectors(target, root);
  const dist = Math.min(d.length(), l1 + l2 - 1e-3);
  const a = Math.acos(THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
  const base = Math.atan2(d.y, d.x);
  const ang = base + a * bendSign;
  out.set(root.x + Math.cos(ang) * l1, root.y + Math.sin(ang) * l1, (root.z + target.z) / 2 + 0.6);
  return out;
}

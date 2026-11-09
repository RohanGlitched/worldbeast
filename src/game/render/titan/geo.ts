import * as THREE from "three";

// Geometry helpers for titan anatomy.

/** A tube with a radius per point, rebuilt in place when the spine moves. */
export class Sweep {
  geo: THREE.BufferGeometry;
  private n: number;
  private radial: number;
  private pos: Float32Array;
  private nor: Float32Array;
  constructor(points: number, radial = 12) {
    this.n = points;
    this.radial = radial;
    const vCount = points * (radial + 1);
    this.pos = new Float32Array(vCount * 3);
    this.nor = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx: number[] = [];
    for (let i = 0; i < points; i++)
      for (let j = 0; j <= radial; j++) {
        uv[(i * (radial + 1) + j) * 2] = i / (points - 1);
        uv[(i * (radial + 1) + j) * 2 + 1] = j / radial;
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
      // frame: keep the "up" toward the viewer so the tube shades well from the front
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

export function lumpySphere(r: number, detail: number, seed: number, amt = 0.12) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 2.1 + seed) * Math.sin(v.y * 1.7 + seed * 2) * Math.sin(v.z * 2.3 + seed * 3);
    v.multiplyScalar(1 + n * amt);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Points along a quadratic-ish chain between a and b, bowed by `bow` (for limbs). */
export function bowChain(a: THREE.Vector3, b: THREE.Vector3, bow: THREE.Vector3, n: number, out: THREE.Vector3[] = []) {
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = out[i] ?? new THREE.Vector3();
    p.lerpVectors(a, b, t).addScaledVector(bow, 4 * t * (1 - t));
    out[i] = p;
  }
  return out;
}

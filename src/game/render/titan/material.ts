import * as THREE from "three";
import { NOISE } from "../glsl";

// The engraving. Each part carries its own surface parameterisation (uv × aLines) that the lines follow
// like a burin following a curve, but line SPACING and WEIGHT are measured in screen pixels: the shader
// picks the power-of-two line density that lands nearest a fixed pitch (fading the in-between lines in,
// so nothing pops or shimmers), and every line's width is set in pixels from the tone, so a line swells
// in shadow and thins to a hairline (or breaks off) in the light, the same on a finger as on a torso.
// Cross-hatching runs along the form's long axis in shadow only; lozenge dots sit between the crossings
// in the deepest shade. A two-pigment hand-coloured wash sits underneath. Gold kintsugi cracks spread
// across the body as it is wounded.

export interface TitanUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uInk: THREE.IUniform<THREE.Color>;
  uBody: THREE.IUniform<THREE.Color>;
  uVellum: THREE.IUniform<THREE.Color>;
  uGold: THREE.IUniform<THREE.Color>;
  uAccent: THREE.IUniform<THREE.Color>;
  uWash2: THREE.IUniform<THREE.Color>; // the second pigment of the hand-colouring (lights and "wash2" parts)
  uLight: THREE.IUniform<THREE.Vector3>;
  uCrack: THREE.IUniform<number>;
  uFlash: THREE.IUniform<number>;
  uWrath: THREE.IUniform<number>;
  uPx: THREE.IUniform<number>; // world units per device pixel (line weight stays crisp at any size)
  uReveal: THREE.IUniform<number>; // 0..3: lines engrave in (0-1), wash bleeds in (1-2), gold settles (2-3)
  uClipX: THREE.IUniform<number>; // nothing of the titan is drawn left of this x (the open book's left leaf)
  uClipX2: THREE.IUniform<number>; // ...or right of this x (the outer edge of the page)
}

export function titanUniforms(): TitanUniforms {
  return {
    uTime: { value: 0 },
    uInk: { value: new THREE.Color("#231c17") },
    uBody: { value: new THREE.Color("#2b4a8b") },
    uVellum: { value: new THREE.Color("#efe4cc") },
    uGold: { value: new THREE.Color("#d6a531") },
    uAccent: { value: new THREE.Color("#c8321f") },
    uWash2: { value: new THREE.Color("#b98a4a") },
    uLight: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
    uCrack: { value: 0 },
    uFlash: { value: 0 },
    uWrath: { value: 0 },
    uPx: { value: 0.03 },
    uReveal: { value: 3 },
    uClipX: { value: -1e4 },
    uClipX2: { value: 1e4 },
  };
}

export interface EngraveOpts {
  wash?: number; // how strongly the body ink tints the paper
  tone?: number; // tone bias (+ lighter, - darker)
  gilt?: number; // 0..1 gold leaf
  tint?: "body" | "accent" | "paper" | "ink" | "wash2";
  scales?: number; // 0..1 scale/plate pattern
  cracks?: number; // 0..1 how much this part shows kintsugi
  pitch?: number; // line pitch multiplier (backgrounds are cut sparser and finer)
  ink?: number; // line strength 0..1
  ashlar?: number; // 0..1 masonry joints on a planar (world-unit) uv: coursed stone
}

const f3 = (n: number) => n.toFixed(3);

/** GLSL: screen-pitch line families (shared by every engraved part). */
const LINES = /* glsl */ `
  // one family of engraved lines along the iso-lines of c. d = fwidth(c) (taken by the caller, outside
  // any branch), S = pitch in px, hw = half-width in px, j = sideways wobble in px. The density is the
  // power of two of the part's own line count that lands nearest S; the lines of the next finer level
  // fade in between, so a part never pops or shimmers as it grows or shrinks on screen.
  float fam(float c, float d, float S, float hw, float j, out vec2 cell){
    d = max(d, 1e-6);
    float lvl = clamp(log2(1. / (S * d)), -5., 10.);
    float L0 = floor(lvl);
    float t = lvl - L0;
    float f0 = exp2(L0);
    float p0 = 1. / (f0 * d);                      // px between level-0 lines, in [S, 2S)
    cell = vec2(c * f0, p0);                       // the level-0 lattice (for lozenge dots)
    float cc = c * f0 + j / p0;
    float da = abs(fract(cc + .5) - .5) * p0;      // px to the nearest level-0 line
    float db = abs(fract(cc * 2. + .5) - .5) * p0 * .5;
    float a = 1. - smoothstep(hw - .6, hw + .6, da);
    float b = 1. - smoothstep(hw - .6, hw + .6, db);
    return max(a, b * smoothstep(.1, .9, t)) * smoothstep(.0, .45, hw);
  }
`;

export function engraveMaterial(u: TitanUniforms, o: EngraveOpts = {}) {
  const wash = o.wash ?? 0.7;
  const tone = o.tone ?? 0;
  const gilt = o.gilt ?? 0;
  const scales = o.scales ?? 0;
  const cracks = o.cracks ?? 1;
  const pitch = o.pitch ?? 1;
  const inkK = o.ink ?? 0.94;
  const ashlar = o.ashlar ?? 0;
  const tint = o.tint ?? "body";
  const tintExpr =
    tint === "accent" ? "uAccent" : tint === "paper" ? "uVellum" : tint === "ink" ? "uInk * 1.6 + .05" : tint === "wash2" ? "uWash2" : "mix(uWash2, uBody, smoothstep(.9, .35, tone))";
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      attribute vec2 aLines;
      varying vec3 vN; varying vec3 vObj; varying vec2 vUv; varying vec2 vL; varying vec3 vWorld;
      void main(){
        vec4 local = vec4(position, 1.);
        vec3 nrm = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vN = normalize(normalMatrix * nrm);
        vObj = position; vUv = uv; vL = aLines;
        vec4 w = modelMatrix * local; vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uCrack, uFlash, uWrath, uPx, uReveal, uClipX, uClipX2;
      uniform vec3 uInk, uBody, uVellum, uGold, uAccent, uLight, uWash2;
      varying vec3 vN; varying vec3 vObj; varying vec2 vUv; varying vec2 vL; varying vec3 vWorld;
      ${NOISE}
      ${LINES}
      void main(){
        if (vWorld.x < uClipX || vWorld.x > uClipX2) discard;
        vec3 n = normalize(vN);
        vec3 L = normalize(uLight);
        float key = max(dot(n, L), 0.);
        float fill = max(dot(n, normalize(vec3(.6, -.2, .7))), 0.) * .25;
        float under = smoothstep(.2, -.8, n.y) * .25; // undersides sink into shadow
        float rim = pow(1. - abs(n.z), 3.);
        float tone = clamp(.12 + .82 * key + fill - under - .25 * rim + ${f3(tone)}, 0., 1.);
        // the pitch: ~4-5 device px wherever the titan is small or mid-sized (Hall plates, the lobby, play),
        // opening up on big high-density screens so the plate keeps about the same number of lines
        float S = clamp(.14 / max(uPx, 1e-4), 4.2, 9.) * ${f3(pitch)};
        S *= 1. + .9 * rim; // lines open out and thin toward the silhouette instead of bunching up
        // the burin's hand: a slow sideways wobble and a swell along each cut
        float wob = (vnoise(vWorld.xy * 1.7 + vObj.z) - .5) * 1.6;
        float swell = .8 + .2 * sin(vWorld.x * 2.9 + vWorld.y * 1.7 + vObj.z * 3.) * sin(vWorld.y * 3.7 - vWorld.x * 1.3);
        vec2 lc = vUv * abs(vL);
        // A tube (negative u count) as wide as ~8 lines or more is cut in rings around its form; a thinner
        // one (beard strand, spike, spoke) lengthwise, and in between the cut turns through a helix. The
        // tube's true on-screen width comes from its world-units-per-u (its circumference), recovered from
        // screen derivatives. (uv seams sit on the far side of every round part, so the turn is seamless.)
        // Every derivative is taken here, in uniform control flow: ANGLE/D3D are strict about it.
        vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
        vec2 dtx = dFdx(vUv), dty = dFdy(vUv);
        float det = dtx.x * dty.y - dtx.y * dty.x;
        vec3 dPdu = (dpx * dty.y - dpy * dtx.y) / (abs(det) > 1e-14 ? det : 1e-14);
        float widthPx = length(dPdu) / 3.1416 / max(uPx, 1e-5);
        float ring = vL.x < 0. ? smoothstep(S * 3.4, S * 6.5, widthPx) : 1.;
        float cP = mix(lc.x, lc.y, ring);
        // the cross family runs on a diagonal of the surface grid (an angled second pass, never a net)
        float cX = lc.x + .6 * lc.y;
        float dP = fwidth(cP), dX = fwidth(cX);
        // the primary lines: hairlines in the light (broken off in the brightest), swelling in shade
        // (coverage of a family = 2 hw / S: ~8% in the lights, ~45% in the midtones, near solid in shade)
        float k1 = smoothstep(.985, .18, tone);
        float hw1 = S * mix(.035, .47, k1) * swell * (1. - .45 * rim * (1. - k1));
        hw1 *= smoothstep(.995, .93, tone);
        vec2 ca, cb = vec2(0.);
        float l1 = fam(cP, dP, S, hw1, wob, ca);
        // cross-hatching only in shadow (and only where the primaries run around the form). No derivative
        // is taken past this point, so these branches are safe and skip the work on lit surfaces.
        float k2 = smoothstep(.6, .12, tone) * ring;
        float lines = l1;
        if (k2 > 0.) lines = max(lines, fam(cX, dX, S * 1.2, S * .34 * k2 * swell, wob * .6, cb));
        // lozenge dots between the crossings in the deepest shade
        float k3 = smoothstep(.3, .03, tone) * ring;
        if (k3 > 0.) {
          vec2 q = (abs(fract(vec2(ca.x, cb.x)) - .5)) * vec2(ca.y, cb.y);
          float dotR = S * .3 * k3;
          lines = max(lines, (1. - smoothstep(dotR - .6, dotR + .6, length(q))) * k3);
        }
        ${scales > 0 ? `
        // scale / plate pattern: overlapping arcs cut into the surface (fades out where the cells get tiny)
        vec2 sc = vec2(lc.x * .5, lc.y * .35 + step(1., mod(floor(lc.x * .5), 2.)) * .5);
        vec2 sf = fract(sc) - vec2(.5, .0);
        float arc = abs(length(sf * vec2(1., 1.6)) - .55);
        float cellPx = 1. / max(fwidth(sc.y), 1e-5);
        float scaleLine = 1. - smoothstep(.03, .05 + fwidth(sc.y) * 1.2, arc);
        lines = max(lines, scaleLine * ${f3(scales)} * smoothstep(1.02, .3, tone) * smoothstep(7., 16., cellPx));
        ` : ""}
        ${ashlar > 0 ? `
        // coursed ashlar: bed joints every course, staggered head joints (vUv here is in world units)
        vec2 st = vec2(vUv.x * vL.x / 1.6, vUv.y * vL.y / .9);
        float course = floor(st.y);
        float bx = st.x + mod(course, 2.) * .5;
        float jy = abs(fract(st.y + .5) - .5) / max(fwidth(st.y), 1e-5);
        float jx = abs(fract(bx + .5) - .5) / max(fwidth(bx), 1e-5);
        float joint = 1. - smoothstep(.5, 1.5, min(jy, jx));
        lines = max(lines * .8, joint * ${f3(ashlar)} * smoothstep(1.05, .4, tone));
        ` : ""}
        // hand-coloured wash: strong in the midtones, paper showing through the highlights
        vec3 washCol = ${tintExpr};
        vec3 paper = mix(uVellum, washCol, ${f3(wash)} * (.45 + .55 * smoothstep(1., .25, tone)));
        paper = mix(paper, uVellum * 1.05, smoothstep(.82, 1., tone) * .55);
        // the engraver's pass: lines are cut in from the crown down with a ragged burin front,
        // then the hand-colouring bleeds in, then the gold leaf settles
        float frontY = mix(36., 17., clamp(uReveal, 0., 1.));
        float cutIn = smoothstep(frontY - .7, frontY + .7, vWorld.y + (vnoise(vWorld.xy * 1.3) - .5) * 1.6);
        float washIn = clamp((uReveal - 1.) * 1.4 - (vnoise(vWorld.xy * .45) - .5) * .8, 0., 1.);
        paper = mix(uVellum, paper, washIn);
        vec3 col = mix(paper, uInk, lines * ${f3(inkK)} * cutIn);
        if (cutIn < .01 && washIn < .01) discard;
        float gl = ${f3(gilt)} * clamp(uReveal - 2., 0., 1.);
        if (gl > 0.) {
          vec3 h = normalize(L + vec3(0., 0., 1.));
          float spec = pow(max(dot(n, h), 0.), 40.);
          float leaf = .88 + .24 * vnoise(vObj.xy * 14. + vObj.z * 5.);
          vec3 gold = uGold * (.55 + .6 * key) * leaf + vec3(1., .92, .65) * spec * 1.2;
          col = mix(col, mix(gold, uInk, lines * .7), gl);
        }
        // kintsugi: gold veins open across the body as the world wounds it
        if (uCrack > .12) {
          vec2 cq = vObj.xy * .9 + vObj.z * .5 + 4.2;
          float cn = vnoise(cq) * .55 + vnoise(cq * 2.1 + 7.) * .3 + vnoise(cq * 4.3 + 3.) * .15;
          float vein = 1. - smoothstep(.0, .014 + .03 * uCrack, abs(cn - .5));
          float reveal = smoothstep(.2, .95, uCrack + (vnoise(vObj.xy * .6) - .5) * .5) * ${f3(cracks)};
          vec3 crackCol = mix(uGold * 1.2, vec3(1., .86, .5), .5 + .5 * sin(uTime * 3. + vObj.y * 2.));
          col = mix(col, crackCol, vein * reveal);
        }
        col = mix(col, uAccent * .65, uWrath * .22 * smoothstep(.6, .1, tone));
        col = mix(col, vec3(1., .96, .82), uFlash);
        gl_FragColor = vec4(col, 1.);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Ink outline: back faces pushed out along the normal (width in world units). */
export function outlineMaterial(u: TitanUniforms, width = 0.07) {
  return new THREE.ShaderMaterial({
    uniforms: u,
    side: THREE.BackSide,
    vertexShader: /* glsl */ `
      varying float vY; varying float vX;
      void main(){
        vec4 local = vec4(position, 1.);
        vec3 nrm = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vec3 nW = normalize(mat3(modelMatrix) * nrm);
        vec4 w = modelMatrix * local;
        w.xyz += nW * ${f3(width)};
        vY = w.y; vX = w.x;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uInk; uniform float uReveal, uClipX, uClipX2;
      varying float vY; varying float vX;
      void main(){
        if (vX < uClipX || vX > uClipX2) discard;
        float frontY = mix(36., 17., clamp(uReveal, 0., 1.));
        if (vY < frontY) discard;
        gl_FragColor = vec4(uInk, 1.);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Gold reliquary for cores: flaking leaf, a hot specular, a heartbeat glow when open. */
export function goldMaterial(u: TitanUniforms) {
  const uu = { ...u, uOpen: { value: 0 }, uHit: { value: 0 } };
  return new THREE.ShaderMaterial({
    uniforms: uu,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vObj;
      void main(){ vN = normalize(normalMatrix * normal); vObj = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uOpen, uHit, uReveal; uniform vec3 uGold, uInk, uLight, uAccent;
      varying vec3 vN; varying vec3 vObj;
      ${NOISE}
      void main(){
        if (uReveal < 2. + vnoise(vObj.xy * 3.) * .8) discard;
        vec3 n = normalize(vN);
        vec3 L = normalize(uLight);
        float lam = max(dot(n, L), 0.);
        float facet = step(.5, vnoise(vObj.xy * 7. + floor(uTime * 3.)));
        float spec = pow(max(dot(n, normalize(L + vec3(0., 0., 1.))), 0.), 30.);
        float beat = pow(.5 + .5 * sin(uTime * 6.28 * 1.1), 3.);
        vec3 g = uGold * (.5 + .7 * lam) * (.9 + .2 * facet) + vec3(1., .94, .72) * spec * 1.4;
        g += vec3(1., .75, .3) * beat * .35 * uOpen;
        vec3 shut = mix(uInk * 1.4, uGold * .38, .3 + .25 * lam);
        vec3 col = mix(shut, g, uOpen);
        col = mix(col, vec3(1., .98, .9), uHit);
        gl_FragColor = vec4(col, 1.);
        #include <colorspace_fragment>
      }
    `,
  });
}

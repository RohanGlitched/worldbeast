import * as THREE from "three";
import { NOISE } from "../glsl";

// The engraving. Each part carries its own line field (uv × aLines): primary lines run around the form
// like a burin following a curve, cross-hatching and stipple arrive as the tone darkens, and a
// hand-coloured wash sits underneath. Gold kintsugi cracks spread across the body as it is wounded.

export interface TitanUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uInk: THREE.IUniform<THREE.Color>;
  uBody: THREE.IUniform<THREE.Color>;
  uVellum: THREE.IUniform<THREE.Color>;
  uGold: THREE.IUniform<THREE.Color>;
  uAccent: THREE.IUniform<THREE.Color>;
  uLight: THREE.IUniform<THREE.Vector3>;
  uCrack: THREE.IUniform<number>;
  uFlash: THREE.IUniform<number>;
  uWrath: THREE.IUniform<number>;
  uPx: THREE.IUniform<number>; // world units per device pixel (line weight stays crisp at any size)
}

export function titanUniforms(): TitanUniforms {
  return {
    uTime: { value: 0 },
    uInk: { value: new THREE.Color("#231c17") },
    uBody: { value: new THREE.Color("#2b4a8b") },
    uVellum: { value: new THREE.Color("#efe4cc") },
    uGold: { value: new THREE.Color("#d6a531") },
    uAccent: { value: new THREE.Color("#c8321f") },
    uLight: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
    uCrack: { value: 0 },
    uFlash: { value: 0 },
    uWrath: { value: 0 },
    uPx: { value: 0.03 },
  };
}

export interface EngraveOpts {
  wash?: number; // how strongly the body ink tints the paper
  tone?: number; // tone bias (+ lighter, - darker)
  gilt?: number; // 0..1 gold leaf
  tint?: "body" | "accent" | "paper" | "ink";
  scales?: number; // 0..1 scale/plate pattern
  cracks?: number; // 0..1 how much this part shows kintsugi
}

const f3 = (n: number) => n.toFixed(3);

export function engraveMaterial(u: TitanUniforms, o: EngraveOpts = {}) {
  const wash = o.wash ?? 0.7;
  const tone = o.tone ?? 0;
  const gilt = o.gilt ?? 0;
  const scales = o.scales ?? 0;
  const cracks = o.cracks ?? 1;
  const tint = o.tint ?? "body";
  const tintExpr = tint === "accent" ? "uAccent" : tint === "paper" ? "uVellum" : tint === "ink" ? "uInk * 1.6 + .05" : "uBody";
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      attribute vec2 aLines;
      varying vec3 vN; varying vec3 vObj; varying vec2 vUv; varying vec2 vL; varying vec3 vWorld;
      void main(){
        vN = normalize(normalMatrix * normal);
        vObj = position; vUv = uv; vL = aLines;
        vec4 w = modelMatrix * vec4(position, 1.); vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uCrack, uFlash, uWrath, uPx;
      uniform vec3 uInk, uBody, uVellum, uGold, uAccent, uLight;
      varying vec3 vN; varying vec3 vObj; varying vec2 vUv; varying vec2 vL; varying vec3 vWorld;
      ${NOISE}
      // an engraved line family: v in "line units", width 0..0.5 of the period, swelling like a burin cut
      float cut(float v, float width){
        float w = fwidth(v) * .9;
        float f = abs(fract(v) - .5);
        return 1. - smoothstep(width - w, width + w, f);
      }
      void main(){
        vec3 n = normalize(vN);
        vec3 L = normalize(uLight);
        float key = max(dot(n, L), 0.);
        float fill = max(dot(n, normalize(vec3(.6, -.2, .7))), 0.) * .25;
        float under = smoothstep(.2, -.8, n.y) * .25; // undersides sink into shadow
        float rim = pow(1. - abs(n.z), 3.);
        float tone = clamp(.12 + .82 * key + fill - under - .25 * rim + ${f3(tone)}, 0., 1.);
        // line coordinates follow the part's own surface parameterisation
        vec2 lc = vUv * vL;
        float jitter = (vnoise(vec2(lc.x * .35, lc.y * 2.)) - .5) * .18;
        float swell = .75 + .25 * sin(lc.x * .9 + lc.y * .13);
        float w1 = mix(.0, .42, smoothstep(.97, .30, tone)) * swell;
        float w2 = mix(.0, .36, smoothstep(.62, .12, tone));
        float w3 = mix(.0, .34, smoothstep(.34, .02, tone));
        float l1 = cut(lc.y + jitter, w1);
        float l2 = cut(lc.x * 1. + jitter * .6, w2);
        float l3 = cut((lc.x + lc.y) * .72, w3);
        float lines = max(l1, max(l2, l3));
        // scale / plate pattern: overlapping arcs cut into the surface
        ${scales > 0 ? `
        vec2 sc = vec2(lc.x * .5, lc.y * .35 + step(1., mod(floor(lc.x * .5), 2.)) * .5);
        vec2 sf = fract(sc) - vec2(.5, .0);
        float arc = abs(length(sf * vec2(1., 1.6)) - .55);
        float scaleLine = 1. - smoothstep(.04, .08 + fwidth(sc.y), arc);
        lines = max(lines, scaleLine * ${f3(scales)} * smoothstep(1.05, .35, tone));
        ` : ""}
        // hand-coloured wash: strong in the midtones, paper showing through the highlights
        vec3 washCol = ${tintExpr};
        vec3 paper = mix(uVellum, washCol, ${f3(wash)} * (.45 + .55 * smoothstep(1., .25, tone)));
        paper = mix(paper, uVellum * 1.05, smoothstep(.82, 1., tone) * .55);
        vec3 col = mix(paper, uInk, lines * .94);
        // gold leaf
        float gl = ${f3(gilt)};
        if (gl > 0.) {
          vec3 h = normalize(L + vec3(0., 0., 1.));
          float spec = pow(max(dot(n, h), 0.), 40.);
          float leaf = .88 + .24 * vnoise(vObj.xy * 14. + vObj.z * 5.);
          vec3 gold = uGold * (.55 + .6 * key) * leaf + vec3(1., .92, .65) * spec * 1.2;
          col = mix(col, mix(gold, uInk, lines * .7), gl);
        }
        // kintsugi: gold veins open across the body as the world wounds it
        float cn = fbm(vObj.xy * .9 + vObj.z * .5 + 4.2);
        float vein = 1. - smoothstep(.0, .012 + .03 * uCrack, abs(cn - .5));
        float reveal = smoothstep(.2, .95, uCrack + (vnoise(vObj.xy * .6) - .5) * .5) * ${f3(cracks)};
        vec3 crackCol = mix(uGold * 1.2, vec3(1., .86, .5), .5 + .5 * sin(uTime * 3. + vObj.y * 2.));
        col = mix(col, crackCol, vein * reveal);
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
      void main(){
        vec3 nW = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.);
        w.xyz += nW * ${f3(width)};
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uInk;
      void main(){ gl_FragColor = vec4(uInk, 1.);
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
      uniform float uTime, uOpen, uHit; uniform vec3 uGold, uInk, uLight, uAccent;
      varying vec3 vN; varying vec3 vObj;
      ${NOISE}
      void main(){
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

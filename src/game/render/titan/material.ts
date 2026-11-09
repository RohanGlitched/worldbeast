import * as THREE from "three";
import { HATCH, NOISE } from "../glsl";

// The engraving: lambert + rim light turned into families of engraved lines that follow the form,
// a watercolour wash of the titan's body ink, gold kintsugi cracks that spread as it is wounded.

export interface TitanUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uInk: THREE.IUniform<THREE.Color>;
  uBody: THREE.IUniform<THREE.Color>;
  uVellum: THREE.IUniform<THREE.Color>;
  uGold: THREE.IUniform<THREE.Color>;
  uAccent: THREE.IUniform<THREE.Color>;
  uLight: THREE.IUniform<THREE.Vector3>;
  uCrack: THREE.IUniform<number>; // 0..1 how wounded
  uFlash: THREE.IUniform<number>; // hit flash
  uFreq: THREE.IUniform<number>; // engraving line frequency (lines per unit)
  uWrath: THREE.IUniform<number>;
}

export function titanUniforms(): TitanUniforms {
  return {
    uTime: { value: 0 },
    uInk: { value: new THREE.Color("#231c17") },
    uBody: { value: new THREE.Color("#2b4a8b") },
    uVellum: { value: new THREE.Color("#efe4cc") },
    uGold: { value: new THREE.Color("#d6a531") },
    uAccent: { value: new THREE.Color("#c8321f") },
    uLight: { value: new THREE.Vector3(-0.55, 0.7, 0.45).normalize() },
    uCrack: { value: 0 },
    uFlash: { value: 0 },
    uFreq: { value: 6.5 },
    uWrath: { value: 0 },
  };
}

export function engraveMaterial(u: TitanUniforms, opts: { wash?: number; tone?: number; gilt?: number } = {}) {
  const wash = opts.wash ?? 0.55;
  const toneBias = opts.tone ?? 0;
  const gilt = opts.gilt ?? 0;
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vObj; varying vec3 vWorld; varying vec3 vView;
      void main(){
        vN = normalize(normalMatrix * normal);
        vObj = position;
        vec4 w = modelMatrix * vec4(position, 1.);
        vWorld = w.xyz;
        vec4 mv = viewMatrix * w;
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uCrack, uFlash, uFreq, uWrath;
      uniform vec3 uInk, uBody, uVellum, uGold, uAccent, uLight;
      varying vec3 vN; varying vec3 vObj; varying vec3 vWorld; varying vec3 vView;
      ${NOISE}
      ${HATCH}
      void main(){
        vec3 n = normalize(vN);
        float lam = max(dot(n, normalize(uLight)), 0.);
        float rim = pow(1. - abs(n.z), 2.2);
        float tone = .18 + .9 * lam - .35 * rim + ${toneBias.toFixed(3)};
        // engraving lines follow the form: rotate the pattern by the surface's facing
        float ang = atan(n.y, n.x) * .35;
        mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
        vec2 hp = R * (vWorld.xy * uFreq) + vec2(vObj.z * 1.7, 0.);
        float wob = (vnoise(vWorld.xy * 2.2) - .5) * .35;
        float lines = hatch(hp, tone, wob);
        // wash: thin watercolour of the body ink, pooled darker in the shadows
        vec3 paper = mix(uVellum, uBody, ${wash.toFixed(3)} * (.55 + .45 * (1. - lam)));
        paper = mix(paper, uVellum * 1.04, smoothstep(.75, 1., lam) * .5);
        vec3 col = mix(paper, uInk, lines * mix(.62, .95, 1. - lam));
        // gilding
        float gl = ${gilt.toFixed(3)};
        vec3 gold = uGold * (.75 + .5 * lam) + vec3(1.,.9,.6) * pow(max(dot(reflect(-normalize(uLight), n), vec3(0.,0.,1.)), 0.), 18.) * .9;
        col = mix(col, mix(gold, uInk, lines * .5), gl);
        // kintsugi cracks: thin gold veins that widen with wounds
        float cn = fbm(vObj.xy * 1.15 + vObj.z * .6 + 4.2);
        float vein = 1. - smoothstep(.0, .018 + .03 * uCrack, abs(cn - .5));
        float reveal = smoothstep(.15, .9, uCrack + (vnoise(vObj.xy * .7) - .5) * .5);
        vec3 crackCol = mix(uGold * 1.15, vec3(1., .85, .45), .5 + .5 * sin(uTime * 3. + vObj.y));
        col = mix(col, crackCol, vein * reveal);
        // wrath tints the shadows with the attack ink
        col = mix(col, uAccent * .7, uWrath * .18 * (1. - lam));
        col = mix(col, vec3(1., .95, .8), uFlash * .55);
        gl_FragColor = vec4(col, 1.);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Ink outline: back faces pushed out along the normal. */
export function outlineMaterial(u: TitanUniforms, width = 0.07) {
  return new THREE.ShaderMaterial({
    uniforms: u,
    side: THREE.BackSide,
    vertexShader: /* glsl */ `
      void main(){
        vec3 p = position + normal * ${width.toFixed(3)};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
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

/** Gold leaf reliquary for cores: flaking leaf, hot specular, a pulse when open. */
export function goldMaterial(u: TitanUniforms) {
  const uu = { ...u, uOpen: { value: 0 }, uHit: { value: 0 } } as TitanUniforms & { uOpen: THREE.IUniform<number>; uHit: THREE.IUniform<number> };
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
        float lam = max(dot(n, normalize(uLight)), 0.);
        float flakes = step(.55, vnoise(vObj.xy * 9. + floor(uTime * 2.)));
        float spec = pow(max(dot(reflect(-normalize(uLight), n), vec3(0., 0., 1.)), 0.), 24.);
        vec3 g = uGold * (.45 + .7 * lam) * (.88 + .24 * flakes) + vec3(1., .93, .7) * spec;
        float pulse = .5 + .5 * sin(uTime * 6.);
        vec3 shut = mix(uInk, uGold * .45, .35 + .2 * lam);
        vec3 col = mix(shut, g + vec3(1., .8, .4) * pulse * .25, uOpen);
        col = mix(col, vec3(1., .97, .85), uHit);
        gl_FragColor = vec4(col, 1.);
        #include <colorspace_fragment>
      }
    `,
  });
}

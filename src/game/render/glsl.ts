// Shared GLSL snippets for the living bestiary look.

export const NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return s; }
`;

/** Hatching: returns ink coverage 0..1 for a given tone (0 = dark, 1 = light) at a screen position. */
export const HATCH = /* glsl */ `
float hatchLine(vec2 p, float angle, float freq, float width){
  vec2 d = vec2(cos(angle), sin(angle));
  float v = dot(p, d) * freq;
  float w = fwidth(v);
  float f = abs(fract(v) - .5);
  return 1. - smoothstep(width - w, width + w, f);
}
float hatch(vec2 p, float tone, float wob){
  float c = 0.;
  float t = clamp(tone, 0., 1.);
  // layers switch on as the tone darkens; each layer is a family of parallel engraved lines
  c = max(c, hatchLine(p + wob, .78, 1., mix(.0, .32, smoothstep(.95, .45, t))));
  c = max(c, hatchLine(p - wob * .7, -.62, 1., mix(.0, .30, smoothstep(.72, .25, t))));
  c = max(c, hatchLine(p + wob * .4, 1.57, 1.3, mix(.0, .28, smoothstep(.45, .08, t))));
  c = max(c, smoothstep(.12, .0, t));
  return clamp(c, 0., 1.);
}
`;

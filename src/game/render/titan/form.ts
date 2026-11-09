import { TitanSpec } from "@/core/titan";
import { rngFor } from "@/core/rng";

// The titan's look beyond its archetype: proportions, pose, ornament sets and a second pigment, all
// drawn from the seed on a render-only stream ("form"). Nothing here feeds the fight: cores, attack
// origins, tempo and the attack plan come from makeTitan alone and are never moved by the form.

/** Second pigments for the hand-colouring (lights and secondary parts), period earth and plant colours. */
export const PIGMENTS = [
  { name: "yellow ochre", hex: "#c39445" },
  { name: "sinopia", hex: "#b45a43" },
  { name: "verdigris", hex: "#5f9179" },
  { name: "folium", hex: "#8a6a9e" },
  { name: "rose madder", hex: "#c47a8a" },
  { name: "burnt sienna", hex: "#a8693a" },
  { name: "smalt", hex: "#6f86b8" },
  { name: "sap green", hex: "#7f9150" },
] as const;

export interface ThroneForm {
  back: "gothic" | "apse" | "wheel";
  halo: "spikes" | "beads" | "rays" | "none";
  crown: "spikes" | "mitre" | "tiara" | "horns";
  face: "gilt" | "bearded" | "veiled";
  pauldron: "orb" | "lames" | "spiked";
  attribute: "none" | "sceptre" | "orb" | "both";
  shoulders: number; // shoulder width scale
  head: number; // head scale
  spikes: number; // crown / halo spike counts
  windows: number;
  tilt: number; // head tilt (pose)
}
export interface StriderForm {
  shell: "dome" | "saucer" | "bell";
  back: "plates" | "spires" | "spines";
  head: "mandibles" | "tusks" | "proboscis";
  knee: "orb" | "spur";
  eyes: number;
  eyeRows: 1 | 2;
  leg: number; // leg thickness scale
  kneeLift: number; // how high the knees ride
  folds: number;
}
export interface BloomForm {
  petal: "lancet" | "round" | "thistle";
  layers: 2 | 3;
  ruff: "torus" | "beads" | "thorns";
  bud: "orb" | "bell" | "hook";
  leaves: boolean;
  spread: number; // crown scale
  lashes: boolean;
}
export interface CoilForm {
  frill: "fan" | "spines" | "antlers";
  horns: "swept" | "ram" | "none";
  fins: "cones" | "sails" | "none";
  bands: boolean;
  snout: number;
  barbels: boolean;
}
export interface SwarmForm {
  heart: "egg" | "sacred" | "anatomical" | "geode";
  ink: "accent" | "wash2" | "body"; // the heart's own pigment
  cage: "armillary" | "gyre" | "thorns";
  swarm: "shards" | "moths" | "eyes";
  eyes: 1 | 3;
  bands: number;
  flames: boolean;
}

export interface TitanForm {
  pigment: string; // hex of the second wash pigment
  pigmentName: string;
  warm: boolean; // a warm earth pigment (it can colour painted-stone flesh)
  wash: number; // wash strength multiplier
  throne: ThroneForm;
  strider: StriderForm;
  bloom: BloomForm;
  coil: CoilForm;
  swarm: SwarmForm;
}

/** Pure: same seed, same form, on every browser. */
export function titanForm(spec: Pick<TitanSpec, "seed" | "archetype" | "plate">): TitanForm {
  const r = rngFor("form", spec.seed);
  // a pigment that is not the plate's own body hue
  const bodyHue = hue(spec.plate.body);
  const far = PIGMENTS.filter((p) => Math.abs(angDiff(hue(p.hex), bodyHue)) > 40);
  const pig = r.pick(far.length ? far : PIGMENTS);
  const wash = r.range(0.9, 1.25);
  const throne: ThroneForm = {
    back: r.pick(["gothic", "apse", "wheel"] as const),
    halo: "spikes",
    crown: r.pick(["spikes", "mitre", "tiara", "horns"] as const),
    face: r.pick(["gilt", "bearded", "veiled"] as const),
    pauldron: r.pick(["orb", "lames", "spiked"] as const),
    attribute: r.weighted(["none", "sceptre", "orb", "both"] as const, [1, 2, 2, 1]),
    shoulders: r.range(0.9, 1.12),
    head: r.range(0.94, 1.1),
    spikes: r.int(5, 9),
    windows: r.pick([1, 3, 5]),
    tilt: r.range(-0.06, 0.06),
  };
  throne.halo = throne.back === "wheel" ? "none" : r.pick(["spikes", "beads", "rays"] as const);
  const strider: StriderForm = {
    shell: r.pick(["dome", "saucer", "bell"] as const),
    back: r.pick(["plates", "spires", "spines"] as const),
    head: r.pick(["mandibles", "tusks", "proboscis"] as const),
    knee: r.pick(["orb", "spur"] as const),
    eyes: r.int(3, 8),
    eyeRows: r.chance(0.45) ? 2 : 1,
    leg: r.range(0.8, 1.2),
    kneeLift: r.range(-1.2, 1.4),
    folds: r.pick([0, 7, 9, 12]),
  };
  const bloom: BloomForm = {
    petal: r.pick(["lancet", "round", "thistle"] as const),
    layers: r.chance(0.45) ? 3 : 2,
    ruff: r.pick(["torus", "beads", "thorns"] as const),
    bud: r.pick(["orb", "bell", "hook"] as const),
    leaves: r.chance(0.55),
    spread: r.range(0.9, 1.12),
    lashes: r.chance(0.5),
  };
  const coil: CoilForm = {
    frill: r.pick(["fan", "spines", "antlers"] as const),
    horns: r.pick(["swept", "ram", "none"] as const),
    fins: r.pick(["cones", "sails", "none"] as const),
    bands: r.chance(0.5),
    snout: r.range(0.85, 1.25),
    barbels: r.chance(0.6),
  };
  const swarm: SwarmForm = {
    heart: r.pick(["egg", "sacred", "anatomical", "geode"] as const),
    ink: r.pick(["accent", "wash2", "body"] as const),
    cage: r.pick(["armillary", "gyre", "thorns"] as const),
    swarm: r.pick(["shards", "moths", "eyes"] as const),
    eyes: r.chance(0.4) ? 3 : 1,
    bands: r.int(4, 8),
    flames: r.chance(0.5),
  };
  const h = hue(pig.hex);
  return { pigment: pig.hex, pigmentName: pig.name, warm: h < 50 || h > 330, wash, throne, strider, bloom, coil, swarm };
}

function hue(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  if (d < 1e-6) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

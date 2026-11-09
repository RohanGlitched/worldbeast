import { describe, it, expect } from "vitest";
import { makeTitan, LOOP_BEATS, Stage, PLATES } from "./titan";
import { Field, newFrame } from "./field";
import { Hunt } from "./hunt";
import { Bot } from "./bot/bot";

function runBot(seed: number, stage: Stage, start: number, secs: number, aspect: "ember" | "lance" | "bloom" | "mirror" = "ember") {
  const spec = makeTitan(seed, 1);
  const field = new Field(spec);
  const h = new Hunt(spec, field, aspect);
  const bot = new Bot(field, 1, 0.5);
  const dt = 1 / 60;
  let t = start;
  let maxBullets = 0;
  for (let i = 0; i < secs * 60 && h.alive; i++) {
    const inp = bot.decide(h, t, stage);
    h.step(t, dt, inp, stage);
    maxBullets = Math.max(maxBullets, h.frame.bulletCount);
    t += dt;
  }
  return { alive: h.alive, time: h.time, dmg: h.damage, hits: h.hits, grazes: h.grazeCount, maxBullets, spec };
}

describe("titan", () => {
  it("is deterministic per seed", () => {
    expect(JSON.stringify(makeTitan(42, 1))).toBe(JSON.stringify(makeTitan(42, 1)));
    expect(makeTitan(42, 1).name).not.toBe(makeTitan(43, 1).name);
  });
  it("samples identically for the same time", () => {
    const spec = makeTitan(7, 1);
    const a = new Field(spec), b = new Field(spec);
    const fa = newFrame(), fb = newFrame();
    for (const t of [3.3, 47.9, 120.25, 333.3]) {
      a.sample(t, 1, fa); b.sample(t, 1, fb);
      expect(fa.bulletCount).toBe(fb.bulletCount);
      expect(Array.from(fa.bullets.slice(0, fa.bulletCount * 7))).toEqual(Array.from(fb.bullets.slice(0, fb.bulletCount * 7)));
    }
  });
});

describe("fairness (look-ahead bot)", () => {
  it("survives most of a phrase in every stage across many titans", () => {
    const rows: string[] = [];
    let total = 0, survived = 0;
    for (let seed = 1; seed <= 24; seed++) {
      for (const stage of [0, 1, 2] as Stage[]) {
        const spec = makeTitan(seed, 1);
        const start = ((seed * 37) % 8) * 64 * spec.beat; // a phrase start within the loop
        const r = runBot(seed, stage, start, 40);
        total++;
        if (r.alive) survived++;
        rows.push(`${seed} ${spec.archetype.padEnd(10)} st${stage} ${r.alive ? "LIVE" : "dead"} t=${r.time.toFixed(1)} hits=${r.hits} dmg=${Math.round(r.dmg)} grz=${r.grazes} maxB=${r.maxBullets}`);
      }
    }
    console.log(rows.join("\n"));
    console.log(`survived ${survived}/${total}`);
    expect(survived / total).toBeGreaterThan(0.5);
  }, 400000);
});

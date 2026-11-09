import { it } from "vitest";
import { makeTitan, Stage } from "./titan";
import { Field } from "./field";
import { Hunt } from "./hunt";
import { Bot } from "./bot/bot";

it("difficulty report", () => {
  const kills: Record<string, number> = {};
  const surv: Record<number, number[]> = { 0: [], 1: [], 2: [] };
  for (let seed = 100; seed < 130; seed++) {
    for (const stage of [0, 1, 2] as Stage[]) {
      const spec = makeTitan(seed, 1);
      const field = new Field(spec);
      const h = new Hunt(spec, field, "ember");
      const bot = new Bot(field, 1, 0.5);
      let t = ((seed * 13) % 8) * 64 * spec.beat;
      for (let i = 0; i < 60 * 60 && h.alive; i++) {
        h.step(t, 1 / 60, bot.decide(h, t, stage), stage);
        t += 1 / 60;
      }
      surv[stage].push(h.time);
      for (const k of h.hitLog) kills[k] = (kills[k] ?? 0) + 1;
    }
  }
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log("median survival (s, cap 60):", [0, 1, 2].map((s) => med(surv[s]).toFixed(1)).join(" / "), " alive@60:", [0, 1, 2].map((s) => surv[s].filter((x) => x >= 59.9).length + "/30").join(" "));
  console.log("hits by kind:", JSON.stringify(Object.entries(kills).sort((a, b) => b[1] - a[1])));
}, 600000);

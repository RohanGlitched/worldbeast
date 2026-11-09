import { ARENA, Stage } from "../titan";
import { Field, newFrame, touch, Touch } from "../field";
import { Hunt, Input } from "../hunt";

// A look-ahead dodger used for fairness tests, demo echoes and attract mode.
const DIRS: Array<[number, number]> = [[0, 0]];
for (let i = 0; i < 12; i++) DIRS.push([Math.cos((i / 12) * Math.PI * 2), Math.sin((i / 12) * Math.PI * 2)]);

export class Bot {
  private probe = newFrame(2048);
  private tc: Touch = { hit: false, grazes: [], nearest: 99 };
  constructor(private field: Field, private skill = 1, private greed = 0.5) {}
  decide(h: Hunt, t: number, stage: Stage): Input {
    let best: [number, number] = [0, 0];
    let bestScore = -1e9;
    const speed = h.aspect.speed;
    const horizons = this.skill >= 1 ? [0.12, 0.28, 0.5] : [0.15, 0.35];
    for (const [dx, dy] of DIRS) {
      let score = 0;
      for (const hz of horizons) {
        const x = Math.max(-ARENA.W / 2 + 0.3, Math.min(ARENA.W / 2 - 0.3, h.x + dx * speed * hz));
        const y = Math.max(0.4, Math.min(ARENA.H - 1.2, h.y + dy * speed * hz));
        this.field.sample(t + hz, stage, this.probe);
        touch(this.probe, x, y, this.tc);
        const c = Math.min(this.tc.nearest, 1.2);
        score += c < 0 ? -50 / hz : c;
      }
      const nx = h.x + dx, ny = h.y + dy;
      // preference: stay near a target band (greedy bots fly higher for damage), stay central
      const band = 3 + this.greed * 9;
      score -= Math.abs(ny - band) * 0.05 + Math.abs(nx) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = [dx, dy];
      }
    }
    return { mx: best[0], my: best[1], dash: bestScore < -40 && this.skill >= 1 };
  }
}

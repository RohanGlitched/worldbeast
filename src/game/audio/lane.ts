// An automation lane for a long-lived AudioParam.
// It only ever writes ramps that end (never setTargetAtTime), so the param drops back onto the
// browser's cheap constant-value path between moves, and it mirrors its own breakpoints so a new
// move can start from the exact value the param will have at that moment (no jumps, no clicks).

export class Lane {
  private ev: Array<[number, number]> = []; // (time, value) breakpoints, linear between them

  constructor(
    readonly p: AudioParam,
    v: number,
    private ctx: BaseAudioContext,
  ) {
    p.value = v;
    this.ev.push([0, v]);
  }

  /** The value this lane will have at time t. */
  at(t: number): number {
    const ev = this.ev;
    if (t <= ev[0][0]) return ev[0][1];
    for (let i = ev.length - 1; i >= 0; i--) {
      if (ev[i][0] <= t) {
        const nx = ev[i + 1];
        if (!nx) return ev[i][1];
        const k = (t - ev[i][0]) / Math.max(1e-9, nx[0] - ev[i][0]);
        return ev[i][1] + (nx[1] - ev[i][1]) * k;
      }
    }
    return ev[ev.length - 1][1];
  }

  /** Last value the lane is heading to. */
  get target(): number {
    return this.ev[this.ev.length - 1][1];
  }

  /** Move to v over T seconds starting at `when`. Exponential ramps suit frequencies. */
  to(v: number, when: number, T: number, exp = false) {
    const now = this.ctx.currentTime;
    if (when < now) when = now;
    const start = this.at(when);
    const p = this.p;
    if (typeof p.cancelAndHoldAtTime === "function") p.cancelAndHoldAtTime(when);
    else p.cancelScheduledValues(when);
    // drop our mirror of anything at or after `when`
    let n = this.ev.length;
    while (n > 1 && this.ev[n - 1][0] >= when) n--;
    this.ev.length = n;
    p.setValueAtTime(start, when);
    this.ev.push([when, start]);
    const end = when + Math.max(0.001, T);
    if (exp && start > 0 && v > 0) p.exponentialRampToValueAtTime(v, end);
    else p.linearRampToValueAtTime(v, end);
    this.ev.push([end, v]);
    // forget breakpoints that are long past
    let drop = 0;
    while (drop < this.ev.length - 2 && this.ev[drop + 1][0] < now - 1) drop++;
    if (drop) this.ev.splice(0, drop);
  }

  /** A swell: go to v over `rise`, hold until `until`, then return to `back` over `fall`. */
  swell(v: number, when: number, rise: number, until: number, back: number, fall: number) {
    this.to(v, when, rise);
    this.to(back, Math.max(until, when + rise), fall);
  }
}

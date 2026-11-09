// Keyboard, mouse, touch and gamepad, folded into one movement vector + dash.
// Touch uses relative drag (your finger never covers your spark); a second finger or the dash button dashes.

export interface InputState {
  mx: number;
  my: number;
  dash: boolean;
  /** relative drag target in world units (touch / mouse drag) */
  drag: { active: boolean; ox: number; oy: number; px: number; py: number };
  usingTouch: boolean;
  any: boolean;
}

export class Input {
  state: InputState = { mx: 0, my: 0, dash: false, drag: { active: false, ox: 0, oy: 0, px: 0, py: 0 }, usingTouch: false, any: false };
  private keys = new Set<string>();
  private dashQueued = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragId = -1;
  private lastTap = 0;
  private el: HTMLElement;
  private toWorldDelta: (dxPx: number, dyPx: number) => { x: number; y: number };
  constructor(el: HTMLElement, toWorldDelta: (dx: number, dy: number) => { x: number; y: number }) {
    this.el = el;
    this.toWorldDelta = toWorldDelta;
    window.addEventListener("keydown", this.kd);
    window.addEventListener("keyup", this.ku);
    window.addEventListener("blur", this.blur);
    el.addEventListener("pointerdown", this.pd);
    window.addEventListener("pointermove", this.pm);
    window.addEventListener("pointerup", this.pu);
    window.addEventListener("pointercancel", this.pu);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  dispose() {
    window.removeEventListener("keydown", this.kd);
    window.removeEventListener("keyup", this.ku);
    window.removeEventListener("blur", this.blur);
    this.el.removeEventListener("pointerdown", this.pd);
    window.removeEventListener("pointermove", this.pm);
    window.removeEventListener("pointerup", this.pu);
    window.removeEventListener("pointercancel", this.pu);
  }
  queueDash() {
    this.dashQueued = true;
  }
  private kd = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    if ((k === " " || k === "shift" || k === "k" || k === "x") && !this.keys.has(k)) this.dashQueued = true;
    this.keys.add(k);
    this.state.usingTouch = false;
    this.state.any = true;
  };
  private ku = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
  private blur = () => {
    this.keys.clear();
    this.pointers.clear();
    this.dragId = -1;
    this.state.drag.active = false;
  };
  private pd = (e: PointerEvent) => {
    this.state.any = true;
    this.state.usingTouch = e.pointerType === "touch";
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.dragId === -1) {
      this.dragId = e.pointerId;
      this.state.drag.active = true;
      this.state.drag.ox = 0;
      this.state.drag.oy = 0;
      const now = performance.now();
      if (now - this.lastTap < 260) this.dashQueued = true; // double tap dashes
      this.lastTap = now;
    } else {
      this.dashQueued = true; // second finger
    }
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
  };
  private pm = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (e.pointerId === this.dragId) {
      const d = this.toWorldDelta(e.clientX - p.x, e.clientY - p.y);
      this.state.drag.ox += d.x * 1.15;
      this.state.drag.oy += d.y * 1.15;
    }
    p.x = e.clientX;
    p.y = e.clientY;
  };
  private pu = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (e.pointerId === this.dragId) {
      this.dragId = -1;
      this.state.drag.active = false;
    }
  };

  /** Called once per frame. Returns the movement vector and whether to dash. */
  poll() {
    const k = this.keys;
    let mx = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("a") || k.has("arrowleft") ? 1 : 0);
    let my = (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0);
    let dash = this.dashQueued;
    // gamepad
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0,
        ay = gp.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.18) {
        mx = ax;
        my = -ay;
        this.state.any = true;
      }
      if (gp.buttons[0]?.pressed || gp.buttons[5]?.pressed) dash = true;
    }
    this.dashQueued = false;
    this.state.mx = mx;
    this.state.my = my;
    this.state.dash = dash;
    return this.state;
  }
  /** consume the accumulated drag delta */
  takeDrag() {
    const d = { x: this.state.drag.ox, y: this.state.drag.oy };
    this.state.drag.ox = 0;
    this.state.drag.oy = 0;
    return d;
  }
}

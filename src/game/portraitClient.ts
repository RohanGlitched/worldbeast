// Portraits for pages without the game (the Hall): drawn on a worker thread when the browser can run WebGL
// in a worker (OffscreenCanvas), otherwise on the page in idle slots (portrait.ts). This module is tiny and
// loads neither three.js nor the engraver on the page unless the worker is unavailable.

type Opts = { crack?: number; w?: number; h?: number; dpr?: number };
type Pending = { res: (b: Blob) => void; rej: (e: Error) => void };

let worker: Worker | null | undefined; // undefined: not tried yet; null: unavailable
let seq = 0;
const pending = new Map<number, Pending>();
const cache = new Map<string, Promise<string>>();

function failAll(why: string) {
  worker = null;
  for (const p of pending.values()) p.rej(new Error(why));
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") throw new Error("no OffscreenCanvas");
    const w = new Worker(new URL("./portraitWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.blob) p.res(e.data.blob);
      else {
        // WebGL in a worker failed (e.g. no WebGL on OffscreenCanvas): stop using it
        p.rej(new Error(e.data.error || "worker"));
        failAll("worker unavailable");
        w.terminate();
      }
    };
    w.onerror = () => {
      failAll("worker error");
      w.terminate();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

const onPage = (seed: number, number: number, o: Opts) => import("./portrait").then((m) => m.portraitAsync(seed, number, o));

/** A titan's engraved portrait as an image URL, drawn without blocking the page. */
export function portraitOffThread(seed: number, number: number, opts: Opts = {}): Promise<string> {
  const o = { ...opts, dpr: opts.dpr ?? Math.min(2, window.devicePixelRatio || 1) };
  const key = `${seed}:${number}:${o.crack ?? 0}:${o.w ?? 360}x${o.h ?? 300}@${o.dpr}`;
  let p = cache.get(key);
  if (!p) {
    const w = getWorker();
    p = (
      w
        ? new Promise<Blob>((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            w.postMessage({ id, seed, number, opts: o });
          }).then(
            (b) => URL.createObjectURL(b),
            () => onPage(seed, number, o),
          )
        : onPage(seed, number, o)
    ).catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, p);
  }
  return p;
}

/// <reference lib="webworker" />
import { portraitBlob } from "./portrait";

// Engraves portraits on a worker thread (an OffscreenCanvas WebGL renderer): building the titan, linking its
// programs, drawing and encoding never touch the page's main thread. See portraitClient.ts.

type Req = { id: number; seed: number; number: number; opts: Parameters<typeof portraitBlob>[2] };

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, seed, number, opts } = e.data;
  portraitBlob(seed, number, opts).then(
    (blob) => self.postMessage({ id, blob }),
    (err) => self.postMessage({ id, error: String((err && err.message) || err) }),
  );
};

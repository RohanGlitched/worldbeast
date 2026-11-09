import { lazy, Suspense } from "react";
import { usePath } from "@/ui/router";
import NotFound from "@/ui/NotFound";

// Every leaf of the codex is its own chunk: the Hall and How it works load without the game and three.js.
// On the hunt's own address the hunt's chunks are preloaded from index.html (vite.config.js), so the cover
// does not wait for an extra round trip.
const Hunt = lazy(() => import("@/ui/Hunt"));
const Hall = lazy(() => import("@/ui/Hall"));
const How = lazy(() => import("@/ui/How"));

export default function App() {
  const path = usePath();
  const hunt = path === "/" || path === "";
  const page = hunt ? <Hunt /> : path.startsWith("/hall") ? <Hall /> : path.startsWith("/how") ? <How /> : <NotFound />;
  return <Suspense fallback={hunt ? <div className="stage" aria-busy="true" /> : <div className="doc" aria-busy="true" />}>{page}</Suspense>;
}

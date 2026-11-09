import { lazy, Suspense } from "react";
import Hunt from "@/ui/Hunt";
import { usePath } from "@/ui/router";
import NotFound from "@/ui/NotFound";

// the hunt loads first; the other leaves of the codex load when they are turned to
const Hall = lazy(() => import("@/ui/Hall"));
const How = lazy(() => import("@/ui/How"));

export default function App() {
  const path = usePath();
  const page = path === "/" || path === "" ? <Hunt /> : path.startsWith("/hall") ? <Hall /> : path.startsWith("/how") ? <How /> : <NotFound />;
  return <Suspense fallback={<div className="doc" aria-busy="true" />}>{page}</Suspense>;
}

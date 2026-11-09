import Hunt from "@/ui/Hunt";
import Hall from "@/ui/Hall";
import How from "@/ui/How";
import { usePath } from "@/ui/router";

export default function App() {
  const path = usePath();
  if (path.startsWith("/hall")) return <Hall />;
  if (path.startsWith("/how")) return <How />;
  return <Hunt />;
}

// Wax seals: feats a hunter earns once, kept in this browser.

export const SEALS = [
  { id: "first", name: "First Light", line: "Finish your first hunt.", test: (s) => true },
  { id: "graze", name: "Grazer", line: "Graze 50 attacks in one hunt.", test: (s) => s.grazes >= 50 },
  { id: "surge", name: "Thrice Surged", line: "Surge three times in one hunt.", test: (s) => s.surges >= 3 },
  { id: "unbroken", name: "Unbroken", line: "Last 60 s without being struck.", test: (s) => s.cleanTime >= 60 },
  { id: "ruin", name: "Ruinwalker", line: "Last 45 s while a titan is in Ruin.", test: (s) => s.stage === 2 && s.time >= 45 },
  { id: "heavy", name: "Heavy Hand", line: "Strike 2,000 blows in one hunt.", test: (s) => s.damage >= 2000 },
  { id: "witness", name: "Witness", line: "Be hunting when a titan falls.", test: (s) => !!s.felled },
  { id: "final", name: "The Final Blow", line: "Strike the blow that fells a titan.", test: (s) => !!s.finalBlow },
];

const COLORS = ["#a8261a", "#2b4a8b", "#8a6512", "#2f6b4f", "#5b2550", "#a8261a", "#36507a", "#9c7420"];

export function Seal({ i, earned, size = 34, fresh = false }) {
  const s = SEALS[i];
  const c = COLORS[i % COLORS.length];
  return (
    <span className={"seal" + (earned ? " earned" : "") + (fresh ? " fresh" : "")} title={`${s.name}: ${s.line}`} style={{ "--seal": c, width: size, height: size }}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M20 2c3 2 6 1 8 3s1 5 3 8 4 4 4 7-3 4-4 7 0 6-3 8-5 1-8 3-5 1-8-1-6-1-8-3-1-5-3-8-4-4-4-7 3-4 4-7 0-6 3-8 5-1 8-3 5-1 8 1z" />
        <circle cx="20" cy="20" r="11" className="inner" />
        <text x="20" y="25">{s.name[0]}</text>
      </svg>
      <span className="sr-only">{s.name}</span>
    </span>
  );
}

/** returns the ids newly earned by this run */
export function judgeSeals(profile, s) {
  const have = new Set(profile.seals || []);
  const fresh = SEALS.filter((x) => !have.has(x.id) && x.test(s)).map((x) => x.id);
  return fresh;
}

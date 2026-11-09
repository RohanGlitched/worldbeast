const out: Record<string, number | string> = {};
for (const name of ["Titan", "Hunter", "Run", "Echo"]) {
  try {
    const rows = await (base44 as any).entities[name].list("-created_date", 5000, 0, ["id"]);
    out[name] = rows.length;
  } catch (e) {
    out[name] = "ERR " + String(e).slice(0, 120);
  }
}
console.log(JSON.stringify(out));

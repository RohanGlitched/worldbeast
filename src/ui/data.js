import { base44 } from "@/api/base44Client";

// Public reads from the Base44 database (records are written only by the world actor).

async function safe(fn, fallback) {
  try {
    const v = await fn();
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export const listTitans = (limit = 60) => safe(() => base44.entities.Titan.list("-number", limit), []);
export const listHunters = (limit = 30) => safe(() => base44.entities.Hunter.list("-damageTotal", limit), []);
export const listRuns = (limit = 30) => safe(() => base44.entities.Run.list("-damage", limit), []);
export const titanRuns = (number, limit = 12) => safe(() => base44.entities.Run.filter({ titanNumber: number }, "-damage", limit), []);
export const titanEchoes = (number, limit = 3) => safe(() => base44.entities.Echo.filter({ titanNumber: number }, "-damage", limit), []);

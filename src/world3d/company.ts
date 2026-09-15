// Persistent between-campaign progression — the "company" that outlives each mine.
// Every board review banks legacy points by grade; you spend them on permanent
// perks that apply to every future campaign. Stored in localStorage.

export interface Company { legacy: number; perks: string[] }

export interface MetaPerk { id: string; name: string; desc: string; cost: number }
export const META_PERKS: MetaPerk[] = [
  { id: "seed", name: "Seed capital", desc: "+15% starting budget on every mine", cost: 4 },
  { id: "veterans", name: "Veteran crew", desc: "Start each campaign with 8 research points", cost: 3 },
  { id: "lean", name: "Lean operations", desc: "−8% daily running costs", cost: 5 },
  { id: "prospect", name: "Regional prospecting", desc: "+30,000 t orebody on every mine", cost: 4 },
];

const KEY = "bt_company";
const EMPTY: Company = { legacy: 0, perks: [] };

export function loadCompany(): Company {
  try { const c = JSON.parse(localStorage.getItem(KEY) || "null"); return c && Array.isArray(c.perks) ? c : { ...EMPTY }; }
  catch { return { ...EMPTY }; }
}
export function saveCompany(c: Company) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private mode */ } }

/** Legacy points a board-review grade is worth. */
export function legacyForGrade(g: string): number { return ({ S: 5, A: 3, B: 2, C: 1, D: 0 } as Record<string, number>)[g] ?? 0; }
export const hasPerk = (c: Company, id: string) => c.perks.includes(id);

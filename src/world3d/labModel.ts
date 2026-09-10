// The lab: rheology + strength. The core course trade-off — % solids and binder
// pull strength up but pumpability down. Yield stress rises steeply past ~78%
// solids (paste band 75-83%); 28-day UCS scales with binder and solids; binder
// is the dominant cost (~70% of opex).

export interface Recipe { solids: number; binderKgPerM3: number; }
export const DEFAULT_RECIPE: Recipe = { solids: 0.74, binderKgPerM3: 200 };
export const BINDER_PRICE_PER_TONNE = 160;

/** Yield stress (Pa), rising steeply with solids. ~38 Pa at 74%, ~110 at 78%, ~180 at 80%. */
export const yieldStressPa = (solids: number) => 8 * Math.exp(26 * (solids - 0.68));

/** Friction gradient (kPa/m), roughly proportional to yield stress; course band 3-8. */
export const frictionKpaPerM = (solids: number) => 2.5 + yieldStressPa(solids) * 0.045;

/** Multiplier on the design-basis friction (5 kPa/m) used by the live pour. */
export const frictionScale = (solids: number) => frictionKpaPerM(solids) / 5;

/** Predicted 28-day UCS (kPa). Calibrated so ~200 kg/m³ at 74% solids ≈ 730 kPa. */
export function ucs28Kpa(r: Recipe): number {
  const solidsFactor = Math.pow(r.solids / 0.74, 3.2); // strength is very sensitive to solids
  return 5.0 * Math.pow(r.binderKgPerM3, 0.95) * solidsFactor;
}

/** Paste cost per m³ — binder-dominated. */
export function recipeCostPerM3(r: Recipe): number {
  return (r.binderKgPerM3 / 1000) * BINDER_PRICE_PER_TONNE + 6;
}

/** Pumpability verdict for the current solids (paste band vs plug/settle risk). */
export function pumpability(solids: number): { label: string; level: "green" | "amber" | "red" } {
  if (solids > 0.80) return { label: "very stiff — pump/plug risk", level: "red" };
  if (solids > 0.785) return { label: "stiff — watch pressure", level: "amber" };
  if (solids < 0.70) return { label: "thin — segregation risk", level: "amber" };
  return { label: "good paste", level: "green" };
}

/** Deterministic per-stope strength variance (no RNG so renders/results are stable). */
export function ucsVariance(seed: number): number {
  const s = Math.sin(seed * 91.7 + 12.3) * 43758.5453;
  return 0.9 + (s - Math.floor(s)) * 0.18; // 0.90 - 1.08
}

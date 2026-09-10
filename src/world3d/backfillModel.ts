// Underground reticulation physics + economy, grounded in the P&C backfill course.
// Static head ρgh dominates deep lines (800 m paste ≈ 14 MPa), friction ~3-8 kPa/m,
// borehole couplings rated ~250 bar; deeper stopes force a stronger (pricier) pipe
// class, and a choke station burns off head so a cheaper class survives.

export const RHO_PASTE = 1800;          // kg/m³ (course paste density)
export const G = 9.81;
export const FRICTION_KPA_PER_M = 5;    // mid of the 3-8 kPa/m paste band
export const SURGE_MPA = 2;             // Joukowsky allowance (~2 m/s step)
export const CHOKE_HEAD_RELIEF = 0.5;   // a choke station burns ~half the static head on the leg

export interface PipeClass { id: number; name: string; ratingMpa: number; costPerM: number; color: string; }

// HDPE < Sch 40 < Sch 80 < Sch 120 (borehole spec). Ratings in MPa (1 bar = 0.1 MPa).
export const PIPE_CLASSES: PipeClass[] = [
  { id: 0, name: "HDPE",    ratingMpa: 1.6, costPerM: 220,  color: "#39d98a" },
  { id: 1, name: "Sch 40",  ratingMpa: 10,  costPerM: 520,  color: "#4aa8ff" },
  { id: 2, name: "Sch 80",  ratingMpa: 16,  costPerM: 880,  color: "#ffb020" },
  { id: 3, name: "Sch 120", ratingMpa: 25,  costPerM: 1500, color: "#ff7a3a" },
];

export const staticHeadMpa = (depthM: number) => (RHO_PASTE * G * depthM) / 1e6;
export const frictionMpa = (lengthM: number) => (FRICTION_KPA_PER_M * lengthM) / 1000;

// Live-pour pressure: friction rises steeply with flow (~flow^1.8); a forming
// plug piles static head onto the line (blockage = pressure rises); burst when
// the line pressure tops the pipe's rating.
export const BURST_PENALTY = 1_500_000;
export const pourFrictionMpa = (lengthM: number, flowFactor: number) =>
  frictionMpa(lengthM) * Math.pow(Math.max(0.2, flowFactor), 1.8);
export function pourPressureMpa(depthM: number, lengthM: number, choke: boolean, flowFactor: number, plugDrift: number, ratingMpa: number, noise: number, frictionScale = 1): number {
  const head = staticHeadMpa(depthM) * (choke ? CHOKE_HEAD_RELIEF : 1);
  return Math.max(0, head + pourFrictionMpa(lengthM, flowFactor) * frictionScale + plugDrift * ratingMpa + noise);
}

/** Pressure the line must survive at the stope, with optional choke relief. */
export function requiredMpa(depthM: number, lengthM: number, choke: boolean): number {
  const head = staticHeadMpa(depthM) * (choke ? CHOKE_HEAD_RELIEF : 1);
  return head + frictionMpa(lengthM) + SURGE_MPA;
}

/** Cheapest pipe class that survives the required pressure, or null if beyond Sch 120. */
export function pickClass(reqMpa: number): PipeClass | null {
  return PIPE_CLASSES.find((c) => c.ratingMpa >= reqMpa) ?? null;
}

export const CHOKE_CAPEX = 850_000;     // a choke/dissipation station
export const reticulationCost = (lengthM: number, cls: PipeClass) => Math.round(lengthM * cls.costPerM);

// Fill economy: binder is ~70% of a paste opex of roughly $40/m³; delivering fill
// unlocks the next mining lift, which is worth far more than the fill costs.
export const PASTE_COST_PER_M3 = 42;
export const ORE_VALUE_PER_M3 = 460;    // value of the ore access each filled stope unlocks
export const fillCost = (volumeM3: number) => Math.round(volumeM3 * PASTE_COST_PER_M3);
export const fillRevenue = (volumeM3: number) => Math.round(volumeM3 * ORE_VALUE_PER_M3);

// ---- live-game constants ---------------------------------------------------
export const SECONDS_PER_DAY = 2.6;     // real seconds per game day at 1x
export const POUR_RATE_M3_PER_DAY = 6000; // plant throughput while a pour runs
export const CURE_DAYS = 14;            // paste cure clock (compressed from 28)
export const HORIZON_DAY = 60;          // campaign horizon
export const LATE_COST_PER_DAY = 120_000; // per overdue, unfilled available stope
export const BASE_OPEX_PER_DAY = 40_000;  // fixed site running cost

// Binder supply (course: silos up to ~4000 t; binder ~70% of opex; silo capacity
// vs delivery lead time is the eternal squeeze).
export const BINDER_SILO_CAP = 4000;        // tonnes
export const BINDER_DELIVERY_PER_DAY = 400; // rail replenishment
export const BINDER_TOPUP_TONNES = 1500;    // emergency truck top-up
export const BINDER_TOPUP_COST = 400_000;   // short lead, premium price

/** Compact money format: $1.8m / $850k / $420. */
export function fmtMoney(n: number): string {
  const s = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${Math.round(a)}`;
}

// Real-number anchors from the GDD (04, 06, 09). Units are real.
// These are the balance foundation — keep them honest.

export const G = 9.81; // m/s^2

// Paste backfill envelope (GDD 04, LOCKED)
export const PASTE_SOLIDS_MIN = 0.70; // 70% solids by mass
export const PASTE_SOLIDS_MAX = 0.80; // 80% solids by mass
export const PASTE_DENSITY = 1800; // kg/m^3 (worked example ρ, GDD 06)

// Friction gradient band for paste (GDD 06): 3–8 kPa/m, higher at high solids
export const FRICTION_KPA_PER_M_MIN = 3;
export const FRICTION_KPA_PER_M_MAX = 8;

// Pipe pressure rating classes (GDD 06): 50 / 100 / 150 bar => MPa
export const PIPE_RATINGS_MPA = [5, 10, 15] as const;

// UCS design (GDD 04/03): design ages 7 and 28 days, plug > ~100 kPa
export const UCS_TEST_AGES_DAYS = [7, 28] as const;
export const UCS_PLUG_MIN_KPA = 100; // liquefaction-threshold guidance

// Economy (GDD 09): binder ~70% of opex, the money system
export const BINDER_PRICE_PER_TONNE = 180; // $/t cement (campaign-tunable)
export const WATER_COST_PER_M3 = 0.8;
export const POWER_COST_PER_M3 = 1.2; // rolled-up plant power per m^3 placed
export const LABOUR_COST_PER_HOUR = 65;

// Time model (GDD 03): 1 in-game day ≈ 75s real at 1x
export const SECONDS_PER_GAME_DAY = 75;
export const SPEEDS = [1, 2, 4, 8] as const;

// Tonne <-> m^3 helper for placed paste
export function tonnesPlaced(volumeM3: number): number {
  return (volumeM3 * PASTE_DENSITY) / 1000;
}

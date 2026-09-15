// The surface materials economy — the supply/demand game behind the plant.
//
// The mine hoists ore to a ROM pad; the MILL turns ore into saleable concentrate
// (the steady cash income) plus TAILINGS as a byproduct. Course rule: only ~50%
// of tailings can ever go back underground as fill (1 m³ ore → 1.5 m³ fill but
// only 1 m³ void), so the balance is forced to the TSF — which fills up and must
// be raised, or the mill chokes for want of somewhere to put its waste. Binder
// arrives by rail (and costs money), water is pumped to a pond. A pour draws
// tailings + water + binder at once; whichever runs dry throttles the pour.

export interface Stock { level: number; cap: number; }

// ---- economy anchors (grounded in the P&C course throughput/utilisation) ----
export const MINE_HOIST_TPD = 4000;        // ROM ore hoisted per day while reserves remain
export const MILL_ORE_TPD = 3600;          // mill ore throughput per day (the bottleneck)
export const MILL_NET_PER_T = 130;         // net concentrate value per tonne milled ($)
export const TAILINGS_YIELD = 0.92;        // tonnes of tailings per tonne of ore milled

export const ORE_RESERVE_START = 230_000;  // the orebody — hoisting depletes it; the mine runs down late-campaign
export const ORE_PAD_CAP = 45_000;         // ROM stockpile capacity (t)
export const TAILINGS_BUFFER_CAP = 9_000;  // thickened-tailings surge buffer feeding the plant (t)
export const WATER_POND_CAP = 60_000;      // process-water pond (m³)
export const WATER_PUMP_M3_PER_DAY = 9_000;// pumped raw-water make-up per day
export const TSF_CAP_PER_CELL = 60_000;    // storage added by each TSF (t); ~half a campaign's tailings, so a raise is forced mid-run
export const TSF_RAISE_FRACTION = 0.5;     // each dam lift adds 50% of the base cell capacity
export const TSF_MAX_RAISES = 4;           // upstream raises get impractical beyond a few lifts
/** Effective storage of one TSF after `raises` lifts. */
export const tsfCapacity = (baseCap: number, raises: number) => Math.round(baseCap * (1 + raises * TSF_RAISE_FRACTION));
/** Capex of the next lift — upstream raises get progressively dearer. */
export const tsfRaiseCost = (raises: number) => Math.round(4_000_000 * (1 + raises * 0.6));

// Binder now genuinely arrives and costs money (course: binder ≈ 70% of backfill opex).
export const BINDER_COST_PER_T = 190;      // delivered rail binder cost ($/t)

// Plant consumption per m³ of fill placed (paste ρ≈1800, ~76% solids).
export const TAILINGS_T_PER_M3 = 1.35;     // dry tailings tonnes per m³ paste
export const WATER_M3_PER_M3 = 0.34;       // process water per m³ paste

// Starting stocks: enough to make the first pour, but the chain must be built to sustain it.
export const START_BINDER_T = 1_000;
export const START_WATER_M3 = 22_000;

export interface SupplyBuildings {
  mill: boolean;   // a powered mill is present
  rail: boolean;   // a powered rail terminal is present
  water: boolean;  // a powered water pump is present
  tsfCap: number;  // total TSF storage capacity available (0 = no TSF)
}

export interface DayResult {
  milledT: number;
  revenue: number;    // concentrate sales this tick
  binderCost: number; // cost of binder delivered this tick
  toTsf: number;      // tailings deposited to the TSF this tick
  notes: string[];    // player-facing supply warnings
}

export interface Draw { m3: number; limiting: "tailings" | "water" | "binder" | null; }

export class SupplyChain {
  oreReserve: Stock = { level: ORE_RESERVE_START, cap: ORE_RESERVE_START }; // the orebody in the ground
  ore: Stock = { level: 0, cap: ORE_PAD_CAP };
  tailings: Stock = { level: 0, cap: TAILINGS_BUFFER_CAP };
  binder: Stock = { level: START_BINDER_T, cap: 4_000 };
  water: Stock = { level: START_WATER_M3, cap: WATER_POND_CAP };
  tsf: Stock = { level: 0, cap: 0 };

  /** One game-day tick of the surface economy: hoist, mill, route tailings, deliver binder, pump water. */
  tick(dd: number, b: SupplyBuildings, binderDeliveryMult: number): DayResult {
    const notes: string[] = [];
    this.tsf.cap = b.tsfCap;

    // Hoist ore to the ROM pad, drawing down the finite orebody.
    const hoist = Math.min(MINE_HOIST_TPD * dd, this.oreReserve.level, this.ore.cap - this.ore.level);
    this.ore.level += hoist; this.oreReserve.level = Math.max(0, this.oreReserve.level - hoist);
    if (this.oreReserve.level <= 0 && this.ore.level < 1) notes.push("Orebody exhausted — no ore left to hoist or mill. Wind the operation down.");
    else if (this.oreReserve.level > 0 && this.oreReserve.level < ORE_RESERVE_START * 0.15) notes.push("Orebody running low — the mine is near end of life.");

    // Mill ore → concentrate + tailings, but only as fast as the tailings have somewhere to go.
    let milled = 0, revenue = 0, toTsf = 0;
    if (b.mill) {
      let want = Math.min(MILL_ORE_TPD * dd, this.ore.level);
      let tail = want * TAILINGS_YIELD;
      const bufFree = this.tailings.cap - this.tailings.level;
      const tsfFree = this.tsf.cap - this.tsf.level;
      const space = bufFree + tsfFree;
      if (tail > space + 1e-6) {
        const k = space <= 0 ? 0 : space / tail;
        want *= k; tail *= k;
        notes.push(this.tsf.cap <= 0 ? "⚠ No TSF — nowhere for tailings, mill choked. Build a TSF."
          : "⚠ TSF full — mill throttled. Raise the dam or build another TSF.");
      }
      // Route: the plant buffer takes what it can hold; the excess is forced to the TSF.
      // Over a campaign the plant reuses only part of the tailings (void < production),
      // so the bulk still lands in the TSF — the ~50% rule emerges instead of being imposed.
      const toBuffer = Math.min(tail, bufFree);
      this.tailings.level += toBuffer;
      toTsf = tail - toBuffer;
      this.tsf.level = Math.min(this.tsf.cap, this.tsf.level + toTsf);
      this.ore.level -= want;
      milled = want;
      revenue = milled * MILL_NET_PER_T;
      if (this.tsf.cap > 0 && this.tsf.level > this.tsf.cap * 0.85) notes.push("TSF above 85% — plan a dam raise soon.");
    } else if (this.ore.level >= this.ore.cap - 1) {
      notes.push("ROM pad full — no mill to process ore (no income). Build a Mill.");
    }

    // Binder arrives by rail (and costs money); no rail terminal ⇒ no delivery.
    let binderCost = 0;
    if (b.rail) {
      const room = this.binder.cap - this.binder.level;
      const delivered = Math.min(BINDER_DELIVERY_PER_DAY_ * binderDeliveryMult * dd, room);
      this.binder.level += delivered;
      binderCost = delivered * BINDER_COST_PER_T;
    }

    // Water pumped to the pond; no pump ⇒ the pond only drains.
    if (b.water) this.water.level = Math.min(this.water.cap, this.water.level + WATER_PUMP_M3_PER_DAY * dd);

    return { milledT: milled, revenue, binderCost, toTsf, notes };
  }

  /** Draw materials for `m3Want` of fill. Returns the m³ actually supplied (throttled by the scarcest stock). */
  drawForPour(m3Want: number, binderTonnesFull: number): Draw {
    if (m3Want <= 0) return { m3: 0, limiting: null };
    const tailNeed = m3Want * TAILINGS_T_PER_M3;
    const waterNeed = m3Want * WATER_M3_PER_M3;
    const binderNeed = binderTonnesFull;
    const ratios: Array<[number, Draw["limiting"]]> = [
      [tailNeed > 0 ? this.tailings.level / tailNeed : 1, "tailings"],
      [waterNeed > 0 ? this.water.level / waterNeed : 1, "water"],
      [binderNeed > 0 ? this.binder.level / binderNeed : 1, "binder"],
    ];
    let frac = 1; let limiting: Draw["limiting"] = null;
    for (const [r, name] of ratios) if (r < frac) { frac = r; limiting = name; }
    frac = Math.max(0, Math.min(1, frac));
    const m3 = m3Want * frac;
    this.tailings.level = Math.max(0, this.tailings.level - m3 * TAILINGS_T_PER_M3);
    this.water.level = Math.max(0, this.water.level - m3 * WATER_M3_PER_M3);
    this.binder.level = Math.max(0, this.binder.level - binderNeed * frac);
    return { m3, limiting: frac >= 0.999 ? null : limiting };
  }

  /** Emergency binder truck top-up (short lead, premium price) — added straight to the silo. */
  topUpBinder(tonnes: number) { this.binder.level = Math.min(this.binder.cap, this.binder.level + tonnes); }
}

// Kept here so the module is self-contained; mirrors the course silo/rail cadence.
export const BINDER_DELIVERY_PER_DAY_ = 400;

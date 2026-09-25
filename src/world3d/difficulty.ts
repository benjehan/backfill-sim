// Difficulty: one bundle of multipliers applied on top of a scenario. "Hard" is the
// original, authentic balance (every multiplier 1, no safety nets). "Normal" is a
// little gentler, and "Easy" (the default) is kid-friendly: cheaper to build, more
// income, softer penalties, a safety crew that eases risky pours for you, and a
// board that steps in with extra money instead of letting you go broke.
// The engineering depth is all still there; Easy just forgives mistakes.
import type { Scenario } from "./scenarios.js";
import { CATALOG as BUILDINGS } from "./catalog.js";
import { CATALOG as PLANT_EQUIP } from "../plant/model.js";
import { PIPE_CLASSES } from "./backfillModel.js";

export type DifficultyId = "easy" | "normal" | "hard";

export interface Difficulty {
  id: DifficultyId;
  label: string;
  tag: string;          // short badge on the select screen
  blurb: string;        // one line on the select screen
  startCash: number;    // × starting budget
  build: number;        // × capital costs (buildings, plant line, pipes, barricades, dam raises, upgrades)
  explore: number;      // × survey / drilling / test-work costs
  permit: number;       // × mining permit fee
  revenue: number;      // × mill income and fill (ore access) revenue
  opex: number;         // × daily running costs (site, buildings, wages, flowsheet)
  dewater: number;      // × pumping cost on flooded mines
  binderCost: number;   // × delivered binder price
  binderDelivery: number; // × binder delivery rate
  fines: number;        // × environmental fines and late-stope costs
  penalties: number;    // × burst / inrush / seepage / event costs
  barricadeCap: number; // × barricade strength
  pressureTol: number;  // × effective pipe rating before a burst
  ucsTarget: number;    // × stope strength targets
  cure: number;         // × cure time
  pasteFeed: number;    // × share of mill tailings that suits paste (faster, less starved pours)
  scatter: number;      // × the extra strength scatter / mineralogy penalty from skipping test-work
  startBinder: number;
  remoteHandicap: number; // × how much a remote mine throttles and marks up binder (1 = full)  // the Lab's starting mix binder (kg/m³); Easy starts on a stronger, safer mix
  scheduleSlack: number; // extra days on every stope due date
  horizonAdd: number;   // extra campaign days
  rescues: number;      // how many times the board will step in when money runs out (99 = always)
  rescueAmount: number; // minimum top-up ($)
  rescueIsLoan: boolean; // true: repaid from mill income (+10%); false: a free grant
  autoSafety: boolean;  // the crew eases flow / flushes lines before anything bursts
  legAware: boolean;    // a pour is checked leg-by-leg (each leg vs the pressure it actually sees), not the whole stope vs the weakest leg
  autoDesign: boolean;  // the pipe designer offers a one-click safe design
}

export const DIFFICULTIES: Record<DifficultyId, Difficulty> = {
  easy: {
    id: "easy", label: "Easy", tag: "Kid-friendly",
    blurb: "Lots of money, cheaper buildings, and a safety crew that helps you. Great for learning and for kids.",
    startCash: 1.3, build: 0.7, explore: 0.5, permit: 0.4,
    revenue: 1.6, opex: 0.6, dewater: 0.35, binderCost: 0.6, binderDelivery: 1.5,
    fines: 0.25, penalties: 0.3, barricadeCap: 1.6, pressureTol: 1.25, ucsTarget: 0.75, cure: 0.7, pasteFeed: 1.35, scatter: 0.5, startBinder: 260, remoteHandicap: 0.5,
    scheduleSlack: 6, horizonAdd: 6,
    rescues: 99, rescueAmount: 30_000_000, rescueIsLoan: false, autoSafety: true, // Easy: the board never lets you go broke
    legAware: true, autoDesign: true,
  },
  normal: {
    id: "normal", label: "Normal", tag: "Balanced",
    blurb: "A fair challenge. Mistakes cost money, but the board will lend you cash once or twice.",
    startCash: 1.12, build: 0.88, explore: 0.8, permit: 0.75,
    revenue: 1.25, opex: 0.85, dewater: 0.7, binderCost: 0.85, binderDelivery: 1.2,
    fines: 0.7, penalties: 0.7, barricadeCap: 1.2, pressureTol: 1.1, ucsTarget: 0.92, cure: 0.8, pasteFeed: 1.25, scatter: 0.8, startBinder: 230, remoteHandicap: 0.75,
    scheduleSlack: 3, horizonAdd: 2,
    rescues: 2, rescueAmount: 20_000_000, rescueIsLoan: true, autoSafety: false,
    legAware: true, autoDesign: true,
  },
  hard: {
    id: "hard", label: "Hard", tag: "Authentic",
    blurb: "The real-world numbers. Tight budgets, no safety net. For backfill engineers.",
    startCash: 1, build: 1, explore: 1, permit: 1,
    revenue: 1, opex: 1, dewater: 1, binderCost: 1, binderDelivery: 1,
    fines: 1, penalties: 1, barricadeCap: 1, pressureTol: 1, ucsTarget: 1, cure: 1, pasteFeed: 1, scatter: 1, startBinder: 200, remoteHandicap: 1,
    scheduleSlack: 0, horizonAdd: 0,
    rescues: 0, rescueAmount: 0, rescueIsLoan: false, autoSafety: false,
    legAware: false, autoDesign: false,
  },
};

export const DIFFICULTY_ORDER: DifficultyId[] = ["easy", "normal", "hard"];
export const DEFAULT_DIFFICULTY: DifficultyId = "easy";
const KEY = "bt_difficulty";

export const isDifficultyId = (x: unknown): x is DifficultyId => x === "easy" || x === "normal" || x === "hard";
export const difficultyOf = (id: unknown): Difficulty => DIFFICULTIES[isDifficultyId(id) ? id : DEFAULT_DIFFICULTY];

export function loadDifficulty(): DifficultyId {
  try { const v = localStorage.getItem(KEY); return isDifficultyId(v) ? v : DEFAULT_DIFFICULTY; } catch { return DEFAULT_DIFFICULTY; }
}
export function saveDifficulty(id: DifficultyId) { try { localStorage.setItem(KEY, id); } catch { /* private mode */ } }

/** A copy of the scenario with the difficulty's budget, schedule, horizon, strength and pumping applied. */
export function applyDifficulty(s: Scenario, d: Difficulty): Scenario {
  if (d.id === "hard") return s;
  return {
    ...s,
    startCash: Math.round(s.startCash * d.startCash),
    horizonDays: s.horizonDays + d.horizonAdd,
    schedule: s.schedule.map((x) => ({ a: x.a, d: x.d + d.scheduleSlack })),
    ucs: { base: Math.round(s.ucs.base * d.ucsTarget), perLevel: Math.round(s.ucs.perLevel * d.ucsTarget), primary: Math.round(s.ucs.primary * d.ucsTarget) },
    wet: s.wet ? { ...s.wet, dewaterPerDay: Math.round(s.wet.dewaterPerDay * d.dewater) } : undefined,
    // remote-mine binder squeeze: Easy halves the handicap, Normal trims a quarter of it
    binder: s.binder ? { ...s.binder, deliveryMult: 1 - (1 - s.binder.deliveryMult) * d.remoteHandicap, costMult: 1 + (s.binder.costMult - 1) * d.remoteHandicap } : undefined,
  };
}

// Capital-cost scaling: the catalogs are shared module objects read by the HUD palette,
// the plant interior and the reticulation designer, so scaling them in place keeps every
// displayed price and every charge consistent. Idempotent (always from the base price).
const baseCost = new Map<object, Record<string, number>>();
export function applyCostScale(k: number) {
  const scale = (o: object, key: string) => {
    const rec = o as Record<string, number>;
    let base = baseCost.get(o); if (!base) { base = {}; baseCost.set(o, base); }
    if (!(key in base)) base[key] = rec[key] ?? 0;
    rec[key] = Math.round(base[key] * k);
  };
  for (const b of BUILDINGS) { scale(b, "cost"); if (b.upgrade) scale(b.upgrade, "cost0"); }
  for (const e of Object.values(PLANT_EQUIP)) scale(e, "cost");
  for (const c of PIPE_CLASSES) scale(c, "costPerM");
}

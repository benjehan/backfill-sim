// The honest physics core (GDD 04 & 06). Simplified but not fake:
// one rheology curve per stream, real ρgh head, real friction band,
// real pipe ratings, real cure curve. All numbers in real units.

import {
  PASTE_SOLIDS_MIN,
  PASTE_SOLIDS_MAX,
  UCS_PLUG_MIN_KPA,
  BINDER_PRICE_PER_TONNE,
  WATER_COST_PER_M3,
  POWER_COST_PER_M3,
} from "./constants.js";
import type {
  TailingsStream,
  Recipe,
  RecipeEval,
  LineProfile,
  Stope,
} from "./types.js";

// Yield stress vs solids concentration — rises steeply near max solids (GDD 04).
export function yieldStressKpa(stream: TailingsStream, solids: number): number {
  return stream.tauA * Math.exp(stream.tauB * (solids - stream.refSolids));
}

// Friction gradient (kPa/m). Laminar paste: grows with yield stress and solids.
// Calibrated to sit in the 3–8 kPa/m band around design, climbing sharply when thick.
export function frictionKpaPerM(
  stream: TailingsStream,
  solids: number,
): number {
  const tau = yieldStressKpa(stream, solids);
  // Base friction scales with yield stress; small floor keeps a full line honest.
  return 2.0 + tau * 0.9;
}

// Predicted 28-day UCS (kPa). Grows with binder dose, penalised if too dilute
// (segregation/dilution) — the classic weak-fill failure (GDD 04/07).
export function ucs28Predicted(recipe: Recipe): number {
  const { solids, binderKgPerM3 } = recipe;
  // Binder contribution with mild diminishing returns. Calibrated so a ~700 kPa
  // target needs a meaningful dose (~180 kg/m³ at design solids): cutting binder
  // risks a 28-day failure — that IS the game (GDD 04, binder ~70% of opex).
  const binderTerm = 5.0 * Math.pow(binderKgPerM3, 0.95);
  // Solids/quality factor: full strength near the design band, dropping off if dilute.
  const solidsFactor = Math.max(
    0.35,
    Math.min(1.0, (solids - 0.66) / (0.76 - 0.66)),
  );
  return Math.max(0, binderTerm * solidsFactor);
}

// Cure curve: fraction of 28-day strength reached at a given age (GDD 03/07).
// Logarithmic development; ~65% at 7 days, 100% at 28 days.
export function cureFraction(ageDays: number): number {
  if (ageDays <= 0) return 0;
  const f = Math.log(1 + ageDays) / Math.log(1 + 28);
  return Math.min(1, f);
}

// Full recipe evaluation against a stope and its built UDS line (GDD 04/06/09).
export function evaluateRecipe(
  stream: TailingsStream,
  recipe: Recipe,
  line: LineProfile,
  stope: Stope,
): RecipeEval {
  const warnings: string[] = [];
  const { solids } = recipe;

  const yieldStress = yieldStressKpa(stream, solids);
  const friction = frictionKpaPerM(stream, solids);
  const staticHead = line.staticHeadMpa;
  const frictionLoss = line.frictionLossMpa;

  // Pressure profile comes from the built network (peak point vs weakest rating).
  const peakPressure = line.peakPressureMpa;
  const rating = line.ratingMpa || 1;
  const hglMargin = (rating - peakPressure) / rating;

  // Regime + feasibility (GDD 06): too thick => plug risk; too thin => slack/segregation.
  let regime: RecipeEval["regime"] = "laminar";
  if (solids > PASTE_SOLIDS_MAX || friction > 8.5) {
    regime = "plug-risk";
    warnings.push(
      `Mix is thick (${(solids * 100).toFixed(0)}% solids, ${friction.toFixed(1)} kPa/m) — plug risk climbing.`,
    );
  }
  if (solids < PASTE_SOLIDS_MIN || line.slack) {
    regime = "slack-risk";
    if (solids < PASTE_SOLIDS_MIN)
      warnings.push(`Mix is dilute (${(solids * 100).toFixed(0)}% solids) — segregation & slack-flow risk, UCS may miss.`);
    if (line.slack)
      warnings.push(`The line runs slack — free-fall and wear. Use bigger pipe or ease a choke.`);
  }

  if (line.ratingMpa === 0) {
    warnings.push(`No line to this stope yet — build the UDS reticulation.`);
  } else if (peakPressure > rating) {
    warnings.push(`Peak pressure ${peakPressure.toFixed(1)} MPa EXCEEDS line rating ${rating} MPa — it will burst.`);
  } else if (hglMargin < 0.15) {
    warnings.push(`HGL within ${(hglMargin * 100).toFixed(0)}% of rating — little margin for transients.`);
  }
  if (line.ratingMpa > 0 && !line.delivered) {
    warnings.push(`Line doesn't deliver to the stope — add head (booster) or reduce friction.`);
  }

  const ucs28 = ucs28Predicted(recipe);
  if (ucs28 < stope.targetUcsKpa) {
    warnings.push(
      `Predicted UCS ${ucs28.toFixed(0)} kPa is below target ${stope.targetUcsKpa} kPa — add binder or solids.`,
    );
  }
  if (ucs28 < UCS_PLUG_MIN_KPA) {
    warnings.push(
      `Predicted UCS below ${UCS_PLUG_MIN_KPA} kPa liquefaction guidance.`,
    );
  }

  // Economy (GDD 09): binder dominates opex.
  const binderTonnesPerM3 = recipe.binderKgPerM3 / 1000;
  const binderCostPerM3 = binderTonnesPerM3 * BINDER_PRICE_PER_TONNE;
  const otherOpexPerM3 = WATER_COST_PER_M3 + POWER_COST_PER_M3;
  const costPerM3 = binderCostPerM3 + otherOpexPerM3;
  const binderCostShare = binderCostPerM3 / costPerM3;

  const feasible = line.reticulated && ucs28 >= stope.targetUcsKpa;

  return {
    yieldStressKpa: yieldStress,
    frictionKpaPerM: friction,
    staticHeadMpa: staticHead,
    frictionLossMpa: frictionLoss,
    peakPressureMpa: peakPressure,
    ratingMpa: line.ratingMpa,
    hglMargin,
    regime,
    ucs28Predicted: ucs28,
    feasible,
    warnings,
    costPerM3,
    binderCostShare,
  };
}

// Auto-recipe helper (GDD 04): lowest-binder recipe that clears the target UCS
// with a 15% design margin at safe design solids. Manager mode uses this; the
// engineer trims closer to the edge to save binder, accepting the variance risk.
export function autoRecipe(stope: Stope): Recipe {
  const solids = 0.76; // solidsFactor = 1.0 at/above this
  const designUcs = stope.targetUcsKpa * 1.15;
  // Invert ucs28Predicted = 5.0 * binder^0.95 (solidsFactor 1.0).
  const binder = Math.ceil(Math.pow(designUcs / 5.0, 1 / 0.95) / 5) * 5;
  return { solids, binderKgPerM3: Math.max(60, Math.min(450, binder)) };
}

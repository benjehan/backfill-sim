// The honest physics core (GDD 04 & 06). Simplified but not fake:
// one rheology curve per stream, real ρgh head, real friction band,
// real pipe ratings, real cure curve. All numbers in real units.

import {
  G,
  PASTE_DENSITY,
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
  PipeSpec,
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

// Static head from the vertical drop: ρgh (GDD 06). Returns MPa.
export function staticHeadMpa(verticalDropM: number): number {
  return (PASTE_DENSITY * G * verticalDropM) / 1e6;
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

// Full recipe evaluation against a stope + chosen pipe (GDD 04/06/09).
export function evaluateRecipe(
  stream: TailingsStream,
  recipe: Recipe,
  pipe: PipeSpec,
  stope: Stope,
): RecipeEval {
  const warnings: string[] = [];
  const { solids } = recipe;

  const yieldStress = yieldStressKpa(stream, solids);
  const friction = frictionKpaPerM(stream, solids);
  const staticHead = staticHeadMpa(stope.verticalDropM);
  const frictionLoss = (friction * stope.runLengthM) / 1000; // kPa/m * m -> kPa -> MPa

  // Peak pressure the line sees ~ static head that must be dissipated by friction.
  // If friction can't consume the gravity head over the run, the excess shows up
  // as pressure at the base of the borehole (worst case near the pipe rating).
  const peakPressure = Math.max(staticHead, frictionLoss);
  const rating = pipe.ratingMpa;
  const hglMargin = (rating - peakPressure) / rating;

  // Regime + feasibility (GDD 06): too thick => plug risk; too thin => slack/segregation.
  let regime: RecipeEval["regime"] = "laminar";
  if (solids > PASTE_SOLIDS_MAX || friction > 8.5) {
    regime = "plug-risk";
    warnings.push(
      `Mix is thick (${(solids * 100).toFixed(0)}% solids, ${friction.toFixed(1)} kPa/m) — plug risk climbing.`,
    );
  }
  if (solids < PASTE_SOLIDS_MIN) {
    regime = "slack-risk";
    warnings.push(
      `Mix is dilute (${(solids * 100).toFixed(0)}% solids) — segregation & slack-flow risk, UCS may miss.`,
    );
  }

  if (peakPressure > rating) {
    warnings.push(
      `Peak pressure ${peakPressure.toFixed(1)} MPa EXCEEDS pipe rating ${rating} MPa — line will not hold.`,
    );
  } else if (hglMargin < 0.15) {
    warnings.push(
      `HGL within ${(hglMargin * 100).toFixed(0)}% of rating — little margin for transients.`,
    );
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

  const feasible = peakPressure <= rating && ucs28 >= stope.targetUcsKpa;

  return {
    yieldStressKpa: yieldStress,
    frictionKpaPerM: friction,
    staticHeadMpa: staticHead,
    frictionLossMpa: frictionLoss,
    peakPressureMpa: peakPressure,
    ratingMpa: rating,
    hglMargin,
    regime,
    ucs28Predicted: ucs28,
    feasible,
    warnings,
    costPerM3,
    binderCostShare,
  };
}

// Auto-recipe helper (GDD 04): lowest-binder recipe that hits target UCS + is feasible.
// Manager mode uses this; engineers can override.
export function autoRecipe(
  stream: TailingsStream,
  pipe: PipeSpec,
  stope: Stope,
): Recipe {
  // Design conservatism (GDD 04): the helper aims 15% above target so the mix
  // reliably passes at 28 days despite variance. Engineers can trim closer to
  // the edge manually to save binder — accepting the delayed-consequence risk.
  const designTarget = stope.targetUcsKpa * 1.15;
  let best: Recipe | null = null;
  for (let solids = 0.70; solids <= 0.79; solids += 0.005) {
    for (let binder = 60; binder <= 400; binder += 5) {
      const r: Recipe = {
        solids: +solids.toFixed(3),
        binderKgPerM3: binder,
      };
      const e = evaluateRecipe(stream, r, pipe, stope);
      if (e.peakPressureMpa <= e.ratingMpa && e.ucs28Predicted >= designTarget) {
        if (!best || r.binderKgPerM3 < best.binderKgPerM3) best = r;
        break; // lowest binder at this solids found
      }
    }
  }
  return best ?? { solids: 0.76, binderKgPerM3: 220 };
}

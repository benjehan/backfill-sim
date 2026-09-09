// Core domain types for the sim brain. UI-agnostic.

export type Mode = "manager" | "engineer";

export type Phase =
  | "briefing"    // mine manager hands you the stope
  | "design"      // recipe + pipe selection
  | "prepour"     // checklist + pour note approval
  | "pouring"     // the tense verb
  | "flushing"    // clean the line
  | "curing"      // UCS develops over days
  | "qaqc"        // 7/28-day results arrive
  | "reconcile"   // close-out + scorecard
  | "done";

// A tailings source with a real rheology basis (GDD 04).
export interface TailingsStream {
  name: string;
  // Rheology curve is parameterised: yield stress rises steeply near max solids.
  // tau_y(Cw) = tauA * exp(tauB * (Cw - refSolids)) in kPa
  refSolids: number;
  tauA: number;
  tauB: number;
  availabilityTph: number; // t/h from the mill
}

// A pipe run choice (GDD 06): diameter + rating class.
export interface PipeSpec {
  label: string;
  diameterMm: number;
  ratingMpa: number;
  costPerMetre: number;
}

// The recipe the player designs — THE tension (GDD 04).
export interface Recipe {
  solids: number;        // fraction by mass, e.g. 0.74
  binderKgPerM3: number; // binder dose
}

// Live evaluation of a recipe against physics + the line (GDD 04/06).
export interface RecipeEval {
  yieldStressKpa: number;
  frictionKpaPerM: number;
  staticHeadMpa: number;     // ρgh over the vertical drop
  frictionLossMpa: number;   // friction * horizontal+total length
  peakPressureMpa: number;   // worst-case pressure seen at pipe
  ratingMpa: number;
  hglMargin: number;         // (rating - peak) / rating; <0 = over rating
  regime: "laminar" | "plug-risk" | "slack-risk";
  ucs28Predicted: number;    // kPa, design expectation
  feasible: boolean;
  warnings: string[];
  costPerM3: number;
  binderCostShare: number;   // 0..1 fraction of opex that is binder
}

export interface Stope {
  id: string;
  name: string;
  level: number;         // m depth below plant
  volumeM3: number;
  targetUcsKpa: number;
  dueDay: number;        // day the fill is due
  verticalDropM: number; // borehole drop to the stope
  runLengthM: number;    // total pipe length plant->stope
}

// The pour note / fill note (GDD 07).
export interface PourNote {
  stopeId: string;
  recipe: Recipe;
  targetFlowM3h: number;
  plannedVolumeM3: number;
  issued: boolean;
  approved: boolean;
}

export interface ChecklistItem {
  key: string;
  label: string;
  checked: boolean;
  skipRisk: string; // what surfaces later if skipped
}

// QAQC cylinder result (GDD 07).
export interface UcsResult {
  ageDays: number;
  targetKpa: number;
  achievedKpa: number;
  pass: boolean;
}

export interface Kpis {
  volumePlacedM3: number;
  volumePlannedM3: number;
  binderTonnes: number;
  costTotal: number;
  costPerTonne: number;
  scheduleAdherence: boolean; // filled by due day
  ucsPassRate: number;        // 0..1
  reconciliationGapM3: number;
  safetyIncidents: number;
}

// The game brain: clock, phase machine, pour dynamics, curing, QAQC, reconciliation.
// Pure logic + a tiny observer. No DOM here.

import {
  SECONDS_PER_GAME_DAY,
  BINDER_PRICE_PER_TONNE,
  tonnesPlaced,
} from "./constants.js";
import type {
  Mode,
  Phase,
  Recipe,
  PipeSpec,
  Stope,
  PourNote,
  ChecklistItem,
  UcsResult,
  Kpis,
  RecipeEval,
  TailingsStream,
} from "./types.js";
import { evaluateRecipe, cureFraction, ucs28Predicted } from "./physics.js";
import {
  TUTORIAL_STREAM,
  TUTORIAL_STOPE,
  PIPE_OPTIONS,
  freshChecklist,
} from "./scenario.js";

export interface PourRuntime {
  active: boolean;
  subPhase: "water-test" | "line-fill" | "main" | "done";
  elapsedHours: number;
  placedM3: number;
  targetFlowM3h: number;
  currentFlowM3h: number;
  pressureMpa: number;
  plugDrift: number; // hidden accumulator; high => plug forming
  flushWaterM3: number;
  alarms: string[];
  broke: boolean;
  logged: boolean;
  lowSolidsStartDone: boolean;
}

export type Listener = () => void;

export class Game {
  mode: Mode = "manager";
  phase: Phase = "briefing";

  // Clock
  day = 1;
  dayFraction = 0; // 0..1 within a day
  speedIndex = 1; // index into SPEEDS
  paused = true;

  // World
  readonly stream: TailingsStream = TUTORIAL_STREAM;
  readonly stope: Stope = TUTORIAL_STOPE;
  readonly pipeOptions: PipeSpec[] = PIPE_OPTIONS;
  pipe: PipeSpec = PIPE_OPTIONS[1];

  // Design
  recipe: Recipe = { solids: 0.74, binderKgPerM3: 200 };

  // Pre-pour
  checklist: ChecklistItem[] = freshChecklist();
  pourNote: PourNote = {
    stopeId: TUTORIAL_STOPE.id,
    recipe: this.recipe,
    targetFlowM3h: 45,
    plannedVolumeM3: TUTORIAL_STOPE.volumeM3,
    issued: false,
    approved: false,
  };

  // Pour runtime
  pour: PourRuntime = this.freshPour();

  // Cure / QAQC
  cureStartDay = 0;
  ucsResults: UcsResult[] = [];
  actualUcs28: number | null = null; // materialised at pour end (with variance)

  // Close-out
  kpis: Kpis | null = null;
  managerVerdict = "";

  private listeners: Listener[] = [];

  subscribe(l: Listener) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  /** Force a UI refresh after an external mutation. */
  touch() {
    this.emit();
  }

  private freshPour(): PourRuntime {
    return {
      active: false,
      subPhase: "water-test",
      elapsedHours: 0,
      placedM3: 0,
      targetFlowM3h: 45,
      currentFlowM3h: 0,
      pressureMpa: 0,
      plugDrift: 0,
      flushWaterM3: 0,
      alarms: [],
      broke: false,
      logged: false,
      lowSolidsStartDone: false,
    };
  }

  get speed() {
    return [1, 2, 4, 8][this.speedIndex];
  }

  evalRecipe(): RecipeEval {
    return evaluateRecipe(this.stream, this.recipe, this.pipe, this.stope);
  }

  // ---- Phase transitions ----------------------------------------------------

  startDesign() {
    this.phase = "design";
    this.paused = true;
    this.emit();
  }

  proceedToPrepour() {
    this.pourNote.recipe = { ...this.recipe };
    this.phase = "prepour";
    this.checklist = freshChecklist();
    this.pourNote.issued = false;
    this.pourNote.approved = false;
    this.emit();
  }

  toggleChecklist(key: string) {
    const item = this.checklist.find((c) => c.key === key);
    if (item) item.checked = !item.checked;
    this.emit();
  }

  issuePourNote() {
    this.pourNote.issued = true;
    this.emit();
  }
  approvePourNote() {
    if (this.pourNote.issued) this.pourNote.approved = true;
    this.emit();
  }

  get checklistComplete() {
    return this.checklist.every((c) => c.checked);
  }
  get skippedItems() {
    return this.checklist.filter((c) => !c.checked);
  }

  beginPour() {
    // Can begin even with skipped items — but they bite (GDD 07).
    this.phase = "pouring";
    this.pour = this.freshPour();
    this.pour.active = true;
    this.pour.targetFlowM3h = this.pourNote.targetFlowM3h;
    // Skipping the low-solids start plan pre-loads plug risk.
    const skippedLowStart = this.checklist.find((c) => c.key === "lowstart" && !c.checked);
    if (skippedLowStart) this.pour.plugDrift += 0.25;
    const skippedInstr = this.checklist.find((c) => c.key === "instr" && !c.checked);
    if (skippedInstr) this.pour.alarms.push("No instrumentation — pressure readout unreliable.");
    this.paused = false;
    this.emit();
  }

  setPourFlow(v: number) {
    this.pour.targetFlowM3h = Math.max(0, Math.min(80, v));
    this.emit();
  }

  flushLine() {
    // Diverts to water, clears plug drift, costs flush water + time.
    if (!this.pour.active) return;
    this.pour.plugDrift = Math.max(0, this.pour.plugDrift - 0.7);
    this.pour.flushWaterM3 += 6;
    this.pour.elapsedHours += 0.4;
    this.pour.alarms.push(`Flush @ ${this.pour.elapsedHours.toFixed(1)} h — line cleared, drift eased.`);
    this.emit();
  }

  // ---- Tick -----------------------------------------------------------------

  tick(realDt: number) {
    if (this.paused) return;
    const dayDt = (realDt / SECONDS_PER_GAME_DAY) * this.speed;

    if (this.phase === "pouring") {
      this.tickPour(dayDt);
    } else if (this.phase === "curing") {
      this.advanceDays(dayDt);
      this.tickCure();
    } else {
      this.advanceDays(dayDt);
    }
    this.emit();
  }

  private advanceDays(dayDt: number) {
    this.dayFraction += dayDt;
    while (this.dayFraction >= 1) {
      this.dayFraction -= 1;
      this.day += 1;
    }
  }

  private tickPour(dayDt: number) {
    const p = this.pour;
    const hoursDt = dayDt * 24;
    p.elapsedHours += hoursDt;
    this.advanceDays(dayDt);

    const ev = this.evalRecipe();

    // Sub-phase progression: water test -> low-solids line fill -> main recipe.
    if (p.subPhase === "water-test" && p.elapsedHours > 0.3) {
      p.subPhase = "line-fill";
    }
    if (p.subPhase === "line-fill" && p.elapsedHours > 0.9) {
      p.subPhase = "main";
      p.lowSolidsStartDone = true;
    }

    // Flow ramps toward target; water-test placed nothing, line-fill places a little.
    const flowTarget =
      p.subPhase === "water-test" ? 0 :
      p.subPhase === "line-fill" ? p.targetFlowM3h * 0.5 :
      p.targetFlowM3h;
    p.currentFlowM3h += (flowTarget - p.currentFlowM3h) * Math.min(1, hoursDt * 3);

    // Volume placed (line-fill counts, water-test does not).
    if (p.subPhase !== "water-test") {
      p.placedM3 += p.currentFlowM3h * hoursDt;
    }

    // Pressure model: friction loss scales with (flow/design)^1.8, plus plug drift.
    const designFlow = 45;
    const flowRatio = p.currentFlowM3h / designFlow;
    const base = ev.frictionLossMpa * Math.pow(Math.max(0.15, flowRatio), 1.8);
    const staticContribution = ev.staticHeadMpa * 0.12; // residual at pipe base
    const noise = (pseudoNoise(p.elapsedHours) - 0.5) * 0.15;
    p.pressureMpa = Math.max(0, base + staticContribution + p.plugDrift * ev.ratingMpa + noise);

    // Plug drift dynamics: thick mix or over-fast flow builds drift; good ops eases it.
    if (p.subPhase === "main") {
      if (ev.regime === "plug-risk") p.plugDrift += hoursDt * 0.06;
      if (flowRatio > 1.25) p.plugDrift += hoursDt * 0.04; // pushing too hard
      if (flowRatio < 0.85 && ev.regime === "laminar")
        p.plugDrift = Math.max(0, p.plugDrift - hoursDt * 0.03); // steady & full eases it
    }

    // Alarms + failure.
    const margin = (ev.ratingMpa - p.pressureMpa) / ev.ratingMpa;
    if (margin < 0.12 && !p.broke) {
      const msg = `Pressure ${p.pressureMpa.toFixed(1)} MPa near rating ${ev.ratingMpa} MPa — plug forming, ease flow or flush.`;
      if (p.alarms[p.alarms.length - 1] !== msg) p.alarms.push(msg);
    }
    if (p.pressureMpa > ev.ratingMpa) {
      p.broke = true;
      p.active = false;
      this.paused = true;
      p.alarms.push("LINE BURST at pressure — pour aborted. Isolate, contain, post-mortem.");
      this.phase = "reconcile";
      this.finishPour(true);
      return;
    }

    // Completed?
    if (p.placedM3 >= this.pourNote.plannedVolumeM3) {
      p.placedM3 = this.pourNote.plannedVolumeM3;
      p.subPhase = "done";
      p.active = false;
      this.phase = "flushing";
      this.paused = true;
      this.emit();
    }
  }

  completeFlush() {
    this.pour.flushWaterM3 += 8;
    this.pour.logged = true;
    this.phase = "curing";
    this.cureStartDay = this.day;
    // Materialise the ACTUAL 28-day UCS with variance (delayed consequence, GDD 07).
    const predicted = ucs28Predicted(this.pourNote.recipe);
    // Penalties from execution quality.
    let penalty = 1.0;
    if (!this.pour.lowSolidsStartDone) penalty *= 0.9;
    if (this.pour.plugDrift > 0.4) penalty *= 0.9; // disturbed/cold joints
    const skippedMaterial = this.checklist.find((c) => c.key === "material" && !c.checked);
    if (skippedMaterial) penalty *= 0.88;
    const variance = 0.9 + pseudoNoise(this.pourNote.recipe.binderKgPerM3) * 0.2;
    this.actualUcs28 = predicted * penalty * variance;
    this.paused = false;
    this.emit();
  }

  private finishPour(broke: boolean) {
    // Called on burst: compute KPIs on partial placement.
    this.computeKpis(broke);
    this.managerVerdict = broke
      ? "That line burst on my watch. Contain it, write it up, and we do NOT repeat it."
      : "";
    this.emit();
  }

  private tickCure() {
    if (this.actualUcs28 == null) return;
    const age = this.day - this.cureStartDay + this.dayFraction;

    for (const testAge of [7, 28]) {
      if (age >= testAge && !this.ucsResults.some((r) => r.ageDays === testAge)) {
        const frac = cureFraction(testAge);
        const achieved = this.actualUcs28 * frac;
        // Target scales with age fraction too — you don't need full strength at 7 days.
        const targetAtAge =
          testAge === 28 ? this.stope.targetUcsKpa : this.stope.targetUcsKpa * 0.6;
        this.ucsResults.push({
          ageDays: testAge,
          targetKpa: Math.round(targetAtAge),
          achievedKpa: Math.round(achieved),
          pass: achieved >= targetAtAge,
        });
      }
    }

    if (this.ucsResults.some((r) => r.ageDays === 28)) {
      this.phase = "qaqc";
      this.paused = true;
      this.computeKpis(false);
      this.emit();
    }
  }

  // Fast-forward to the next cylinder test (7 then 28 days). In the full game the
  // player fills other stopes during cure; in this slice we let them jump ahead.
  skipToNextTest() {
    if (this.phase !== "curing") return;
    const age = this.day - this.cureStartDay + this.dayFraction;
    const next = age < 7 ? 7 : 28;
    this.day = this.cureStartDay + next;
    this.dayFraction = 0;
    this.tickCure();
    this.emit();
  }

  goToReconcile() {
    this.phase = "reconcile";
    this.computeKpis(false);
    this.managerVerdict = this.buildVerdict();
    this.emit();
  }

  private computeKpis(broke: boolean) {
    const placed = this.pour.placedM3;
    const planned = this.pourNote.plannedVolumeM3;
    const binderTonnes = (this.pourNote.recipe.binderKgPerM3 * placed) / 1000;
    const binderCost = binderTonnes * BINDER_PRICE_PER_TONNE;
    const otherOpex = placed * 2.0 + this.pour.flushWaterM3 * 0.8;
    const costTotal = binderCost + otherOpex;
    const placedTonnes = tonnesPlaced(placed);
    const ucs28 = this.ucsResults.find((r) => r.ageDays === 28);
    const passCount = this.ucsResults.filter((r) => r.pass).length;

    this.kpis = {
      volumePlacedM3: placed,
      volumePlannedM3: planned,
      binderTonnes,
      costTotal,
      costPerTonne: placedTonnes > 0 ? costTotal / placedTonnes : 0,
      scheduleAdherence: !broke && this.cureStartDay <= this.stope.dueDay,
      ucsPassRate:
        this.ucsResults.length > 0 ? passCount / this.ucsResults.length : 0,
      reconciliationGapM3: planned - placed,
      safetyIncidents: broke ? 1 : 0,
    };
  }

  private buildVerdict(): string {
    const k = this.kpis!;
    const ucs28 = this.ucsResults.find((r) => r.ageDays === 28);
    if (k.safetyIncidents > 0)
      return "A burst line is a bad day. No one hurt, but that's cost and a black mark. Learn from the post-mortem.";
    if (ucs28 && !ucs28.pass)
      return `Stope's filled but the 28-day cylinders came back at ${ucs28.achievedKpa} kPa against ${ucs28.targetKpa}. That's under strength — geotech won't sign the hand-back. We'll be talking about your recipe.`;
    if (k.costPerTonne > 22)
      return `Good fill, cylinders passed — but $${k.costPerTonne.toFixed(1)}/t is rich. That binder line is eating us. Trim it next time.`;
    return `Clean pour, cylinders passed at 28 days, and you kept the cost sensible. That's exactly the job. The cut above is yours to blast — well done.`;
  }

  restart() {
    Object.assign(this, new Game());
    this.emit();
  }
}

// Deterministic pseudo-noise so renders are stable per state (no Math.random needed).
function pseudoNoise(x: number): number {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

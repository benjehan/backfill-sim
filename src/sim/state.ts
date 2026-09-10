// The campaign brain (GDD 02/03/10): a living mine with a rolling stope schedule.
// One global clock never stops — you fill stopes while others cure in the
// background, due dates bite, the mine blasts and hoists around you, and earned
// events interrupt with real decisions. Pure logic + a tiny observer.

import { SECONDS_PER_GAME_DAY, BINDER_PRICE_PER_TONNE, tonnesPlaced } from "./constants.js";
import type {
  Mode, Recipe, PipeSpec, PourNote, ChecklistItem, UcsResult, RecipeEval, TailingsStream,
} from "./types.js";
import { evaluateRecipe, ucs28Predicted } from "./physics.js";
import {
  TUTORIAL_STREAM, PIPE_OPTIONS, freshChecklist,
  STOPE_SCHEDULE, BLAST_WINDOWS, CAMPAIGN, FLAVOUR, type ScheduledStope,
} from "./scenario.js";

export type StopeStatus =
  | "scheduled"    // being mined — not yet available
  | "available"    // mucked out, ready to fill
  | "filling"      // pour in progress (active focus)
  | "curing"       // cure clock ticking (background)
  | "handed-back"  // 28-day pass, returned to mining
  | "failed";      // 28-day strength failure

export interface StopeRun {
  spec: ScheduledStope;
  status: StopeStatus;
  recipe?: Recipe;
  pipe?: PipeSpec;
  cureStartDay?: number;
  actualUcs28?: number;
  ucsResults: UcsResult[];
  placedM3: number;
  binderTonnes: number;
  costTotal: number;
  handedBackDay?: number;
  barricadeRisk?: boolean;
  barricadeReinforced?: boolean;
  strengthPenaltyApplied?: boolean;
  broke?: boolean;
  lateFlagged?: boolean;
}

export interface LogEntry { day: number; text: string; kind: "mine" | "ops" | "warn" | "event" | "good"; }

export interface EventOption { label: string; detail: string; effect: (g: Game) => void; }
export interface GameEvent { id: string; title: string; body: string; lesson: string; options: EventOption[]; }

export type View = "board" | "pour";
export type PourPhase = "design" | "prepour" | "pouring" | "flushing" | null;

export interface PourRuntime {
  active: boolean;
  subPhase: "water-test" | "line-fill" | "main" | "done";
  elapsedHours: number;
  placedM3: number;
  targetFlowM3h: number;
  currentFlowM3h: number;
  pressureMpa: number;
  plugDrift: number;
  flushWaterM3: number;
  alarms: string[];
  broke: boolean;
  lowSolidsStartDone: boolean;
  startedUnderStrengthPenalty: boolean;
}

export type Listener = () => void;

export class Game {
  mode: Mode = "manager";

  // Clock
  day = 1;
  dayFraction = 0;
  speedIndex = 1;
  paused = true;

  // World
  readonly stream: TailingsStream = TUTORIAL_STREAM;
  readonly pipeOptions: PipeSpec[] = PIPE_OPTIONS;
  pipe: PipeSpec = PIPE_OPTIONS[1];
  stopes: StopeRun[] = STOPE_SCHEDULE.map((s) => ({
    spec: s,
    status: s.availableDay <= 1 ? "available" : "scheduled",
    ucsResults: [],
    placedM3: 0,
    binderTonnes: 0,
    costTotal: 0,
  }));

  // Focus
  view: View = "board";
  activeStopeId: string | null = null;
  pourPhase: PourPhase = null;

  // Active-pour design scratch
  recipe: Recipe = { solids: 0.74, binderKgPerM3: 200 };
  checklist: ChecklistItem[] = freshChecklist();
  pourNote: PourNote = { stopeId: "", recipe: this.recipe, targetFlowM3h: 45, plannedVolumeM3: 0, issued: false, approved: false };
  pour: PourRuntime = this.freshPour();

  // Campaign KPIs
  spend = 0;
  lateCost = 0;
  mood = CAMPAIGN.startMood;
  safetyIncidents = 0;

  // Events & mine life
  activeEvent: GameEvent | null = null;
  firedEvents = new Set<string>();
  log: LogEntry[] = [];
  private nextFlavourDay = 0.8;
  private telegraphed = new Set<string>();
  private blastsDone = new Set<number>();

  // Temporary condition flags
  strengthPenaltyUntilDay = 0;
  tailingsCapTph: number | null = null;
  tailingsCapUntilDay = 0;

  // Campaign end
  campaignOver = false;
  finalGrade = "";
  boardVerdict = "";

  private listeners: Listener[] = [];

  constructor() {
    this.pushLog("Welcome to Wheal Verity. Level 1 is mucked — Stope 150-1 is ready to fill.", "ops");
  }

  subscribe(l: Listener) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter((x) => x !== l); }; }
  private emit() { for (const l of this.listeners) l(); }
  touch() { this.emit(); }

  private freshPour(): PourRuntime {
    return {
      active: false, subPhase: "water-test", elapsedHours: 0, placedM3: 0,
      targetFlowM3h: 45, currentFlowM3h: 0, pressureMpa: 0, plugDrift: 0,
      flushWaterM3: 0, alarms: [], broke: false, lowSolidsStartDone: false,
      startedUnderStrengthPenalty: false,
    };
  }

  get speed() { return [1, 2, 4, 8][this.speedIndex]; }
  activeStope(): StopeRun | null { return this.stopes.find((s) => s.spec.id === this.activeStopeId) ?? null; }
  private pushLog(text: string, kind: LogEntry["kind"]) { this.log.push({ day: this.day, text, kind }); if (this.log.length > 60) this.log.shift(); }

  evalRecipe(st?: StopeRun): RecipeEval {
    const stope = st ?? this.activeStope();
    const spec = stope ? stope.spec : STOPE_SCHEDULE[0];
    return evaluateRecipe(this.stream, this.recipe, this.pipe, spec);
  }

  // ---- Board actions --------------------------------------------------------

  selectStope(id: string) {
    const st = this.stopes.find((s) => s.spec.id === id);
    if (!st || st.status !== "available") return;
    this.activeStopeId = id;
    this.view = "pour";
    this.pourPhase = "design";
    this.recipe = { solids: 0.74, binderKgPerM3: 200 };
    this.checklist = freshChecklist();
    this.pipe = this.pipeOptions[1];
    this.pourNote = { stopeId: id, recipe: this.recipe, targetFlowM3h: 45, plannedVolumeM3: st.spec.volumeM3, issued: false, approved: false };
    this.paused = true;
    // Geotech flag on the deeper secondary stope (earned event, GDD 08/10).
    if (id === "300-2" && !this.firedEvents.has("geotech-300-2")) {
      this.fireEvent(this.evGeotech(st));
      return;
    }
    this.emit();
  }

  backToBoard() {
    if (this.pourPhase === "pouring") return; // can't abandon mid-pour
    this.view = "board";
    this.pourPhase = null;
    this.activeStopeId = null;
    this.paused = true;
    this.emit();
  }

  // ---- Pour design flow -----------------------------------------------------

  proceedToPrepour() {
    this.pourNote.recipe = { ...this.recipe };
    this.pourPhase = "prepour";
    this.checklist = freshChecklist();
    this.pourNote.issued = false;
    this.pourNote.approved = false;
    this.emit();
  }
  backToDesign() { this.pourPhase = "design"; this.emit(); }
  toggleChecklist(key: string) { const i = this.checklist.find((c) => c.key === key); if (i) i.checked = !i.checked; this.emit(); }
  issuePourNote() { this.pourNote.issued = true; this.emit(); }
  approvePourNote() { if (this.pourNote.issued) this.pourNote.approved = true; this.emit(); }
  get checklistComplete() { return this.checklist.every((c) => c.checked); }

  beginPour() {
    const st = this.activeStope();
    if (!st) return;
    st.status = "filling";
    st.recipe = { ...this.recipe };
    st.pipe = this.pipe;
    this.pourPhase = "pouring";
    this.pour = this.freshPour();
    this.pour.active = true;
    this.pour.targetFlowM3h = this.pourNote.targetFlowM3h;
    this.pour.startedUnderStrengthPenalty = this.day < this.strengthPenaltyUntilDay;
    if (!this.checklist.find((c) => c.key === "lowstart")?.checked) this.pour.plugDrift += 0.25;
    if (!this.checklist.find((c) => c.key === "instr")?.checked) this.pour.alarms.push("No instrumentation — pressure readout unreliable.");
    this.pushLog(`Pour started on ${st.spec.name}.`, "ops");
    this.paused = false;
    this.emit();
  }

  setPourFlow(v: number) { this.pour.targetFlowM3h = Math.max(0, Math.min(80, v)); this.emit(); }

  flushLine() {
    if (!this.pour.active) return;
    this.pour.plugDrift = Math.max(0, this.pour.plugDrift - 0.7);
    this.pour.flushWaterM3 += 6;
    this.pour.elapsedHours += 0.4;
    this.pour.alarms.push(`Flush @ ${this.pour.elapsedHours.toFixed(1)} h — line cleared, drift eased.`);
    this.emit();
  }

  completeFlush() {
    const st = this.activeStope();
    if (!st) return;
    this.pour.flushWaterM3 += 8;
    st.placedM3 = this.pour.placedM3;

    // Materialise the ACTUAL 28-day UCS with execution penalties (GDD 07).
    const predicted = ucs28Predicted(st.recipe!);
    let penalty = 1.0;
    if (!this.pour.lowSolidsStartDone) penalty *= 0.9;
    if (this.pour.plugDrift > 0.4) penalty *= 0.9;
    if (!this.checklist.find((c) => c.key === "material")?.checked) penalty *= 0.88;
    if (this.pour.startedUnderStrengthPenalty) penalty *= 0.93;
    if (st.barricadeRisk && !st.barricadeReinforced) {
      penalty *= 0.9;
      if (pseudoNoise(st.spec.runLengthM) > 0.6) {
        this.safetyIncidents++; this.mood -= 10;
        this.pushLog(`Barricade seepage on ${st.spec.name} — minor spill, contained. Geotech was right.`, "warn");
      }
    }
    const variance = 0.92 + pseudoNoise(st.recipe!.binderKgPerM3 + st.spec.verticalDropM) * 0.16;
    st.actualUcs28 = predicted * penalty * variance;

    // Costs (GDD 09): binder dominates; a line-prep charge folds in pipe class.
    const binderTonnes = (st.recipe!.binderKgPerM3 * st.placedM3) / 1000;
    const binderCost = binderTonnes * BINDER_PRICE_PER_TONNE;
    const opex = st.placedM3 * 2.0 + this.pour.flushWaterM3 * 0.8;
    const linePrep = st.spec.runLengthM * 6 + (this.pipe.ratingMpa - 5) * 800;
    st.binderTonnes = binderTonnes;
    st.costTotal = binderCost + opex + linePrep;
    this.spend += st.costTotal;

    st.status = "curing";
    st.cureStartDay = this.day;
    this.pushLog(`${st.spec.name} filled (${st.placedM3.toFixed(0)} m³). Curing — cylinders due 7 & 28 days.`, "good");

    this.view = "board";
    this.pourPhase = null;
    this.activeStopeId = null;
    this.paused = false;
    this.emit();
  }

  // ---- Events ---------------------------------------------------------------

  private fireEvent(ev: GameEvent) {
    this.activeEvent = ev;
    this.firedEvents.add(ev.id);
    this.paused = true;
    this.pushLog(`EVENT: ${ev.title}`, "event");
    this.emit();
  }

  resolveEvent(i: number) {
    const ev = this.activeEvent;
    if (!ev) return;
    ev.options[i].effect(this);
    this.pushLog(`Lesson: ${ev.lesson}`, "ops");
    this.activeEvent = null;
    this.paused = false;
    this.emit();
  }

  private evBinderDelay(): GameEvent {
    return {
      id: "binder-delay",
      title: "Binder delivery delayed (rail)",
      body: "The rail cement shipment is held up — the silo will run dry in about two days. Binder is 70% of your cost and every pour needs it.",
      lesson: "Silo capacity vs delivery lead time is the eternal supply-chain squeeze. Size your buffer for the slip you can't control.",
      options: [
        { label: "Pay for a truck top-up (+$9,000)", detail: "Short lead, higher unit price — keeps pours running.", effect: (g) => { g.spend += 9000; g.pushLog("Truck cement top-up ordered — silo holds.", "ops"); } },
        { label: "Run leaner recipes for 6 days", detail: "Stretch the binder — but strength risk on those pours.", effect: (g) => { g.strengthPenaltyUntilDay = g.day + 6; g.pushLog("Recipes trimmed to stretch binder — watch the 28-day cylinders.", "warn"); } },
        { label: "Pause pours for 3 days", detail: "Wait for rail — schedule pressure builds.", effect: (g) => { g.day += 3; g.mood -= 4; g.pushLog("Pours held 3 days for cement — the schedule slips.", "warn"); g.tickCureAll(); } },
      ],
    };
  }

  private evMillShutdown(): GameEvent {
    return {
      id: "mill-shutdown",
      title: "Mill trip — tailings supply cut",
      body: "The mill has tripped. Tailings feed to the plant is throttled for the next few days, capping how fast you can pour.",
      lesson: "The plant only makes paste if tailings, binder, water and power line up. Surge capacity is your buffer against the mill's bad days.",
      options: [
        { label: "Run at reduced flow (4 days)", detail: "Pours proceed but capped at 45 m³/h — slower.", effect: (g) => { g.tailingsCapTph = 45; g.tailingsCapUntilDay = g.day + 4; g.pushLog("Running on reduced tailings — flow capped 45 m³/h.", "ops"); } },
        { label: "Draw down tailings buffer (+$7,000)", detail: "Buy stored tailings to keep full rate.", effect: (g) => { g.spend += 7000; g.pushLog("Tailings buffer drawn down — full flow maintained.", "ops"); } },
        { label: "Hold pours 2 days", detail: "Wait for the mill — schedule pressure.", effect: (g) => { g.day += 2; g.mood -= 3; g.pushLog("Pours held for the mill restart.", "warn"); g.tickCureAll(); } },
      ],
    };
  }

  private evSeismic(): GameEvent {
    return {
      id: `seismic-${this.day}`,
      title: "Seismic trigger during pour",
      body: "A blast on the level above has shaken the fresh fill mid-pour. Pressure just spiked on the line — decide now.",
      lesson: "A blast above sends a seismic pulse to fresh fill. Soft-start and steady flow survive it; a stiff, over-pressured line does not.",
      options: [
        { label: "Ease flow and ride it out", detail: "Reduce flow, let the pulse pass.", effect: (g) => { g.pour.targetFlowM3h *= 0.6; g.pour.plugDrift += 0.1; g.pushLog("Flow eased through the seismic pulse.", "ops"); } },
        { label: "Emergency flush", detail: "Clear the line now — costs water and time.", effect: (g) => { g.flushLine(); g.pushLog("Emergency flush through the seismic event.", "ops"); } },
        { label: "Stand down the pour", detail: "Stop safely — cold joint, re-pour needed.", effect: (g) => { g.standDownPour(); } },
      ],
    };
  }

  private evGeotech(st: StopeRun): GameEvent {
    return {
      id: "geotech-300-2",
      title: `Geotech flag on ${st.spec.name}`,
      body: "Ground control has flagged the barricade footing on this stope. They want it reinforced before you pour fresh paste against it.",
      lesson: "Ignore the geotech at your peril — their warnings are the early signal for an earned failure. A barricade breach is a runaway.",
      options: [
        { label: "Reinforce the barricade (+$6,000, +1 day)", detail: "Do it right — removes the failure risk.", effect: (g) => { st.barricadeReinforced = true; g.spend += 6000; g.day += 1; g.pushLog(`${st.spec.name} barricade reinforced and re-signed.`, "ops"); g.emit(); } },
        { label: "Proceed as designed", detail: "Save time and money — accept the risk.", effect: (g) => { st.barricadeRisk = true; g.pushLog(`${st.spec.name} barricade NOT reinforced — proceeding on risk.`, "warn"); g.emit(); } },
        { label: "Delay this stope 2 days", detail: "Wait for a fuller assessment.", effect: (g) => { g.day += 2; g.mood -= 2; g.pushLog(`${st.spec.name} held for geotech review.`, "warn"); g.tickCureAll(); g.emit(); } },
      ],
    };
  }

  standDownPour() {
    const st = this.activeStope();
    if (!st) return;
    st.status = "available";
    st.placedM3 = 0;
    this.pour.active = false;
    this.mood -= 3;
    this.pushLog(`Pour on ${st.spec.name} stood down — line safe, re-pour required.`, "warn");
    this.view = "board";
    this.pourPhase = null;
    this.activeStopeId = null;
    this.paused = true;
    this.emit();
  }

  // ---- Tick -----------------------------------------------------------------

  tick(realDt: number) {
    if (this.paused || this.activeEvent || this.campaignOver) return;
    const dayDt = (realDt / SECONDS_PER_GAME_DAY) * this.speed;

    if (this.pourPhase === "pouring") this.tickPour(dayDt);
    else this.advanceDays(dayDt);

    this.tickCureAll();
    this.tickSchedule();
    this.tickMineLife(dayDt);
    this.tickLatePenalties(dayDt);
    this.checkCampaignEnd();
    this.emit();
  }

  private advanceDays(dayDt: number) {
    this.dayFraction += dayDt;
    while (this.dayFraction >= 1) { this.dayFraction -= 1; this.day += 1; }
    if (this.day >= this.tailingsCapUntilDay) this.tailingsCapTph = null;
  }

  private tickPour(dayDt: number) {
    const p = this.pour;
    const st = this.activeStope();
    if (!st) return;
    const hoursDt = dayDt * 24;
    p.elapsedHours += hoursDt;
    this.advanceDays(dayDt);
    const ev = this.evalRecipe(st);

    if (p.subPhase === "water-test" && p.elapsedHours > 0.3) p.subPhase = "line-fill";
    if (p.subPhase === "line-fill" && p.elapsedHours > 0.9) { p.subPhase = "main"; p.lowSolidsStartDone = true; }

    let flowTarget = p.subPhase === "water-test" ? 0 : p.subPhase === "line-fill" ? p.targetFlowM3h * 0.5 : p.targetFlowM3h;
    if (this.tailingsCapTph != null) flowTarget = Math.min(flowTarget, this.tailingsCapTph);
    p.currentFlowM3h += (flowTarget - p.currentFlowM3h) * Math.min(1, hoursDt * 3);

    if (p.subPhase !== "water-test") p.placedM3 += p.currentFlowM3h * hoursDt;

    const designFlow = 45;
    const flowRatio = p.currentFlowM3h / designFlow;
    const base = ev.frictionLossMpa * Math.pow(Math.max(0.15, flowRatio), 1.8);
    const staticContribution = ev.staticHeadMpa * 0.12;
    const noise = (pseudoNoise(p.elapsedHours) - 0.5) * 0.15;
    p.pressureMpa = Math.max(0, base + staticContribution + p.plugDrift * ev.ratingMpa + noise);

    if (p.subPhase === "main") {
      if (ev.regime === "plug-risk") p.plugDrift += hoursDt * 0.06;
      if (flowRatio > 1.25) p.plugDrift += hoursDt * 0.04;
      if (flowRatio < 0.85 && ev.regime === "laminar") p.plugDrift = Math.max(0, p.plugDrift - hoursDt * 0.03);
    }

    const margin = (ev.ratingMpa - p.pressureMpa) / ev.ratingMpa;
    if (margin < 0.12 && !p.broke) {
      const msg = `Pressure ${p.pressureMpa.toFixed(1)} MPa near rating ${ev.ratingMpa} MPa — plug forming, ease flow or flush.`;
      if (p.alarms[p.alarms.length - 1] !== msg) p.alarms.push(msg);
    }
    if (p.pressureMpa > ev.ratingMpa) {
      p.broke = true; p.active = false;
      st.broke = true; st.status = "available"; st.placedM3 = 0;
      this.safetyIncidents++; this.mood -= 16;
      p.alarms.push("LINE BURST at pressure — pour aborted. Isolate, contain, post-mortem.");
      this.pushLog(`LINE BURST on ${st.spec.name} — no injuries, but a spill and lost time. Re-pour needed.`, "warn");
      this.view = "board"; this.pourPhase = null; this.activeStopeId = null; this.paused = true;
      return;
    }

    if (p.placedM3 >= st.spec.volumeM3) {
      p.placedM3 = st.spec.volumeM3; p.subPhase = "done"; p.active = false;
      this.pourPhase = "flushing"; this.paused = true;
    }
  }

  private tickCureAll() {
    for (const st of this.stopes) {
      if (st.status !== "curing" || st.actualUcs28 == null || st.cureStartDay == null) continue;
      const age = this.day - st.cureStartDay + this.dayFraction;
      for (const testAge of [7, 28]) {
        if (age >= testAge && !st.ucsResults.some((r) => r.ageDays === testAge)) {
          const frac = Math.min(1, Math.log(1 + testAge) / Math.log(1 + 28));
          const achieved = st.actualUcs28 * frac;
          const targetAtAge = testAge === 28 ? st.spec.targetUcsKpa : st.spec.targetUcsKpa * 0.6;
          const pass = achieved >= targetAtAge;
          st.ucsResults.push({ ageDays: testAge, targetKpa: Math.round(targetAtAge), achievedKpa: Math.round(achieved), pass });
          if (testAge === 7) this.pushLog(`${st.spec.name}: 7-day cylinder ${Math.round(achieved)} kPa (${pass ? "on track" : "LOW"}).`, pass ? "ops" : "warn");
          if (testAge === 28) {
            if (pass) {
              st.status = "handed-back"; st.handedBackDay = this.day; this.mood = Math.min(100, this.mood + 8);
              this.pushLog(`${st.spec.name}: 28-day PASS (${Math.round(achieved)}/${st.spec.targetUcsKpa} kPa). Handed back to mining. ✔`, "good");
            } else {
              st.status = "failed"; this.mood -= 12;
              this.pushLog(`${st.spec.name}: 28-day FAIL (${Math.round(achieved)}/${st.spec.targetUcsKpa} kPa). Geotech won't sign the hand-back.`, "warn");
            }
          }
        }
      }
    }
  }

  private tickSchedule() {
    for (const st of this.stopes) {
      if (st.status === "scheduled" && this.day >= st.spec.availableDay) {
        st.status = "available";
        this.pushLog(`${st.spec.name} mucked out and ready to fill (due day ${st.spec.dueDay}).`, "mine");
      }
    }
  }

  private tickMineLife(dayDt: number) {
    // Flavour ticker — the mine is alive around you (GDD 02).
    if (this.day + this.dayFraction >= this.nextFlavourDay) {
      const idx = Math.floor(pseudoNoise(this.nextFlavourDay) * FLAVOUR.length) % FLAVOUR.length;
      this.pushLog(FLAVOUR[idx], "mine");
      this.nextFlavourDay = this.day + this.dayFraction + 0.7 + pseudoNoise(this.day) * 0.6;
    }

    // Blast windows: telegraph, then fire; a blast above an active pour = seismic.
    for (const b of BLAST_WINDOWS) {
      const tkey = `tel-${b.day}`;
      if (this.day >= b.telegraphDay && !this.telegraphed.has(tkey)) {
        this.telegraphed.add(tkey);
        this.pushLog(`Mine plan: production blast scheduled on Level ${b.level} around day ${b.day}.`, "warn");
      }
      if (this.day >= b.day && !this.blastsDone.has(b.day)) {
        this.blastsDone.add(b.day);
        this.pushLog(`Production blast fired on Level ${b.level}.`, "mine");
        const active = this.activeStope();
        if (this.pourPhase === "pouring" && active && active.spec.level > b.level && !this.firedEvents.has(`seismic-${this.day}`)) {
          this.fireEvent(this.evSeismic());
        }
      }
    }

    // Earned commercial/operations events, telegraphed and one-shot.
    if (this.day >= 8 && !this.telegraphed.has("tel-binder")) { this.telegraphed.add("tel-binder"); this.pushLog("Supplier notice: rail cement shipment reported running late.", "warn"); }
    if (this.day >= 11 && !this.firedEvents.has("binder-delay") && this.pourPhase !== "pouring") this.fireEvent(this.evBinderDelay());
    if (this.day >= 19 && !this.firedEvents.has("mill-shutdown") && this.pourPhase !== "pouring") this.fireEvent(this.evMillShutdown());
  }

  private tickLatePenalties(dayDt: number) {
    for (const st of this.stopes) {
      if (st.status === "available" && this.day > st.spec.dueDay) {
        const pen = CAMPAIGN.lateCostPerDay * dayDt;
        this.spend += pen; this.lateCost += pen;
        this.mood -= dayDt * 1.5;
        if (!st.lateFlagged) { st.lateFlagged = true; this.pushLog(`${st.spec.name} is PAST its fill date — mining is stalled above it ($${CAMPAIGN.lateCostPerDay}/day).`, "warn"); }
      }
    }
    this.mood = Math.max(0, Math.min(100, this.mood));
  }

  private checkCampaignEnd() {
    const allResolved = this.stopes.every((s) => s.status === "handed-back" || s.status === "failed");
    if (this.day >= CAMPAIGN.horizonDay || allResolved) this.endCampaign();
  }

  skipDays(n: number) {
    // Fast-forward while idle at the board (cures/schedule/events still resolve).
    if (this.view !== "board" || this.activeEvent) return;
    this.paused = false;
    const target = this.day + n;
    let guard = 0;
    while (this.day < target && !this.activeEvent && !this.campaignOver && guard++ < 5000) {
      this.tick(SECONDS_PER_GAME_DAY / this.speed); // one game-day-equivalent chunk
    }
    this.paused = true;
    this.emit();
  }

  private endCampaign() {
    if (this.campaignOver) return;
    this.campaignOver = true;
    this.paused = true;

    const filled = this.stopes.filter((s) => s.status === "handed-back" || s.status === "failed" || s.cureStartDay != null);
    const onTime = this.stopes.filter((s) => s.cureStartDay != null && s.cureStartDay <= s.spec.dueDay).length;
    const passed = this.stopes.filter((s) => s.status === "handed-back").length;
    const scheduled = this.stopes.length;
    const placedTonnes = this.stopes.reduce((a, s) => a + tonnesPlaced(s.placedM3), 0);
    const costPerTonne = placedTonnes > 0 ? this.spend / placedTonnes : 0;
    const adherence = scheduled > 0 ? onTime / scheduled : 0;
    const passRate = filled.length > 0 ? passed / filled.length : 0;

    let score = 0;
    score += passRate >= 0.99 ? 3 : passRate >= 0.75 ? 2 : passRate >= 0.5 ? 1 : 0;
    score += adherence >= 0.99 ? 2 : adherence >= 0.75 ? 1 : 0;
    score += this.spend <= CAMPAIGN.budget ? 2 : this.spend <= CAMPAIGN.budget * 1.1 ? 1 : 0;
    score += this.safetyIncidents === 0 ? 2 : 0;
    score += this.mood >= 60 ? 1 : 0;
    let grade = score >= 9 ? "S" : score >= 7 ? "A" : score >= 5 ? "B" : score >= 3 ? "C" : "D";
    if (this.safetyIncidents > 0 && (grade === "S" || grade === "A")) grade = "B";

    this.finalGrade = grade;
    this.boardVerdict = this.buildBoardVerdict(passed, scheduled, onTime, costPerTonne);
    this.pushLog(`Board review: campaign grade ${grade}.`, grade === "S" || grade === "A" ? "good" : "event");
    this.emit();
  }

  private buildBoardVerdict(passed: number, scheduled: number, onTime: number, cpt: number): string {
    const over = this.spend - CAMPAIGN.budget;
    const overK = Math.round(over / 1000);
    if (this.safetyIncidents > 0)
      return `${passed}/${scheduled} stopes handed back, but ${this.safetyIncidents} safety incident(s) on your record. The board notes the fill rate; the incidents cap the review. Fix the discipline and this is an A operation.`;
    if (passed === scheduled && onTime === scheduled && this.spend <= CAMPAIGN.budget)
      return `Every stope filled, on time, cylinders passing, AND you brought it in under budget. That is a textbook backfill operation — the mine never waited on you once, and the binder line stayed lean. Outstanding.`;
    if (passed === scheduled && onTime === scheduled)
      return `Flawless on the ground — every stope filled, on time, all cylinders passing. The one smudge is the binder bill: $${overK}k over budget at $${cpt.toFixed(1)}/t. Trim the mix closer to target and this is a perfect run.`;
    if (passed >= scheduled - 1)
      return `${passed}/${scheduled} stopes handed back at $${cpt.toFixed(1)}/t. Solid, dependable backfill — a slip or two on the schedule, but the mine kept advancing. Tighten the binder and the dates and you're at the top.`;
    return `${passed}/${scheduled} stopes handed back. The mine felt the gaps — late fills stalled cuts and a few cylinders missed strength. The fundamentals are there; now make it reliable.`;
  }

  campaignStats() {
    const placedTonnes = this.stopes.reduce((a, s) => a + tonnesPlaced(s.placedM3), 0);
    return {
      passed: this.stopes.filter((s) => s.status === "handed-back").length,
      failed: this.stopes.filter((s) => s.status === "failed").length,
      scheduled: this.stopes.length,
      onTime: this.stopes.filter((s) => s.cureStartDay != null && s.cureStartDay <= s.spec.dueDay).length,
      spend: this.spend,
      budget: CAMPAIGN.budget,
      lateCost: this.lateCost,
      costPerTonne: placedTonnes > 0 ? this.spend / placedTonnes : 0,
      mood: this.mood,
      safetyIncidents: this.safetyIncidents,
    };
  }

  restart() { Object.assign(this, new Game()); this.emit(); }
}

// Deterministic pseudo-noise so renders/results are stable per state.
function pseudoNoise(x: number): number {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Scenario 1 — Tutorial / Starter mine (GDD 02): shallow, gravity flow, paste path.
// One stope, learn the full loop: schedule -> recipe -> pour -> cure -> QAQC -> reconcile.

import type {
  TailingsStream, Stope, ChecklistItem, PipeClass, UdsNodeSpec, UdsSegmentSpec,
} from "./types.js";

export const TUTORIAL_STREAM: TailingsStream = {
  name: "Mill whole tailings (No.1 stream)",
  refSolids: 0.74,
  tauA: 0.35, // kPa at reference solids
  tauB: 55, // steep rise near max solids
  availabilityTph: 90,
};

// Pipe classes for the UDS routing puzzle (GDD 06). Rating governs burst;
// diameter governs friction (bigger = less head loss, but pricier).
export const PIPE_CLASSES: PipeClass[] = [
  { label: "DN150 · 50 bar", diameterMm: 150, ratingMpa: 5, costPerMetre: 60, frictionMult: 1.0 },
  { label: "DN150 · 100 bar", diameterMm: 150, ratingMpa: 10, costPerMetre: 95, frictionMult: 1.0 },
  { label: "DN200 · 100 bar", diameterMm: 200, ratingMpa: 10, costPerMetre: 120, frictionMult: 0.6 },
  { label: "DN200 · 150 bar", diameterMm: 200, ratingMpa: 15, costPerMetre: 170, frictionMult: 0.6 },
];

// ---- UDS network topology (GDD 06): a shared borehole trunk + level runs -----
// Shaft nodes sit on the vertical trunk; stopes hang off their level collar.
export const UDS_NODES: UdsNodeSpec[] = [
  { id: "plant", label: "PLANT", depthM: 0, xM: 0, kind: "plant", canStation: false },
  { id: "c150", label: "L1 collar", depthM: 150, xM: 0, kind: "collar", canStation: true },
  { id: "c300", label: "L2 collar", depthM: 300, xM: 0, kind: "collar", canStation: true },
  { id: "c450", label: "L3 collar", depthM: 450, xM: 0, kind: "collar", canStation: true },
  { id: "s150-1", label: "150-1", depthM: 150, xM: 170, kind: "stope", stopeId: "150-1", canStation: false },
  { id: "s150-2", label: "150-2", depthM: 150, xM: 210, kind: "stope", stopeId: "150-2", canStation: false },
  { id: "s300-1", label: "300-1", depthM: 300, xM: 200, kind: "stope", stopeId: "300-1", canStation: false },
  { id: "s300-2", label: "300-2", depthM: 300, xM: 240, kind: "stope", stopeId: "300-2", canStation: false },
  { id: "s450-1", label: "450-1", depthM: 450, xM: 250, kind: "stope", stopeId: "450-1", canStation: false },
  { id: "s450-2", label: "450-2", depthM: 450, xM: 270, kind: "stope", stopeId: "450-2", canStation: false },
];

export const UDS_SEGMENTS: UdsSegmentSpec[] = [
  { id: "bh150", from: "plant", to: "c150", kind: "borehole", lengthM: 150, depthChangeM: 150 },
  { id: "bh300", from: "c150", to: "c300", kind: "borehole", lengthM: 150, depthChangeM: 150 },
  { id: "bh450", from: "c300", to: "c450", kind: "borehole", lengthM: 150, depthChangeM: 150 },
  { id: "l150a", from: "c150", to: "s150-1", kind: "level", lengthM: 170, depthChangeM: 0 },
  { id: "l150b", from: "c150", to: "s150-2", kind: "level", lengthM: 210, depthChangeM: 0 },
  { id: "l300a", from: "c300", to: "s300-1", kind: "level", lengthM: 200, depthChangeM: 0 },
  { id: "l300b", from: "c300", to: "s300-2", kind: "level", lengthM: 240, depthChangeM: 0 },
  { id: "l450a", from: "c450", to: "s450-1", kind: "level", lengthM: 250, depthChangeM: 0 },
  { id: "l450b", from: "c450", to: "s450-2", kind: "level", lengthM: 270, depthChangeM: 0 },
];

// Ordered segment ids from the plant to each stope.
const PATHS: Record<string, string[]> = {
  "150-1": ["bh150", "l150a"],
  "150-2": ["bh150", "l150b"],
  "300-1": ["bh150", "bh300", "l300a"],
  "300-2": ["bh150", "bh300", "l300b"],
  "450-1": ["bh150", "bh300", "bh450", "l450a"],
  "450-2": ["bh150", "bh300", "bh450", "l450b"],
};
export function pathSegmentsFor(stopeId: string): string[] { return PATHS[stopeId] ?? []; }
export function segmentById(id: string): UdsSegmentSpec { return UDS_SEGMENTS.find((s) => s.id === id)!; }
export function nodeById(id: string): UdsNodeSpec { return UDS_NODES.find((n) => n.id === id)!; }

export const TUTORIAL_STOPE: Stope = {
  id: "150-1",
  name: "Stope 150-1 (Level 1)",
  level: 150,
  volumeM3: 620,
  targetUcsKpa: 700,
  dueDay: 9,
  verticalDropM: 150,
  runLengthM: 320, // 150 m borehole + ~170 m on-level run to the stope
};

// ---- Campaign: the rolling stope schedule (GDD 02) ------------------------
// Voids become available (mucked) on a staggered plan; each has a strength
// demand that rises with depth, and a fill-by date. This is the mission board.
// Deeper stopes carry more static head (ρgh) so they force higher-rated pipe —
// escalating difficulty as the mine deepens (GDD 10).

export interface ScheduledStope extends Stope {
  availableDay: number; // day the void is mucked out and ready to fill
}

export const STOPE_SCHEDULE: ScheduledStope[] = [
  { id: "150-1", name: "Stope 150-1", level: 150, volumeM3: 620, targetUcsKpa: 700, verticalDropM: 150, runLengthM: 320, availableDay: 1, dueDay: 12 },
  { id: "150-2", name: "Stope 150-2", level: 150, volumeM3: 540, targetUcsKpa: 700, verticalDropM: 150, runLengthM: 360, availableDay: 8, dueDay: 22 },
  { id: "300-1", name: "Stope 300-1", level: 300, volumeM3: 700, targetUcsKpa: 900, verticalDropM: 300, runLengthM: 500, availableDay: 20, dueDay: 34 },
  { id: "300-2", name: "Stope 300-2", level: 300, volumeM3: 680, targetUcsKpa: 900, verticalDropM: 300, runLengthM: 540, availableDay: 30, dueDay: 44 },
  { id: "450-1", name: "Stope 450-1", level: 450, volumeM3: 800, targetUcsKpa: 1100, verticalDropM: 450, runLengthM: 700, availableDay: 42, dueDay: 58 },
  { id: "450-2", name: "Stope 450-2", level: 450, volumeM3: 760, targetUcsKpa: 1100, verticalDropM: 450, runLengthM: 720, availableDay: 52, dueDay: 70 },
];

// Blast windows on the mine side (GDD 02): a blast on the level ABOVE an active
// pour sends a seismic trigger to the fresh fill. Telegraphed a few days ahead.
export interface BlastWindow {
  day: number;      // the blast fires on this day
  level: number;    // the level being blasted
  telegraphDay: number;
}

export const BLAST_WINDOWS: BlastWindow[] = [
  { day: 24, level: 150, telegraphDay: 21 }, // above the 300 level pours
  { day: 47, level: 300, telegraphDay: 44 }, // above the 450 level pours
];

export const CAMPAIGN = {
  horizonDay: 90,        // board review at day 90 (GDD 03: 90-day visible plan)
  budget: 340_000,       // cost-centre budget to defend: binder opex + UDS capex (GDD 09)
  startMood: 70,         // mine manager mood 0..100
  lateCostPerDay: 1_800, // stalled mining cost per late stope per day
};

export const FLAVOUR: string[] = [
  "Hoist cycling ore to surface on the main shaft.",
  "Development crew advancing the Level 3 access drive.",
  "Loader mucking the 300 level draw points.",
  "Ventilation fans stepped up for the deep levels.",
  "Survey pickup on the 150 level complete.",
  "Diamond drill rig turning on a grade-control hole.",
  "Shotcrete crew rehabbing a Level 2 intersection.",
  "Mill running steady — tailings stream nominal.",
];

export function freshChecklist(): ChecklistItem[] {
  return [
    {
      key: "line",
      label: "Line connections confirmed (plant → borehole → drop line)",
      checked: false,
      skipRisk: "Loose connection — pressure loss and spill risk mid-pour.",
    },
    {
      key: "barricade",
      label: "Fill fence / barricade installed, cured & signed off (geotech)",
      checked: false,
      skipRisk: "Barricade failure — paste runaway, safety incident, re-pour.",
    },
    {
      key: "material",
      label: "Material availability confirmed (tailings, binder silo level, water)",
      checked: false,
      skipRisk: "Run dry mid-pour — line sets up, cold joint, plug.",
    },
    {
      key: "instr",
      label: "Instrumentation & comms checked (pressure, flow, radio)",
      checked: false,
      skipRisk: "Fly blind — a forming plug won't be seen until it sets.",
    },
    {
      key: "lowstart",
      label: "Start-up plan: water test → low-solids line fill → main recipe",
      checked: false,
      skipRisk: "Skipping the low-solids start spikes plug risk at the head of the pour.",
    },
  ];
}

export const TUTORIAL_BRIEFING = {
  from: "Dai Morgan — Mine Manager",
  title: "Welcome to Wheal Verity. First fill.",
  body:
    "Backfill's yours now. Level 1 is mucked out and the geotech wants Stope 150-1 filled before " +
    "we blast the cut above. Target 700 kPa, gravity paste — it's only 150 m down, so no boosters, " +
    "just get the recipe right and keep the line full. Due day 9. Miss it and the whole level waits on you. " +
    "Design your mix, run the pour, and let's see cylinders that pass at 28 days. Good luck.",
};

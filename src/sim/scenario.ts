// Scenario 1 — Tutorial / Starter mine (GDD 02): shallow, gravity flow, paste path.
// One stope, learn the full loop: schedule -> recipe -> pour -> cure -> QAQC -> reconcile.

import type { TailingsStream, PipeSpec, Stope, ChecklistItem } from "./types.js";

export const TUTORIAL_STREAM: TailingsStream = {
  name: "Mill whole tailings (No.1 stream)",
  refSolids: 0.74,
  tauA: 0.35, // kPa at reference solids
  tauB: 55, // steep rise near max solids
  availabilityTph: 90,
};

export const PIPE_OPTIONS: PipeSpec[] = [
  { label: "DN150 · 50 bar", diameterMm: 150, ratingMpa: 5, costPerMetre: 120 },
  { label: "DN150 · 100 bar", diameterMm: 150, ratingMpa: 10, costPerMetre: 190 },
  { label: "DN200 · 100 bar", diameterMm: 200, ratingMpa: 10, costPerMetre: 240 },
  { label: "DN200 · 150 bar", diameterMm: 200, ratingMpa: 15, costPerMetre: 330 },
];

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

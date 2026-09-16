// The buildable catalog: what the player can place, its cost, footprint, power
// role, and the mesh factory that builds it.
import { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import {
  createPlant, createPowerStation, createThickener, createSilos, createWorkshop, createDry, createCrusher,
  createMill, createRail, createWaterPump, createTSF, createSubstation, createHaulage, createIsotainer,
} from "./buildings.js";

export interface BuildingSpec {
  type: string;
  label: string;
  icon: string;
  cost: number;
  fw: number; fd: number;              // footprint (world units)
  markerY: number;                     // height for the power marker
  needsPower: boolean;
  powerRadius?: number;                // if set, this is a power source
  opexPerDay: number;                  // daily running cost once built
  supplies?: "tailings" | "binder" | "water"; // inbound supply this feeds the plant
  tsfCap?: number;                     // tailings storage capacity this adds (t)
  offPad?: boolean;                    // sited out on the terrain, away from the plant pad
  upgrade?: { stat: "mill" | "water" | "binder" | "power"; max: number; cost0: number; step: number }; // tiered upgrades
  binder?: { deliveryMult: number; costMult: number; siloCap: number; reliable: boolean }; // binder supply mode (rail/haulage/isotainer)
  spawnsTrucks?: number;
  spawnsWorkers?: number;
  make: (scene: Scene, onMesh?: (m: Mesh) => void) => TransformNode;
}

// Costs are real mining capital: a paste plant is ~$45m (course: ~$50m total),
// so the starting project budget is set in the tens of millions.
export const CATALOG: BuildingSpec[] = [
  { type: "power", label: "Power station", icon: "⚡", cost: 8_000_000, fw: 18, fd: 13, markerY: 18, needsPower: false, powerRadius: 95, opexPerDay: 50_000, upgrade: { stat: "power", max: 2, cost0: 4_000_000, step: 0.25 }, make: createPowerStation },
  { type: "substation", label: "Substation (power relay)", icon: "🔌", cost: 3_000_000, fw: 8, fd: 8, markerY: 12, needsPower: true, powerRadius: 78, opexPerDay: 8_000, offPad: true, make: createSubstation },
  { type: "plant", label: "Backfill plant", icon: "🏭", cost: 45_000_000, fw: 28, fd: 22, markerY: 21, needsPower: true, opexPerDay: 120_000, spawnsWorkers: 3, make: createPlant },
  { type: "crusher", label: "Crusher plant", icon: "⚒", cost: 12_000_000, fw: 16, fd: 12, markerY: 9, needsPower: true, opexPerDay: 35_000, make: createCrusher },
  { type: "workshop", label: "Truck workshop", icon: "🚚", cost: 6_500_000, fw: 18, fd: 14, markerY: 10, needsPower: true, opexPerDay: 30_000, spawnsTrucks: 3, spawnsWorkers: 2, make: createWorkshop },
  { type: "dry", label: "Miners' dry", icon: "👷", cost: 3_000_000, fw: 14, fd: 10, markerY: 8, needsPower: true, opexPerDay: 20_000, spawnsWorkers: 4, make: createDry },
  // inbound supply chain — sited OUT on the terrain (off the plant pad), the plant starves without these
  { type: "mill", label: "Mill (tailings)", icon: "⚙", cost: 20_000_000, fw: 20, fd: 14, markerY: 11, needsPower: true, opexPerDay: 60_000, supplies: "tailings", offPad: true, upgrade: { stat: "mill", max: 2, cost0: 9_000_000, step: 0.4 }, make: createMill },
  // binder supply — pick ONE mode (course: silo capacity vs delivery lead time is the eternal squeeze)
  { type: "rail", label: "Rail terminal (binder)", icon: "🚆", cost: 10_000_000, fw: 24, fd: 8, markerY: 14, needsPower: true, opexPerDay: 25_000, supplies: "binder", offPad: true, binder: { deliveryMult: 1.0, costMult: 1.0, siloCap: 4_000, reliable: false }, upgrade: { stat: "binder", max: 2, cost0: 5_000_000, step: 0.5 }, make: createRail },
  { type: "haulage", label: "Road haulage depot (binder)", icon: "🚛", cost: 3_500_000, fw: 16, fd: 10, markerY: 8, needsPower: true, opexPerDay: 18_000, supplies: "binder", offPad: true, binder: { deliveryMult: 0.6, costMult: 1.35, siloCap: 2_500, reliable: true }, make: createHaulage },
  { type: "isotainer", label: "Isotainer pad (binder)", icon: "📦", cost: 2_000_000, fw: 12, fd: 10, markerY: 6, needsPower: false, opexPerDay: 10_000, supplies: "binder", offPad: true, binder: { deliveryMult: 0.5, costMult: 1.6, siloCap: 2_000, reliable: true }, make: createIsotainer },
  { type: "waterpump", label: "Water pump", icon: "💧", cost: 6_000_000, fw: 11, fd: 11, markerY: 6, needsPower: true, opexPerDay: 15_000, supplies: "water", offPad: true, upgrade: { stat: "water", max: 2, cost0: 3_000_000, step: 0.5 }, make: createWaterPump },
  { type: "tsf", label: "Tailings dam (TSF)", icon: "⛰", cost: 15_000_000, fw: 42, fd: 42, markerY: 7, needsPower: false, opexPerDay: 22_000, tsfCap: 60_000, offPad: true, make: createTSF },
];

export const specOf = (type: string) => CATALOG.find((c) => c.type === type)!;

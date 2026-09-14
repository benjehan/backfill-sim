// The buildable catalog: what the player can place, its cost, footprint, power
// role, and the mesh factory that builds it.
import { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import {
  createPlant, createPowerStation, createThickener, createSilos, createWorkshop, createDry, createCrusher,
  createMill, createRail, createWaterPump, createTSF, createSubstation,
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
  spawnsTrucks?: number;
  spawnsWorkers?: number;
  make: (scene: Scene, onMesh?: (m: Mesh) => void) => TransformNode;
}

// Costs are real mining capital: a paste plant is ~$45m (course: ~$50m total),
// so the starting project budget is set in the tens of millions.
export const CATALOG: BuildingSpec[] = [
  { type: "power", label: "Power station", icon: "⚡", cost: 8_000_000, fw: 18, fd: 13, markerY: 18, needsPower: false, powerRadius: 95, opexPerDay: 50_000, make: createPowerStation },
  { type: "substation", label: "Substation (power relay)", icon: "🔌", cost: 3_000_000, fw: 8, fd: 8, markerY: 12, needsPower: true, powerRadius: 78, opexPerDay: 8_000, offPad: true, make: createSubstation },
  { type: "plant", label: "Backfill plant", icon: "🏭", cost: 45_000_000, fw: 28, fd: 22, markerY: 21, needsPower: true, opexPerDay: 120_000, spawnsWorkers: 3, make: createPlant },
  { type: "crusher", label: "Crusher plant", icon: "⚒", cost: 12_000_000, fw: 16, fd: 12, markerY: 9, needsPower: true, opexPerDay: 35_000, make: createCrusher },
  { type: "workshop", label: "Truck workshop", icon: "🚚", cost: 6_500_000, fw: 18, fd: 14, markerY: 10, needsPower: true, opexPerDay: 30_000, spawnsTrucks: 3, spawnsWorkers: 2, make: createWorkshop },
  { type: "dry", label: "Miners' dry", icon: "👷", cost: 3_000_000, fw: 14, fd: 10, markerY: 8, needsPower: true, opexPerDay: 20_000, spawnsWorkers: 4, make: createDry },
  // inbound supply chain — sited OUT on the terrain (off the plant pad), the plant starves without these
  { type: "mill", label: "Mill (tailings)", icon: "⚙", cost: 20_000_000, fw: 20, fd: 14, markerY: 11, needsPower: true, opexPerDay: 60_000, supplies: "tailings", offPad: true, make: createMill },
  { type: "rail", label: "Rail terminal (binder)", icon: "🚆", cost: 10_000_000, fw: 24, fd: 8, markerY: 14, needsPower: true, opexPerDay: 25_000, supplies: "binder", offPad: true, make: createRail },
  { type: "waterpump", label: "Water pump", icon: "💧", cost: 6_000_000, fw: 11, fd: 11, markerY: 6, needsPower: true, opexPerDay: 15_000, supplies: "water", offPad: true, make: createWaterPump },
  { type: "tsf", label: "Tailings dam (TSF)", icon: "⛰", cost: 15_000_000, fw: 42, fd: 42, markerY: 7, needsPower: false, opexPerDay: 22_000, tsfCap: 260_000, offPad: true, make: createTSF },
];

export const specOf = (type: string) => CATALOG.find((c) => c.type === type)!;

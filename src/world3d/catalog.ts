// The buildable catalog: what the player can place, its cost, footprint, power
// role, and the mesh factory that builds it.
import { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import {
  createPlant, createPowerStation, createThickener, createSilos, createWorkshop, createDry,
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
  spawnsTrucks?: number;
  spawnsWorkers?: number;
  make: (scene: Scene, onMesh?: (m: Mesh) => void) => TransformNode;
}

// Costs are real mining capital: a paste plant is ~$45m (course: ~$50m total),
// so the starting project budget is set in the tens of millions.
export const CATALOG: BuildingSpec[] = [
  { type: "power", label: "Power station", icon: "⚡", cost: 8_000_000, fw: 18, fd: 13, markerY: 18, needsPower: false, powerRadius: 95, opexPerDay: 50_000, make: createPowerStation },
  { type: "plant", label: "Backfill plant", icon: "🏭", cost: 45_000_000, fw: 28, fd: 22, markerY: 21, needsPower: true, opexPerDay: 120_000, spawnsWorkers: 3, make: createPlant },
  { type: "workshop", label: "Truck workshop", icon: "🚚", cost: 6_500_000, fw: 18, fd: 14, markerY: 10, needsPower: true, opexPerDay: 30_000, spawnsTrucks: 3, spawnsWorkers: 2, make: createWorkshop },
  { type: "dry", label: "Miners' dry", icon: "👷", cost: 3_000_000, fw: 14, fd: 10, markerY: 8, needsPower: true, opexPerDay: 20_000, spawnsWorkers: 4, make: createDry },
];

export const specOf = (type: string) => CATALOG.find((c) => c.type === type)!;

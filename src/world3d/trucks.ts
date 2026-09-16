// Haulage: low-poly dump trucks that run a real haul cycle between a source
// building and the mine portal — load, haul loaded, tip/dump, return empty.
// Loaded and empty trucks use opposite lanes of the road (so they never meet
// head-on) and slow down behind the truck ahead (simple anti-collision).
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { heightAt } from "./terrain.js";

type TruckState = "load" | "haul" | "dump" | "return";

interface Truck {
  root: TransformNode;
  bed: Mesh;
  payload: Mesh;
  a: Vector3; b: Vector3;    // source, portal
  t: number;                 // 0..1 along the leg
  state: TruckState;
  speed: number;             // units/sec
  wait: number;              // pause timer at the ends
  tip: number;               // 0..1 bed tilt during a dump
  lane: number;              // half-road offset magnitude
}

const LANE = 2.4;            // half the road width — loaded/empty lanes
const LOAD_TIME = 1.4;       // s spent loading at the source
const DUMP_TIME = 1.8;       // s spent tipping at the portal

function mat(scene: Scene, hex: string) {
  const m = new StandardMaterial("tm", scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black(); return m;
}

export class TruckFleet {
  private trucks: Truck[] = [];
  constructor(private scene: Scene, private onMesh?: (m: Mesh) => void, private parent?: TransformNode) {}

  add(count: number, from: Vector3, to: Vector3) {
    for (let i = 0; i < count; i++) {
      const root = new TransformNode("truck", this.scene);
      if (this.parent) root.parent = this.parent;
      const cab = MeshBuilder.CreateBox("cab", { width: 2.2, height: 1.8, depth: 2.2 }, this.scene);
      cab.material = mat(this.scene, "#e0a52e"); cab.position.set(0, 1.9, 1.6); cab.parent = root;
      const bed = MeshBuilder.CreateBox("bed", { width: 2.6, height: 1.6, depth: 4.2 }, this.scene);
      bed.material = mat(this.scene, "#4c5a66"); bed.position.set(0, 1.7, -1.2); bed.parent = root;
      // ore/aggregate heaped in the bed — shown only when the truck is loaded
      const payload = MeshBuilder.CreateBox("payload", { width: 2.3, height: 1.0, depth: 3.6 }, this.scene);
      payload.material = mat(this.scene, "#6b5a44"); payload.position.set(0, 2.6, -1.2); payload.parent = root;
      payload.setEnabled(false);
      const wheelMat = mat(this.scene, "#1c2229");
      for (const [wx, wz] of [[-1.3, 1.4], [1.3, 1.4], [-1.3, -1.8], [1.3, -1.8]] as const) {
        const w = MeshBuilder.CreateCylinder("tw", { diameter: 1.4, height: 0.5, tessellation: 10 }, this.scene);
        w.rotation.z = Math.PI / 2; w.material = wheelMat; w.position.set(wx, 0.7, wz); w.parent = root;
      }
      root.getChildMeshes().forEach((m) => this.onMesh?.(m as Mesh));
      // stagger the fleet around the cycle so they don't drive in lockstep
      const phase = i / Math.max(1, count);
      this.trucks.push({
        root, bed, payload, a: from.clone(), b: to.clone(),
        t: phase, state: phase < 0.5 ? "haul" : "return", speed: 7 + Math.random() * 3,
        wait: 0, tip: 0, lane: LANE,
      });
    }
  }

  clear() { for (const t of this.trucks) t.root.dispose(); this.trucks = []; }
  get count() { return this.trucks.length; }

  /** `busy` (a CAF/trucked pour is running) makes the fleet haul faster and skip idling. */
  update(dt: number, busy = false) {
    const boost = busy ? 1.5 : 1;
    for (const t of this.trucks) {
      const loaded = t.state === "haul" || t.state === "dump";
      if (t.state === "load" || t.state === "dump") {
        t.wait -= dt * boost;
        // tip the bed up and back down over a dump
        if (t.state === "dump") { const full = DUMP_TIME; t.tip = Math.sin(Math.max(0, Math.min(1, 1 - t.wait / full)) * Math.PI); }
        if (t.wait <= 0) {
          if (t.state === "load") { t.state = "haul"; t.payload.setEnabled(true); }
          else { t.state = "return"; t.payload.setEnabled(false); t.tip = 0; }
        }
      } else {
        // moving leg — haul (t: 0->1) or return (t: 1->0)
        const legLen = Vector3.Distance(t.a, t.b) || 1;
        const mv = t.state === "haul" ? 1 : -1;
        // anti-collision: slow if a same-lane truck is close ahead in our travel direction
        let slow = 1;
        for (const o of this.trucks) {
          if (o === t) continue;
          const oLoaded = o.state === "haul" || o.state === "dump";
          if (oLoaded !== loaded) continue;               // different lane
          if (o.state !== "haul" && o.state !== "return") continue;
          const gap = (o.t - t.t) * mv;                    // >0 means o is ahead of us
          if (gap > 0 && gap < 0.10) slow = Math.min(slow, gap / 0.10);
        }
        t.t += (mv * t.speed * boost * slow * dt) / legLen;
        if (t.t >= 1) { t.t = 1; t.state = "dump"; t.wait = DUMP_TIME; }
        else if (t.t <= 0) { t.t = 0; t.state = "load"; t.wait = LOAD_TIME; }
      }
      this.place(t, loaded);
    }
  }

  private place(t: Truck, loaded: boolean) {
    const dx = t.b.x - t.a.x, dz = t.b.z - t.a.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;       // along the road
    const px = -uz, pz = ux;                   // perpendicular (lane offset)
    const side = loaded ? 1 : -1;              // loaded and empty on opposite lanes
    const bx = t.a.x + dx * t.t + px * t.lane * side;
    const bz = t.a.z + dz * t.t + pz * t.lane * side;
    t.root.position.set(bx, heightAt(bx, bz) + 0.2, bz);
    // face the way we're travelling (or the road while paused)
    const facing = t.state === "return" ? -1 : 1;
    t.root.rotation.y = Math.atan2(ux * facing, uz * facing);
    t.bed.rotation.x = -t.tip * 0.6; // tip the bed to dump
  }
}

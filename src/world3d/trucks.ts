// Haulage: low-poly dump trucks that drive back and forth between two points
// (e.g. a truck workshop and the mine portal), hugging the terrain surface.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { heightAt } from "./terrain.js";

interface Truck {
  root: TransformNode;
  a: Vector3; b: Vector3;
  t: number;      // 0..1 along the leg
  dir: 1 | -1;
  speed: number;  // units/sec
  wait: number;   // pause timer at ends
}

function mat(scene: Scene, hex: string) {
  const m = new StandardMaterial("tm", scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black(); return m;
}

export class TruckFleet {
  private trucks: Truck[] = [];
  constructor(private scene: Scene, private onMesh?: (m: Mesh) => void) {}

  add(count: number, from: Vector3, to: Vector3) {
    for (let i = 0; i < count; i++) {
      const root = new TransformNode("truck", this.scene);
      const cab = MeshBuilder.CreateBox("cab", { width: 2.2, height: 1.8, depth: 2.2 }, this.scene);
      cab.material = mat(this.scene, "#e0a52e"); cab.position.set(0, 1.9, 1.6); cab.parent = root;
      const bed = MeshBuilder.CreateBox("bed", { width: 2.6, height: 1.6, depth: 4.2 }, this.scene);
      bed.material = mat(this.scene, "#4c5a66"); bed.position.set(0, 1.7, -1.2); bed.parent = root;
      const wheelMat = mat(this.scene, "#1c2229");
      for (const [wx, wz] of [[-1.3, 1.4], [1.3, 1.4], [-1.3, -1.8], [1.3, -1.8]] as const) {
        const w = MeshBuilder.CreateCylinder("tw", { diameter: 1.4, height: 0.5, tessellation: 10 }, this.scene);
        w.rotation.z = Math.PI / 2; w.material = wheelMat; w.position.set(wx, 0.7, wz); w.parent = root;
      }
      root.getChildMeshes().forEach((m) => this.onMesh?.(m as Mesh));
      this.trucks.push({ root, a: from.clone(), b: to.clone(), t: i / Math.max(1, count), dir: 1, speed: 7 + Math.random() * 3, wait: 0 });
    }
  }

  clear() { for (const t of this.trucks) t.root.dispose(); this.trucks = []; }
  get count() { return this.trucks.length; }

  update(dt: number) {
    for (const t of this.trucks) {
      if (t.wait > 0) { t.wait -= dt; continue; }
      const legLen = Vector3.Distance(t.a, t.b) || 1;
      t.t += (t.dir * t.speed * dt) / legLen;
      if (t.t >= 1) { t.t = 1; t.dir = -1; t.wait = 1.2; }
      else if (t.t <= 0) { t.t = 0; t.dir = 1; t.wait = 1.2; }
      const x = t.a.x + (t.b.x - t.a.x) * t.t;
      const z = t.a.z + (t.b.z - t.a.z) * t.t;
      t.root.position.set(x, heightAt(x, z) + 0.2, z);
      t.root.rotation.y = Math.atan2((t.b.x - t.a.x) * t.dir, (t.b.z - t.a.z) * t.dir);
    }
  }
}

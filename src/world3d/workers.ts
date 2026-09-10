// Low-poly site workers that wander the pad with a little walk-bob, so the world
// feels alive. Simple waypoint steering; feet stick to the terrain surface.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { heightAt } from "./terrain.js";

interface Worker {
  root: TransformNode;
  target: Vector3;
  speed: number;
  phase: number;
  legs: Mesh;
}

const HI_VIS = ["#ffcf33", "#ff8c1a", "#ffe14d"];

export class WorkerCrew {
  private workers: Worker[] = [];
  private roam: number;

  constructor(
    private scene: Scene, count: number, roamRadius: number,
    private onMesh?: (m: Mesh) => void, private parent?: TransformNode,
    private obstacles?: () => { x: number; z: number; r: number }[],
  ) {
    this.roam = roamRadius;
    this.add(count);
  }

  /** Head for a spot near a building (purposeful) or a random point. */
  private pickTarget(obs: { x: number; z: number; r: number }[]): Vector3 {
    let t: Vector3;
    if (obs.length && Math.random() < 0.6) {
      const o = obs[Math.floor(Math.random() * obs.length)];
      const a = Math.random() * Math.PI * 2;
      const d = o.r + 3 + Math.random() * 3;
      t = new Vector3(o.x + Math.cos(a) * d, 0, o.z + Math.sin(a) * d);
    } else t = this.randSpot();
    // never target a point inside a building — nudge it clear
    for (const o of obs) {
      const ox = t.x - o.x, oz = t.z - o.z; const d = Math.hypot(ox, oz) || 0.001;
      if (d < o.r + 2) { t.x = o.x + (ox / d) * (o.r + 3); t.z = o.z + (oz / d) * (o.r + 3); }
    }
    return t;
  }

  /** Spawn more wandering crew (e.g. when a building that employs people is placed). */
  add(count: number) {
    for (let i = 0; i < count; i++) this.workers.push(this.make(this.workers.length, this.onMesh));
  }

  get count() { return this.workers.length; }
  positions() { return this.workers.map((w) => ({ x: w.root.position.x, z: w.root.position.z })); }

  private randSpot(): Vector3 {
    const a = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * this.roam;
    return new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  }

  private make(i: number, onMesh?: (m: Mesh) => void): Worker {
    const root = new TransformNode("w" + i, this.scene);
    if (this.parent) root.parent = this.parent;
    const vestMat = new StandardMaterial("vest" + i, this.scene);
    vestMat.diffuseColor = Color3.FromHexString(HI_VIS[i % HI_VIS.length]);
    vestMat.specularColor = Color3.Black();
    const skinMat = new StandardMaterial("skin" + i, this.scene);
    skinMat.diffuseColor = Color3.FromHexString("#caa07a");
    skinMat.specularColor = Color3.Black();

    const legs = MeshBuilder.CreateBox("legs" + i, { width: 0.7, height: 1.0, depth: 0.5 }, this.scene);
    legs.position.y = 0.5; legs.material = new StandardMaterial("trous" + i, this.scene);
    (legs.material as StandardMaterial).diffuseColor = Color3.FromHexString("#33465a");
    (legs.material as StandardMaterial).specularColor = Color3.Black();
    legs.parent = root;

    const torso = MeshBuilder.CreateBox("torso" + i, { width: 0.9, height: 1.1, depth: 0.55 }, this.scene);
    torso.position.y = 1.55; torso.material = vestMat; torso.parent = root;

    const head = MeshBuilder.CreateSphere("head" + i, { diameter: 0.55, segments: 6 }, this.scene);
    head.position.y = 2.35; head.material = skinMat; head.parent = root;

    const hat = MeshBuilder.CreateCylinder("hat" + i, { diameter: 0.62, height: 0.28, tessellation: 10 }, this.scene);
    hat.position.y = 2.62; hat.material = vestMat; hat.parent = root;

    [legs, torso, head, hat].forEach((m) => onMesh?.(m));

    const spot = this.randSpot();
    root.position.set(spot.x, heightAt(spot.x, spot.z), spot.z);
    return { root, target: this.randSpot(), speed: 2.2 + Math.random() * 1.6, phase: Math.random() * 10, legs };
  }

  update(dt: number) {
    const obs = this.obstacles?.() ?? [];
    for (const w of this.workers) {
      const p = w.root.position;
      const dx = w.target.x - p.x, dz = w.target.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.5) { w.target = this.pickTarget(obs); continue; }
      // steer: seek target + repel from buildings + separate from crew
      let ax = dx / dist, az = dz / dist;
      for (const o of obs) {
        const ox = p.x - o.x, oz = p.z - o.z; const d = Math.hypot(ox, oz) || 0.001;
        const clear = o.r + 3.5;
        if (d < clear) { const push = ((clear - d) / clear) * 4.0; ax += (ox / d) * push; az += (oz / d) * push; }
      }
      for (const other of this.workers) {
        if (other === w) continue;
        const ox = p.x - other.root.position.x, oz = p.z - other.root.position.z; const d = Math.hypot(ox, oz);
        if (d > 0.001 && d < 2.2) { const push = ((2.2 - d) / 2.2) * 1.2; ax += (ox / d) * push; az += (oz / d) * push; }
      }
      const m = Math.hypot(ax, az) || 1; ax /= m; az /= m;
      const step = w.speed * dt;
      p.x += ax * step; p.z += az * step;
      p.y = heightAt(p.x, p.z);
      w.root.rotation.y = Math.atan2(ax, az);
      w.phase += dt * w.speed * 2.5;
      w.legs.position.y = 0.5 + Math.abs(Math.sin(w.phase)) * 0.12; // walk bob
    }
  }
}

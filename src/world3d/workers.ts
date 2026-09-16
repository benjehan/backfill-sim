// Low-poly site workers with real tasks: they walk to buildings and construction
// sites, dwell there and *work* (a shoulder-swinging tool animation), then move
// on. When a stope is pouring they converge on the mine portal ("all hands on
// the pour"); when something is under construction they crew the site. Steering
// keeps them off buildings and out of each other's way (simple anti-collision).
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { heightAt } from "./terrain.js";

type Mode = "roam" | "goto" | "work";

interface Worker {
  root: TransformNode;
  target: Vector3;
  mode: Mode;
  atSite: boolean;     // is the current goto/work a construction site (works harder/longer)
  dwell: number;       // seconds left in a work stint
  speed: number;
  phase: number;
  legs: Mesh;
  armPivot: TransformNode;
}

// Live signals the world feeds in each frame so the crew reacts to operations.
export interface CrewSignals {
  sites: { x: number; z: number }[];   // active construction sites (top priority)
  focus: { x: number; z: number } | null; // pour portal to converge on, or null
}

const HI_VIS = ["#ffcf33", "#ff8c1a", "#ffe14d"];

export class WorkerCrew {
  private workers: Worker[] = [];
  private roam: number;

  constructor(
    private scene: Scene, count: number, roamRadius: number,
    private onMesh?: (m: Mesh) => void, private parent?: TransformNode,
    private obstacles?: () => { x: number; z: number; r: number }[],
    private signals?: () => CrewSignals,
  ) {
    this.roam = roamRadius;
    this.add(count);
  }

  /** Choose the next destination + intent, biased toward real work over wandering. */
  private pickTask(w: Worker, obs: { x: number; z: number; r: number }[]) {
    const sig = this.signals?.() ?? { sites: [], focus: null };
    // 1) construction sites win — the crew builds what you place
    if (sig.sites.length && Math.random() < 0.8) {
      const s = sig.sites[Math.floor(Math.random() * sig.sites.length)];
      w.target = this.spread(s.x, s.z, 4, obs); w.mode = "goto"; w.atSite = true; return;
    }
    // 2) a running pour pulls a share of the crew to the portal
    if (sig.focus && Math.random() < 0.5) {
      w.target = this.spread(sig.focus.x, sig.focus.z, 6, obs); w.mode = "goto"; w.atSite = false; return;
    }
    // 3) otherwise attend a building (purposeful) or take a stroll
    if (obs.length && Math.random() < 0.6) {
      const o = obs[Math.floor(Math.random() * obs.length)];
      const a = Math.random() * Math.PI * 2;
      w.target = new Vector3(o.x + Math.cos(a) * (o.r + 2.5), 0, o.z + Math.sin(a) * (o.r + 2.5));
      this.nudgeClear(w.target, obs); w.mode = "goto"; w.atSite = false; return;
    }
    w.target = this.randSpot(); w.mode = "roam"; w.atSite = false;
  }

  /** A point near (x,z) with a little scatter, nudged clear of buildings. */
  private spread(x: number, z: number, r: number, obs: { x: number; z: number; r: number }[]): Vector3 {
    const a = Math.random() * Math.PI * 2, d = r * (0.4 + Math.random() * 0.8);
    const t = new Vector3(x + Math.cos(a) * d, 0, z + Math.sin(a) * d);
    this.nudgeClear(t, obs); return t;
  }
  private nudgeClear(t: Vector3, obs: { x: number; z: number; r: number }[]) {
    for (const o of obs) {
      const ox = t.x - o.x, oz = t.z - o.z; const d = Math.hypot(ox, oz) || 0.001;
      if (d < o.r + 2) { t.x = o.x + (ox / d) * (o.r + 3); t.z = o.z + (oz / d) * (o.r + 3); }
    }
  }

  /** Spawn more crew (e.g. when a building that employs people is placed). */
  add(count: number) {
    for (let i = 0; i < count; i++) this.workers.push(this.make(this.workers.length, this.onMesh));
  }

  get count() { return this.workers.length; }
  positions() { return this.workers.map((w) => ({ x: w.root.position.x, z: w.root.position.z })); }
  /** How many are currently working a construction site — for HUD/tests. */
  buildingCount() { return this.workers.filter((w) => w.mode === "work" && w.atSite).length; }

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

    // one arm on a shoulder pivot — swings gently walking, harder while working
    const armPivot = new TransformNode("arm" + i, this.scene);
    armPivot.position.set(0.6, 2.0, 0); armPivot.parent = root;
    const arm = MeshBuilder.CreateBox("armseg" + i, { width: 0.24, height: 0.9, depth: 0.24 }, this.scene);
    arm.position.y = -0.4; arm.material = skinMat; arm.parent = armPivot;

    [legs, torso, head, hat, arm].forEach((m) => onMesh?.(m));

    const spot = this.randSpot();
    root.position.set(spot.x, heightAt(spot.x, spot.z), spot.z);
    return {
      root, target: this.randSpot(), mode: "roam", atSite: false, dwell: 0,
      speed: 2.2 + Math.random() * 1.6, phase: Math.random() * 10, legs, armPivot,
    };
  }

  update(dt: number) {
    const obs = this.obstacles?.() ?? [];
    for (const w of this.workers) {
      if (w.mode === "work") { this.work(w, dt, obs); continue; }
      const p = w.root.position;
      const dx = w.target.x - p.x, dz = w.target.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.5) {
        if (w.mode === "goto") { w.mode = "work"; w.dwell = w.atSite ? 3 + Math.random() * 4 : 1.5 + Math.random() * 2.5; }
        else this.pickTask(w, obs);
        continue;
      }
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
      w.armPivot.rotation.x = Math.sin(w.phase) * 0.5;              // arm swing
    }
  }

  /** Stand at the task and work: a faster tool swing, small ready-stance leg bob. */
  private work(w: Worker, dt: number, obs: { x: number; z: number; r: number }[]) {
    w.dwell -= dt;
    w.phase += dt * 9;
    w.armPivot.rotation.x = -0.6 + Math.abs(Math.sin(w.phase)) * 1.5; // overhead tool strokes
    w.legs.position.y = 0.5 + Math.abs(Math.sin(w.phase * 0.4)) * 0.03;
    if (w.dwell <= 0) this.pickTask(w, obs);
  }
}

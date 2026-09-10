// The 3D underground: a cutaway of the shaft, three producing levels and their
// stopes, with the borehole trunk. Stopes come alive on a schedule (mining
// develops them), you reticulate + fill them, and paste cures over days. All
// economics/pressures come from ./backfillModel (the course numbers).
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import {
  PIPE_CLASSES, requiredMpa, pickClass, reticulationCost, staticHeadMpa, CURE_DAYS,
  type PipeClass,
} from "./backfillModel.js";

export type StopeStatus = "locked" | "available" | "piped" | "pouring" | "curing" | "cured";

export interface StopeUG {
  id: string;
  mesh: Mesh;
  depthM: number;
  lengthM: number;
  volumeM3: number;
  placedM3: number;
  availableDay: number;
  dueDay: number;
  status: StopeStatus;
  cls: PipeClass | null;
  choke: boolean;
  cureStartDay: number;
  pipes: Mesh[];
}

const UNIT_M = 7.5;
const LEVELS = [
  { depthM: 150, y: -18 },
  { depthM: 300, y: -36 },
  { depthM: 450, y: -54 },
];
// per-stope schedule (availableDay, dueDay), staggered by depth
const SCHEDULE = [
  { a: 1, d: 12 }, { a: 4, d: 18 },   // -150
  { a: 8, d: 26 }, { a: 12, d: 32 },  // -300
  { a: 18, d: 42 }, { a: 24, d: 50 }, // -450
];
const STATUS_COLOR: Record<StopeStatus, string> = {
  locked: "#363b42", available: "#6b7076", piped: "#7d93a8", pouring: "#96793f", curing: "#b5822f", cured: "#d3a63a",
};

function mat(scene: Scene, hex: string, emissive?: string): StandardMaterial {
  const m = new StandardMaterial("um", scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = Color3.Black();
  if (emissive) m.emissiveColor = Color3.FromHexString(emissive);
  return m;
}

export class Underground {
  readonly root: TransformNode;
  readonly stopes: StopeUG[] = [];
  private selected: StopeUG | null = null;

  constructor(private scene: Scene, private shadow: ShadowGenerator) {
    this.root = new TransformNode("underground", scene);
    this.build();
    this.root.setEnabled(false);
  }

  center() { return new Vector3(34, -34, 8); }

  private build() {
    const rock = mat(this.scene, "#20262e");
    const drive = mat(this.scene, "#4a5058");
    const steel = mat(this.scene, "#8a939c");

    const back = MeshBuilder.CreateBox("rockback", { width: 96, height: 74, depth: 2 }, this.scene);
    back.material = rock; back.position.set(32, -28, -14); back.parent = this.root;

    const shaft = MeshBuilder.CreateBox("shaft", { width: 7, height: 64, depth: 7 }, this.scene);
    shaft.material = mat(this.scene, "#2a2f36"); shaft.position.set(0, -28, 0); shaft.parent = this.root;
    const collar = MeshBuilder.CreateBox("collar", { width: 9, height: 2, depth: 9 }, this.scene);
    collar.material = steel; collar.position.set(0, 1, 0); collar.parent = this.root;
    const trunk = MeshBuilder.CreateCylinder("trunk", { diameter: 1.3, height: 60, tessellation: 10 }, this.scene);
    trunk.material = steel; trunk.position.set(1.8, -28, 0); trunk.parent = this.root;

    for (const lv of LEVELS) {
      const dr = MeshBuilder.CreateBox("drive" + lv.depthM, { width: 62, height: 6, depth: 6 }, this.scene);
      dr.material = drive; dr.position.set(34, lv.y, 0); dr.parent = this.root;
      const tag = MeshBuilder.CreateBox("tag" + lv.depthM, { width: 2, height: 5, depth: 6.2 }, this.scene);
      tag.material = mat(this.scene, "#31414f"); tag.position.set(3, lv.y, 0); tag.parent = this.root;

      for (const sx of [32, 56]) {
        const cc = MeshBuilder.CreateBox("cc", { width: 5, height: 6, depth: 10 }, this.scene);
        cc.material = drive; cc.position.set(sx, lv.y, 8); cc.parent = this.root;
        const chamber = MeshBuilder.CreateBox("stope", { width: 12, height: 11, depth: 12 }, this.scene);
        chamber.material = mat(this.scene, STATUS_COLOR.locked);
        chamber.position.set(sx, lv.y + 1, 15);
        chamber.parent = this.root;
        chamber.outlineColor = Color3.FromHexString("#39d98a");
        chamber.outlineWidth = 0.35;
        this.shadow.addShadowCaster(chamber);
        this.stopes.push({
          id: "", mesh: chamber, depthM: lv.depthM, lengthM: lv.depthM + sx * UNIT_M,
          volumeM3: 9000 + sx * 90 + lv.depthM * 6, placedM3: 0,
          availableDay: 1, dueDay: 12, status: "locked", cls: null, choke: false, cureStartDay: 0, pipes: [],
        });
      }
    }
    this.stopes.forEach((s, i) => {
      s.id = `S${i + 1}`; s.mesh.metadata = { stopeId: s.id };
      s.availableDay = SCHEDULE[i].a; s.dueDay = SCHEDULE[i].d;
    });
  }

  byMesh(m: unknown): StopeUG | null {
    const id = (m as { metadata?: { stopeId?: string } })?.metadata?.stopeId;
    return id ? this.stopes.find((s) => s.id === id) ?? null : null;
  }

  select(stope: StopeUG | null) {
    if (this.selected) this.selected.mesh.renderOutline = false;
    this.selected = stope;
    if (stope) stope.mesh.renderOutline = true;
  }

  cureProgress(stope: StopeUG, day: number): number {
    if (stope.status === "cured") return 1;
    if (stope.status !== "curing") return 0;
    return Math.min(1, (day - stope.cureStartDay) / CURE_DAYS);
  }

  counts() {
    const c = { locked: 0, available: 0, piped: 0, pouring: 0, curing: 0, cured: 0 };
    for (const s of this.stopes) c[s.status]++;
    return c;
  }

  /** Advance stope lifecycles to `day`: mine out locked stopes, cure filled ones,
   *  flag overdue. Returns notable transitions for the caller to surface. */
  updateSchedule(day: number): { newlyAvailable: StopeUG[]; newlyCured: StopeUG[]; overdue: StopeUG[] } {
    const newlyAvailable: StopeUG[] = [], newlyCured: StopeUG[] = [], overdue: StopeUG[] = [];
    for (const s of this.stopes) {
      if (s.status === "locked" && day >= s.availableDay) { s.status = "available"; newlyAvailable.push(s); }
      if (s.status === "curing" && day - s.cureStartDay >= CURE_DAYS) { s.status = "cured"; newlyCured.push(s); }
      if ((s.status === "available" || s.status === "piped") && day > s.dueDay) overdue.push(s);
      this.paint(s, day);
    }
    return { newlyAvailable, newlyCured, overdue };
  }

  private paint(s: StopeUG, day: number) {
    const m = s.mesh.material as StandardMaterial;
    if (s.status === "pouring") {
      const f = Math.min(1, s.placedM3 / s.volumeM3);
      m.diffuseColor = Color3.Lerp(Color3.FromHexString(STATUS_COLOR.piped), Color3.FromHexString(STATUS_COLOR.curing), f);
      m.emissiveColor = Color3.FromHexString("#3a2a10").scale(f);
    } else {
      m.diffuseColor = Color3.FromHexString(STATUS_COLOR[s.status]);
      const isOverdue = (s.status === "available" || s.status === "piped") && day > s.dueDay;
      if (isOverdue) m.emissiveColor = Color3.FromHexString("#5a1414");
      else if (s.status === "curing") m.emissiveColor = Color3.FromHexString("#3a2a10");
      else if (s.status === "cured") m.emissiveColor = Color3.FromHexString("#2a3a1a");
      else m.emissiveColor = Color3.Black();
    }
  }

  preview(stope: StopeUG, choke: boolean) {
    const reqMpa = requiredMpa(stope.depthM, stope.lengthM, choke);
    const cls = pickClass(reqMpa);
    const cost = cls ? reticulationCost(stope.lengthM, cls) : 0;
    return { reqMpa, headMpa: staticHeadMpa(stope.depthM), cls, cost };
  }

  reticulate(stope: StopeUG, choke: boolean): { cls: PipeClass; cost: number } | null {
    if (stope.status !== "available") return null;
    const { cls } = this.preview(stope, choke);
    if (!cls) return null;
    stope.pipes.forEach((p) => p.dispose());
    stope.pipes = [];
    const col = mat(this.scene, cls.color, cls.color);
    const lv = stope.mesh.position.y - 1;
    const sx = stope.mesh.position.x;
    const drop = MeshBuilder.CreateCylinder("pd", { diameter: 0.8, height: Math.abs(lv) + 2, tessellation: 8 }, this.scene);
    drop.material = col; drop.position.set(2.4, lv / 2, 0); drop.parent = this.root; stope.pipes.push(drop);
    const run = MeshBuilder.CreateCylinder("pr", { diameter: 0.8, height: sx - 2, tessellation: 8 }, this.scene);
    run.rotation.z = Math.PI / 2; run.material = col; run.position.set((sx + 2) / 2, lv + 2.4, 0); run.parent = this.root; stope.pipes.push(run);
    const br = MeshBuilder.CreateCylinder("pb", { diameter: 0.8, height: 15, tessellation: 8 }, this.scene);
    br.rotation.x = Math.PI / 2; br.material = col; br.position.set(sx, lv + 2.4, 8); br.parent = this.root; stope.pipes.push(br);
    if (choke) {
      const ch = MeshBuilder.CreateBox("choke", { width: 2.2, height: 2.2, depth: 2.2 }, this.scene);
      ch.material = mat(this.scene, "#ff7a3a", "#7a2f10"); ch.position.set(6, lv + 2.4, 0); ch.parent = this.root; stope.pipes.push(ch);
    }
    stope.cls = cls; stope.choke = choke; stope.status = "piped";
    (stope.mesh.material as StandardMaterial).diffuseColor = Color3.FromHexString(STATUS_COLOR.piped);
    return { cls, cost: reticulationCost(stope.lengthM, cls) };
  }

  /** Begin a timed pour (m³ placed over game-time by World). */
  startPour(stope: StopeUG): boolean {
    if (stope.status !== "piped") return false;
    stope.status = "pouring"; stope.placedM3 = 0;
    this.paint(stope, 0);
    return true;
  }

  /** Pour complete -> paste cures over CURE_DAYS. */
  completePour(stope: StopeUG, day: number) {
    stope.placedM3 = stope.volumeM3;
    stope.status = "curing"; stope.cureStartDay = day;
    this.paint(stope, day);
  }
}

export { PIPE_CLASSES };

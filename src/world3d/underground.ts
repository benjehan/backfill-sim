// The 3D underground: a cutaway of the shaft, three producing levels and their
// stopes, with the borehole trunk. You reticulate each stope (route a pipe of the
// right pressure class for its depth) and then fill it. All economics/pressures
// come from ./backfillModel (the course numbers).
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import {
  PIPE_CLASSES, requiredMpa, pickClass, reticulationCost, staticHeadMpa,
  type PipeClass,
} from "./backfillModel.js";

export interface StopeUG {
  id: string;
  mesh: Mesh;
  depthM: number;
  lengthM: number;      // reticulation run to this stope (m)
  volumeM3: number;
  state: "empty" | "piped" | "filled";
  cls: PipeClass | null;
  choke: boolean;
  pipes: Mesh[];
}

const UNIT_M = 7.5; // world unit -> metres (horizontal run scaling)
const LEVELS = [
  { depthM: 150, y: -18 },
  { depthM: 300, y: -36 },
  { depthM: 450, y: -54 },
];
const STATE_COLOR = { empty: "#6b7076", piped: "#7d93a8", filled: "#b5822f" };

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

    // rock backdrop so the workings read as carved out (sits well behind the plane)
    const back = MeshBuilder.CreateBox("rockback", { width: 96, height: 74, depth: 2 }, this.scene);
    back.material = rock; back.position.set(32, -28, -14); back.parent = this.root;

    // shaft + collar + borehole trunk
    const shaft = MeshBuilder.CreateBox("shaft", { width: 7, height: 64, depth: 7 }, this.scene);
    shaft.material = mat(this.scene, "#2a2f36"); shaft.position.set(0, -28, 0); shaft.parent = this.root;
    const collar = MeshBuilder.CreateBox("collar", { width: 9, height: 2, depth: 9 }, this.scene);
    collar.material = steel; collar.position.set(0, 1, 0); collar.parent = this.root;
    const trunk = MeshBuilder.CreateCylinder("trunk", { diameter: 1.3, height: 60, tessellation: 10 }, this.scene);
    trunk.material = steel; trunk.position.set(1.8, -28, 0); trunk.parent = this.root;

    for (const lv of LEVELS) {
      // horizontal drive off the shaft
      const dr = MeshBuilder.CreateBox("drive" + lv.depthM, { width: 62, height: 6, depth: 6 }, this.scene);
      dr.material = drive; dr.position.set(34, lv.y, 0); dr.parent = this.root;
      // a depth tag block (colour steps with depth for quick reading)
      const tag = MeshBuilder.CreateBox("tag" + lv.depthM, { width: 2, height: 5, depth: 6.2 }, this.scene);
      tag.material = mat(this.scene, "#31414f"); tag.position.set(3, lv.y, 0); tag.parent = this.root;

      for (const sx of [32, 56]) {
        // cross-cut to the stope
        const cc = MeshBuilder.CreateBox("cc", { width: 5, height: 6, depth: 10 }, this.scene);
        cc.material = drive; cc.position.set(sx, lv.y, 8); cc.parent = this.root;
        // the stope chamber (the void you fill)
        const chamber = MeshBuilder.CreateBox("stope", { width: 12, height: 11, depth: 12 }, this.scene);
        chamber.material = mat(this.scene, STATE_COLOR.empty);
        chamber.position.set(sx, lv.y + 1, 15);
        chamber.parent = this.root;
        this.shadow.addShadowCaster(chamber);
        const lengthM = lv.depthM + sx * UNIT_M;
        this.stopes.push({
          id: "", mesh: chamber, depthM: lv.depthM, lengthM,
          volumeM3: 9000 + sx * 90 + lv.depthM * 6, // ~9-16k m³
          state: "empty", cls: null, choke: false, pipes: [],
        });
      }
    }
    // sequential ids for readability + pick lookup
    this.stopes.forEach((s, i) => { s.id = `S${i + 1}`; s.mesh.metadata = { stopeId: s.id }; });
  }

  byMesh(m: unknown): StopeUG | null {
    const id = (m as { metadata?: { stopeId?: string } })?.metadata?.stopeId;
    return id ? this.stopes.find((s) => s.id === id) ?? null : null;
  }

  select(stope: StopeUG | null) {
    if (this.selected) (this.selected.mesh.material as StandardMaterial).emissiveColor = Color3.Black();
    this.selected = stope;
    if (stope) (stope.mesh.material as StandardMaterial).emissiveColor = Color3.FromHexString("#2b3a2f");
  }

  /** Preview the pressure + class + cost for a stope at a choke setting. */
  preview(stope: StopeUG, choke: boolean) {
    const reqMpa = requiredMpa(stope.depthM, stope.lengthM, choke);
    const cls = pickClass(reqMpa);
    const cost = cls ? reticulationCost(stope.lengthM, cls) : 0;
    return { reqMpa, headMpa: staticHeadMpa(stope.depthM), cls, cost };
  }

  /** Build the reticulation for a stope. Returns null if it exceeds Sch 120 (needs a choke). */
  reticulate(stope: StopeUG, choke: boolean): { cls: PipeClass; cost: number } | null {
    const { reqMpa, cls } = this.preview(stope, choke);
    if (!cls) return null;
    stope.pipes.forEach((p) => p.dispose());
    stope.pipes = [];
    const col = mat(this.scene, cls.color, cls.color);
    const lv = stope.mesh.position.y - 1;
    const sx = stope.mesh.position.x;

    // drop down the shaft to this level
    const drop = MeshBuilder.CreateCylinder("pd", { diameter: 0.8, height: Math.abs(lv) + 2, tessellation: 8 }, this.scene);
    drop.material = col; drop.position.set(2.4, lv / 2, 0); drop.parent = this.root; stope.pipes.push(drop);
    // run along the drive
    const run = MeshBuilder.CreateCylinder("pr", { diameter: 0.8, height: sx - 2, tessellation: 8 }, this.scene);
    run.rotation.z = Math.PI / 2; run.material = col; run.position.set((sx + 2) / 2, lv + 2.4, 0); run.parent = this.root; stope.pipes.push(run);
    // branch into the stope
    const br = MeshBuilder.CreateCylinder("pb", { diameter: 0.8, height: 15, tessellation: 8 }, this.scene);
    br.rotation.x = Math.PI / 2; br.material = col; br.position.set(sx, lv + 2.4, 8); br.parent = this.root; stope.pipes.push(br);

    if (choke) {
      const ch = MeshBuilder.CreateBox("choke", { width: 2.2, height: 2.2, depth: 2.2 }, this.scene);
      ch.material = mat(this.scene, "#ff7a3a", "#7a2f10"); ch.position.set(6, lv + 2.4, 0); ch.parent = this.root; stope.pipes.push(ch);
    }

    stope.cls = cls; stope.choke = choke; stope.state = "piped";
    (stope.mesh.material as StandardMaterial).diffuseColor = Color3.FromHexString(STATE_COLOR.piped);
    return { cls, cost: reticulationCost(stope.lengthM, cls) };
  }

  fill(stope: StopeUG) {
    stope.state = "filled";
    const m = stope.mesh.material as StandardMaterial;
    m.diffuseColor = Color3.FromHexString(STATE_COLOR.filled);
    m.emissiveColor = Color3.FromHexString("#3a2a10");
  }
}

export { PIPE_CLASSES };

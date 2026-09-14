// The reticulation network as a designable segment graph. A shared borehole
// (three legs down the shaft), a run along each level, and a branch to each
// stope. You choose the pipe class and chokes leg-by-leg; pressure = effective
// static head (choke-relieved) + friction, and each leg's class must out-rate
// the pressure it sees. Deeper legs carry more head; a borehole choke relieves
// everything below it. (Course: UDS design, static head ρgh, 250-bar couplings.)
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import {
  PIPE_CLASSES, staticHeadMpa, frictionMpa, SURGE_MPA, CHOKE_HEAD_RELIEF, CHOKE_CAPEX,
  type PipeClass,
} from "./backfillModel.js";

const DEPTHS = [150, 300, 450];        // level depths (m)
const BORE_LEN = 150;                  // each borehole leg (m)
const RUN_LEN = 300;                   // level run (m)
const BRANCH_LEN = 120;                // stope branch (m)
const LEVEL_Y = [-18, -36, -54];       // world Y of each level

export interface Segment {
  id: string;
  kind: "borehole" | "level" | "branch";
  label: string;
  levelIdx: number;                    // 0..2 the level this leg reaches/serves
  lengthM: number;
  cumLenM: number;                     // path length from surface to the end of this leg
  choke: boolean;                      // borehole legs only
  classId: number | null;
  built: boolean;
  mesh: Mesh;
}

const GREY = "#3a4048";

export class Reticulation {
  readonly segs: Segment[] = [];
  private byId = new Map<string, Segment>();
  private flowBeads = new Map<number, Mesh[]>();

  constructor(private scene: Scene, private root: TransformNode, shadow: ShadowGenerator) {
    const add = (s: Omit<Segment, "mesh">, mesh: Mesh) => {
      mesh.parent = root; mesh.metadata = { segId: s.id }; shadow.addShadowCaster(mesh);
      const seg = { ...s, mesh } as Segment; this.segs.push(seg); this.byId.set(s.id, seg);
    };
    const cyl = (name: string, dia: number, h: number) => MeshBuilder.CreateCylinder(name, { diameter: dia, height: h, tessellation: 8 }, this.scene);

    // borehole legs down the shaft (chunky trunk main)
    for (let i = 0; i < 3; i++) {
      const top = i === 0 ? 0 : LEVEL_Y[i - 1];
      const m = cyl("B" + (i + 1), 1.7, Math.abs(LEVEL_Y[i] - top));
      m.position.set(2.4, (top + LEVEL_Y[i]) / 2, 0);
      add({ id: "B" + (i + 1), kind: "borehole", label: `Borehole ${i === 0 ? "surface" : DEPTHS[i - 1] + "m"}→${DEPTHS[i]}m`, levelIdx: i, lengthM: BORE_LEN, cumLenM: BORE_LEN * (i + 1), choke: false, classId: null, built: false }, m);
    }
    // level runs (drive-level distribution pipe)
    for (let i = 0; i < 3; i++) {
      const m = cyl("R" + (i + 1), 1.35, 58); m.rotation.z = Math.PI / 2; m.position.set(31, LEVEL_Y[i] + 2.4, 0);
      add({ id: "R" + (i + 1), kind: "level", label: `Level ${DEPTHS[i]}m run`, levelIdx: i, lengthM: RUN_LEN, cumLenM: BORE_LEN * (i + 1) + RUN_LEN, choke: false, classId: null, built: false }, m);
    }
    // stope branches (two per level, at x = 32 and 56)
    let n = 1;
    for (let i = 0; i < 3; i++) {
      for (const sx of [32, 56]) {
        const m = cyl("Br" + n, 1.15, 15); m.rotation.x = Math.PI / 2; m.position.set(sx, LEVEL_Y[i] + 2.4, 8);
        add({ id: "Br" + n, kind: "branch", label: `Branch to S${n}`, levelIdx: i, lengthM: BRANCH_LEN, cumLenM: BORE_LEN * (i + 1) + RUN_LEN + BRANCH_LEN, choke: false, classId: null, built: false }, m);
        n++;
      }
    }
    this.repaintAll();
  }

  get(id: string) { return this.byId.get(id); }
  bySegMesh(m: unknown): Segment | null {
    const id = (m as { metadata?: { segId?: string } })?.metadata?.segId;
    return id ? this.byId.get(id) ?? null : null;
  }

  /** Chokes on borehole legs at or above a level relieve its head. */
  private chokeCount(levelIdx: number): number {
    let c = 0;
    for (let i = 0; i <= levelIdx; i++) if (this.byId.get("B" + (i + 1))!.choke) c++;
    return c;
  }
  effHeadMpa(levelIdx: number): number {
    return staticHeadMpa(DEPTHS[levelIdx]) * Math.pow(CHOKE_HEAD_RELIEF, this.chokeCount(levelIdx));
  }
  /** Pressure this leg must hold. */
  pressureMpa(seg: Segment): number {
    return this.effHeadMpa(seg.levelIdx) + frictionMpa(seg.cumLenM) + SURGE_MPA;
  }
  cls(seg: Segment): PipeClass | null { return seg.classId == null ? null : PIPE_CLASSES[seg.classId]; }
  valid(seg: Segment): boolean { const c = this.cls(seg); return !!c && c.ratingMpa >= this.pressureMpa(seg); }
  cost(seg: Segment): number { const c = this.cls(seg); return c ? Math.round(c.costPerM * seg.lengthM) + (seg.choke ? CHOKE_CAPEX : 0) : 0; }

  // ---- editing (free while planning; locked once built) ----------------------
  cycleClass(id: string) {
    const s = this.byId.get(id); if (!s || s.built) return;
    const order: (number | null)[] = [null, 0, 1, 2, 3];
    s.classId = order[(order.indexOf(s.classId) + 1) % order.length];
    this.repaint(s);
  }
  toggleChoke(id: string) {
    const s = this.byId.get(id); if (!s || s.built || s.kind !== "borehole") return;
    s.choke = !s.choke;
    this.repaintAll(); // choke changes pressures below it
  }

  // ---- path helpers ----------------------------------------------------------
  pathFor(stopeIdx: number): Segment[] {
    const level = Math.floor(stopeIdx / 2);
    const path: Segment[] = [];
    for (let i = 0; i <= level; i++) path.push(this.byId.get("B" + (i + 1))!);
    path.push(this.byId.get("R" + (level + 1))!);
    path.push(this.byId.get("Br" + (stopeIdx + 1))!);
    return path;
  }
  pathCanBuild(stopeIdx: number): boolean { return this.pathFor(stopeIdx).every((s) => s.classId != null && this.valid(s)); }
  pathReady(stopeIdx: number): boolean { return this.pathFor(stopeIdx).every((s) => s.built && this.valid(s)); }
  pathPlannedCost(stopeIdx: number): number { return this.pathFor(stopeIdx).filter((s) => !s.built).reduce((a, s) => a + this.cost(s), 0); }

  /** Weakest built class + any choke on the path — used by the pour's burst check. */
  pathWeakest(stopeIdx: number): { cls: PipeClass; choke: boolean } | null {
    const path = this.pathFor(stopeIdx);
    let weak: PipeClass | null = null, choke = false;
    for (const s of path) { const c = this.cls(s); if (!c) return null; if (!weak || c.ratingMpa < weak.ratingMpa) weak = c; if (s.choke) choke = true; }
    return weak ? { cls: weak, choke } : null;
  }

  buildPath(stopeIdx: number): number {
    let charged = 0;
    for (const s of this.pathFor(stopeIdx)) {
      if (!s.built && s.classId != null && this.valid(s)) { charged += this.cost(s); s.built = true; this.repaint(s); }
    }
    return charged;
  }

  // ---- visuals ---------------------------------------------------------------
  private repaintAll() { for (const s of this.segs) this.repaint(s); }
  private repaint(s: Segment) {
    let m = s.mesh.material as StandardMaterial | null;
    if (!m) { m = new StandardMaterial("seg", this.scene); m.specularColor = Color3.Black(); s.mesh.material = m; }
    const c = this.cls(s);
    if (!c) { m.diffuseColor = Color3.FromHexString(GREY); m.emissiveColor = Color3.Black(); m.alpha = 0.6; return; }
    const ok = this.valid(s);
    m.diffuseColor = Color3.FromHexString(ok ? c.color : "#ff5a5a");
    m.emissiveColor = ok ? Color3.FromHexString(c.color).scale(0.25) : Color3.FromHexString("#ff3030");
    m.alpha = s.built ? 1 : 0.55; // planned = translucent, built = solid
  }

  highlightPath(stopeIdx: number | null) {
    for (const s of this.segs) s.mesh.renderOutline = false;
    if (stopeIdx == null) return;
    for (const s of this.pathFor(stopeIdx)) { s.mesh.renderOutline = true; s.mesh.outlineColor = Color3.FromHexString("#ffffff"); s.mesh.outlineWidth = 0.25; }
  }

  /** Animate paste flowing down the active path during a pour: a pulsing band on the
   *  pipes plus paste beads travelling shaft→level→stope (matches the surface flow). */
  flowPulse(stopeIdx: number, phase: number) {
    const path = this.pathFor(stopeIdx);
    for (let k = 0; k < path.length; k++) {
      const m = path[k].mesh.material as StandardMaterial | null; if (!m) continue;
      const wave = 0.5 + 0.5 * Math.sin(phase * 7 - k * 1.4);
      m.emissiveColor = Color3.FromHexString("#e0a83a").scale(0.2 + wave * 0.7);
    }
    // travelling paste beads down the reticulation polyline
    let beads = this.flowBeads.get(stopeIdx);
    if (!beads) {
      beads = [];
      const bmat = new StandardMaterial("pbead", this.scene);
      bmat.diffuseColor = Color3.FromHexString("#e0a83a"); bmat.emissiveColor = Color3.FromHexString("#e0a83a").scale(0.8); bmat.specularColor = Color3.Black();
      for (let i = 0; i < 5; i++) {
        const b = MeshBuilder.CreateSphere("pbead", { diameter: 1.3, segments: 6 }, this.scene);
        b.material = bmat; b.parent = this.root; b.isPickable = false; beads.push(b);
      }
      this.flowBeads.set(stopeIdx, beads);
    }
    const pts = this.pathPoints(stopeIdx); const n = beads.length;
    for (let i = 0; i < n; i++) {
      const t = ((phase * 0.5 + i / n) % 1 + 1) % 1;
      const p = posOnPolyline(pts, t);
      beads[i].position.copyFrom(p); beads[i].setEnabled(true);
    }
  }
  /** Stop the flow animation, dispose beads, and restore the path's class colours. */
  clearFlow(stopeIdx: number) {
    for (const s of this.pathFor(stopeIdx)) this.repaint(s);
    const beads = this.flowBeads.get(stopeIdx);
    if (beads) { beads.forEach((b) => b.dispose()); this.flowBeads.delete(stopeIdx); }
  }

  /** The reticulation polyline a stope's paste follows: collar → down shaft → along level → into stope. */
  private pathPoints(stopeIdx: number): Vector3[] {
    const L = Math.floor(stopeIdx / 2); const sx = stopeIdx % 2 === 0 ? 32 : 56; const ly = LEVEL_Y[L] + 2.4;
    return [new Vector3(2.4, 0, 0), new Vector3(2.4, ly, 0), new Vector3(sx, ly, 0), new Vector3(sx, ly, 12)];
  }
}

/** Position at fraction t (0..1) along a multi-point polyline, by cumulative length. */
function posOnPolyline(pts: Vector3[], t: number): Vector3 {
  const segs: number[] = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const d = Vector3.Distance(pts[i], pts[i + 1]); segs.push(d); total += d; }
  let target = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) return Vector3.Lerp(pts[i], pts[i + 1], segs[i] ? target / segs[i] : 0);
    target -= segs[i];
  }
  return pts[pts.length - 1].clone();
}

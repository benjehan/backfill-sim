// Enter-the-plant: a 3D interior where you place and connect the process line —
// tailings → thickener → mixer (+binder +water) → pump → borehole. Reuses the
// validated pull-based flow solve from ../plant/model.ts, rendered in 3D. The
// throughput you achieve feeds the campaign's pour rate.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Plant, CATALOG, MAT, COLS, ROWS } from "../plant/model.js";
import { fmtMoney } from "./backfillModel.js";

const T3 = 3;                       // world units per plant tile
const OX = -(COLS * T3) / 2;
const OZ = -(ROWS * T3) / 2;
const EQUIP_COST_MULT = 100;        // scale the model's costs to mining capital
const BUILDABLE = ["thickener", "mixer", "pump"];
const STATE_EMIT: Record<string, string> = { running: "#194b32", throttled: "#4a3a10", starved: "#4a1414", idle: "#101418", off: "#101418" };

function mat(scene: Scene, hex: string) { const m = new StandardMaterial("pm", scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black(); return m; }

export class PlantInterior {
  readonly root: TransformNode;
  readonly plant = new Plant();
  private floor!: Mesh;
  private machineMeshes = new Map<string, { box: Mesh; ports: Mesh[] }>();
  private pipeMeshes: Mesh[] = [];
  private ghost: Mesh | null = null;
  private tool: string | null = null;
  private pending: { mId: string; port: number } | null = null;
  private overlay: HTMLElement;

  constructor(
    private scene: Scene,
    private shadow: ShadowGenerator,
    host: HTMLElement,
    private onExit: () => void,
    private onSpend: (cost: number) => boolean,
    private onThroughput: (m3h: number) => void,
  ) {
    this.plant.cash = 1e12; // world manages the money; never let the model block
    this.root = new TransformNode("plantInterior", scene);
    this.buildFloor();
    this.overlay = this.buildOverlay(host);
    this.rebuild();
    this.root.setEnabled(false);
    this.overlay.classList.add("hidden");
  }

  center() { return new Vector3(0, 0, 0); }

  enter() { this.root.setEnabled(true); this.overlay.classList.remove("hidden"); this.solveSync(); }
  exit() { this.root.setEnabled(false); this.overlay.classList.add("hidden"); this.tool = null; this.pending = null; this.disposeGhost(); }

  // ---- world geometry -------------------------------------------------------
  private tileCenter(col: number, row: number, w: number, h: number) {
    return new Vector3(OX + (col + w / 2) * T3, 0, OZ + (row + h / 2) * T3);
  }
  private portPos(col: number, row: number, w: number, h: number, side: "in" | "out", i: number, n: number): Vector3 {
    const x = side === "in" ? OX + col * T3 : OX + (col + w) * T3;
    const z = OZ + (row + ((i + 0.5) / Math.max(1, n)) * h) * T3;
    return new Vector3(x, 2.2, z);
  }

  private buildFloor() {
    const f = MeshBuilder.CreateBox("plantFloor", { width: COLS * T3, height: 1, depth: ROWS * T3 }, this.scene);
    f.material = mat(this.scene, "#2b3038"); f.position.set(0, -0.5, 0); f.parent = this.root; f.receiveShadows = true;
    this.floor = f;
    // faint grid tiles as a border frame
    const frame = MeshBuilder.CreateBox("plantFrame", { width: COLS * T3 + 2, height: 0.4, depth: ROWS * T3 + 2 }, this.scene);
    frame.material = mat(this.scene, "#1b2027"); frame.position.set(0, -0.8, 0); frame.parent = this.root;
  }

  // ---- render machines + pipes from plant state -----------------------------
  private rebuild() {
    for (const { box, ports } of this.machineMeshes.values()) { box.dispose(); ports.forEach((p) => p.dispose()); }
    this.machineMeshes.clear();
    for (const m of this.plant.machines) this.drawMachine(m.id);
    this.redrawPipes();
  }

  private drawMachine(id: string) {
    const m = this.plant.getMachine(id)!; const s = this.plant.spec(m);
    const c = this.tileCenter(m.col, m.row, s.w, s.h);
    const box = MeshBuilder.CreateBox("mach_" + id, { width: s.w * T3 - 0.8, height: 4, depth: s.h * T3 - 0.8 }, this.scene);
    box.material = mat(this.scene, s.color); box.position.set(c.x, 2, c.z); box.parent = this.root;
    box.metadata = { machineId: id }; this.shadow.addShadowCaster(box);
    const ports: Mesh[] = [];
    const mkPort = (pos: Vector3, material: string, side: "in" | "out", port: number) => {
      const sph = MeshBuilder.CreateSphere("port", { diameter: 1.3, segments: 6 }, this.scene);
      sph.material = mat(this.scene, MAT[material as keyof typeof MAT].color); sph.position.copyFrom(pos); sph.parent = this.root;
      sph.metadata = { machineId: id, port, side }; ports.push(sph);
    };
    m.inputs.forEach((sl, i) => mkPort(this.portPos(m.col, m.row, s.w, s.h, "in", i, m.inputs.length), sl.material, "in", i));
    m.outputs.forEach((sl, i) => mkPort(this.portPos(m.col, m.row, s.w, s.h, "out", i, m.outputs.length), sl.material, "out", i));
    this.machineMeshes.set(id, { box, ports });
  }

  private redrawPipes() {
    this.pipeMeshes.forEach((p) => p.dispose()); this.pipeMeshes = [];
    for (const pipe of this.plant.pipes) {
      const fm = this.plant.getMachine(pipe.from.m), tm = this.plant.getMachine(pipe.to.m);
      if (!fm || !tm) continue;
      const fs = this.plant.spec(fm), ts = this.plant.spec(tm);
      const a = this.portPos(fm.col, fm.row, fs.w, fs.h, "out", pipe.from.port, fm.outputs.length);
      const b = this.portPos(tm.col, tm.row, ts.w, ts.h, "in", pipe.to.port, tm.inputs.length);
      const col = MAT[pipe.material].color;
      const midx = (a.x + b.x) / 2;
      // an elbow: run in x to midx, then in z to b, then x to b — two axis-aligned legs
      this.addLeg(Math.abs(midx - a.x), "x", (midx + a.x) / 2, a.z, col);
      this.addLeg(Math.abs(b.z - a.z), "z", midx, (a.z + b.z) / 2, col);
      this.addLeg(Math.abs(b.x - midx), "x", (midx + b.x) / 2, b.z, col);
    }
  }
  private addLeg(len: number, axis: "x" | "z", cx: number, cz: number, color: string) {
    if (len < 0.1) return;
    const c = MeshBuilder.CreateCylinder("pleg", { diameter: 0.6, height: len, tessellation: 6 }, this.scene);
    c.material = mat(this.scene, color);
    if (axis === "x") c.rotation.z = Math.PI / 2; else c.rotation.x = Math.PI / 2;
    c.position.set(cx, 2.2, cz); c.parent = this.root; this.pipeMeshes.push(c);
  }

  private solveSync() {
    this.plant.solve();
    for (const [id, { box }] of this.machineMeshes) {
      const m = this.plant.getMachine(id)!;
      (box.material as StandardMaterial).emissiveColor = Color3.FromHexString(STATE_EMIT[m.state] ?? "#101418");
    }
    this.onThroughput(this.plant.deliveredM3h);
    this.updateOverlay();
  }

  // ---- overlay --------------------------------------------------------------
  private buildOverlay(host: HTMLElement): HTMLElement {
    const el = document.createElement("div");
    el.className = "plantHud";
    el.innerHTML = `
      <div class="phTop">
        <div class="phTitle">🏭 Backfill plant <span id="phThru"></span></div>
        <button class="whMode" data-pact="exit">☀ Back to surface</button>
      </div>
      <div class="phStatus" id="phStatus"></div>
      <div class="whPalette" id="phPalette">${BUILDABLE.map((t) => {
        const s = CATALOG[t];
        return `<button class="palBtn" data-pact="tool:${t}"><span class="palI">${s.icon}</span><span class="palN">${s.label}</span><span class="palC">${fmtMoney(s.cost * EQUIP_COST_MULT)} · ${s.cap} m³/h</span></button>`;
      }).join("")}</div>`;
    host.appendChild(el);
    el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-pact]") as HTMLElement | null;
      if (!b) return;
      const act = b.dataset.pact!;
      if (act === "exit") this.onExit();
      else if (act.startsWith("tool:")) this.armTool(act.slice(5));
    });
    return el;
  }
  private updateOverlay() {
    const thru = this.overlay.querySelector("#phThru")!;
    const met = this.plant.deliveredM3h >= this.plant.targetM3h - 0.5;
    thru.innerHTML = `<b class="${met ? "good" : ""}">${this.plant.deliveredM3h.toFixed(0)}</b> / ${this.plant.targetM3h} m³/h to borehole`;
    const st = this.overlay.querySelector("#phStatus")!;
    st.textContent = this.pending ? "Connecting — click a matching input port."
      : this.tool ? `Placing ${CATALOG[this.tool].label} — click the floor. Right-click to cancel.`
      : "Place equipment, then click an output port and a matching input port to pipe it.";
    this.overlay.querySelectorAll<HTMLElement>("[data-pact^='tool:']").forEach((b) => b.classList.toggle("on", b.dataset.pact === "tool:" + this.tool));
  }

  private armTool(type: string) {
    this.tool = this.tool === type ? null : type; this.pending = null;
    this.disposeGhost();
    if (this.tool) { this.ghost = MeshBuilder.CreateBox("ghost", { width: CATALOG[type].w * T3 - 0.8, height: 4, depth: CATALOG[type].h * T3 - 0.8 }, this.scene); const g = mat(this.scene, CATALOG[type].color); g.alpha = 0.5; this.ghost.material = g; this.ghost.parent = this.root; this.ghost.isPickable = false; }
    this.updateOverlay();
  }
  private disposeGhost() { this.ghost?.dispose(); this.ghost = null; }

  // ---- pointer (routed from World in plant mode) ----------------------------
  handlePointer(pi: { type: number; event: { button?: number } }) {
    if (pi.type === PointerEventTypes.POINTERMOVE) {
      if (!this.tool || !this.ghost) return;
      const g = this.floorPick(); if (!g) return;
      const c = this.tileCenter(g.col, g.row, CATALOG[this.tool].w, CATALOG[this.tool].h);
      this.ghost.position.set(c.x, 2, c.z);
      return;
    }
    if (pi.type !== PointerEventTypes.POINTERTAP) return;
    if (pi.event.button === 2) { this.tool = null; this.pending = null; this.disposeGhost(); this.updateOverlay(); return; }
    if (this.tool) { this.tryPlace(); return; }
    // otherwise a port click?
    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => !!(m.metadata as any)?.side);
    if (pick?.pickedMesh) this.onPort((pick.pickedMesh.metadata as any));
  }

  private floorPick(): { col: number; row: number } | null {
    const hit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.floor);
    if (!hit?.pickedPoint) return null;
    const type = this.tool!; const s = CATALOG[type];
    let col = Math.round((hit.pickedPoint.x - OX) / T3 - s.w / 2);
    let row = Math.round((hit.pickedPoint.z - OZ) / T3 - s.h / 2);
    col = Math.max(0, Math.min(COLS - s.w, col)); row = Math.max(0, Math.min(ROWS - s.h, row));
    return { col, row };
  }

  private tryPlace() {
    const g = this.floorPick(); if (!g || !this.tool) return;
    if (!this.plant.canPlace(this.tool, g.col, g.row)) return;
    const cost = CATALOG[this.tool].cost * EQUIP_COST_MULT;
    if (!this.onSpend(cost)) return;
    this.plant.place(this.tool, g.col, g.row);
    this.rebuild(); this.solveSync();
  }

  /** Debug/testing: place and wire a full working line. */
  debugBuildLine() {
    this.plant.place("thickener", 3, 1); this.plant.place("mixer", 8, 4); this.plant.place("pump", 13, 4);
    const id = (t: string) => this.plant.machines.find((m) => m.type === t)!.id;
    this.plant.connect(id("src_tailings"), 0, id("thickener"), 0);
    this.plant.connect(id("thickener"), 0, id("mixer"), 0);
    this.plant.connect(id("src_binder"), 0, id("mixer"), 1);
    this.plant.connect(id("src_water"), 0, id("mixer"), 2);
    this.plant.connect(id("mixer"), 0, id("pump"), 0);
    this.plant.connect(id("pump"), 0, id("shaft"), 0);
    this.rebuild(); this.solveSync();
  }

  private onPort(meta: { machineId: string; port: number; side: "in" | "out" }) {
    if (meta.side === "out") { this.pending = { mId: meta.machineId, port: meta.port }; this.updateOverlay(); return; }
    if (!this.pending) return;
    this.plant.connect(this.pending.mId, this.pending.port, meta.machineId, meta.port);
    this.pending = null;
    this.rebuild(); this.solveSync();
  }
}

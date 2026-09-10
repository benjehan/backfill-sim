// The 3D world: an RTS surface where you lay out the operation, and an
// underground you descend into to reticulate and fill stopes. The pure-TS sim
// physics lives in ./backfillModel (course numbers). Surface geometry is parented
// under one node so descend/ascend is a single toggle.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import "@babylonjs/core/Culling/ray";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { createTerrain, heightAt, PAD_RADIUS } from "./terrain.js";
import { ghostify } from "./buildings.js";
import { CATALOG, specOf, type BuildingSpec } from "./catalog.js";
import { WorkerCrew } from "./workers.js";
import { TruckFleet } from "./trucks.js";
import { Underground, type StopeUG } from "./underground.js";
import {
  fmtMoney, fillCost, fillRevenue, CHOKE_CAPEX, staticHeadMpa,
} from "./backfillModel.js";
import { Hud } from "./hud.js";

const SKY = "#8ec5e6";
const START_CASH = 150_000_000;

interface Placed { spec: BuildingSpec; root: TransformNode; pos: Vector3; marker: Mesh | null; }

export class World {
  private engine!: Engine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private shadow!: ShadowGenerator;
  private ground!: Mesh;
  private surfaceRoot!: TransformNode;
  private crew!: WorkerCrew;
  private fleet!: TruckFleet;
  private underground!: Underground;
  private hud!: Hud;
  private canvas!: HTMLCanvasElement;
  private portal!: Vector3;

  private mode: "surface" | "underground" = "surface";
  private cash = START_CASH;
  private powered = 0; private total = 0;
  private buildings: Placed[] = [];
  private selectedStope: StopeUG | null = null;

  private armed: BuildingSpec | null = null;
  private ghost: TransformNode | null = null;
  private setGhostValid: ((ok: boolean) => void) | null = null;
  private ghostPos: Vector3 | null = null;
  private ghostValid = false;

  constructor(private root: HTMLElement) {}

  start() {
    this.root.classList.add("world-mode");
    this.canvas = document.createElement("canvas");
    this.canvas.id = "renderCanvas";
    this.root.appendChild(this.canvas);

    this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: false });
    this.scene = new Scene(this.engine);
    this.setSky(false);

    this.setupCamera();
    this.setupLights();

    this.surfaceRoot = new TransformNode("surface", this.scene);
    this.ground = createTerrain(this.scene); this.ground.parent = this.surfaceRoot;
    this.portal = this.createPortal();
    this.crew = new WorkerCrew(this.scene, 5, PAD_RADIUS - 6, (m) => this.shadow.addShadowCaster(m), this.surfaceRoot);
    this.fleet = new TruckFleet(this.scene, (m) => this.shadow.addShadowCaster(m), this.surfaceRoot);
    this.underground = new Underground(this.scene, this.shadow);

    this.hud = new Hud(this.root, {
      onSelect: (t) => this.onSelect(t),
      onToggleMode: () => this.toggleMode(),
      onPanelAction: (a) => this.onPanelAction(a),
    });
    this.updateEconomy();

    this.scene.onPointerObservable.add((pi) => this.onPointer(pi));
    this.engine.runRenderLoop(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      if (this.mode === "surface") { this.crew.update(dt); this.fleet.update(dt); }
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
    (window as any).__world = this;
  }

  private setSky(underground: boolean) {
    if (underground) {
      this.scene.clearColor = new Color4(0.05, 0.06, 0.08, 1);
      this.scene.fogColor = Color3.FromHexString("#0a0d12");
      this.scene.fogMode = Scene.FOGMODE_EXP2; this.scene.fogDensity = 0.0032;
    } else {
      this.scene.clearColor = new Color4(0.556, 0.772, 0.902, 1);
      this.scene.fogColor = Color3.FromHexString(SKY);
      this.scene.fogMode = Scene.FOGMODE_EXP2; this.scene.fogDensity = 0.0032;
    }
  }

  private setupCamera() {
    const cam = new ArcRotateCamera("cam", -Math.PI * 0.72, 0.86, 96, new Vector3(0, 4, 0), this.scene);
    cam.attachControl(this.canvas, true);
    cam.lowerRadiusLimit = 40; cam.upperRadiusLimit = 210;
    cam.lowerBetaLimit = 0.2; cam.upperBetaLimit = 1.45;
    cam.wheelPrecision = 1.6; cam.panningSensibility = 26;
    cam.panningDistanceLimit = 160; cam.panningInertia = 0.6;
    this.camera = cam;
  }

  private setupLights() {
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.75; hemi.groundColor = Color3.FromHexString("#42502f");
    const sun = new DirectionalLight("sun", new Vector3(-0.6, -1, -0.4), this.scene);
    sun.position = new Vector3(90, 140, 70); sun.intensity = 1.1;
    this.shadow = new ShadowGenerator(1024, sun);
    this.shadow.useBlurExponentialShadowMap = true; this.shadow.blurKernel = 16;
  }

  private createPortal(): Vector3 {
    const x = -64, z = 10, y = heightAt(x, z);
    const mk = (hex: string) => { const m = new StandardMaterial("pm", this.scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black(); return m; };
    const frame = MeshBuilder.CreateBox("adit", { width: 11, height: 8, depth: 3 }, this.scene);
    frame.material = mk("#5a5148"); frame.position.set(x, y + 3.5, z); frame.parent = this.surfaceRoot; this.shadow.addShadowCaster(frame);
    const mouth = MeshBuilder.CreateBox("aditMouth", { width: 6.5, height: 5.5, depth: 1.2 }, this.scene);
    mouth.material = mk("#14181d"); mouth.position.set(x, y + 3, z + 1.3); mouth.parent = this.surfaceRoot;
    const apron = MeshBuilder.CreateGround("aditApron", { width: 12, height: 14 }, this.scene);
    apron.material = mk("#6b6256"); apron.position.set(x + 5, y + 0.1, z); apron.parent = this.surfaceRoot;
    return new Vector3(x + 7, y, z);
  }

  // ---- mode toggle ----------------------------------------------------------

  private toggleMode() {
    this.mode === "surface" ? this.descend() : this.ascend();
  }

  private descend() {
    this.disarm();
    this.mode = "underground";
    this.surfaceRoot.setEnabled(false);
    this.underground.root.setEnabled(true);
    this.setSky(true);
    // view the cutaway roughly face-on (X across, depth down), stopes toward camera
    this.camera.setTarget(new Vector3(30, -30, 7));
    this.camera.radius = 104; this.camera.beta = 1.04; this.camera.alpha = Math.PI * 0.42;
    this.hud.setMode("underground");
    this.hud.setPanel(`<div class="panelHint">Click a stope to reticulate and fill it.</div>`);
  }

  private ascend() {
    this.mode = "surface";
    this.underground.select(null); this.selectedStope = null;
    this.underground.root.setEnabled(false);
    this.surfaceRoot.setEnabled(true);
    this.setSky(false);
    this.camera.setTarget(new Vector3(0, 4, 0)); this.camera.radius = 96; this.camera.beta = 0.86; this.camera.alpha = -Math.PI * 0.72;
    this.hud.setMode("surface");
  }

  // ---- pointer --------------------------------------------------------------

  private onPointer(pi: { type: number; event: { button?: number } }) {
    if (this.mode === "underground") {
      if (pi.type === PointerEventTypes.POINTERTAP && pi.event.button !== 2) {
        const hit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => !!(m.metadata as any)?.stopeId);
        const st = hit?.pickedMesh ? this.underground.byMesh(hit.pickedMesh) : null;
        if (st) this.selectStope(st);
      }
      return;
    }
    if (!this.armed || !this.ghost) return;
    if (pi.type === PointerEventTypes.POINTERMOVE) {
      const hit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.ground);
      if (!hit?.pickedPoint) return;
      const x = Math.round(hit.pickedPoint.x / 2) * 2;
      const z = Math.round(hit.pickedPoint.z / 2) * 2;
      this.ghost.position.set(x, heightAt(x, z), z);
      this.ghostPos = new Vector3(x, heightAt(x, z), z);
      this.ghostValid = this.canPlace(this.armed, x, z);
      this.setGhostValid?.(this.ghostValid);
    } else if (pi.type === PointerEventTypes.POINTERTAP) {
      if (pi.event.button === 2) { this.disarm(); return; }
      if (this.ghostValid && this.ghostPos) this.place(this.armed, this.ghostPos.clone());
    }
  }

  // ---- surface placement ----------------------------------------------------

  private onSelect(type: string) {
    const spec = specOf(type);
    if (this.armed?.type === type) { this.disarm(); return; }
    if (this.cash < spec.cost) { this.hud.setStatus(`Not enough cash for ${spec.label} (${fmtMoney(spec.cost)}).`); return; }
    this.arm(spec);
  }

  private arm(spec: BuildingSpec) {
    if (this.ghost) this.ghost.dispose();
    this.armed = spec;
    this.ghost = spec.make(this.scene); this.ghost.parent = this.surfaceRoot;
    this.setGhostValid = ghostify(this.scene, this.ghost, spec.fw, spec.fd);
    this.camera.detachControl();
    this.hud.setArmed(spec.type);
    this.hud.setStatus(`Placing ${spec.label} — click the graded pad. Right-click to cancel.`);
  }

  private disarm() {
    this.armed = null;
    this.ghost?.dispose(); this.ghost = null; this.ghostPos = null; this.setGhostValid = null;
    this.camera.attachControl(this.canvas, true);
    this.hud.setArmed(null);
  }

  private canPlace(spec: BuildingSpec, x: number, z: number): boolean {
    if (Math.hypot(x, z) > PAD_RADIUS - Math.max(spec.fw, spec.fd) * 0.35) return false;
    for (const b of this.buildings) {
      const gap = 3;
      if (Math.abs(x - b.pos.x) < (spec.fw + b.spec.fw) / 2 + gap &&
          Math.abs(z - b.pos.z) < (spec.fd + b.spec.fd) / 2 + gap) return false;
    }
    return true;
  }

  private place(spec: BuildingSpec, at: Vector3) {
    const root = spec.make(this.scene, (m) => this.shadow.addShadowCaster(m));
    root.parent = this.surfaceRoot; root.position.copyFrom(at);
    this.cash -= spec.cost;
    this.buildings.push({ spec, root, pos: at, marker: null });
    if (spec.spawnsWorkers) this.crew.add(spec.spawnsWorkers);
    if (spec.spawnsTrucks) { this.fleet.clear(); this.fleet.add(spec.spawnsTrucks, at, this.portal); }
    this.recomputePower();
    this.hud.setStatus(`${spec.label} built.` + (spec.type === "power" ? " It powers everything nearby." : ""));
    if (this.cash >= spec.cost) this.arm(spec); else this.disarm();
  }

  private recomputePower() {
    const sources = this.buildings.filter((b) => b.spec.powerRadius);
    this.powered = 0;
    for (const b of this.buildings) {
      const ok = !b.spec.needsPower || sources.some((s) => Vector3.Distance(s.pos, b.pos) <= (s.spec.powerRadius ?? 0));
      this.updateMarker(b, !ok && b.spec.needsPower);
      if (ok) this.powered++;
    }
    this.total = this.buildings.length;
    this.updateEconomy();
  }

  private updateEconomy() { this.hud.setEconomy(this.cash, this.powered, this.total); }

  private updateMarker(b: Placed, showRed: boolean) {
    if (showRed && !b.marker) {
      const s = MeshBuilder.CreateSphere("nopwr", { diameter: 2, segments: 8 }, this.scene);
      const m = new StandardMaterial("nopwrM", this.scene);
      m.diffuseColor = Color3.FromHexString("#ff5a5a"); m.emissiveColor = Color3.FromHexString("#ff3030"); m.specularColor = Color3.Black();
      s.material = m; s.position.set(b.pos.x, b.pos.y + b.spec.markerY + 3, b.pos.z); s.parent = this.surfaceRoot;
      b.marker = s;
    } else if (!showRed && b.marker) { b.marker.dispose(); b.marker = null; }
  }

  // ---- underground: stope panel + actions -----------------------------------

  private selectStope(st: StopeUG) {
    this.underground.select(st);
    this.selectedStope = st;
    this.renderStopePanel();
  }

  private renderStopePanel() {
    const st = this.selectedStope; if (!st) return;
    const head = staticHeadMpa(st.depthM);
    const head2 = `Static head ρgh: <b>${head.toFixed(1)} MPa</b>`;
    const meta = `<div class="pMeta">−${st.depthM} m · ${st.volumeM3.toLocaleString()} m³ · run ${Math.round(st.lengthM)} m<br>${head2}</div>`;
    let body = "";
    if (st.state === "empty") {
      const noChoke = this.underground.preview(st, false);
      const withChoke = this.underground.preview(st, true);
      const opt = (label: string, p: ReturnType<Underground["preview"]>, act: string, extra = 0) => p.cls
        ? `<button class="pBtn" data-act="${act}"><b>${label}: ${p.cls.name}</b><span>needs ${p.reqMpa.toFixed(1)} MPa · ${fmtMoney(p.cost + extra)}</span></button>`
        : `<button class="pBtn" disabled><b>${label}: exceeds Sch 120</b><span>too much head</span></button>`;
      body = `
        ${opt("Reticulate", noChoke, "reticulate")}
        ${opt("With choke station", withChoke, "reticulate-choke", CHOKE_CAPEX)}
        <div class="pNote">Deeper stopes carry more static head, forcing a stronger pipe class. A choke station burns off head so a cheaper class survives.</div>`;
    } else if (st.state === "piped") {
      const cost = fillCost(st.volumeM3), rev = fillRevenue(st.volumeM3);
      body = `
        <div class="pRow">Reticulated · <b>${st.cls?.name}</b>${st.choke ? " + choke" : ""}</div>
        <button class="pBtn primary" data-act="fill"><b>Fill stope</b><span>paste ${fmtMoney(cost)} → unlocks ${fmtMoney(rev)} ore access</span></button>`;
    } else {
      body = `<div class="pRow good">✓ Filled — curing. Ore access unlocked.</div>`;
    }
    this.hud.setPanel(`<div class="pHead">${st.id} <span data-act="close" class="pClose">✕</span></div>${meta}${body}`);
  }

  private onPanelAction(act: string) {
    const st = this.selectedStope;
    if (act === "close") { this.underground.select(null); this.selectedStope = null; this.hud.setPanel(`<div class="panelHint">Click a stope to reticulate and fill it.</div>`); return; }
    if (!st) return;
    if (act === "reticulate" || act === "reticulate-choke") {
      const choke = act === "reticulate-choke";
      const p = this.underground.preview(st, choke);
      if (!p.cls) { this.hud.setStatus("Too much static head for Sch 120 — add a choke station."); return; }
      const total = p.cost + (choke ? CHOKE_CAPEX : 0);
      if (this.cash < total) { this.hud.setStatus(`Not enough cash to reticulate ${st.id} (${fmtMoney(total)}).`); return; }
      this.underground.reticulate(st, choke);
      this.cash -= total; this.updateEconomy(); this.renderStopePanel();
      this.hud.setStatus(`${st.id} reticulated in ${p.cls.name}${choke ? " with a choke station" : ""} — ${fmtMoney(total)}.`);
    } else if (act === "fill") {
      if (st.state !== "piped") return;
      const cost = fillCost(st.volumeM3), rev = fillRevenue(st.volumeM3);
      this.underground.fill(st);
      this.cash += rev - cost; this.updateEconomy(); this.renderStopePanel();
      this.hud.setStatus(`${st.id} filled — paste ${fmtMoney(cost)}, ore access ${fmtMoney(rev)} unlocked.`);
    }
  }

  /** Debug/testing hooks. */
  debugBuild(type: string, x: number, z: number) { const spec = specOf(type); this.place(spec, new Vector3(x, heightAt(x, z), z)); this.disarm(); }
  debugDescend() { this.descend(); }
  debugStope(i: number, choke = false) { const st = this.underground.stopes[i]; this.selectStope(st); this.underground.reticulate(st, choke); this.underground.fill(st); }
}

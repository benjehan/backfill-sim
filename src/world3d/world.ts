// The 3D surface world: RTS camera over low-poly terrain where you lay out a
// backfill operation — power, plant, equipment, haulage and people. The pure-TS
// sim core in ../sim stays the "brain" and wires in as the world grows.
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
import "@babylonjs/core/Culling/ray"; // enables scene.pick
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { createTerrain, heightAt, PAD_RADIUS } from "./terrain.js";
import { ghostify } from "./buildings.js";
import { CATALOG, specOf, type BuildingSpec } from "./catalog.js";
import { WorkerCrew } from "./workers.js";
import { TruckFleet } from "./trucks.js";
import { Hud } from "./hud.js";

const SKY = "#8ec5e6";

interface Placed { spec: BuildingSpec; root: TransformNode; pos: Vector3; marker: Mesh | null; }

export class World {
  private engine!: Engine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private shadow!: ShadowGenerator;
  private ground!: Mesh;
  private crew!: WorkerCrew;
  private fleet!: TruckFleet;
  private hud!: Hud;
  private canvas!: HTMLCanvasElement;
  private portal!: Vector3;

  private cash = 500_000;
  private buildings: Placed[] = [];

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
    this.scene.clearColor = new Color4(0.556, 0.772, 0.902, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogColor = Color3.FromHexString(SKY);
    this.scene.fogDensity = 0.0032;

    this.setupCamera();
    this.setupLights();
    this.ground = createTerrain(this.scene);
    this.portal = this.createPortal();
    this.crew = new WorkerCrew(this.scene, 5, PAD_RADIUS - 6, (m) => this.shadow.addShadowCaster(m));
    this.fleet = new TruckFleet(this.scene, (m) => this.shadow.addShadowCaster(m));

    this.hud = new Hud(this.root, (t) => this.onSelect(t));
    this.hud.setEconomy(this.cash, 0, 0);

    this.scene.onPointerObservable.add((pi) => this.onPointer(pi));
    this.engine.runRenderLoop(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      this.crew.update(dt);
      this.fleet.update(dt);
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
    (window as any).__world = this;
  }

  private setupCamera() {
    const cam = new ArcRotateCamera("cam", -Math.PI * 0.72, 0.86, 96, new Vector3(0, 4, 0), this.scene);
    cam.attachControl(this.canvas, true);
    cam.lowerRadiusLimit = 40;
    cam.upperRadiusLimit = 210;
    cam.lowerBetaLimit = 0.25;
    cam.upperBetaLimit = 1.35;
    cam.wheelPrecision = 1.6;
    cam.panningSensibility = 26;
    cam.panningDistanceLimit = 150;
    cam.panningInertia = 0.6;
    this.camera = cam;
  }

  private setupLights() {
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.72;
    hemi.groundColor = Color3.FromHexString("#42502f");
    const sun = new DirectionalLight("sun", new Vector3(-0.6, -1, -0.4), this.scene);
    sun.position = new Vector3(90, 140, 70);
    sun.intensity = 1.12;
    this.shadow = new ShadowGenerator(1024, sun);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = 16;
  }

  private createPortal(): Vector3 {
    const x = -64, z = 10;
    const y = heightAt(x, z);
    const mat = (hex: string) => { const m = new StandardMaterial("pm", this.scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black(); return m; };
    const frame = MeshBuilder.CreateBox("adit", { width: 11, height: 8, depth: 3 }, this.scene);
    frame.material = mat("#5a5148"); frame.position.set(x, y + 3.5, z); this.shadow.addShadowCaster(frame);
    const mouth = MeshBuilder.CreateBox("aditMouth", { width: 6.5, height: 5.5, depth: 1.2 }, this.scene);
    mouth.material = mat("#14181d"); mouth.position.set(x, y + 3, z + 1.3);
    const apron = MeshBuilder.CreateGround("aditApron", { width: 12, height: 14 }, this.scene);
    apron.material = mat("#6b6256"); apron.position.set(x + 5, y + 0.1, z);
    return new Vector3(x + 7, y, z);
  }

  // ---- placement ------------------------------------------------------------

  private onSelect(type: string) {
    const spec = specOf(type);
    if (this.armed?.type === type) { this.disarm(); return; }
    if (this.cash < spec.cost) { this.hud.setStatus(`Not enough cash for ${spec.label} ($${(spec.cost / 1000).toFixed(0)}k).`); return; }
    this.arm(spec);
  }

  private arm(spec: BuildingSpec) {
    if (this.ghost) this.ghost.dispose();
    this.armed = spec;
    this.ghost = spec.make(this.scene);
    this.setGhostValid = ghostify(this.scene, this.ghost, spec.fw, spec.fd);
    this.camera.detachControl();
    this.hud.setArmed(spec.type);
    this.hud.setStatus(`Placing ${spec.label} — click the graded pad. Right-click to cancel.`);
  }

  private disarm() {
    this.armed = null;
    this.ghost?.dispose(); this.ghost = null;
    this.ghostPos = null;
    this.setGhostValid = null;
    this.camera.attachControl(this.canvas, true);
    this.hud.setArmed(null);
  }

  private onPointer(pi: { type: number; event: { button?: number } }) {
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

  private canPlace(spec: BuildingSpec, x: number, z: number): boolean {
    if (Math.hypot(x, z) > PAD_RADIUS - Math.max(spec.fw, spec.fd) * 0.35) return false; // stay on the pad
    for (const b of this.buildings) {
      const gap = 3;
      if (Math.abs(x - b.pos.x) < (spec.fw + b.spec.fw) / 2 + gap &&
          Math.abs(z - b.pos.z) < (spec.fd + b.spec.fd) / 2 + gap) return false; // overlap
    }
    return true;
  }

  private place(spec: BuildingSpec, at: Vector3) {
    const root = spec.make(this.scene, (m) => this.shadow.addShadowCaster(m));
    root.position.copyFrom(at);
    this.cash -= spec.cost;
    this.buildings.push({ spec, root, pos: at, marker: null });

    if (spec.spawnsWorkers) this.crew.add(spec.spawnsWorkers);
    if (spec.spawnsTrucks) { this.fleet.clear(); this.fleet.add(spec.spawnsTrucks, at, this.portal); }

    this.recomputePower();
    this.hud.setStatus(`${spec.label} built.` + (spec.type === "power" ? " It powers everything nearby." : ""));

    // stay armed for rapid building if still affordable, else drop the tool
    if (this.cash >= spec.cost) this.arm(spec); else this.disarm();
  }

  /** Debug/testing hook: place a building directly, bypassing pointer interaction. */
  debugBuild(type: string, x: number, z: number) {
    const spec = specOf(type);
    this.place(spec, new Vector3(x, heightAt(x, z), z));
    this.disarm();
  }

  private recomputePower() {
    const sources = this.buildings.filter((b) => b.spec.powerRadius);
    let powered = 0;
    for (const b of this.buildings) {
      const ok = !b.spec.needsPower || sources.some((s) => Vector3.Distance(s.pos, b.pos) <= (s.spec.powerRadius ?? 0));
      this.updateMarker(b, !ok && b.spec.needsPower);
      if (ok) powered++;
    }
    this.hud.setEconomy(this.cash, powered, this.buildings.length);
  }

  private updateMarker(b: Placed, showRed: boolean) {
    if (showRed && !b.marker) {
      const s = MeshBuilder.CreateSphere("nopwr", { diameter: 2, segments: 8 }, this.scene);
      const m = new StandardMaterial("nopwrM", this.scene);
      m.diffuseColor = Color3.FromHexString("#ff5a5a");
      m.emissiveColor = Color3.FromHexString("#ff3030");
      m.specularColor = Color3.Black();
      s.material = m;
      s.position.set(b.pos.x, b.pos.y + b.spec.markerY + 3, b.pos.z);
      b.marker = s;
    } else if (!showRed && b.marker) {
      b.marker.dispose(); b.marker = null;
    }
  }
}

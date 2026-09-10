// The 3D surface world: an RTS-camera view over low-poly terrain where you site
// the backfill plant and watch the crew move. This is the new shell; the pure-TS
// sim core in ../sim stays the "brain" and will wire in as the world grows.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import "@babylonjs/core/Culling/ray"; // enables scene.pick
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { createTerrain, heightAt, PAD_RADIUS } from "./terrain.js";
import { createPlant, createPlantGhost } from "./buildings.js";
import { WorkerCrew } from "./workers.js";
import { Hud } from "./hud.js";

const SKY = "#8ec5e6";
const PLACE_LIMIT = PAD_RADIUS - 10; // keep the footprint inside the graded pad

export class World {
  private engine!: Engine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private shadow!: ShadowGenerator;
  private ground!: Mesh;
  private crew!: WorkerCrew;
  private hud!: Hud;
  private canvas!: HTMLCanvasElement;

  private armed = false;
  private built = false;
  private ghost: { root: TransformNode; setValid: (ok: boolean) => void } | null = null;
  private ghostPoint: Vector3 | null = null;
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
    this.scene.fogDensity = 0.0035;

    this.setupCamera();
    this.setupLights();
    this.ground = createTerrain(this.scene);
    this.crew = new WorkerCrew(this.scene, 7, PAD_RADIUS - 4, (m) => this.shadow.addShadowCaster(m));
    this.hud = new Hud(this.root, () => this.toggleBuild());

    this.scene.onPointerObservable.add((pi) => this.onPointer(pi));

    this.engine.runRenderLoop(() => {
      const dt = this.engine.getDeltaTime() / 1000;
      this.crew.update(Math.min(dt, 0.1));
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
    (window as any).__world = this;
  }

  private setupCamera() {
    const cam = new ArcRotateCamera("cam", -Math.PI * 0.75, 0.95, 150, new Vector3(0, 0, 0), this.scene);
    cam.attachControl(this.canvas, true);
    cam.lowerRadiusLimit = 45;
    cam.upperRadiusLimit = 260;
    cam.lowerBetaLimit = 0.25;
    cam.upperBetaLimit = 1.35; // stay above the horizon
    cam.wheelPrecision = 1.4;
    cam.panningSensibility = 28;
    cam.panningDistanceLimit = 170;
    cam.panningInertia = 0.6;
    cam.useAutoRotationBehavior = false;
    this.camera = cam;
  }

  private setupLights() {
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.7;
    hemi.groundColor = Color3.FromHexString("#42502f");
    const sun = new DirectionalLight("sun", new Vector3(-0.6, -1, -0.4), this.scene);
    sun.position = new Vector3(90, 140, 70);
    sun.intensity = 1.15;
    this.shadow = new ShadowGenerator(1024, sun);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = 16;
  }

  // ---- build placement ------------------------------------------------------

  private toggleBuild() {
    if (this.built) return;
    this.armed ? this.disarm() : this.arm();
  }

  private arm() {
    this.armed = true;
    this.ghost = createPlantGhost(this.scene);
    this.camera.detachControl(); // free the left button for placement clicks
    this.hud.setArmed(true);
  }

  private disarm() {
    this.armed = false;
    this.ghost?.root.dispose();
    this.ghost = null;
    this.ghostPoint = null;
    this.camera.attachControl(this.canvas, true);
    this.hud.setArmed(false);
  }

  private onPointer(pi: { type: number; event: { button?: number } }) {
    if (!this.armed) return;
    if (pi.type === PointerEventTypes.POINTERMOVE) {
      const hit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.ground);
      if (!hit?.pickedPoint || !this.ghost) return;
      const x = Math.round(hit.pickedPoint.x / 2) * 2;
      const z = Math.round(hit.pickedPoint.z / 2) * 2;
      this.ghost.root.position.set(x, heightAt(x, z), z);
      this.ghostPoint = new Vector3(x, heightAt(x, z), z);
      this.ghostValid = Math.hypot(x, z) < PLACE_LIMIT;
      this.ghost.setValid(this.ghostValid);
    } else if (pi.type === PointerEventTypes.POINTERTAP) {
      if (pi.event.button === 2) { this.disarm(); return; } // right-click cancels
      if (this.ghostValid && this.ghostPoint) this.placePlant(this.ghostPoint);
    }
  }

  private placePlant(at: Vector3) {
    const plant = createPlant(this.scene, (m) => this.shadow.addShadowCaster(m));
    plant.position.copyFrom(at);
    this.built = true;
    this.disarm();
    this.hud.setBuilt();
  }
}

// Low-poly surface structures, composed from primitives. Each factory builds
// under a fresh root at local origin; the caller positions the root. A generic
// ghostify() turns any built root into a translucent placement preview.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

function mat(scene: Scene, hex: string): StandardMaterial {
  const m = new StandardMaterial("m", scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = Color3.Black();
  return m;
}

type Build = (scene: Scene, onMesh?: (m: Mesh) => void) => TransformNode;

const box = (scene: Scene, name: string, w: number, h: number, d: number, hex: string) => {
  const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  m.material = mat(scene, hex);
  return m;
};
const cyl = (scene: Scene, name: string, dia: number, h: number, hex: string, tess = 16) => {
  const m = MeshBuilder.CreateCylinder(name, { diameter: dia, height: h, tessellation: tess }, scene);
  m.material = mat(scene, hex);
  return m;
};

function rootOf(scene: Scene, name: string, parts: (r: TransformNode) => Mesh[], onMesh?: (m: Mesh) => void): TransformNode {
  const root = new TransformNode(name, scene);
  for (const m of parts(root)) { m.parent = root; onMesh?.(m); }
  return root;
}

// ---- the backfill plant ----------------------------------------------------
export const createPlant: Build = (scene, onMesh) =>
  rootOf(scene, "plant", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "pad", 28, 1, 22, "#8a8f96"); pad.position.y = 0.5; parts.push(pad);
    const shed = box(scene, "shed", 15, 8, 11, "#b7bcc2"); shed.position.set(-5, 5, 0); parts.push(shed);
    const roof = box(scene, "roof", 15.6, 1, 11.6, "#e0a52e"); roof.position.set(-5, 9.3, 0); parts.push(roof);
    for (let i = 0; i < 3; i++) {
      const silo = cyl(scene, "silo" + i, 3.4, 13, "#d9d2bd", 12); silo.position.set(6.5, 7.5, -5 + i * 4); parts.push(silo);
      const cap = MeshBuilder.CreateCylinder("cap" + i, { diameterTop: 0, diameterBottom: 3.6, height: 1.6, tessellation: 12 }, scene);
      cap.material = mat(scene, "#d9d2bd"); cap.position.set(6.5, 14.8, -5 + i * 4); parts.push(cap);
    }
    const tank = cyl(scene, "thickener", 13, 4, "#5b7d8c", 20); tank.position.set(-9, 3, 6.5); parts.push(tank);
    const tower = cyl(scene, "headframe", 3.2, 18, "#4c5a66", 4); tower.rotation.y = Math.PI / 4; tower.position.set(10, 9.5, 6); parts.push(tower);
    const wheel = MeshBuilder.CreateTorus("wheel", { diameter: 4, thickness: 0.6, tessellation: 20 }, scene);
    wheel.material = mat(scene, "#ffb020"); wheel.rotation.x = Math.PI / 2; wheel.position.set(10, 18.5, 6); parts.push(wheel);
    return parts;
  }, onMesh);

// ---- power station ----------------------------------------------------------
export const createPowerStation: Build = (scene, onMesh) =>
  rootOf(scene, "power", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "ppad", 18, 1, 13, "#7d8288"); pad.position.y = 0.5; parts.push(pad);
    const hall = box(scene, "hall", 11, 7, 9, "#9aa0a6"); hall.position.set(-2, 4, 0); parts.push(hall);
    const roof = box(scene, "proof", 11.4, 0.8, 9.4, "#c04a3a"); roof.position.set(-2, 7.8, 0); parts.push(roof);
    const stack = cyl(scene, "stack", 2.6, 16, "#c7ccd1", 14); stack.position.set(5, 8.5, -2); parts.push(stack);
    const band = cyl(scene, "band", 2.8, 2, "#c04a3a", 14); band.position.set(5, 14, -2); parts.push(band);
    const trafo = box(scene, "trafo", 3, 3, 3, "#556170"); trafo.position.set(5, 2, 4); parts.push(trafo);
    return parts;
  }, onMesh);

// ---- thickener (standalone equipment) --------------------------------------
export const createThickener: Build = (scene, onMesh) =>
  rootOf(scene, "thickenerU", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "tpad", 15, 1, 15, "#7d8288"); pad.position.y = 0.5; parts.push(pad);
    const tank = cyl(scene, "ttank", 13, 5, "#5b7d8c", 24); tank.position.set(0, 3.5, 0); parts.push(tank);
    const col = cyl(scene, "tcol", 1.2, 9, "#c7ccd1", 10); col.position.set(0, 6, 0); parts.push(col);
    const bridge = box(scene, "tbridge", 14, 0.6, 1, "#8a8f96"); bridge.position.set(0, 6.5, 0); parts.push(bridge);
    return parts;
  }, onMesh);

// ---- binder silos ----------------------------------------------------------
export const createSilos: Build = (scene, onMesh) =>
  rootOf(scene, "silos", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "spad", 13, 1, 10, "#7d8288"); pad.position.y = 0.5; parts.push(pad);
    for (let i = 0; i < 3; i++) {
      const silo = cyl(scene, "bsilo" + i, 3.6, 14, "#d9d2bd", 12); silo.position.set(-4 + i * 4, 8, 0); parts.push(silo);
      const cap = MeshBuilder.CreateCylinder("bcap" + i, { diameterTop: 0, diameterBottom: 3.8, height: 1.6, tessellation: 12 }, scene);
      cap.material = mat(scene, "#cfc7ad"); cap.position.set(-4 + i * 4, 15.6, 0); parts.push(cap);
    }
    return parts;
  }, onMesh);

// ---- truck workshop (haulage depot) ----------------------------------------
export const createWorkshop: Build = (scene, onMesh) =>
  rootOf(scene, "workshop", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "wpad", 18, 1, 14, "#6f7378"); pad.position.y = 0.5; parts.push(pad);
    const shed = box(scene, "wshed", 16, 7, 11, "#b0662f"); shed.position.set(0, 4, 0); parts.push(shed);
    const roof = box(scene, "wroof", 16.6, 0.8, 11.6, "#7a4620"); roof.position.set(0, 7.6, 0); parts.push(roof);
    const door = box(scene, "wdoor", 5, 5, 0.4, "#2c3138"); door.position.set(0, 3, 5.6); parts.push(door);
    return parts;
  }, onMesh);

// ---- miners' dry (people building) -----------------------------------------
export const createDry: Build = (scene, onMesh) =>
  rootOf(scene, "dry", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "dpad", 14, 1, 10, "#7d8288"); pad.position.y = 0.5; parts.push(pad);
    const hall = box(scene, "dhall", 12, 5, 8, "#cdd3d8"); hall.position.set(0, 3, 0); parts.push(hall);
    const roof = box(scene, "droof", 12.4, 0.8, 8.4, "#3f7bb0"); roof.position.set(0, 5.6, 0); parts.push(roof);
    for (let i = 0; i < 3; i++) { const win = box(scene, "dwin" + i, 1.6, 1.6, 0.3, "#2b3a48"); win.position.set(-3.5 + i * 3.5, 3.2, 4.1); parts.push(win); }
    return parts;
  }, onMesh);

// ---- generic ghost ---------------------------------------------------------
/** Turn a built root into a translucent ghost with a validity footprint disc. */
export function ghostify(scene: Scene, root: TransformNode, fw: number, fd: number): (ok: boolean) => void {
  root.getChildMeshes().forEach((m) => {
    const src = m.material as StandardMaterial | null;
    const g = new StandardMaterial("gh", scene);
    g.diffuseColor = src ? src.diffuseColor : Color3.White();
    g.specularColor = Color3.Black();
    g.alpha = 0.5;
    m.material = g;
    m.isPickable = false;
  });
  const disc = MeshBuilder.CreateGround("gpad", { width: fw + 4, height: fd + 4 }, scene);
  disc.parent = root; disc.position.y = 0.2; disc.isPickable = false;
  const dm = new StandardMaterial("gpadm", scene); dm.specularColor = Color3.Black(); dm.alpha = 0.4; disc.material = dm;
  const setValid = (ok: boolean) => {
    dm.diffuseColor = ok ? Color3.FromHexString("#39d98a") : Color3.FromHexString("#ff5a5a");
    dm.emissiveColor = ok ? Color3.FromHexString("#1c6b45") : Color3.FromHexString("#7a1f1f");
  };
  setValid(true);
  return setValid;
}

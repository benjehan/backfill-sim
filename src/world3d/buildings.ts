// Low-poly surface backfill plant, composed from primitives so it reads as a
// recognizable mine plant: process shed, binder silos, thickener tank, and a
// headframe with a hoist wheel over the shaft.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

export const PLANT_FOOTPRINT = { w: 28, d: 22 };

function mat(scene: Scene, name: string, hex: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = Color3.Black();
  return m;
}

/** Build the plant under a fresh root node at local origin. Caller positions the root. */
export function createPlant(scene: Scene, onMesh?: (m: Mesh) => void): TransformNode {
  const root = new TransformNode("plant", scene);
  const parts: { mesh: Mesh }[] = [];
  const add = (m: Mesh) => { m.parent = root; parts.push({ mesh: m }); onMesh?.(m); return m; };

  const concrete = mat(scene, "concrete", "#8a8f96");
  const steel = mat(scene, "steel", "#4c5a66");
  const shedMat = mat(scene, "shed", "#b7bcc2");
  const roofMat = mat(scene, "roof", "#e0a52e");
  const siloMat = mat(scene, "silo", "#d9d2bd");
  const tankMat = mat(scene, "tank", "#5b7d8c");
  const amber = mat(scene, "amber", "#ffb020");

  // concrete pad
  const pad = MeshBuilder.CreateBox("pad", { width: PLANT_FOOTPRINT.w, depth: PLANT_FOOTPRINT.d, height: 1 }, scene);
  pad.position.y = 0.5; pad.material = concrete; add(pad);

  // process shed + roof
  const shed = MeshBuilder.CreateBox("shed", { width: 15, height: 8, depth: 11 }, scene);
  shed.position.set(-5, 5, 0); shed.material = shedMat; add(shed);
  const roof = MeshBuilder.CreateBox("roof", { width: 15.6, height: 1, depth: 11.6 }, scene);
  roof.position.set(-5, 9.3, 0); roof.material = roofMat; add(roof);

  // binder silos (cylinder body + cone top)
  for (let i = 0; i < 3; i++) {
    const silo = MeshBuilder.CreateCylinder(`silo${i}`, { diameter: 3.4, height: 13, tessellation: 12 }, scene);
    silo.position.set(6.5, 7.5, -5 + i * 4); silo.material = siloMat; add(silo);
    const cap = MeshBuilder.CreateCylinder(`siloCap${i}`, { diameterTop: 0, diameterBottom: 3.6, height: 1.6, tessellation: 12 }, scene);
    cap.position.set(6.5, 14.8, -5 + i * 4); cap.material = siloMat; add(cap);
  }

  // thickener tank (wide short cylinder)
  const tank = MeshBuilder.CreateCylinder("thickener", { diameter: 13, height: 4, tessellation: 20 }, scene);
  tank.position.set(-9, 3, 6.5); tank.material = tankMat; add(tank);

  // headframe over the shaft + hoist wheel
  const tower = MeshBuilder.CreateCylinder("headframe", { diameter: 3.2, height: 18, tessellation: 4 }, scene);
  tower.rotation.y = Math.PI / 4; tower.position.set(10, 9.5, 6); tower.material = steel; add(tower);
  const wheel = MeshBuilder.CreateTorus("hoistWheel", { diameter: 4, thickness: 0.6, tessellation: 20 }, scene);
  wheel.rotation.x = Math.PI / 2; wheel.position.set(10, 18.5, 6); wheel.material = amber; add(wheel);

  return root;
}

/** A translucent ghost of the plant plus a validity footprint disc, for placement. */
export function createPlantGhost(scene: Scene): { root: TransformNode; setValid: (ok: boolean) => void } {
  const root = createPlant(scene);
  root.getChildMeshes().forEach((m) => {
    const src = m.material as StandardMaterial | null;
    const g = new StandardMaterial(m.name + "Ghost", scene);
    g.diffuseColor = src ? src.diffuseColor : Color3.White();
    g.specularColor = Color3.Black();
    g.alpha = 0.5;
    m.material = g;
    m.isPickable = false;
  });

  const disc = MeshBuilder.CreateGround("ghostPad", { width: PLANT_FOOTPRINT.w + 4, height: PLANT_FOOTPRINT.d + 4 }, scene);
  disc.parent = root; disc.position.y = 0.15; disc.isPickable = false;
  const discMat = new StandardMaterial("ghostPadMat", scene);
  discMat.specularColor = Color3.Black();
  discMat.alpha = 0.35;
  disc.material = discMat;

  const setValid = (ok: boolean) => {
    discMat.diffuseColor = ok ? Color3.FromHexString("#39d98a") : Color3.FromHexString("#ff5a5a");
    discMat.emissiveColor = ok ? Color3.FromHexString("#1c6b45") : Color3.FromHexString("#7a1f1f");
  };
  setValid(true);
  return { root, setValid };
}

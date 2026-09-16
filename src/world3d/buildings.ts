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

// ---- inbound supply: mill (tailings), rail terminal (binder), water pump ----
export const createMill: Build = (scene, onMesh) =>
  rootOf(scene, "mill", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "mpad", 20, 1, 14, "#6f7378"); pad.position.y = 0.5; parts.push(pad);
    const hall = box(scene, "mhall", 16, 9, 11, "#8a8f96"); hall.position.set(-1, 5, 0); parts.push(hall);
    const roof = box(scene, "mroof", 16.4, 0.8, 11.4, "#c04a3a"); roof.position.set(-1, 9.8, 0); parts.push(roof);
    const drum = cyl(scene, "mdrum", 4, 8, "#4c5a66", 14); drum.rotation.z = Math.PI / 2; drum.position.set(8, 4, 0); parts.push(drum); // SAG mill drum
    return parts;
  }, onMesh);

export const createRail: Build = (scene, onMesh) =>
  rootOf(scene, "rail", () => {
    const parts: Mesh[] = [];
    const bed = box(scene, "rbed", 24, 0.6, 6, "#5a5148"); bed.position.y = 0.3; parts.push(bed);
    for (const rz of [-1.4, 1.4]) { const r = box(scene, "rrail", 24, 0.3, 0.4, "#2c3138"); r.position.set(0, 0.7, rz); parts.push(r); }
    const silo = cyl(scene, "rsilo", 4.4, 12, "#d9d2bd", 12); silo.position.set(6, 6.5, 0); parts.push(silo);
    const car = box(scene, "rcar", 6, 3, 3, "#b0662f"); car.position.set(-7, 2, 0); parts.push(car); // rail car
    return parts;
  }, onMesh);

// Controlled slurry pond: a lined, bunded cell for reactive (PAG/reagent) reject.
export const createControlled: Build = (scene, onMesh) =>
  rootOf(scene, "controlled", () => {
    const parts: Mesh[] = [];
    const berm = box(scene, "cberm", 24, 2.4, 24, "#5a5148"); berm.position.y = 1.2; parts.push(berm);
    const liner = box(scene, "cliner", 20, 0.4, 20, "#2b3a44"); liner.position.y = 2.2; parts.push(liner); // HDPE liner
    const slurry = box(scene, "cslurry", 18, 1.2, 18, "#6b5a3f"); slurry.position.y = 2.6; parts.push(slurry);
    const pipe = cyl(scene, "cpipe", 1, 8, "#4c5a66", 8); pipe.rotation.z = Math.PI / 2; pipe.position.set(-13, 3, 0); parts.push(pipe);
    return parts;
  }, onMesh);

// Road haulage depot: a binder silo fed by tanker trucks (low capex, pricier binder).
export const createHaulage: Build = (scene, onMesh) =>
  rootOf(scene, "haulage", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "hpad", 16, 0.5, 10, "#4a4640"); pad.position.y = 0.25; parts.push(pad);
    const silo = cyl(scene, "hsilo", 4, 10, "#d9d2bd", 12); silo.position.set(3, 5.5, 0); parts.push(silo);
    const cab = box(scene, "htcab", 2.4, 2.2, 2.4, "#c58a2e"); cab.position.set(-5, 1.6, 1.5); parts.push(cab); // tanker
    const tank = cyl(scene, "htank", 2.4, 6, "#b8bcc2", 12); tank.rotation.z = Math.PI / 2; tank.position.set(-5, 1.9, -1.6); parts.push(tank);
    return parts;
  }, onMesh);

// Isotainer pad: stacked dry-binder containers, pneumatically offloaded (remote sites).
export const createIsotainer: Build = (scene, onMesh) =>
  rootOf(scene, "isotainer", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "ipad", 12, 0.5, 10, "#4a4640"); pad.position.y = 0.25; parts.push(pad);
    const cols = ["#3f6653", "#7a6a3f", "#5a4a63"];
    let i = 0;
    for (const [x, z, y] of [[-3, -2, 1.4], [-3, 2, 1.4], [0, 0, 1.4], [0, 0, 3.8]] as const) {
      const c = box(scene, "iso" + i, 5, 2.4, 2.4, cols[i % cols.length]); c.position.set(x, y, z); parts.push(c); i++;
    }
    const silo = cyl(scene, "idose", 2.6, 7, "#d9d2bd", 12); silo.position.set(4, 4, 0); parts.push(silo);
    return parts;
  }, onMesh);

export const createWaterPump: Build = (scene, onMesh) =>
  rootOf(scene, "waterpump", () => {
    const parts: Mesh[] = [];
    const pond = MeshBuilder.CreateCylinder("wpond", { diameter: 11, height: 0.6, tessellation: 20 }, scene);
    pond.material = mat(scene, "#3f7bb0"); pond.position.set(-3, 0.3, 0); parts.push(pond);
    const house = box(scene, "whouse", 6, 4, 5, "#9aa0a6"); house.position.set(5, 2.5, 0); parts.push(house);
    const pipe = cyl(scene, "wpipe", 1, 6, "#4c5a66", 8); pipe.rotation.z = Math.PI / 2; pipe.position.set(1, 3, 0); parts.push(pipe);
    return parts;
  }, onMesh);

// ---- substation: relays power out to distant works -------------------------
export const createSubstation: Build = (scene, onMesh) =>
  rootOf(scene, "substation", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "spad", 8, 0.6, 8, "#6f7378"); pad.position.y = 0.3; parts.push(pad);
    // two transformer cans
    for (const x of [-1.8, 1.8]) {
      const tf = cyl(scene, "stf", 2.4, 3.2, "#5b6570", 10); tf.position.set(x, 2.2, -1); parts.push(tf);
      const lid = cyl(scene, "stflid", 2.6, 0.4, "#454e58", 10); lid.position.set(x, 3.9, -1); parts.push(lid);
    }
    // lattice pylon with a cross-arm + insulators
    const mast = box(scene, "smast", 0.5, 8, 0.5, "#48535e"); mast.position.set(0, 4, 2.2); parts.push(mast);
    const arm = box(scene, "sarm", 6, 0.4, 0.4, "#48535e"); arm.position.set(0, 7.4, 2.2); parts.push(arm);
    for (const x of [-2.4, 0, 2.4]) { const ins = cyl(scene, "sins", 0.5, 1, "#c9cdd2", 6); ins.position.set(x, 6.8, 2.2); parts.push(ins); }
    return parts;
  }, onMesh);

// ---- mine headframe: steel lattice + sheave wheels over the hoisting shaft --
export const createHeadframe: Build = (scene, onMesh) =>
  rootOf(scene, "headframe", () => {
    const parts: Mesh[] = [];
    const steel = "#48535e", dark = "#3a444d";
    // hoist house at the base
    const house = box(scene, "hfhouse", 9, 5, 7, "#8a7f6c"); house.position.set(-8, 2.5, 0); parts.push(house);
    const houseRoof = box(scene, "hfroof", 9.4, 0.6, 7.4, "#5a4d3f"); houseRoof.position.set(-8, 5.3, 0); parts.push(houseRoof);
    // four legs, splayed at the base (back pair vertical, front pair raked)
    const legH = 22;
    const legAt = (x: number, z: number, rake: number) => {
      const leg = box(scene, "hfleg", 0.7, legH, 0.7, steel);
      leg.position.set(x, legH / 2, z); leg.rotation.z = rake; parts.push(leg);
    };
    legAt(-2.4, -2.4, 0.16); legAt(-2.4, 2.4, 0.16);   // front (raked toward the sheave)
    legAt(3.0, -2.4, -0.02); legAt(3.0, 2.4, -0.02);   // back (near-vertical)
    // cross bracing on the two long faces
    for (const z of [-2.4, 2.4]) for (let k = 0; k < 4; k++) {
      const br = box(scene, "hfbr", 6.6, 0.35, 0.35, dark); br.position.set(0.3, 3 + k * 5, z); br.rotation.z = (k % 2 ? 0.5 : -0.5); parts.push(br);
    }
    // head platform + two sheave wheels
    const plat = box(scene, "hfplat", 7, 1, 6, dark); plat.position.set(-0.4, legH + 0.4, 0); parts.push(plat);
    for (const z of [-1.6, 1.6]) {
      const wheel = cyl(scene, "hfwheel", 5, 0.6, "#6d7783", 20); wheel.rotation.x = Math.PI / 2; wheel.position.set(-1.5, legH + 3.4, z); parts.push(wheel);
      const hub = cyl(scene, "hfhub", 1.2, 0.9, "#3a444d", 10); hub.rotation.x = Math.PI / 2; hub.position.set(-1.5, legH + 3.4, z); parts.push(hub);
    }
    // hoist ropes from the sheaves down into the house
    for (const z of [-1.6, 1.6]) { const rope = cyl(scene, "hfrope", 0.14, legH, "#2a323a", 6); rope.position.set(-5, legH / 2 + 2, z); rope.rotation.z = 0.24; parts.push(rope); }
    return parts;
  }, onMesh);

// ---- tailings storage facility: ring embankment, beach, decant pond ---------
// The "tsffill" disc is driven at runtime to rise as the TSF fills; the whole
// root is scaled in Y as the dam is raised in lifts.
export const createTSF: Build = (scene, onMesh) =>
  rootOf(scene, "tsf", () => {
    const parts: Mesh[] = [];
    // ring embankment (upstream-raised dam wall) — a flattened torus reads as a bund
    const emb = MeshBuilder.CreateTorus("tsfemb", { diameter: 34, thickness: 9, tessellation: 22 }, scene);
    emb.material = mat(scene, "#8a7a56"); emb.scaling.y = 0.7; emb.position.y = 3; parts.push(emb);
    const crest = MeshBuilder.CreateTorus("tsfcrest", { diameter: 34, thickness: 4, tessellation: 22 }, scene);
    crest.material = mat(scene, "#9a8a63"); crest.scaling.y = 0.5; crest.position.y = 5; parts.push(crest);
    // beach floor inside the bund (dry deposited tailings)
    const floor = cyl(scene, "tsffloor", 32, 0.6, "#b0a37a", 24); floor.position.y = 1.6; parts.push(floor);
    // the wet tailings/supernatant surface — RAISED at runtime by fill level (named for lookup)
    const fill = cyl(scene, "tsffill", 30, 0.5, "#6f8466", 24); fill.position.y = 1.9; parts.push(fill);
    // decant pond (clarified water) offset to the low end
    const pond = cyl(scene, "tsfpond", 9, 0.35, "#4f6f8a", 20); pond.position.set(8, 2.05, -6); parts.push(pond);
    // spigot delivery ring: header pipe over the crest + drop bars discharging inward
    const header = MeshBuilder.CreateTorus("tsfheader", { diameter: 33, thickness: 0.8, tessellation: 20 }, scene);
    header.material = mat(scene, "#4c5a66"); header.position.y = 5.4; parts.push(header);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const drop = cyl(scene, "tsfspig", 0.7, 3, "#3a444d", 6);
      drop.position.set(Math.cos(a) * 14, 4.3, Math.sin(a) * 14); parts.push(drop);
    }
    return parts;
  }, onMesh);

// ---- crusher plant (aggregate line for CAF) --------------------------------
export const createCrusher: Build = (scene, onMesh) =>
  rootOf(scene, "crusher", () => {
    const parts: Mesh[] = [];
    const pad = box(scene, "cpad", 16, 1, 12, "#6f7378"); pad.position.y = 0.5; parts.push(pad);
    const hopper = MeshBuilder.CreateCylinder("chop", { diameterTop: 6, diameterBottom: 2, height: 6, tessellation: 6 }, scene);
    hopper.material = mat(scene, "#7a5a3a"); hopper.position.set(-4, 4, 0); parts.push(hopper);
    const jaw = box(scene, "cjaw", 6, 6, 6, "#4c5a66"); jaw.position.set(2, 4, 0); parts.push(jaw);
    const belt = box(scene, "cbelt", 11, 0.6, 2.2, "#2c3138"); belt.position.set(6, 3.2, 4); belt.rotation.y = 0.5; parts.push(belt);
    const pile = cyl(scene, "cpile", 7, 3.4, "#9a8763", 8); pile.position.set(10.5, 1.7, 5.5); parts.push(pile);
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

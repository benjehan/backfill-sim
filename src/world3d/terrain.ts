// Surface terrain. A deterministic fbm heightfield, flattened to a build pad near
// the origin, rising into framing hills / mountains / dunes toward the horizon so
// the site sits in a landscape rather than on a floating tile. Smooth-shaded, with
// per-vertex biome colours (grass, sand, rock on steep faces, snow up high) and a
// tiled procedural detail texture for close-up grain. One mesh, one draw.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

export const TERRAIN_SIZE = 720;  // full landscape (fog hides the edge)
export const BUILD_RADIUS = 114;  // furthest a building centre may sit from the origin
export const PAD_RADIUS = 48;     // flat build area around the origin

export type LandType = "hills" | "mountains" | "seaside" | "valley" | "desert";
export const SEA_LEVEL = -1.2; // seaside/wet water plane height
let RELIEF = 1;
let LAND: LandType = "hills";
export function setRelief(m: number) { RELIEF = m; }
export function setLand(l: LandType) { LAND = l; }
export function getLand(): LandType { return LAND; }

// ---- noise -------------------------------------------------------------------
function hash(ix: number, iz: number): number {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
const smooth = (t: number) => t * t * (3 - 2 * t);
export function vnoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smooth(x - ix), fz = smooth(z - iz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
/** Fractal value noise in 0..1. */
export function fbm(x: number, z: number, oct = 5): number {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { v += vnoise(x * f + i * 17.3, z * f - i * 9.1) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
  return v / norm;
}
/** Ridged fbm (sharp crests) in 0..1. */
function ridged(x: number, z: number, oct = 5): number {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(vnoise(x * f + i * 31.7, z * f + i * 5.3) * 2 - 1); v += n * n * amp; norm += amp; amp *= 0.5; f *= 2.1; }
  return v / norm;
}
const sstep = (a: number, b: number, t: number) => { const k = Math.max(0, Math.min(1, (t - a) / (b - a))); return k * k * (3 - 2 * k); };

/** Surface height at world (x,z). Flat within the build pad, biome-shaped beyond,
 *  climbing into a framing ring of high ground past the buildable zone. */
export function heightAt(x: number, z: number): number {
  let h = rawHeight(x, z);
  for (const f of FLATS) { const w = flatWeight(f, x, z); if (w > 0) h += (f.y - h) * w; }
  return h;
}

// Graded benches: building sites cut/filled flat into the slope, with a soft batter.
interface Flat { x: number; z: number; hw: number; hd: number; y: number }
const FLATS: Flat[] = [];
const BATTER = 9; // metres of blended slope around a graded bench
function flatWeight(f: Flat, x: number, z: number): number {
  const e = Math.max(Math.abs(x - f.x) - f.hw, Math.abs(z - f.z) - f.hd);
  return e <= 0 ? 1 : 1 - sstep(0, BATTER, e);
}
function gradedAt(x: number, z: number): number { let w = 0; for (const f of FLATS) w = Math.max(w, flatWeight(f, x, z)); return w; }

function rawHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const n = fbm(x / 70, z / 70);           // rolling ground
  const near = (n - 0.5) * 16;             // gentle relief inside the build ring
  const rim = sstep(140, 340, d);          // 0 inside the site → 1 at the horizon
  let h = near;
  switch (LAND) {
    case "hills": {
      h = near + rim * (8 + fbm(x / 110, z / 110, 4) * 48);
      break;
    }
    case "mountains": {
      const r = ridged(x / 120, z / 120);
      h = near * 1.2 + rim * (25 + r * 120) + sstep(80, 140, d) * r * 14;
      break;
    }
    case "desert": {
      // long wind-aligned dunes near the site, flat-topped mesas toward the horizon
      const dune = Math.sin(x * 0.045 + fbm(x / 60, z / 60) * 5) * 0.5 + 0.5;
      h = (dune * 5 + (n - 0.5) * 6);
      const mesa = fbm(x / 95 + 7, z / 95 - 3, 4);
      const tall = sstep(0.46, 0.58, mesa) * 26 + sstep(0.62, 0.7, mesa) * 12; // stepped buttes
      h += rim * (6 + tall);
      break;
    }
    case "seaside": {
      // land slopes down to a sea on the +z side; hills behind the site on -z
      const behind = sstep(20, -160, z);
      h = near * 0.8 - Math.max(0, z - 30) * 0.14 + rim * behind * (20 + fbm(x / 100, z / 100) * 60);
      break;
    }
    case "valley": {
      h = near * 0.6 + Math.max(0, Math.abs(x) - 70) * 0.3 * (0.6 + fbm(x / 80, z / 80)) + rim * 30 * fbm(x / 120, z / 120);
      break;
    }
  }
  // ramp from flat (0) at the pad edge up to full terrain further out
  const flat = 1 - sstep(PAD_RADIUS, PAD_RADIUS + 55, d);
  return h * (1 - flat) * RELIEF + portalKnoll(x, z);
}

/** The rocky knoll the mine adit is driven into (west of the pad). Its east face
 *  is steep so the concrete portal set reads as tunnelling into the hill. */
export const KNOLL = { x: -88, z: 8, h: 20 };
function portalKnoll(x: number, z: number): number {
  const dx = x - KNOLL.x, dz = z - KNOLL.z;
  const r = Math.hypot(dx * (dx > 0 ? 1.25 : 0.75), dz * 0.9);
  return KNOLL.h * Math.exp(-((r / 19) ** 2)) + (fbm(x / 9, z / 9, 3) - 0.5) * 3 * Math.exp(-((r / 24) ** 2));
}

// ---- colour ------------------------------------------------------------------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function mix(a: Color3, b: Color3, t: number): Color3 {
  t = Math.max(0, Math.min(1, t));
  return new Color3(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t));
}
const C = (h: string) => Color3.FromHexString(h);

interface Palette {
  pad: Color3; padDark: Color3; apron: Color3;
  low: Color3; mid: Color3; dark: Color3; dry: Color3;
  rock: Color3; high?: Color3; snow?: Color3; sand?: Color3;
  snowLine?: number;
}
// Kept for scenario compatibility (older code passes a theme); biome palettes below win.
export interface TerrainTheme { gravel: string; dirt: string; scrub: string; hills: string; rock: string; }

const PALETTES: Record<LandType, Palette> = {
  hills: {
    pad: C("#c2b394"), padDark: C("#a8977a"), apron: C("#a58f68"),
    low: C("#8cc152"), mid: C("#6aa845"), dark: C("#447f37"), dry: C("#b5b35e"),
    rock: C("#9b978c"), high: C("#7d9a58"),
  },
  mountains: {
    pad: C("#b9b3a6"), padDark: C("#9d978b"), apron: C("#948c7c"),
    low: C("#7fae55"), mid: C("#5d9447"), dark: C("#35693a"), dry: C("#a4a766"),
    rock: C("#8e9199"), high: C("#9aa0a8"), snow: C("#f6f9fc"), snowLine: 95,
  },
  desert: {
    pad: C("#e1c898"), padDark: C("#c9ad7c"), apron: C("#d9b27a"),
    low: C("#ecc98c"), mid: C("#e2b475"), dark: C("#c98f55"), dry: C("#d7a96b"),
    rock: C("#b8683f"), high: C("#c7774a"),
  },
  seaside: {
    pad: C("#bfb8a6"), padDark: C("#a39c89"), apron: C("#a3957a"),
    low: C("#7fbf5a"), mid: C("#5fa64a"), dark: C("#3e7f3c"), dry: C("#a8b566"),
    rock: C("#8f9092"), high: C("#77a05e"), sand: C("#ecdcae"),
  },
  valley: {
    pad: C("#c2b394"), padDark: C("#a8977a"), apron: C("#a58f68"),
    low: C("#95c85a"), mid: C("#6fae48"), dark: C("#487f39"), dry: C("#bcb866"),
    rock: C("#9d998e"), high: C("#80a060"),
  },
};

function groundColor(x: number, z: number, h: number, slope: number, p: Palette): Color3 {
  const d = Math.hypot(x, z);
  // irregular pad edge: compacted gravel fades into a worked dirt apron then vegetation
  const edgeN = (fbm(x / 14, z / 14, 3) - 0.5) * 14;
  const padT = sstep(PAD_RADIUS - 6, PAD_RADIUS + 4, d + edgeN);
  const apronT = sstep(PAD_RADIUS + 4, PAD_RADIUS + 22, d + edgeN);

  // vegetation: patchy blend of meadow / grass / forest-dark / dry grass
  const n1 = fbm(x / 38, z / 38, 4), n2 = fbm(x / 13 + 40, z / 13 - 20, 3);
  let veg = mix(p.low, p.mid, sstep(0.35, 0.65, n1));
  veg = mix(veg, p.dark, sstep(0.55, 0.75, fbm(x / 60 - 11, z / 60 + 5, 4)) * 0.9);
  veg = mix(veg, p.dry, sstep(0.62, 0.8, n2) * 0.5);
  if (p.high) veg = mix(veg, p.high, sstep(25, 70, h));
  // rock on steep faces, snow on high flats
  veg = mix(veg, p.rock, sstep(0.45, 0.8, slope));
  if (p.snow && p.snowLine) veg = mix(veg, p.snow, sstep(p.snowLine - 12, p.snowLine + 8, h + fbm(x / 20, z / 20) * 18) * (1 - sstep(0.75, 0.95, slope) * 0.7));
  if (p.sand) veg = mix(veg, p.sand, 1 - sstep(SEA_LEVEL + 0.6, SEA_LEVEL + 2.6, h));

  // pad: warm gravel with darker wheel-worn blotches
  const pad = mix(p.pad, p.padDark, sstep(0.45, 0.7, fbm(x / 9, z / 9, 3)) * 0.8);
  let c = mix(pad, p.apron, padT);
  c = mix(c, veg, apronT);
  // soft cavity darkening in hollows / brightening on crests for a painted look
  const shade = 0.93 + n2 * 0.12;
  return new Color3(c.r * shade, c.g * shade, c.b * shade);
}

/** Tileable grain texture multiplied over the vertex colours (close-up detail). */
function detailTexture(scene: Scene): DynamicTexture {
  const S = 256;
  const tex = new DynamicTexture("terrainDetail", S, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // tileable: sample noise on a torus-ish wrap by using periodic hash coords
    const u = x / S, v = y / S;
    const n = 0.55 * pnoise(u, v, 8) + 0.3 * pnoise(u, v, 32) + 0.15 * pnoise(u, v, 64);
    const g = Math.round(205 + n * 50);
    const i = (y * S + x) * 4;
    img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tex.update(true);
  tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}
/** Periodic value noise on the unit square with `f` cells (tiles seamlessly). */
function pnoise(u: number, v: number, f: number): number {
  const x = u * f, y = v * f;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const h = (a: number, b: number) => hash(((a % f) + f) % f, ((b % f) + f) % f);
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Slope 0 (flat) .. 1 (vertical) at (x,z), by central differences. */
export function slopeAt(x: number, z: number): number {
  const e = 1.5;
  const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  const ny = 1 / Math.sqrt(dx * dx + dz * dz + 1);
  return 1 - ny;
}

let GROUND: Mesh | null = null;
function vertexColor(x: number, z: number, h: number, slope: number): Color3 {
  const p = PALETTES[LAND];
  const c = groundColor(x, z, h, slope * 2.2, p);
  const g = gradedAt(x, z);
  if (g <= 0) return c;
  const earth = mix(p.apron, p.padDark, fbm(x / 7, z / 7, 2));
  return mix(c, earth, g * 0.9);
}

/** Cut a flat bench into the terrain at (x,z) for a building footprint, and
 *  re-sculpt the ground mesh around it so the site really sits on the land. */
export function gradeFlat(x: number, z: number, fw: number, fd: number, y: number) {
  FLATS.push({ x, z, hw: fw / 2 + 3, hd: fd / 2 + 3, y });
  if (!GROUND) return;
  const pos = GROUND.getVerticesData("position")!;
  const col = GROUND.getVerticesData(VertexBuffer.ColorKind)!;
  const R = Math.max(fw, fd) / 2 + 3 + BATTER + 4;
  const touched: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    if (Math.abs(pos[i] - x) > R || Math.abs(pos[i + 2] - z) > R) continue;
    pos[i + 1] = heightAt(pos[i], pos[i + 2]); touched.push(i);
  }
  const normals = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, GROUND.getIndices()!, normals);
  for (const i of touched) {
    const c = vertexColor(pos[i], pos[i + 2], pos[i + 1], 1 - normals[i + 1]);
    const v = (i / 3) * 4; col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b;
  }
  GROUND.updateVerticesData("position", pos);
  GROUND.updateVerticesData("normal", normals);
  GROUND.updateVerticesData(VertexBuffer.ColorKind, col);
  GROUND.refreshBoundingInfo();
}

export function createTerrain(scene: Scene, _theme?: TerrainTheme): Mesh {
  FLATS.length = 0;
  const ground = MeshBuilder.CreateGround(
    "terrain",
    { width: TERRAIN_SIZE, height: TERRAIN_SIZE, subdivisions: 240, updatable: true },
    scene,
  );
  GROUND = ground;
  const pos = ground.getVerticesData("position")!;
  for (let i = 0; i < pos.length; i += 3) pos[i + 1] = heightAt(pos[i], pos[i + 2]);
  ground.updateVerticesData("position", pos);
  const idx = ground.getIndices()!;
  const normals = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, normals);
  ground.updateVerticesData("normal", normals);
  ground.refreshBoundingInfo();
  ground.receiveShadows = true;

  const colors = new Float32Array((pos.length / 3) * 4);
  for (let v = 0, i = 0; i < pos.length; i += 3, v += 4) {
    const c = vertexColor(pos[i], pos[i + 2], pos[i + 1], 1 - normals[i + 1]);
    colors[v] = c.r; colors[v + 1] = c.g; colors[v + 2] = c.b; colors[v + 3] = 1;
  }
  ground.setVerticesData(VertexBuffer.ColorKind, colors, true);

  const mat = new StandardMaterial("terrainMat", scene);
  mat.diffuseColor = Color3.White();   // vertex colours drive the hue
  mat.specularColor = Color3.Black();  // matte ground
  const det = detailTexture(scene);
  det.uScale = TERRAIN_SIZE / 6; det.vScale = TERRAIN_SIZE / 6;
  mat.diffuseTexture = det;
  ground.material = mat;
  return ground;
}

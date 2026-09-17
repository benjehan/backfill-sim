// Low-poly surface terrain. A deterministic layered-sine heightfield, flattened
// to a build pad near the origin, rendered flat-shaded for the faceted look.
// Per-vertex colours zone the ground like a real mine site: a gravel-graded pad,
// a dirt/haul apron, scrub, then greener distant hills — with rockier tints on
// the high faces. Colours are baked into the mesh so it stays one cheap draw.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

export const TERRAIN_SIZE = 240;
export const PAD_RADIUS = 48; // flat build area around the origin

// Per-scenario terrain relief + land type (set at campaign start).
export type LandType = "hills" | "mountains" | "seaside" | "valley" | "desert";
export const SEA_LEVEL = -1.2; // seaside/wet water plane height
let RELIEF = 1;
let LAND: LandType = "hills";
export function setRelief(m: number) { RELIEF = m; }
export function setLand(l: LandType) { LAND = l; }

/** Surface height at world (x,z). Flat within the build pad, biome-shaped beyond. */
export function heightAt(x: number, z: number): number {
  const base =
    Math.sin(x * 0.045) * Math.cos(z * 0.05) * 5 +
    Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.09 + 0.4) * 2.2 +
    Math.sin((x + z) * 0.02) * 3;
  const d = Math.hypot(x, z);
  let h = base;
  switch (LAND) {
    case "mountains": // tall, sharp peaks rising away from the pad
      h = base * 1.4 + Math.max(0, d - 70) * 0.28 + Math.abs(Math.sin(x * 0.03) * Math.sin(z * 0.028)) * 14;
      break;
    case "desert": // gentle long dunes, low relief
      h = Math.sin(x * 0.03) * Math.cos(z * 0.024) * 3 + Math.sin((x - z) * 0.05) * 1.4;
      break;
    case "valley": // a valley through the middle, ridges to the sides (in x)
      h = base * 0.5 + Math.max(0, Math.abs(x) - 60) * 0.32;
      break;
    case "seaside": // land slopes down to a sea on the +z edge
      h = base * 0.8 - Math.max(0, z - 30) * 0.14;
      break;
  }
  // ramp from flat (0) at the pad edge up to full terrain further out
  const flat = 1 - Math.min(1, Math.max(0, (d - PAD_RADIUS) / 55));
  return h * (1 - flat) * RELIEF;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function mix(a: Color3, b: Color3, t: number): Color3 {
  t = Math.max(0, Math.min(1, t));
  return new Color3(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t));
}

export interface TerrainTheme { gravel: string; dirt: string; scrub: string; hills: string; rock: string; }
const DEFAULT_THEME: TerrainTheme = { gravel: "#8f8578", dirt: "#7c6b4c", scrub: "#6f8a4e", hills: "#516d3c", rock: "#948a7a" };

/** Ground colour at (x,z,h) — banded by distance from site, tinted rockier up high. */
function groundColor(x: number, z: number, h: number, t: TerrainTheme): Color3 {
  const C_GRAVEL = Color3.FromHexString(t.gravel), C_DIRT = Color3.FromHexString(t.dirt);
  const C_SCRUB = Color3.FromHexString(t.scrub), C_HILLS = Color3.FromHexString(t.hills), C_ROCK = Color3.FromHexString(t.rock);
  const d = Math.hypot(x, z);
  let c: Color3;
  if (d < PAD_RADIUS) c = C_GRAVEL;
  else if (d < PAD_RADIUS + 18) c = mix(C_GRAVEL, C_DIRT, (d - PAD_RADIUS) / 18);
  else if (d < 92) c = mix(C_DIRT, C_SCRUB, (d - PAD_RADIUS - 18) / (92 - PAD_RADIUS - 18));
  else c = mix(C_SCRUB, C_HILLS, Math.min(1, (d - 92) / 40));
  // rock shows on the higher ground; dither slightly to break up the banding
  c = mix(c, C_ROCK, Math.max(0, Math.min(0.55, (h - 4) / 12)));
  const n = (Math.sin(x * 0.7) * Math.cos(z * 0.6) + Math.sin((x + z) * 0.31)) * 0.5;
  return mix(c, new Color3(c.r * 0.9, c.g * 0.9, c.b * 0.9), (n + 1) * 0.12);
}

export function createTerrain(scene: Scene, theme: TerrainTheme = DEFAULT_THEME): Mesh {
  const ground = MeshBuilder.CreateGround(
    "terrain",
    { width: TERRAIN_SIZE, height: TERRAIN_SIZE, subdivisions: 72 },
    scene,
  );
  const pos = ground.getVerticesData("position")!;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i + 1] = heightAt(pos[i], pos[i + 2]);
  }
  ground.updateVerticesData("position", pos);
  ground.convertToFlatShadedMesh(); // faceted low-poly shading (re-splits vertices)
  ground.receiveShadows = true;

  // bake per-vertex colours from the post-split positions
  const p2 = ground.getVerticesData("position")!;
  const colors = new Float32Array((p2.length / 3) * 4);
  for (let v = 0, i = 0; i < p2.length; i += 3, v += 4) {
    const c = groundColor(p2[i], p2[i + 1], p2[i + 2], theme);
    colors[v] = c.r; colors[v + 1] = c.g; colors[v + 2] = c.b; colors[v + 3] = 1;
  }
  ground.setVerticesData(VertexBuffer.ColorKind, colors);

  const mat = new StandardMaterial("terrainMat", scene);
  mat.diffuseColor = Color3.White();   // let the vertex colours drive the hue
  mat.specularColor = Color3.Black();  // matte, no plastic shine
  ground.material = mat;
  return ground;
}

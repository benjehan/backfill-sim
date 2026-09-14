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

/** Surface height at world (x,z). Flat within the build pad, rolling hills beyond. */
export function heightAt(x: number, z: number): number {
  const hills =
    Math.sin(x * 0.045) * Math.cos(z * 0.05) * 5 +
    Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.09 + 0.4) * 2.2 +
    Math.sin((x + z) * 0.02) * 3;
  const d = Math.hypot(x, z);
  // ramp from flat (0) at the pad edge up to full hills further out
  const flat = 1 - Math.min(1, Math.max(0, (d - PAD_RADIUS) / 55));
  return hills * (1 - flat);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function mix(a: Color3, b: Color3, t: number): Color3 {
  t = Math.max(0, Math.min(1, t));
  return new Color3(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t));
}

const C_GRAVEL = Color3.FromHexString("#8f8578"); // graded build pad
const C_DIRT = Color3.FromHexString("#7c6b4c");   // haul apron / disturbed ground
const C_SCRUB = Color3.FromHexString("#6f8a4e");  // near scrub
const C_HILLS = Color3.FromHexString("#516d3c");  // greener distant hills
const C_ROCK = Color3.FromHexString("#948a7a");   // exposed rock on high faces

/** Ground colour at (x,z,h) — banded by distance from site, tinted rockier up high. */
function groundColor(x: number, z: number, h: number): Color3 {
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

export function createTerrain(scene: Scene): Mesh {
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
    const c = groundColor(p2[i], p2[i + 1], p2[i + 2]);
    colors[v] = c.r; colors[v + 1] = c.g; colors[v + 2] = c.b; colors[v + 3] = 1;
  }
  ground.setVerticesData(VertexBuffer.ColorKind, colors);

  const mat = new StandardMaterial("terrainMat", scene);
  mat.diffuseColor = Color3.White();   // let the vertex colours drive the hue
  mat.specularColor = Color3.Black();  // matte, no plastic shine
  ground.material = mat;
  return ground;
}

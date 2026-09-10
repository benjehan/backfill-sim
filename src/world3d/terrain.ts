// Low-poly surface terrain. A deterministic layered-sine heightfield, flattened
// to a build pad near the origin, rendered flat-shaded for the faceted look.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
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

export function createTerrain(scene: Scene): Mesh {
  const ground = MeshBuilder.CreateGround(
    "terrain",
    { width: TERRAIN_SIZE, height: TERRAIN_SIZE, subdivisions: 64 },
    scene,
  );
  const pos = ground.getVerticesData("position")!;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i + 1] = heightAt(pos[i], pos[i + 2]);
  }
  ground.updateVerticesData("position", pos);
  ground.convertToFlatShadedMesh(); // faceted low-poly shading
  ground.receiveShadows = true;

  const mat = new StandardMaterial("terrainMat", scene);
  mat.diffuseColor = Color3.FromHexString("#6f8f4e"); // stylized grass-green
  mat.specularColor = Color3.Black(); // matte, no plastic shine
  ground.material = mat;
  return ground;
}

// The surface "look": gradient sky dome with a sun, drifting clouds, biome
// scenery (forests, rocks, grass, cacti) as thin instances, animated water, and
// a cinematic post stack (ACES tone mapping, bloom, SSAO, MSAA/FXAA, vignette).
// Everything scenic is decoration only: no gameplay reads it.
import { Scene } from "@babylonjs/core/scene";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { FresnelParameters } from "@babylonjs/core/Materials/fresnelParameters";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import "@babylonjs/core/Meshes/thinInstanceMesh";

import { heightAt, slopeAt, fbm, getLand, PAD_RADIUS, SEA_LEVEL, TERRAIN_SIZE, type LandType } from "./terrain.js";

// ---- sky ---------------------------------------------------------------------
Effect.ShadersStore["btSkyVertexShader"] = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main(void) { vDir = position; gl_Position = worldViewProjection * vec4(position, 1.0); }`;
Effect.ShadersStore["btSkyFragmentShader"] = `
precision highp float;
varying vec3 vDir;
uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor;
void main(void) {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.5));
  // thin warm haze band right on the horizon
  col = mix(col, horizon * 1.06 + vec3(0.03, 0.02, 0.0), exp(-abs(h) * 22.0) * 0.6);
  if (h < 0.0) col = horizon;
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 40.0) * 0.28 + pow(s, 6.0) * 0.12);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface SkyColors { zenith: string; horizon: string; sun: number }

// ---- helpers -----------------------------------------------------------------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function paint(m: Mesh, hex: string, jitter = 0, r?: () => number) {
  const c = Color3.FromHexString(hex);
  const n = m.getTotalVertices();
  const cols = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const j = jitter && r ? 1 + (r() - 0.5) * jitter : 1;
    cols[i * 4] = c.r * j; cols[i * 4 + 1] = c.g * j; cols[i * 4 + 2] = c.b * j; cols[i * 4 + 3] = 1;
  }
  m.setVerticesData(VertexBuffer.ColorKind, cols);
}
function merge(parts: Mesh[], name: string): Mesh {
  const m = Mesh.MergeMeshes(parts, true, true)!;
  m.name = name;
  m.convertToFlatShadedMesh();
  return m;
}

/** Scenery layer: one template mesh drawn as thin instances, clearable around buildings. */
class Layer {
  pts: { x: number; z: number; m: Matrix }[] = [];
  constructor(public mesh: Mesh) {}
  commit(colors: number[]) {
    const buf = new Float32Array(this.pts.length * 16);
    this.pts.forEach((p, i) => p.m.copyToArray(buf, i * 16));
    this.mesh.thinInstanceSetBuffer("matrix", buf, 16, false);
    if (colors.length) this.mesh.thinInstanceSetBuffer("color", new Float32Array(colors), 4, true);
    this.mesh.thinInstanceRefreshBoundingInfo(false);
  }
  clearAround(x: number, z: number, r: number) {
    let hit = false;
    const zero = Matrix.Scaling(0, 0, 0);
    this.pts.forEach((p, i) => {
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) { this.mesh.thinInstanceSetMatrixAt(i, zero, false); hit = true; }
    });
    if (hit) this.mesh.thinInstanceBufferUpdated("matrix");
  }
}

// ---- templates -----------------------------------------------------------------
function pineTemplate(scene: Scene): Mesh {
  const trunk = MeshBuilder.CreateCylinder("t", { diameterTop: 0.35, diameterBottom: 0.55, height: 2.2, tessellation: 6 }, scene);
  trunk.position.y = 1.1; paint(trunk, "#6b4a2e");
  const parts = [trunk];
  const tiers = [[3.6, 3.2, 2.2], [2.9, 2.8, 4.0], [2.0, 2.4, 5.6]];
  tiers.forEach(([dia, h, y], i) => {
    const c = MeshBuilder.CreateCylinder("c" + i, { diameterTop: 0, diameterBottom: dia, height: h, tessellation: 7 }, scene);
    c.position.y = y; c.rotation.y = i * 0.7; paint(c, i === 2 ? "#3f7d45" : "#2f6a3c"); parts.push(c);
  });
  return merge(parts, "pineT");
}
function broadleafTemplate(scene: Scene): Mesh {
  const trunk = MeshBuilder.CreateCylinder("t", { diameterTop: 0.35, diameterBottom: 0.6, height: 2.6, tessellation: 6 }, scene);
  trunk.position.y = 1.3; paint(trunk, "#6e4f33");
  const a = MeshBuilder.CreateIcoSphere("a", { radius: 2.1, subdivisions: 1 }, scene); a.position.set(0, 3.8, 0); paint(a, "#5d9a3e");
  const b = MeshBuilder.CreateIcoSphere("b", { radius: 1.5, subdivisions: 1 }, scene); b.position.set(0.9, 4.6, 0.4); paint(b, "#6fae47");
  const c = MeshBuilder.CreateIcoSphere("c", { radius: 1.4, subdivisions: 1 }, scene); c.position.set(-0.8, 4.3, -0.6); paint(c, "#528d38");
  return merge([trunk, a, b, c], "leafT");
}
function cactusTemplate(scene: Scene): Mesh {
  const col = "#5f8f4a";
  const body = MeshBuilder.CreateCylinder("b", { diameter: 0.8, height: 4.2, tessellation: 8 }, scene); body.position.y = 2.1;
  const top = MeshBuilder.CreateSphere("tp", { diameter: 0.8, segments: 4 }, scene); top.position.y = 4.2;
  const a1 = MeshBuilder.CreateCylinder("a1", { diameter: 0.55, height: 1.6, tessellation: 8 }, scene); a1.position.set(0.8, 2.6, 0);
  const a1b = MeshBuilder.CreateCylinder("a1b", { diameter: 0.55, height: 1.0, tessellation: 8 }, scene); a1b.rotation.z = Math.PI / 2; a1b.position.set(0.45, 1.9, 0);
  const a2 = MeshBuilder.CreateCylinder("a2", { diameter: 0.5, height: 1.3, tessellation: 8 }, scene); a2.position.set(-0.75, 3.0, 0);
  const a2b = MeshBuilder.CreateCylinder("a2b", { diameter: 0.5, height: 0.9, tessellation: 8 }, scene); a2b.rotation.z = Math.PI / 2; a2b.position.set(-0.4, 2.45, 0);
  const parts = [body, top, a1, a1b, a2, a2b]; parts.forEach((p) => paint(p, col));
  return merge(parts, "cactusT");
}
function shrubTemplate(scene: Scene, hex: string): Mesh {
  const a = MeshBuilder.CreateIcoSphere("s", { radius: 0.9, subdivisions: 1 }, scene); a.scaling.y = 0.7; a.position.y = 0.45; paint(a, hex);
  const b = MeshBuilder.CreateIcoSphere("s2", { radius: 0.6, subdivisions: 1 }, scene); b.position.set(0.7, 0.35, 0.2); paint(b, hex);
  return merge([a, b], "shrubT");
}
function rockTemplate(scene: Scene, hex: string, seed: number): Mesh {
  const r = rng(seed);
  const m = MeshBuilder.CreateIcoSphere("rock", { radius: 1, subdivisions: 1, updatable: true }, scene);
  const p = m.getVerticesData("position")!;
  // jitter shared vertices consistently (key by rounded position) so faces stay closed
  const off = new Map<string, number>();
  for (let i = 0; i < p.length; i += 3) {
    const k = `${p[i].toFixed(3)},${p[i + 1].toFixed(3)},${p[i + 2].toFixed(3)}`;
    if (!off.has(k)) off.set(k, 0.75 + r() * 0.5);
    const s = off.get(k)!;
    p[i] *= s; p[i + 1] *= s * 0.62; p[i + 2] *= s;
  }
  m.updateVerticesData("position", p);
  paint(m, hex, 0.12, r);
  m.convertToFlatShadedMesh();
  return m;
}
function grassTemplate(scene: Scene, hex: string): Mesh {
  const parts: Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const b = MeshBuilder.CreateCylinder("g" + i, { diameterTop: 0, diameterBottom: 0.22, height: 0.9 + (i % 3) * 0.25, tessellation: 3 }, scene);
    const a = (i / 5) * Math.PI * 2;
    b.position.set(Math.cos(a) * 0.25, 0.45, Math.sin(a) * 0.25);
    b.rotation.set(Math.sin(a) * 0.3, 0, Math.cos(a) * 0.3);
    paint(b, hex); parts.push(b);
  }
  return merge(parts, "grassT");
}
function flowerTemplate(scene: Scene): Mesh {
  const stem = MeshBuilder.CreateCylinder("st", { diameter: 0.06, height: 0.7, tessellation: 3 }, scene); stem.position.y = 0.35; paint(stem, "#4f8a3a");
  const head = MeshBuilder.CreateIcoSphere("hd", { radius: 0.2, subdivisions: 0 }, scene); head.position.y = 0.75; paint(head, "#ffffff");
  return merge([stem, head], "flowerT");
}

// ---- the environment -------------------------------------------------------------
export class Environment {
  readonly root: TransformNode;
  private sky: Mesh;
  private skyMat: ShaderMaterial;
  private clouds: Mesh[] = [];
  private layers: Layer[] = [];
  private water?: Mesh;
  private waterBump?: Texture;
  pipeline?: DefaultRenderingPipeline;
  ssao?: SSAO2RenderingPipeline;
  private t = 0;

  constructor(private scene: Scene, private camera: Camera, private sun: DirectionalLight, surfaceRoot: TransformNode, casters: (m: Mesh) => void) {
    this.root = new TransformNode("env", scene); this.root.parent = surfaceRoot;

    // sky dome (follows the camera, never fogged)
    this.skyMat = new ShaderMaterial("btSky", scene, "btSky", {
      attributes: ["position"], uniforms: ["worldViewProjection", "zenith", "horizon", "sunDir", "sunColor"],
    });
    this.skyMat.backFaceCulling = false;
    this.sky = MeshBuilder.CreateSphere("skyDome", { diameter: 3000, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    this.sky.material = this.skyMat; this.sky.infiniteDistance = true; this.sky.isPickable = false;
    this.sky.applyFog = false;
    this.sky.parent = this.root;
    this.setSky({ zenith: "#3f86d6", horizon: "#cfe3ef", sun: 1 });

    this.buildClouds();
    this.buildScenery(casters);
    scene.onBeforeRenderObservable.add(() => this.tick(scene.getEngine().getDeltaTime() / 1000));
  }

  /** Recolour sky + fog. Fog matches the horizon so the landscape melts into it. */
  setSky(c: SkyColors) {
    const z = Color3.FromHexString(c.zenith), h = Color3.FromHexString(c.horizon);
    const d = this.sun.direction.normalizeToNew().scale(-1);
    this.skyMat.setColor3("zenith", z);
    this.skyMat.setColor3("horizon", h);
    this.skyMat.setVector3("sunDir", d);
    this.skyMat.setColor3("sunColor", new Color3(1, 0.93, 0.78).scale(c.sun));
    this.scene.fogColor = h;
    this.scene.clearColor.set(h.r, h.g, h.b, 1);
    for (const cl of this.clouds) (cl.material as StandardMaterial).emissiveColor = new Color3(0.55, 0.57, 0.62).scale(0.5 + c.sun * 0.5);
  }

  private buildClouds() {
    const r = rng(77);
    const mat = new StandardMaterial("cloudM", this.scene);
    mat.diffuseColor = new Color3(1, 1, 1); mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(0.55, 0.57, 0.62); mat.fogEnabled = false;
    for (let i = 0; i < 16; i++) {
      const parts: Mesh[] = [];
      const n = 4 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const s = MeshBuilder.CreateIcoSphere("cp", { radius: 7 + r() * 8, subdivisions: 2 }, this.scene);
        s.position.set((k - n / 2) * 8 + r() * 5, r() * 4, (r() - 0.5) * 10);
        s.scaling.y = 0.55;
        parts.push(s);
      }
      const cl = Mesh.MergeMeshes(parts, true, true)!;
      cl.convertToFlatShadedMesh();
      cl.material = mat; cl.isPickable = false; cl.applyFog = false;
      const a = r() * Math.PI * 2, d = 120 + r() * 480;
      cl.position.set(Math.cos(a) * d, 120 + r() * 60, Math.sin(a) * d);
      cl.scaling.setAll(0.8 + r() * 0.8);
      cl.parent = this.root;
      this.clouds.push(cl);
    }
  }

  private buildScenery(casters: (m: Mesh) => void) {
    const land = getLand();
    const r = rng(1234 + land.length * 17);
    const add = (tpl: Mesh, count: number, accept: (x: number, z: number, h: number, s: number) => boolean,
                 scale: [number, number], tint: string[], cast: boolean, tiltMax = 0.12, minD = PAD_RADIUS + 16, maxD = TERRAIN_SIZE * 0.48) => {
      const mat = new StandardMaterial(tpl.name + "M", this.scene);
      mat.diffuseColor = Color3.White(); mat.specularColor = Color3.Black();
      tpl.material = mat; tpl.isPickable = false; tpl.parent = this.root; tpl.receiveShadows = true;
      if (cast) casters(tpl);
      const L = new Layer(tpl);
      const colors: number[] = [];
      const tints = tint.map((t) => Color3.FromHexString(t));
      let tries = 0;
      while (L.pts.length < count && tries++ < count * 12) {
        const a = r() * Math.PI * 2, d = minD + Math.sqrt(r()) * (maxD - minD);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (x > -74 && x < -40 && z > -30 && z < 24) continue; // adit apron + headframe yard
        const h = heightAt(x, z), s = slopeAt(x, z);
        if (!accept(x, z, h, s)) continue;
        const sc = scale[0] + r() * (scale[1] - scale[0]);
        const q = Quaternion.FromEulerAngles((r() - 0.5) * tiltMax, r() * Math.PI * 2, (r() - 0.5) * tiltMax);
        L.pts.push({ x, z, m: Matrix.Compose(new Vector3(sc, sc * (0.85 + r() * 0.3), sc), q, new Vector3(x, h - 0.15, z)) });
        const c = tints[Math.floor(r() * tints.length)]; const j = 0.9 + r() * 0.2;
        colors.push(c.r * j, c.g * j, c.b * j, 1);
      }
      L.commit(colors);
      this.layers.push(L);
    };
    const forest = (x: number, z: number, lo: number, hi: number) => { const f = fbm(x / 55 + 3, z / 55 - 7, 4); return f > lo && f < hi; };
    const dry = (h: number) => h > SEA_LEVEL + 1.6;
    const W = ["#ffffff"];

    const byLand: Record<LandType, () => void> = {
      hills: () => {
        add(broadleafTemplate(this.scene), 900, (x, z, h, s) => s < 0.35 && forest(x, z, 0.52, 1), [0.8, 1.5], ["#ffffff", "#e8f5d0", "#fff2d0"], true);
        add(pineTemplate(this.scene), 700, (x, z, h, s) => s < 0.4 && forest(x, z, 0.58, 1) && h > 8, [0.9, 1.7], W, true);
        add(broadleafTemplate(this.scene), 160, (x, z, h, s) => s < 0.3, [0.7, 1.3], ["#ffffff", "#ffe7b0"], true, 0.1, PAD_RADIUS + 14, 200);
        add(rockTemplate(this.scene, "#9a978f", 3), 260, (x, z, h, s) => s > 0.12 || r() < 0.25, [0.6, 2.8], W, true, 0.6);
        add(grassTemplate(this.scene, "#7fb54a"), 2600, (x, z, h, s) => s < 0.35, [0.8, 1.6], ["#ffffff", "#dfeec0", "#c8e6a0"], false, 0.3, PAD_RADIUS + 8, 230);
        add(flowerTemplate(this.scene), 900, (x, z, h, s) => s < 0.25 && fbm(x / 20, z / 20) > 0.55, [0.8, 1.3], ["#ffd84a", "#ffffff", "#e87fb0", "#9a8cff"], false, 0.2, PAD_RADIUS + 10, 200);
      },
      valley: () => byLand.hills(),
      seaside: () => {
        add(pineTemplate(this.scene), 700, (x, z, h, s) => dry(h) && h > 3 && s < 0.4 && forest(x, z, 0.5, 1), [0.9, 1.6], W, true);
        add(broadleafTemplate(this.scene), 500, (x, z, h, s) => dry(h) && s < 0.35 && forest(x, z, 0.46, 0.7), [0.8, 1.4], ["#ffffff", "#e8f5d0"], true);
        add(rockTemplate(this.scene, "#8e8f91", 5), 300, (x, z, h, s) => h > SEA_LEVEL - 1 && (s > 0.12 || h < SEA_LEVEL + 2), [0.6, 2.6], W, true, 0.6);
        add(grassTemplate(this.scene, "#86bd52"), 2400, (x, z, h, s) => h > SEA_LEVEL + 2.4 && s < 0.35, [0.8, 1.6], ["#ffffff", "#dfeec0"], false, 0.3, PAD_RADIUS + 8, 230);
        add(flowerTemplate(this.scene), 700, (x, z, h, s) => h > SEA_LEVEL + 2.4 && s < 0.25 && fbm(x / 20, z / 20) > 0.55, [0.8, 1.3], ["#ffd84a", "#ffffff", "#e87fb0"], false, 0.2, PAD_RADIUS + 10, 200);
      },
      mountains: () => {
        add(pineTemplate(this.scene), 1800, (x, z, h, s) => s < 0.45 && h < 85 && forest(x, z, 0.4, 1), [0.9, 1.9], ["#ffffff", "#dbe8d5"], true);
        add(rockTemplate(this.scene, "#8f939a", 9), 420, (x, z, h, s) => s > 0.15 || r() < 0.3, [0.7, 3.6], W, true, 0.7);
        add(grassTemplate(this.scene, "#7aa851"), 1800, (x, z, h, s) => s < 0.35 && h < 60, [0.8, 1.5], ["#ffffff", "#dfeec0"], false, 0.3, PAD_RADIUS + 8, 220);
        add(flowerTemplate(this.scene), 500, (x, z, h, s) => s < 0.25 && h < 50 && fbm(x / 20, z / 20) > 0.55, [0.8, 1.2], ["#ffffff", "#9a8cff", "#ffd84a"], false, 0.2, PAD_RADIUS + 10, 180);
      },
      desert: () => {
        add(cactusTemplate(this.scene), 260, (x, z, h, s) => s < 0.3, [0.8, 1.5], ["#ffffff", "#e0f0d0"], true, 0.1);
        add(shrubTemplate(this.scene, "#9aa05a"), 700, (x, z, h, s) => s < 0.35, [0.6, 1.4], ["#ffffff", "#d8c890", "#c0c8a0"], true, 0.2);
        add(rockTemplate(this.scene, "#b86e45", 11), 520, (x, z, h, s) => s > 0.1 || r() < 0.35, [0.7, 3.8], ["#ffffff", "#f0d0b0"], true, 0.7);
        add(grassTemplate(this.scene, "#c9b36a"), 900, (x, z, h, s) => s < 0.3 && fbm(x / 30, z / 30) > 0.5, [0.7, 1.3], W, false, 0.3, PAD_RADIUS + 8, 200);
      },
    };
    byLand[land]();
  }

  /** Clear scenery under a placed building (the site gets cleared, not built through trees). */
  clearAround(x: number, z: number, r: number) { for (const L of this.layers) L.clearAround(x, z, r); }

  /** Standing water / sea to the horizon, with animated ripples and a fresnel sheen. */
  addWater(level: number) {
    const w = MeshBuilder.CreateGround("water", { width: 3000, height: 3000, subdivisions: 1 }, this.scene);
    const m = new StandardMaterial("waterM", this.scene);
    m.diffuseColor = Color3.FromHexString("#1f6f96");
    m.specularColor = new Color3(0.9, 0.9, 0.85); m.specularPower = 180;
    m.alpha = 0.86;
    const bump = rippleTexture(this.scene);
    bump.uScale = 260; bump.vScale = 260; m.bumpTexture = bump; bump.level = 0.35;
    const f = new FresnelParameters(); f.leftColor = Color3.FromHexString("#7fc4de"); f.rightColor = Color3.FromHexString("#06304a"); f.bias = 0.2; f.power = 1.6;
    m.emissiveFresnelParameters = f;
    w.material = m; w.position.y = level; w.isPickable = false; w.parent = this.root;
    m.fogEnabled = true; w.applyFog = true;
    this.water = w; this.waterBump = bump;
    return w;
  }

  /** Post stack. `high` adds SSAO; low-end machines get the lighter path. */
  setupPost(high: boolean) {
    const p = new DefaultRenderingPipeline("post", true, this.scene, [this.camera]);
    p.samples = 4;
    p.fxaaEnabled = true;
    p.bloomEnabled = true; p.bloomThreshold = 0.82; p.bloomWeight = 0.28; p.bloomKernel = 48; p.bloomScale = 0.5;
    p.imageProcessingEnabled = true;
    const ip = p.imageProcessing;
    ip.toneMappingEnabled = true; ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.1; ip.contrast = 1.1;
    ip.vignetteEnabled = true; ip.vignetteWeight = 1.6; ip.vignetteStretch = 0.6;
    ip.vignetteColor.set(0.08, 0.1, 0.16, 1);
    ip.colorCurvesEnabled = true;
    ip.colorCurves!.globalSaturation = 18;
    p.sharpenEnabled = true; p.sharpen.edgeAmount = 0.18;
    this.pipeline = p;
    if (high) this.enableSSAO(true);
  }
  enableSSAO(on: boolean) {
    if (on && !this.ssao) {
      const s = new SSAO2RenderingPipeline("ssao", this.scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [this.camera]);
      s.radius = 3.5; s.totalStrength = 1.1; s.samples = 16; s.maxZ = 400; s.minZAspect = 0.4;
      s.expensiveBlur = true; s.base = 0.1;
      this.ssao = s;
    } else if (!on && this.ssao) { this.ssao.dispose(); this.ssao = undefined; }
  }

  private tick(dt: number) {
    this.t += dt;
    for (const c of this.clouds) {
      c.position.x += dt * 2.2;
      if (c.position.x > 620) c.position.x = -620;
    }
    if (this.waterBump) { this.waterBump.uOffset = this.t * 0.02; this.waterBump.vOffset = this.t * 0.013; }
  }
}

/** Procedural normal map of soft ripples for the water surface. */
function rippleTexture(scene: Scene): Texture {
  const S = 256;
  const tex = new DynamicTexture("ripples", S, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(S, S);
  const hgt = (x: number, y: number) => {
    const u = (x / S) * Math.PI * 2, v = (y / S) * Math.PI * 2;
    return Math.sin(u * 3 + Math.sin(v * 2) * 1.5) * 0.5 + Math.sin(v * 5 + u) * 0.3 + Math.sin((u - v) * 7) * 0.2;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = hgt(x + 1, y) - hgt(x - 1, y), dy = hgt(x, y + 1) - hgt(x, y - 1);
    const nx = -dx * 2, ny = -dy * 2, nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    img.data[i] = ((nx / l) * 0.5 + 0.5) * 255; img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255; img.data[i + 2] = ((nz / l) * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

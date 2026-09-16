// The 3D world: an RTS surface where you lay out the operation, and an
// underground you descend into to reticulate and fill stopes. The pure-TS sim
// physics lives in ./backfillModel (course numbers). Surface geometry is parented
// under one node so descend/ascend is a single toggle.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import "@babylonjs/core/Culling/ray";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { createTerrain, heightAt, PAD_RADIUS, TERRAIN_SIZE } from "./terrain.js";
import { ghostify, createHeadframe } from "./buildings.js";
import { CATALOG, specOf, type BuildingSpec } from "./catalog.js";
import { WorkerCrew } from "./workers.js";
import { TruckFleet } from "./trucks.js";
import { Underground, type StopeUG, type FillType, FILL_TYPES } from "./underground.js";
import { PlantInterior } from "./plantInterior.js";
import {
  DEFAULT_RECIPE, type Recipe, frictionScale, ucs28Kpa, recipeCostPerM3,
  yieldStressPa, frictionKpaPerM, pumpability, ucsVariance,
} from "./labModel.js";
import {
  fmtMoney, fillCost, fillRevenue, CHOKE_CAPEX, staticHeadMpa, frictionMpa, PASTE_COST_PER_M3,
  pourPressureMpa, BURST_PENALTY,
  SECONDS_PER_DAY, POUR_RATE_M3_PER_DAY, LATE_COST_PER_DAY, BASE_OPEX_PER_DAY, CURE_DAYS,
  BINDER_TOPUP_TONNES, BINDER_TOPUP_COST,
} from "./backfillModel.js";
import { Hud } from "./hud.js";
import { SoundKit } from "./sound.js";
import { SupplyChain, tsfRaiseCost, TSF_MAX_RAISES } from "./supplyChain.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { loadCompany, saveCompany, legacyForGrade, hasPerk } from "./company.js";
import { writeSave, clearSave, SAVE_VERSION } from "./savegame.js";

const SKY = "#8ec5e6";
const START_CASH = 150_000_000;
const CONNECT_RANGE = 130; // max feed-line reach from a supply work to the plant
// Research tree — permanent campaign perks bought with RP earned from milling + cured stopes.
const TECHS: { id: string; name: string; desc: string; cost: number }[] = [
  { id: "recovery", name: "High-recovery flotation", desc: "+15% mill income", cost: 12 },
  { id: "binder", name: "Bulk binder contract", desc: "−30% binder cost", cost: 10 },
  { id: "rheology", name: "Paste rheology R&D", desc: "−15% pour friction — safer lines", cost: 14 },
  { id: "rapidset", name: "Rapid-set binder", desc: "−25% cure time", cost: 16 },
  { id: "dameng", name: "Deep-lift dam engineering", desc: "+50% capacity per dam raise", cost: 12 },
  { id: "reserves", name: "Reserve-definition drilling", desc: "+50,000 t orebody", cost: 14 },
];
const SPEEDS = [1, 2, 4, 8];

// Barricade / containment design (GDD 09/10). Capacity is what the barricade can
// hold before it fails; the pour's rate of rise loads it until the plug sets and
// isolates it. Mullock is cheap but weak & variable; arched shotcrete is stronger
// and more forgiving. Relief (breather holes) is the key anti-inrush control.
const BARRICADE = {
  mullock:   { label: "Mullock (waste)", short: "Mullock", capKpa: 300, cost: 250_000, note: "Consolidated waste — cheap, material on hand, but weak and variable. Pour the plug slowly or it fails." },
  shotcrete: { label: "Arched shotcrete", short: "Shotcrete", capKpa: 560, cost: 650_000, note: "Engineered arch — strong, fast, QA/QC-able. Forgiving on rate of rise. Higher cost; can't sit at a drift intersection." },
  reliefBonusKpa: 240, reliefCost: 200_000,
  exclusionCost: 160_000, instrCost: 130_000,
} as const;
const INRUSH_PENALTY = 1_800_000;
const BAR_RISE_K = 360;   // kPa per unit flow-factor while the plug is unset
const BAR_HEAD_K = 220;   // kPa fluid head, scaled by fill fraction, pre-plug-set
const PLUG_SET_FRAC = 0.12; // the plug is placed over the first ~12% of fill
const SURFACE_UNIT_M = 7.5; // world units → metres for the surface pipe run (plant → shaft)
const TESTWORK_COST = 4_000_000; // a lab test-work campaign (characterisation + rheology + UCS)
const TESTWORK_DAYS = 4;         // results lag reality — the program takes time

interface Placed { spec: BuildingSpec; root: TransformNode; pos: Vector3; marker: Mesh | null; raises: number; tier: number; built: boolean; buildProgress: number; buildDays: number; scaffold: TransformNode | null; }
interface EventOption { label: string; detail: string; apply: (w: World) => void; }
interface GameEvent { id: string; title: string; body: string; options: EventOption[]; }

export class World {
  private engine!: Engine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private shadow!: ShadowGenerator;
  private ground!: Mesh;
  private surfaceRoot!: TransformNode;
  private crew!: WorkerCrew;
  private fleet!: TruckFleet;
  private underground!: Underground;
  private plantInterior!: PlantInterior;
  private hud!: Hud;
  private canvas!: HTMLCanvasElement;
  private portal!: Vector3;

  private mode: "surface" | "underground" | "plant" = "surface";
  private plantThroughput = 0;
  private recipe: Recipe = { ...DEFAULT_RECIPE };
  private cash = START_CASH;
  private powered = 0; private total = 0;
  private energized: Placed[] = [];
  private buildings: Placed[] = [];
  private selectedStope: StopeUG | null = null;
  private selectedBuilding: Placed | null = null;

  // live clock — starts PAUSED: design / feasibility / lab is untimed; time runs when you press play
  private day = 1;
  private paused = true;
  private speedIdx = 1;
  private ended = false;
  private opexPerDay = 0;
  private safetyIncidents = 0;
  private testWorkDone = false; // a paid lab campaign that de-risks mix design (tightens UCS scatter)
  private lastGrade = "";
  private sound = new SoundKit();
  private rp = 0;                        // research points — the operation's accumulated know-how
  private research = new Set<string>();  // unlocked tech ids
  private opexMult = 1;                  // company-perk running-cost modifier
  private soundOn = true;
  private ambientStarted = false;
  private supply = new SupplyChain();
  private millDayIncome = 0;
  private lastDayShown = 0;
  private roadMeshes: Mesh[] = [];
  private powerLineMeshes: Mesh[] = [];
  private supplyLinkMeshes: Mesh[] = [];
  private flowLinks: { src: Placed; a: Vector3; c: Vector3; beads: Mesh[]; lift: number; needsConnect: boolean }[] = [];
  private flowPhase = 0;
  private oreHoistAt = new Vector3(-67, 7, -10); // headframe discharge — ore conveyed to the mill
  private activeEvent: GameEvent | null = null;
  private firedEvents = new Set<string>();
  private tempDeliveryMult = 1; private tempDeliveryUntil = 0;
  private tempPourMult = 1; private tempPourUntil = 0;
  private get speed() { return SPEEDS[this.speedIdx]; }

  private armed: BuildingSpec | null = null;
  private ghost: TransformNode | null = null;
  private setGhostValid: ((ok: boolean) => void) | null = null;
  private ghostPos: Vector3 | null = null;
  private ghostValid = false;

  private tutorial = false;
  private tutStep = 0;
  private tutSteps: { text: string; done: () => boolean }[] = [];
  constructor(private root: HTMLElement, private scenario: Scenario = SCENARIOS[0], opts?: { tutorial?: boolean }) {
    this.tutorial = !!opts?.tutorial;
  }

  start() {
    this.root.classList.add("world-mode");
    const co = loadCompany(); // permanent perks from past campaigns
    this.cash = Math.round(this.scenario.startCash * (hasPerk(co, "seed") ? 1.15 : 1));
    this.rp = hasPerk(co, "veterans") ? 8 : 0;
    this.opexMult = hasPerk(co, "lean") ? 0.92 : 1;
    const orebody = this.scenario.orebody + (hasPerk(co, "prospect") ? 30_000 : 0);
    this.supply.oreReserve.level = orebody;
    this.supply.oreReserve.cap = orebody;
    this.canvas = document.createElement("canvas");
    this.canvas.id = "renderCanvas";
    this.root.appendChild(this.canvas);

    this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: false });
    this.scene = new Scene(this.engine);
    this.setSky(false);

    this.setupCamera();
    this.setupLights();

    this.surfaceRoot = new TransformNode("surface", this.scene);
    this.ground = createTerrain(this.scene, this.scenario.terrain); this.ground.parent = this.surfaceRoot;
    this.portal = this.createPortal();
    this.crew = new WorkerCrew(
      this.scene, 5, PAD_RADIUS - 6, (m) => this.shadow.addShadowCaster(m), this.surfaceRoot,
      () => [
        ...this.buildings.map((b) => ({ x: b.pos.x, z: b.pos.z, r: Math.max(b.spec.fw, b.spec.fd) / 2 + 1 })),
        { x: this.portal.x, z: this.portal.z, r: 6 },
      ],
      () => ({
        sites: this.buildings.filter((b) => !b.built).map((b) => ({ x: b.pos.x, z: b.pos.z })),
        focus: this.anyPourActive() ? { x: this.portal.x, z: this.portal.z } : null,
      }),
    );
    this.fleet = new TruckFleet(this.scene, (m) => this.shadow.addShadowCaster(m), this.surfaceRoot);
    this.underground = new Underground(this.scene, this.shadow, this.scenario);
    this.plantInterior = new PlantInterior(
      this.scene, this.shadow, this.root,
      () => this.exitPlant(),
      (cost) => { if (this.cash < cost) { this.hud.setStatus(`Not enough cash (${fmtMoney(cost)}).`); return false; } this.cash -= cost; this.updateEconomy(); return true; },
      (m3h) => { this.plantThroughput = m3h; },
    );
    this.plantInterior.setSupply(this.interiorSupply()); // sources start starved until the supply chain is built

    this.hud = new Hud(this.root, {
      onSelect: (t) => this.onSelect(t),
      onToggleMode: () => this.toggleMode(),
      onPanelAction: (a) => this.onPanelAction(a),
      onPause: () => { this.paused = !this.paused; this.refreshClock(); },
      onSpeed: (i) => { this.speedIdx = i; this.paused = false; this.refreshClock(); },
      onLab: () => { const r = this.activeRecipe(); this.hud.setLabRecipe(r.solids, r.binderKgPerM3); this.hud.toggleLab(this.labReadout()); },
      onRecipe: (solids, binder) => { const r = this.activeRecipe(); r.solids = solids; r.binderKgPerM3 = binder; this.hud.setLabReadout(this.labReadout()); if (this.mode === "underground" && this.selectedStope) this.renderStopePanel(); },
      onBinderTopup: () => {
        if (this.cash < BINDER_TOPUP_COST) { this.hud.setStatus(`Not enough cash for a binder truck top-up (${fmtMoney(BINDER_TOPUP_COST)}).`); return; }
        this.cash -= BINDER_TOPUP_COST; this.supply.topUpBinder(BINDER_TOPUP_TONNES);
        this.updateEconomy(); this.hud.setStatus(`Binder truck top-up: +${BINDER_TOPUP_TONNES} t for ${fmtMoney(BINDER_TOPUP_COST)}.`);
      },
      onToggleSound: () => { this.soundOn = !this.soundOn; this.sound.setMuted(!this.soundOn); this.sound.toggleAmbient(this.soundOn); this.hud.setSoundIcon(this.soundOn); },
      onHelp: () => this.showEconomyHelp(),
      onResearch: () => this.showResearch(),
    });
    this.hud.setMine(this.scenario.name);
    this.updateEconomy();
    if (this.tutorial) { this.setupTutorial(); this.renderTutorial(); }
    this.refreshObjective();
    this.underground.updateSchedule(this.day);
    this.refreshClock();
    this.refreshSchedule();
    if (!this.tutorial) this.maybeShowIntro(); // the tutorial replaces the intro card

    this.scene.onPointerObservable.add((pi) => this.onPointer(pi));
    this.engine.runRenderLoop(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      this.advanceTime(dt);
      if (this.mode === "surface") { this.crew.update(dt); this.fleet.update(dt, this.cafPourActive()); this.updateFlow(dt); }
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
    (window as any).__world = this;
    if (typeof location !== "undefined" && location.hash.startsWith("#autorun")) setTimeout(() => this.debugAutoRun(), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#smartrun")) setTimeout(() => this.debugSmartRun(), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#seed")) setTimeout(() => this.debugSeed(), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#tuttest")) setTimeout(() => this.debugTutTest(), 400);
  }

  /** Research lab: spend RP on permanent campaign perks. */
  private showResearch() {
    this.root.querySelector(".researchCard")?.remove();
    const el = document.createElement("div");
    el.className = "whResult researchCard";
    const rows = TECHS.map((t) => {
      const owned = this.research.has(t.id);
      const afford = this.rp >= t.cost;
      const btn = owned ? `<span class="techOwned">✓ researched</span>`
        : `<button class="pBtn ${afford ? "primary" : ""}" data-act="tech:${t.id}" ${afford ? "" : "disabled"}>${t.cost} RP</button>`;
      return `<div class="techRow ${owned ? "owned" : ""}"><div class="techMain"><b>${t.name}</b><span>${t.desc}</span></div>${btn}</div>`;
    }).join("");
    el.innerHTML = `<div class="introCard">
      <div class="rsHead">🔬 Research lab <span class="techRp">${Math.floor(this.rp)} RP</span></div>
      <div class="pNote">Know-how accrues as you mill ore and hand back cured stopes. Spend it on permanent upgrades for this operation.</div>
      <div class="techList">${rows}</div>
      <button class="pBtn primary" id="techClose"><b>Close ▶</b></button>
    </div>`;
    this.root.appendChild(el);
    el.querySelector("#techClose")!.addEventListener("click", () => el.remove());
    el.querySelectorAll<HTMLElement>("[data-act^='tech:']").forEach((b) => b.addEventListener("click", () => { this.buyTech(b.dataset.act!.slice(5)); this.showResearch(); }));
  }
  private buyTech(id: string) {
    const t = TECHS.find((x) => x.id === id); if (!t || this.research.has(id) || this.rp < t.cost) return;
    this.rp -= t.cost; this.research.add(id); this.sound.pass();
    if (id === "rapidset") this.underground.cureFactor = 0.75;
    if (id === "reserves") { this.supply.oreReserve.level += 50_000; this.supply.oreReserve.cap += 50_000; }
    this.refreshSupply(); this.updateEconomy(); // dam-eng recomputes TSF cap
    this.hud.setStatus(`Researched: ${t.name}.`);
  }

  /** A dismissible card explaining how the money loop works. */
  private showEconomyHelp() {
    if (this.root.querySelector(".econHelp")) return;
    const el = document.createElement("div");
    el.className = "whResult econHelp";
    el.innerHTML = `<div class="introCard">
      <div class="rsHead">💰 How the operation pays</div>
      <ol class="introSteps">
        <li><b>Ore → cash.</b> The headframe hoists ore to the <b>⚙ Mill</b>, which refines it to concentrate — your <b>steady daily income</b>. No mill, no money.</li>
        <li><b>Milling makes tailings.</b> Only about <b>half</b> can go back underground as backfill; the rest is forced to the <b>⛰ TSF</b>. If the dam fills, the mill chokes — <b>raise the dam</b> (click it) to keep earning.</li>
        <li><b>Backfill needs three feeds.</b> Every pour draws <b>tailings + water + binder</b> at once; whichever runs dry throttles the pour. Binder arrives by <b>🚆 rail</b> (and costs money); water is <b>💧 pumped</b> to the pond.</li>
        <li><b>Filling stopes is the profit.</b> Each completed pour unlocks the next ore lift — worth far more than the paste costs.</li>
        <li><b>The mine runs dry.</b> The orebody is finite (watch the <b>Orebody</b> bar) — income tapers late-campaign, so fill while the ore lasts.</li>
      </ol>
      <button class="pBtn primary" id="econClose"><b>Got it ▶</b></button>
    </div>`;
    this.root.appendChild(el);
    el.querySelector("#econClose")!.addEventListener("click", () => el.remove());
  }

  private maybeShowIntro() {
    try { if (localStorage.getItem("bt_intro") === "1") return; } catch { /* ignore */ }
    const el = document.createElement("div");
    el.className = "whResult";
    el.innerHTML = `<div class="introCard">
      <div class="rsHead">BACKFILL TYCOON — how it runs</div>
      <ol class="introSteps">
        <li>Build a <b>power station</b>, then the <b>backfill plant</b> on the pad.</li>
        <li>Stand up the <b>materials chain</b>: a <b>⚙ Mill</b> refines ore (your steady income) and makes tailings, a <b>⛰ TSF</b> stores the ~half of tailings that can't go back down, a <b>🚆 Rail terminal</b> lands binder, and a <b>💧 Water pump</b> feeds the pond. No mill = no cash and no fill; a full TSF chokes the mill.</li>
        <li>Click the plant to step <b>inside</b> and wire the process line: thickener → cyclone → filter → mixer → pump.</li>
        <li>Hit <b>⛏ Go underground</b>. Stopes mine out on a schedule — <b>primaries</b> before their secondaries.</li>
        <li>Pick a <b>fill type</b>, <b>design the reticulation</b> leg-by-leg, set the mix in the <b>🧪 Lab</b>, then <b>press ▶</b> — the clock only runs when you do.</li>
        <li><b>Pour</b> — it draws tailings + water + binder at once; whichever runs dry throttles you. Mind the pressure, flush plugs, cure, crush cylinders, answer to the board.</li>
      </ol>
      <button class="pBtn primary" id="introStart"><b>Start building ▶</b></button>
    </div>`;
    this.root.appendChild(el);
    el.querySelector("#introStart")!.addEventListener("click", () => { el.remove(); try { localStorage.setItem("bt_intro", "1"); } catch { /* ignore */ } });
  }

  private setSky(underground: boolean) {
    if (underground) {
      this.scene.clearColor = new Color4(0.05, 0.06, 0.08, 1);
      this.scene.fogColor = Color3.FromHexString("#0a0d12");
      this.scene.fogMode = Scene.FOGMODE_EXP2; this.scene.fogDensity = 0.0032;
    } else {
      this.scene.clearColor = new Color4(0.556, 0.772, 0.902, 1);
      this.scene.fogColor = Color3.FromHexString(SKY);
      this.scene.fogMode = Scene.FOGMODE_EXP2; this.scene.fogDensity = 0.0032;
    }
  }

  private setupCamera() {
    const cam = new ArcRotateCamera("cam", -Math.PI * 0.72, 0.80, 116, new Vector3(-10, 2, 0), this.scene);
    cam.attachControl(this.canvas, true);
    cam.lowerRadiusLimit = 40; cam.upperRadiusLimit = 210;
    cam.lowerBetaLimit = 0.2; cam.upperBetaLimit = 1.45;
    cam.wheelPrecision = 1.6; cam.panningSensibility = 26;
    cam.panningDistanceLimit = 160; cam.panningInertia = 0.6;
    this.camera = cam;
  }

  private setupLights() {
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.75; hemi.groundColor = Color3.FromHexString("#42502f");
    const sun = new DirectionalLight("sun", new Vector3(-0.6, -1, -0.4), this.scene);
    sun.position = new Vector3(90, 140, 70); sun.intensity = 1.1;
    this.shadow = new ShadowGenerator(1024, sun);
    this.shadow.useBlurExponentialShadowMap = true; this.shadow.blurKernel = 16;
  }

  private createPortal(): Vector3 {
    const x = -64, z = 10, y = heightAt(x, z);
    const mk = (hex: string) => { const m = new StandardMaterial("pm", this.scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black(); return m; };
    // benched box-cut: tan steps descending toward the adit, like ground cut into the slope
    for (let k = 0; k < 3; k++) {
      const w = 34 - k * 7, d = 30 - k * 6;
      const bench = MeshBuilder.CreateBox("boxcut", { width: w, height: 1.2, depth: d }, this.scene);
      bench.material = mk(k === 2 ? "#6b6256" : "#7c7060"); bench.position.set(x + 9 + k * 1.5, y + 0.6 - k * 1.4, z);
      bench.parent = this.surfaceRoot; bench.receiveShadows = true;
    }
    // concrete adit set (portal collar) + dark mouth
    const frame = MeshBuilder.CreateBox("adit", { width: 11, height: 8, depth: 3 }, this.scene);
    frame.material = mk("#8c8478"); frame.position.set(x, y - 2.4 + 3.5, z); frame.parent = this.surfaceRoot; this.shadow.addShadowCaster(frame);
    const lintel = MeshBuilder.CreateBox("aditLintel", { width: 12, height: 1.4, depth: 3.4 }, this.scene);
    lintel.material = mk("#726a5d"); lintel.position.set(x, y - 2.4 + 7.4, z); lintel.parent = this.surfaceRoot;
    const mouth = MeshBuilder.CreateBox("aditMouth", { width: 6.5, height: 5.5, depth: 1.4 }, this.scene);
    mouth.material = mk("#0e1216"); mouth.position.set(x, y - 2.4 + 3, z + 1.3); mouth.parent = this.surfaceRoot;
    // headframe over the hoisting shaft beside the portal — the ore-hoist that feeds the mill
    const hf = createHeadframe(this.scene, (m) => this.shadow.addShadowCaster(m));
    hf.position.set(x - 3, heightAt(x - 3, z - 20), z - 20); hf.parent = this.surfaceRoot;
    this.oreHoistAt = new Vector3(x - 3, heightAt(x - 3, z - 20) + 7, z - 20); // conveyor picks up hoisted ore here
    return new Vector3(x + 7, y, z);
  }

  // ---- mode toggle ----------------------------------------------------------

  private toggleMode() {
    this.mode === "surface" ? this.descend() : this.ascend();
  }

  private descend() {
    this.hud.setObjective(null);
    this.disarm(); this.deselectBuilding();
    this.mode = "underground";
    this.surfaceRoot.setEnabled(false);
    this.underground.root.setEnabled(true);
    this.setSky(true);
    // view the cutaway roughly face-on (X across, depth down), stopes toward camera
    this.camera.setTarget(new Vector3(30, -30, 7));
    this.camera.radius = 104; this.camera.beta = 1.04; this.camera.alpha = Math.PI * 0.42;
    this.hud.setMode("underground");
    this.hud.setPanel(`<div class="panelHint">Click a stope to design its reticulation and pour it.</div>`);
    this.checkTutorial();
  }

  private ascend() {
    this.mode = "surface";
    this.underground.select(null); this.underground.net.highlightPath(null); this.selectedStope = null;
    this.underground.root.setEnabled(false);
    this.surfaceRoot.setEnabled(true);
    this.setSky(false);
    this.camera.setTarget(new Vector3(-10, 2, 0)); this.camera.radius = 116; this.camera.beta = 0.80; this.camera.alpha = -Math.PI * 0.72;
    this.hud.setMode("surface");
    this.refreshObjective();
  }

  private enterPlant() {
    this.disarm(); this.deselectBuilding();
    this.plantInterior.setSupply(this.interiorSupply());
    this.mode = "plant";
    this.surfaceRoot.setEnabled(false);
    this.setSky(true);
    this.plantInterior.enter();
    const c = this.plantInterior.center();
    this.camera.setTarget(c); this.camera.radius = 58; this.camera.beta = 0.62; this.camera.alpha = -Math.PI * 0.72;
    this.hud.setHidden(true);
  }

  private exitPlant() {
    this.mode = "surface";
    this.plantInterior.exit();
    this.checkTutorial(); // the plant-line step completes on exit
    this.surfaceRoot.setEnabled(true);
    this.setSky(false);
    this.camera.setTarget(new Vector3(-10, 2, 0)); this.camera.radius = 116; this.camera.beta = 0.80; this.camera.alpha = -Math.PI * 0.72;
    this.hud.setHidden(false);
    this.refreshObjective();
  }

  /** Pour throughput is set by the plant you build inside: no line = slow contract plant. */
  private pourRatePerDay(): number {
    const base = this.plantThroughput <= 0 ? POUR_RATE_M3_PER_DAY * 0.4 : POUR_RATE_M3_PER_DAY * Math.max(0.4, Math.min(1.2, this.plantThroughput / 55));
    return base * this.pourMult();
  }

  // ---- live clock -----------------------------------------------------------

  private advanceTime(dt: number) {
    if (this.paused || this.ended || this.activeEvent) return;
    const prev = this.day;
    this.day += (dt / SECONDS_PER_DAY) * this.speed;
    const dd = this.day - prev;
    this.updateConstruction(dd);

    // timed pours: pressure builds with flow + plug drift; burst if it tops rating
    for (const s of this.underground.stopes) {
      if (s.status !== "pouring") continue;
      const fill = FILL_TYPES[s.fillType];
      const f = s.flowFactor;
      if (fill.reticulated) {
        if (!s.cls) continue;
        // plug drift: too slow settles (laminar), too fast over-pushes; the sweet band decays it
        if (f < 0.8) s.plugDrift += (0.8 - f) * 0.6 * dd;
        else if (f > 1.15) s.plugDrift += (f - 1.15) * 0.5 * dd;
        else s.plugDrift = Math.max(0, s.plugDrift - 0.22 * dd);
        s.plugDrift = Math.min(1, s.plugDrift);
        const noise = Math.sin(this.day * 41.3 + s.depthM) * 0.06;
        const fScale = frictionScale(this.recipeFor(s).solids) * (this.research.has("rheology") ? 0.85 : 1);
        s.pressureMpa = pourPressureMpa(s.depthM, s.lengthM, s.choke, f, s.plugDrift, s.cls.ratingMpa, noise, fScale);
        if (s.pressureMpa > s.cls.ratingMpa) {
          this.underground.net.clearFlow(this.underground.stopes.indexOf(s));
          this.underground.burst(s); this.safetyIncidents++; this.cash -= BURST_PENALTY; this.sound.burst();
          this.hud.setStatus(`⚠ ${s.id} LINE BURST at ${s.cls.ratingMpa} MPa — pour aborted, line isolated. Re-pour needed (−${fmtMoney(BURST_PENALTY)}).`);
          continue;
        }
        this.underground.net.flowPulse(this.underground.stopes.indexOf(s), this.day); // paste flowing down the line
      } else {
        s.pressureMpa = 0; s.plugDrift = 0; // trucked (CAF) — no pipeline pressure
      }

      // plug (seal the barricade) and cap (working surface) pours are slower/careful
      const frac = s.placedM3 / s.volumeM3;
      const subRate = frac < 0.08 ? 0.5 : frac > 0.92 ? 0.7 : 1;
      const want = Math.min(this.pourRatePerDay() * f * fill.rateMult * subRate * s.lineBoost * dd, s.volumeM3 - s.placedM3);
      const binderNeed = (want * this.recipeFor(s).binderKgPerM3 * fill.binderMult) / 1000; // tonnes at full rate
      const draw = this.supply.drawForPour(want, binderNeed); // throttles to the scarcest of tailings/water/binder
      const delta = draw.m3;
      if (draw.limiting && Math.floor(this.day) !== this.lastDayShown) {
        const fix = draw.limiting === "binder" ? "order a truck top-up or build the Rail terminal"
          : draw.limiting === "tailings" ? "the Mill can't keep the buffer fed" : "the pond is dry — check the Water pump";
        this.hud.setStatus(`⚠ ${s.id} pour throttled — out of ${draw.limiting} (${fix}).`);
      }
      s.placedM3 += delta;
      this.cash -= recipeCostPerM3(this.recipeFor(s)) * fill.costMult * delta;

      // Barricade loading (GDD 09): the rate of rise loads the barricade until the
      // plug sets and isolates it. Pour the plug too fast and it fails — inrush.
      const bfrac = s.placedM3 / s.volumeM3;
      s.plugSet = Math.min(1, bfrac / PLUG_SET_FRAC);
      const preSet = 1 - s.plugSet;
      const fluidMult = fill.reticulated ? 1 : 0.35; // trucked CAF exerts little fluid head
      s.barricadeKpa = (BAR_RISE_K * s.flowFactor + BAR_HEAD_K * bfrac) * preSet * fluidMult;
      const cap = this.barricadeCap(s);
      // grace: the barricade tolerates a brief overload — ease the flow and it recovers
      if (cap > 0 && s.barricadeKpa > cap) s.barricadeOver += dd;
      else s.barricadeOver = Math.max(0, s.barricadeOver - dd * 2);
      if (cap > 0 && s.barricadeOver > 0.05) {
        this.underground.net.clearFlow(this.underground.stopes.indexOf(s));
        this.underground.inrush(s); this.sound.burst();
        if (s.exclusionZone) {
          this.cash -= INRUSH_PENALTY * 0.4;
          this.hud.setStatus(`⚠ ${s.id} INRUSH — barricade failed, but the exclusion zone contained it (no injuries). Rebuild & re-pour (−${fmtMoney(INRUSH_PENALTY * 0.4)}).`);
        } else {
          this.cash -= INRUSH_PENALTY; this.safetyIncidents++;
          this.hud.setStatus(`⚠ ${s.id} INRUSH — barricade failed and paste ran into the drive. Safety incident. Rebuild & re-pour (−${fmtMoney(INRUSH_PENALTY)}).`);
        }
        continue;
      }

      if (s.placedM3 >= s.volumeM3) {
        this.underground.net.clearFlow(this.underground.stopes.indexOf(s));
        this.underground.completePour(s, this.day);
        this.cash += fillRevenue(s.volumeM3); this.sound.cash();
        this.hud.setStatus(`${s.id} ${fill.label} complete — ${fmtMoney(fillRevenue(s.volumeM3))} ore access unlocked. Curing now.`);
        if (s.barricadeRisk && Math.abs(Math.sin(s.depthM * 12.9 + s.volumeM3)) > 0.5) {
          this.safetyIncidents++; this.cash -= 900_000; this.sound.burst();
          this.hud.setStatus(`⚠ ${s.id} barricade seepage on fill — spill contained, but geotech was right (−${fmtMoney(900_000)}).`);
        }
      }
    }

    // surface materials economy: hoist ore, mill it (concentrate income + tailings), route to TSF, deliver binder, pump water
    const deliveryMult = (this.day < this.tempDeliveryUntil ? this.tempDeliveryMult : 1) * (this.scenario.binder?.deliveryMult ?? 1);
    const sup = this.supply.tick(dd, this.supplyState(), deliveryMult);
    const revenue = sup.revenue * (this.research.has("recovery") ? 1.15 : 1);
    const modeCostMult = this.activeBinderMode()?.costMult ?? 1; // haulage/isotainer cost more per tonne
    const binderCost = sup.binderCost * (this.research.has("binder") ? 0.7 : 1) * (this.scenario.binder?.costMult ?? 1) * modeCostMult;
    this.cash += revenue - binderCost;
    this.rp += sup.milledT / 4000; // know-how accrues as ore is processed
    this.millDayIncome = dd > 0 ? revenue / dd : 0; // $/day for the HUD readout
    if (sup.notes.length && Math.floor(this.day) !== this.lastDayShown) this.hud.setStatus(sup.notes[0]);
    const ev = this.underground.updateSchedule(this.day);
    this.cash -= (BASE_OPEX_PER_DAY + this.opexPerDay) * this.opexMult * dd; // daily running cost
    if (this.scenario.wet) this.cash -= this.scenario.wet.dewaterPerDay * dd; // pumping the flooded workings out
    this.cash -= LATE_COST_PER_DAY * ev.overdue.length * dd;             // overdue stopes stall mining
    for (const s of ev.newlyAvailable) this.hud.setStatus(`${s.id} mucked out at −${s.depthM} m — ready to reticulate (due day ${s.dueDay}).`);
    // 7-day early cylinder — the course's mid-cure warning that a recipe is short
    for (const s of this.underground.stopes) {
      if (s.status === "curing" && !s.ucs7Reported && this.day - s.cureStartDay >= this.underground.cureDaysFor(s) * 0.5) {
        s.ucs7Reported = true;
        const ucs7 = ucs28Kpa(this.recipeFor(s)) * this.ucsRealised(s) * FILL_TYPES[s.fillType].ucsMult * 0.6;
        s.ucs7Kpa = Math.round(ucs7);
        this.hud.setStatus(`${s.id} 7-day cylinder ${s.ucs7Kpa} kPa — ${ucs7 >= s.targetUcsKpa * 0.6 ? "on track" : "LOW, 28-day may fail"}.`);
      }
    }
    for (const s of ev.newlyCured) {
      const achieved = ucs28Kpa(this.recipeFor(s)) * this.ucsRealised(s) * FILL_TYPES[s.fillType].ucsMult;
      s.ucsAchievedKpa = Math.round(achieved);
      s.ucsPass = achieved >= s.targetUcsKpa;
      this.rp += 3; // a handed-back stope teaches the crew
      s.ucsPass ? this.sound.pass() : this.sound.fail();
      this.hud.setStatus(`${s.id} 28-day cylinder ${s.ucsAchievedKpa}/${s.targetUcsKpa} kPa — ${s.ucsPass ? "PASS ✓" : "FAIL ✗ (geotech won't sign the hand-back)"}.`);
    }
    this.updateEconomy();

    // throttled HUD refresh
    if (Math.floor(this.day) !== this.lastDayShown) { this.lastDayShown = Math.floor(this.day); this.refreshClock(); this.refreshSchedule(); this.saveGame(); this.checkTutorial(); if (this.mode === "underground") this.renderStopePanel(); }
    else if (this.mode === "underground" && this.selectedStope?.status === "pouring") this.renderStopePanel();

    this.maybeFireEvent();
    if (this.day >= this.scenario.horizonDays || this.underground.counts().cured === this.underground.stopes.length) this.endCampaign();
  }

  private pourMult() { return this.day < this.tempPourUntil ? this.tempPourMult : 1; }

  private maybeFireEvent() {
    if (this.activeEvent) return;
    const pouring = this.underground.stopes.find((s) => s.status === "pouring");
    const avail = this.underground.stopes.find((s) => s.status === "available");
    if (this.day >= 20 && pouring && !this.firedEvents.has("seismic")) this.fireEvent(this.evSeismic(pouring));
    else if (this.day >= 16 && avail && !this.firedEvents.has("geotech")) this.fireEvent(this.evGeotech(avail));
    else if (this.day >= 12 && !this.firedEvents.has("binder-delay") && this.activeBinderMode()?.type === "rail") this.fireEvent(this.evBinderDelay());
    else if (this.day >= 24 && !this.firedEvents.has("mill-trip")) this.fireEvent(this.evMillTrip());
  }
  private fireEvent(ev: GameEvent) {
    this.activeEvent = ev; this.firedEvents.add(ev.id); this.paused = true; this.refreshClock(); this.sound.event();
    this.hud.showEvent(`<div class="rsHead">⚠ ${ev.title}</div><p class="evBody">${ev.body}</p><div class="evOpts">${ev.options.map((o, i) => `<button class="optBtn" data-act="ev:${i}"><b>${o.label}</b><span>${o.detail}</span></button>`).join("")}</div>`);
  }
  private resolveEvent(i: number) {
    const ev = this.activeEvent; if (!ev) return;
    ev.options[i].apply(this);
    this.activeEvent = null; this.paused = false; this.hud.hideEvent(); this.updateEconomy(); this.refreshClock();
  }
  private evBinderDelay(): GameEvent {
    return {
      id: "binder-delay", title: "Binder rail shipment delayed",
      body: "The rail cement shipment is held up — the silo will run down. Binder is ~70% of your cost, and every pour needs it. Silo capacity vs delivery lead time is the eternal squeeze.",
      options: [
        { label: `Truck top-up (+${BINDER_TOPUP_TONNES} t, ${fmtMoney(BINDER_TOPUP_COST)})`, detail: "Short lead, premium price — keeps pours running.", apply: (w) => { w.cash -= BINDER_TOPUP_COST; w.supply.topUpBinder(BINDER_TOPUP_TONNES); } },
        { label: "Accept reduced rail for 8 days", detail: "Delivery cut to 30% — stretch the silo, watch the level.", apply: (w) => { w.tempDeliveryMult = 0.3; w.tempDeliveryUntil = w.day + 8; } },
        { label: "Pause pours 3 days", detail: "Wait for rail — the schedule slips.", apply: (w) => { w.day += 3; } },
      ],
    };
  }
  private evSeismic(s: StopeUG): GameEvent {
    return {
      id: "seismic", title: "Seismic event during pour",
      body: `A production blast on the level above has shaken the fresh fill mid-pour on ${s.id}. Pressure is spiking on the line — a soft, steady pour survives a pulse; a stiff, over-pressured line does not.`,
      options: [
        { label: "Ease flow and ride it out", detail: "Reduce flow, let the pulse pass — a little plug drift.", apply: () => { s.flowFactor = Math.max(0.4, s.flowFactor * 0.6); s.plugDrift = Math.min(1, s.plugDrift + 0.15); } },
        { label: "Emergency flush the line", detail: "Clear the line now — safe, costs a bit of paste.", apply: (w) => { s.plugDrift = 0; w.cash -= 120_000; } },
        { label: "Stand down the pour", detail: "Stop safely — cold joint, re-pour the placed volume.", apply: (w) => { w.underground.burst(s); w.hud.setStatus(`${s.id} stood down through the seismic event — re-pour needed.`); } },
      ],
    };
  }
  private evGeotech(s: StopeUG): GameEvent {
    return {
      id: "geotech", title: `Geotech flag on ${s.id}`,
      body: `Ground control has flagged the barricade footing on ${s.id}. They want it reinforced before you pour fresh fill against it — ignore the geotech at your peril, a barricade breach is a runaway.`,
      options: [
        { label: "Reinforce the barricade (+$600k, +1 day)", detail: "Do it right — removes the failure risk.", apply: (w) => { w.cash -= 600_000; w.day += 1; s.barricadeRisk = false; } },
        { label: "Proceed as designed", detail: "Save time and money — accept the risk of a breach.", apply: () => { s.barricadeRisk = true; } },
        { label: "Delay this stope 2 days", detail: "Wait for a fuller assessment.", apply: (w) => { w.day += 2; } },
      ],
    };
  }
  private evMillTrip(): GameEvent {
    return {
      id: "mill-trip", title: "Mill trip — tailings feed cut",
      body: "The mill has tripped. Tailings feed to the plant is throttled — surge capacity is your buffer against the mill's bad days.",
      options: [
        { label: "Run at reduced flow (5 days)", detail: "Pours proceed but pour rate halved.", apply: (w) => { w.tempPourMult = 0.5; w.tempPourUntil = w.day + 5; } },
        { label: "Draw down tailings buffer (+$300k)", detail: "Buy stored tailings — keep full rate.", apply: (w) => { w.cash -= 300_000; } },
        { label: "Hold pours 2 days", detail: "Wait for the mill restart.", apply: (w) => { w.day += 2; } },
      ],
    };
  }

  /** The mix the Lab currently edits + the pour/QA uses: the selected stope's, else the default. */
  private recipeFor(st: StopeUG) { return st.recipe ?? this.recipe; }
  private activeRecipe() {
    const st = this.selectedStope;
    if (st) { if (!st.recipe) st.recipe = { ...this.recipe }; return st.recipe; }
    return this.recipe;
  }

  /** A compact mix line for the stope panel with predicted strength vs target. */
  private recipeSummary(st: StopeUG): string {
    const r = this.recipeFor(st);
    const ucs = ucs28Kpa(r) * FILL_TYPES[st.fillType].ucsMult;
    const ok = ucs >= st.targetUcsKpa;
    const floor = ucs < World.LIQUEFACTION_FLOOR
      ? `<div class="pWarn">⚠ ${ucs.toFixed(0)} kPa is under the ${World.LIQUEFACTION_FLOOR} kPa liquefaction floor — the fill could flow, not just fail strength.</div>`
      : "";
    return `<div class="pSplit"><span>Mix ${(r.solids * 100).toFixed(0)}% · ${r.binderKgPerM3} kg/m³</span><b class="${ok ? "good" : "pLate"}">${ucs.toFixed(0)}/${st.targetUcsKpa} kPa</b></div>${floor}
      <div class="pNote">Tune this stope's mix in the 🧪 Lab.</div>`;
  }

  // Course guidance: fill below ~100 kPa can liquefy (not just miss strength).
  static readonly LIQUEFACTION_FLOOR = 100; // kPa

  /** Strength-design basis for a stope: exposure by later mining × safety factor
   *  explains WHY the target UCS is what it is (course: SF 1.3–2.0). Primaries get
   *  exposed on more faces when the secondaries around them are mined out. */
  private designBasis(st: StopeUG): { exposure: string; faces: number; sf: number; inSitu: number } {
    const sf = st.isPrimary ? 2.0 : st.levelIdx === 0 ? 1.3 : 1.5;
    const faces = st.isPrimary ? 4 : st.levelIdx === 0 ? 1 : 2;
    const exposure = st.isPrimary
      ? "exposed on all sides once its secondaries are mined"
      : faces === 1 ? "one sidewall exposed" : "sidewall + brow exposed";
    return { exposure, faces, sf, inSitu: Math.round(st.targetUcsKpa / sf) };
  }

  /** Is a fill type the right structural choice for this stope? Teaches when each
   *  fits: HF is for lean secondaries, CAF/PAF are strong primary fills that need
   *  aggregate (a crusher), paste is the balanced default. The sim's multipliers
   *  still enforce the consequence if you override the advice. */
  private fillSuitability(st: StopeUG, ft: FillType): { verdict: "good" | "ok" | "bad"; reason: string } {
    if (ft.needsAggregate && !this.hasCrusher())
      return { verdict: "bad", reason: `${ft.short} needs crushed aggregate — build a Crusher plant on the surface first.` };
    const highDemand = st.isPrimary || st.targetUcsKpa >= 800;
    if (ft.key === "hydraulic")
      return highDemand
        ? { verdict: "bad", reason: `Hydraulic fill can't deliver high early strength — wrong for a ${st.targetUcsKpa} kPa ${st.isPrimary ? "primary" : "stope"}. Save it for lean secondaries.` }
        : { verdict: "good", reason: `A lean secondary — cheap hydraulic fill is a good fit here.` };
    if (ft.key === "caf" || ft.key === "paf")
      return highDemand
        ? { verdict: "good", reason: `Strong ${ft.short} suits this ${st.isPrimary ? "primary" : "high-strength stope"} — exposed on ${this.designBasis(st).faces} faces later.` }
        : { verdict: "ok", reason: `${ft.short} is strong but pricey to place — a leaner fill would do on this ${st.targetUcsKpa} kPa secondary.` };
    // paste
    return { verdict: "good", reason: `Balanced paste — the dependable default for this stope.` };
  }

  private labReadout(): string {
    const st = this.selectedStope;
    const r = st?.recipe ?? this.recipe;
    const ucs = ucs28Kpa(r);
    const pump = pumpability(r.solids);
    const target = st ? st.targetUcsKpa : Math.max(...this.underground.stopes.map((s) => s.targetUcsKpa));
    const strengthOk = ucs >= target;
    const forWho = st ? `for ${st.id}` : "default mix";
    const minl = this.scenario.mineralogy;
    const twBlock = this.testWorkDone
      ? `<div class="labRow"><span class="good">✓ verified</span><small>test-work done — tight UCS scatter, safe to trim binder</small></div>
         ${minl ? `<div class="pNote">Material: <b>${minl.label}</b> — ${minl.note}</div>` : ""}`
      : `<div class="pWarn">⚠ No test-work — the true rheology/UCS curve is unknown. Cylinders scatter widely; over-binder to be safe.</div>
         <button class="pBtn primary" data-act="testwork"><b>Commission test-work (${fmtMoney(TESTWORK_COST)})</b><span>reveals the real UCS curve &amp; mineralogy; cuts scatter so you can trim binder · +${TESTWORK_DAYS} days</span></button>`;
    return `<div class="labFor">Tuning: <b>${forWho}</b></div>` + `
      <div class="labRow"><span>${yieldStressPa(r.solids).toFixed(0)} Pa</span><small>yield stress</small></div>
      <div class="labRow"><span>${frictionKpaPerM(r.solids).toFixed(1)} kPa/m</span><small>friction gradient</small></div>
      <div class="labRow"><span class="${strengthOk ? "good" : "bad"}">${ucs.toFixed(0)} kPa${this.testWorkDone ? "" : " ±?"}</span><small>predicted 28-day UCS (need ${target})</small></div>
      <div class="labRow"><span>$${recipeCostPerM3(r).toFixed(1)}/m³</span><small>paste cost</small></div>
      <div class="labLight ${pump.level}">Pumpability: ${pump.label}</div>
      ${twBlock}`;
  }

  private refreshClock() { this.hud.setClock(this.day, this.paused, this.speedIdx, SPEEDS); }
  private refreshSchedule() { this.hud.setSchedule(this.underground.counts(), this.day, this.scenario.horizonDays); }

  private endCampaign() {
    if (this.ended) return;
    this.ended = true; this.paused = true;
    clearSave(); // finished campaigns don't resume
    const stopes = this.underground.stopes;
    const total = stopes.length;
    const cured = stopes.filter((s) => s.status === "cured").length;
    const passed = stopes.filter((s) => s.status === "cured" && s.ucsPass).length; // cured AND hit strength
    const onTime = stopes.filter((s) => s.status === "cured" && s.cureStartDay <= s.dueDay).length;
    const minedFrac = 1 - this.supply.oreReserve.level / this.scenario.orebody; // how much of the orebody was monetised
    let score = 0;
    score += passed === total ? 3 : passed >= total - 1 ? 2 : passed >= total / 2 ? 1 : 0;
    score += onTime >= total ? 2 : onTime >= total * 0.6 ? 1 : 0;
    score += this.cash > 0 ? 2 : 0;
    score += this.cash > this.scenario.startCash * 0.3 ? 1 : 0;
    score += minedFrac > 0.8 ? 1 : 0; // reward extracting the resource before the horizon
    const order = ["S", "A", "B", "C", "D"];
    const baseGi = order.indexOf(score >= 8 ? "S" : score >= 6 ? "A" : score >= 4 ? "B" : score >= 2 ? "C" : "D");
    // safety costs grade tiers, monotonically: 1 incident -1, a couple -2, a rash -3
    const steps = this.safetyIncidents >= 4 ? 3 : this.safetyIncidents >= 2 ? 2 : this.safetyIncidents === 1 ? 1 : 0;
    const grade = order[Math.min(order.length - 1, baseGi + steps)];
    this.lastGrade = grade;
    // bank legacy points into the persistent company
    const earned = legacyForGrade(grade);
    const co = loadCompany(); co.legacy += earned; saveCompany(co);
    this.hud.showResult(`
      <div class="rsHead">Board review · Day ${Math.floor(this.day)}</div>
      <div class="rsGrade grade-${grade}">${grade}</div>
      <div class="rsRows">
        <div><span>Cylinders passed</span><b>${passed}/${total}</b></div>
        <div><span>On time</span><b>${onTime}/${total}</b></div>
        <div><span>Orebody extracted</span><b>${Math.round(minedFrac * 100)}%</b></div>
        <div><span>Cash</span><b>${fmtMoney(this.cash)}</b></div>
        <div><span>Safety</span><b>${this.safetyIncidents ? this.safetyIncidents + " incident" + (this.safetyIncidents > 1 ? "s" : "") : "clean"}</b></div>
        <div><span>Company legacy</span><b>+${earned} → ${co.legacy}</b></div>
      </div>
      <button class="pBtn primary" data-act="restart"><b>New campaign</b></button>`);
  }

  // ---- save / resume ---------------------------------------------------------
  private serialize() {
    return {
      v: SAVE_VERSION, scenario: this.scenario.id, savedAt: Math.floor(this.day),
      day: this.day, speedIdx: this.speedIdx, cash: this.cash, opexPerDay: this.opexPerDay,
      rp: this.rp, research: [...this.research], opexMult: this.opexMult,
      safetyIncidents: this.safetyIncidents, testWorkDone: this.testWorkDone, firedEvents: [...this.firedEvents],
      tempDeliveryMult: this.tempDeliveryMult, tempDeliveryUntil: this.tempDeliveryUntil,
      tempPourMult: this.tempPourMult, tempPourUntil: this.tempPourUntil,
      plantThroughput: this.plantThroughput,
      recipe: { solids: this.recipe.solids, binder: this.recipe.binderKgPerM3 },
      supply: {
        ore: this.supply.ore.level, oreReserve: this.supply.oreReserve.level,
        tailings: this.supply.tailings.level, binder: this.supply.binder.level, water: this.supply.water.level,
        tsf: this.supply.tsf.level,
      },
      buildings: this.buildings.map((b) => ({ type: b.spec.type, x: b.pos.x, z: b.pos.z, tier: b.tier, raises: b.raises })),
      stopes: this.underground.serializeStopes(),
      net: this.underground.net.serialize(),
      plant: this.plantInterior.serializeLine(),
    };
  }
  private saveGame() { if (!this.ended) writeSave(this.serialize()); }

  /** Rebuild a saved campaign onto a freshly started World (same scenario). */
  loadSave(s: any) {
    // buildings first (silent — no cash deduction, we set cash after)
    for (const b of s.buildings) {
      const spec = specOf(b.type); const at = new Vector3(b.x, heightAt(b.x, b.z), b.z);
      const placed = this.place(spec, at, true);
      placed.tier = b.tier || 0; placed.raises = b.raises || 0;
      if (placed.tier) placed.root.scaling.setAll(1 + placed.tier * 0.08);
      if (placed.raises) placed.root.scaling.y = 1 + placed.raises * 0.22;
    }
    this.underground.net.applySave(s.net);
    this.underground.applyStopes(s.stopes, s.day);
    this.plantInterior.applyLine(s.plant);
    // scalar state
    this.day = s.day; this.speedIdx = s.speedIdx ?? 1; this.cash = s.cash; this.opexPerDay = s.opexPerDay;
    this.rp = s.rp || 0; this.research = new Set(s.research || []); this.opexMult = s.opexMult ?? 1;
    this.safetyIncidents = s.safetyIncidents || 0; this.testWorkDone = !!s.testWorkDone; this.firedEvents = new Set(s.firedEvents || []);
    this.tempDeliveryMult = s.tempDeliveryMult ?? 1; this.tempDeliveryUntil = s.tempDeliveryUntil ?? 0;
    this.tempPourMult = s.tempPourMult ?? 1; this.tempPourUntil = s.tempPourUntil ?? 0;
    this.plantThroughput = s.plantThroughput ?? this.plantThroughput;
    if (s.recipe) { this.recipe.solids = s.recipe.solids; this.recipe.binderKgPerM3 = s.recipe.binder; }
    this.supply.ore.level = s.supply.ore; this.supply.oreReserve.level = s.supply.oreReserve;
    this.supply.tailings.level = s.supply.tailings; this.supply.binder.level = s.supply.binder;
    this.supply.water.level = s.supply.water; this.supply.tsf.level = s.supply.tsf;
    this.paused = true; // resume paused so the player gets their bearings
    this.recomputePower(); this.refreshSupply(); this.updateEconomy(); this.refreshObjective();
    this.refreshClock(); this.refreshSchedule();
    this.hud.setStatus(`Campaign resumed — day ${Math.floor(this.day)}. Press ▶ when ready.`);
    const c = this.underground.counts();
    console.log(`RESUMED|day=${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m buildings=${this.buildings.length} tiers=${this.buildings.map((b) => b.tier).join("")} cured=${c.cured} statuses=${this.underground.stopes.map((s) => s.status[0]).join("")} tsf=${Math.round(this.supply.tsf.level / 1000)}k rp=${Math.floor(this.rp)}`);
  }

  // ---- pointer --------------------------------------------------------------

  private onPointer(pi: { type: number; event: { button?: number } }) {
    if (pi.type === PointerEventTypes.POINTERDOWN) { // unlock + start ambience on first gesture
      this.sound.resume();
      if (this.soundOn && !this.ambientStarted) { this.ambientStarted = true; this.sound.toggleAmbient(true); }
    }
    if (this.mode === "plant") { this.plantInterior.handlePointer(pi); return; }
    if (this.mode === "underground") {
      if (pi.type === PointerEventTypes.POINTERTAP && pi.event.button !== 2) {
        const hit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => !!(m.metadata as any)?.stopeId);
        const st = hit?.pickedMesh ? this.underground.byMesh(hit.pickedMesh) : null;
        if (st) this.selectStope(st);
      }
      return;
    }
    // surface: click a building to inspect it (details panel) when not placing
    if (!this.armed) {
      if (pi.type === PointerEventTypes.POINTERTAP && pi.event.button !== 2) {
        const hit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => (m.metadata as any)?.bi !== undefined);
        const bi = (hit?.pickedMesh?.metadata as any)?.bi as number | undefined;
        if (bi !== undefined && this.buildings[bi]) this.selectBuilding(this.buildings[bi]);
        else this.deselectBuilding();
      }
      return;
    }
    if (!this.ghost) return;
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

  // ---- surface placement ----------------------------------------------------

  private onSelect(type: string) {
    const spec = specOf(type);
    if (this.armed?.type === type) { this.disarm(); return; }
    if (this.cash < spec.cost) { this.hud.setStatus(`Not enough cash for ${spec.label} (${fmtMoney(spec.cost)}).`); return; }
    this.arm(spec);
  }

  private arm(spec: BuildingSpec) {
    if (this.ghost) this.ghost.dispose();
    this.armed = spec;
    this.ghost = spec.make(this.scene); this.ghost.parent = this.surfaceRoot;
    this.setGhostValid = ghostify(this.scene, this.ghost, spec.fw, spec.fd);
    this.camera.detachControl();
    this.hud.setArmed(spec.type);
    this.hud.setStatus(`Placing ${spec.label} — click ${spec.offPad ? "out on the terrain, off the plant pad" : "the graded pad"}. Right-click to cancel.`);
  }

  private disarm() {
    this.armed = null;
    this.ghost?.dispose(); this.ghost = null; this.ghostPos = null; this.setGhostValid = null;
    this.camera.attachControl(this.canvas, true);
    this.hud.setArmed(null);
  }

  private canPlace(spec: BuildingSpec, x: number, z: number): boolean {
    const d = Math.hypot(x, z);
    const half = Math.max(spec.fw, spec.fd) / 2;
    if (spec.offPad) {
      // big works site out on the terrain: clear of the plant pad, but on the map
      if (d < PAD_RADIUS + half * 0.5) return false;
      if (d > TERRAIN_SIZE / 2 - half - 6) return false;
    } else {
      // plant works sit on the graded pad near the origin
      if (d > PAD_RADIUS - Math.max(spec.fw, spec.fd) * 0.35) return false;
    }
    for (const b of this.buildings) {
      const gap = 3;
      if (Math.abs(x - b.pos.x) < (spec.fw + b.spec.fw) / 2 + gap &&
          Math.abs(z - b.pos.z) < (spec.fd + b.spec.fd) / 2 + gap) return false;
    }
    return true;
  }

  private place(spec: BuildingSpec, at: Vector3, silent = false): Placed {
    const bi = this.buildings.length;
    if (spec.offPad) this.gradePlatform(at, spec.fw, spec.fd); // cut a flat bench into the slope first
    const root = spec.make(this.scene, (m) => { this.shadow.addShadowCaster(m); m.metadata = { buildingType: spec.type, bi }; });
    root.parent = this.surfaceRoot; root.position.copyFrom(at);
    if (!silent) this.cash -= spec.cost;
    const placed: Placed = { spec, root, pos: at, marker: null, raises: 0, tier: 0, built: false, buildProgress: 0, buildDays: 0, scaffold: null };
    this.buildings.push(placed);
    if (silent) this.finishBuild(placed);      // loaded/restored buildings stand complete
    else this.startConstruction(placed);       // player builds rise over game-time, crewed
    this.drawRoads();
    this.recomputePower();
    this.refreshSupply();
    this.refreshObjective();
    this.checkTutorial();
    if (silent) return placed;
    this.sound.build();
    this.saveGame();
    this.hud.setStatus(`${spec.label} — construction started. The crew is on site.`);
    if (this.cash >= spec.cost) this.arm(spec); else this.disarm();
    return placed;
  }

  // ---- staged construction --------------------------------------------------

  /** Set a building rising: scaffold up, structure scaled down, crew converges. */
  private startConstruction(b: Placed) {
    const area = b.spec.fw * b.spec.fd;
    b.built = false; b.buildProgress = 0;
    b.buildDays = Math.max(0.5, Math.min(2.2, 0.4 + area / 120)); // bigger footprints take longer
    b.scaffold = this.makeScaffold(b.pos, b.spec.fw, b.spec.fd);
    this.applyBuildVisual(b);
  }

  /** Mark a building finished: full structure, scaffold gone, opex + crews/trucks online. */
  private finishBuild(b: Placed) {
    b.built = true; b.buildProgress = 1;
    b.root.scaling.set(1, 1, 1);
    if (b.scaffold) { b.scaffold.dispose(); b.scaffold = null; }
    this.opexPerDay += b.spec.opexPerDay;
    if (b.spec.spawnsWorkers) this.crew.add(b.spec.spawnsWorkers);
    if (b.spec.spawnsTrucks) { this.fleet.clear(); this.fleet.add(b.spec.spawnsTrucks, b.pos, this.portal); }
  }

  /** Advance every in-progress build by the elapsed game-days; complete + announce. */
  private updateConstruction(dd: number) {
    if (dd <= 0) return;
    for (const b of this.buildings) {
      if (b.built) continue;
      b.buildProgress = Math.min(1, b.buildProgress + dd / b.buildDays);
      this.applyBuildVisual(b);
      if (b.buildProgress >= 1) {
        this.finishBuild(b);
        this.drawRoads(); this.recomputePower(); this.refreshSupply(); this.refreshObjective(); this.checkTutorial(); this.saveGame();
        const disc = b.spec.supplies && !this.connected(b) ? " ⚠ Too far from the plant — no feed line reaches it." : "";
        this.hud.setStatus(`${b.spec.label} complete — now operational.` + disc + (b.spec.type === "power" ? " It powers everything nearby." : ""));
        this.sound.build();
      }
    }
  }

  /** Grow the structure up from its foundations as it's built; reveal-then-hide scaffold. */
  private applyBuildVisual(b: Placed) {
    const p = b.buildProgress;
    const ease = 1 - Math.pow(1 - p, 2);
    b.root.scaling.set(1, 0.06 + 0.94 * ease, 1); // rises from the ground
    if (b.scaffold) b.scaffold.setEnabled(p < 0.999);
  }

  /** Timber/steel scaffold poles + a top rail around the building footprint. */
  private makeScaffold(at: Vector3, fw: number, fd: number): TransformNode {
    const node = new TransformNode("scaffold", this.scene); node.parent = this.surfaceRoot; node.position.copyFrom(at);
    const m = new StandardMaterial("scaffoldM", this.scene);
    m.diffuseColor = Color3.FromHexString("#b7935a"); m.specularColor = Color3.Black();
    const H = 6, hw = fw / 2 + 0.6, hd = fd / 2 + 0.6;
    const corners: [number, number][] = [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]];
    for (const [x, z] of corners) {
      const pole = MeshBuilder.CreateCylinder("spole", { diameter: 0.3, height: H, tessellation: 6 }, this.scene);
      pole.material = m; pole.position.set(x, heightAt(at.x + x, at.z + z) - at.y + H / 2, z); pole.parent = node;
      this.shadow.addShadowCaster(pole);
    }
    for (const yy of [H * 0.45, H * 0.9]) {
      for (const [ax, az, len, rotY] of [[0, -hd, hw * 2, 0], [0, hd, hw * 2, 0], [-hw, 0, hd * 2, Math.PI / 2], [hw, 0, hd * 2, Math.PI / 2]] as const) {
        const rail = MeshBuilder.CreateBox("srail", { width: 0.14, height: 0.14, depth: len }, this.scene);
        rail.material = m; rail.position.set(ax, yy, az); rail.rotation.y = rotY; rail.parent = node;
      }
    }
    return node;
  }

  private anyPourActive() { return this.underground.stopes.some((s) => s.status === "pouring"); }
  private cafPourActive() { return this.underground.stopes.some((s) => s.status === "pouring" && !FILL_TYPES[s.fillType].reticulated); }

  /** Realised UCS factor for a stope's pour: base scatter, widened hugely if no
   *  test-work has been done, plus the scenario's mineralogy risk (sulphide late
   *  strength loss / clay variability). Test-work tightens scatter and halves the
   *  mineralogy penalty — the course's "verify the design basis, then trim binder". */
  private ucsRealised(s: StopeUG): number {
    let v = ucsVariance(s.depthM + s.dueDay);
    const minl = this.scenario.mineralogy;
    if (!this.testWorkDone) v = 1 + (v - 1) * 2.5 - (minl?.varianceAdd ?? 0); // untested → wide, risky scatter
    const latePen = (minl?.latePenalty ?? 0) * (this.testWorkDone ? 0.4 : 1);
    return Math.max(0.4, v * (1 - latePen));
  }

  /** Barricade capacity (kPa it can hold) from its type + optional relief. */
  private barricadeCap(s: StopeUG): number {
    if (!s.barricadeType) return 0;
    return BARRICADE[s.barricadeType].capKpa + (s.barricadeRelief ? BARRICADE.reliefBonusKpa : 0);
  }
  /** Up-front cost of the designed barricade (type + relief + exclusion + instrumentation). */
  private barricadeCost(s: StopeUG): number {
    if (!s.barricadeType) return 0;
    return BARRICADE[s.barricadeType].cost + (s.barricadeRelief ? BARRICADE.reliefCost : 0)
      + (s.exclusionZone ? BARRICADE.exclusionCost : 0) + (s.barricadeInstr ? BARRICADE.instrCost : 0);
  }

  /** Cut a flat gravel bench into the sloping terrain under an off-pad structure. */
  private gradePlatform(at: Vector3, fw: number, fd: number) {
    const pad = MeshBuilder.CreateBox("gradePad", { width: fw + 8, height: 9, depth: fd + 8 }, this.scene);
    const m = new StandardMaterial("gradePadM", this.scene);
    m.diffuseColor = Color3.FromHexString("#8f8578"); m.specularColor = Color3.Black();
    pad.material = m; pad.position.set(at.x, at.y - 4.1, at.z); // top ~0.4 above ground, base sunk into the hill
    pad.parent = this.surfaceRoot; pad.receiveShadows = true; pad.isPickable = false;
  }

  /** Haul roads from every building to the mine portal, so the site reads as connected. */
  private drawRoads() {
    this.roadMeshes.forEach((m) => m.dispose()); this.roadMeshes = [];
    const roadMat = new StandardMaterial("roadMat", this.scene);
    roadMat.diffuseColor = Color3.FromHexString("#4a4640"); roadMat.specularColor = Color3.Black();
    for (const b of this.buildings) {
      const dx = this.portal.x - b.pos.x, dz = this.portal.z - b.pos.z;
      const len = Math.hypot(dx, dz); if (len < 1) continue;
      const road = MeshBuilder.CreateBox("road", { width: 4, height: 0.2, depth: len }, this.scene);
      road.material = roadMat; road.parent = this.surfaceRoot;
      road.position.set((b.pos.x + this.portal.x) / 2, heightAt((b.pos.x + this.portal.x) / 2, (b.pos.z + this.portal.z) / 2) + 0.15, (b.pos.z + this.portal.z) / 2);
      road.rotation.y = Math.atan2(dx, dz);
      road.isPickable = false;
      this.roadMeshes.push(road);
    }
  }

  /** Sources that are actually live: the power station(s), plus any substation relay
   *  reachable through a chain of energised sources. */
  private energizedSources(): Placed[] {
    const roots = this.buildings.filter((b) => b.built && b.spec.powerRadius && !b.spec.needsPower);
    const relays = this.buildings.filter((b) => b.built && b.spec.powerRadius && b.spec.needsPower);
    const energized = [...roots];
    for (let pass = 0; pass < relays.length + 1; pass++) {
      let added = false;
      for (const r of relays) {
        if (energized.includes(r)) continue;
        if (energized.some((s) => Vector3.Distance(s.pos, r.pos) <= this.radiusOf(s))) { energized.push(r); added = true; }
      }
      if (!added) break;
    }
    return energized;
  }

  /** The surface pipe run from the plant to the shaft collar costs friction head:
   *  a plant sited far from the shaft forces stronger pipe (or pumps) on every leg.
   *  Site it near the collar to preserve the gravity head (course Module 03/11). */
  plantSurfaceRunM(): number {
    const plant = this.buildings.find((b) => b.spec.type === "plant" && b.built);
    return plant ? Vector3.Distance(plant.pos, this.portal) * SURFACE_UNIT_M : 0;
  }
  private recomputePlantHead() { this.underground.net.setSurfaceHead(frictionMpa(this.plantSurfaceRunM())); }

  private recomputePower() {
    this.recomputePlantHead();
    this.energized = this.energizedSources();
    this.powered = 0;
    for (const b of this.buildings) {
      const ok = this.isPowered(b);
      this.updateMarker(b, !ok && b.spec.needsPower);
      if (ok) this.powered++;
    }
    this.total = this.buildings.length;
    this.drawPowerLines(this.energized);
    this.updateEconomy();
  }

  /** Draw sagging cables from the nearest in-range power source to each powered building. */
  private drawPowerLines(sources: Placed[]) {
    this.powerLineMeshes.forEach((m) => m.dispose()); this.powerLineMeshes = [];
    if (!sources.length) return;
    for (const b of this.buildings) {
      if (!b.spec.needsPower) continue;
      let best: Placed | null = null, bd = Infinity;
      for (const s of sources) { const d = Vector3.Distance(s.pos, b.pos); if (d <= this.radiusOf(s) && d < bd) { bd = d; best = s; } }
      if (!best) continue;
      const a = new Vector3(best.pos.x, best.pos.y + best.spec.markerY, best.pos.z);
      const c = new Vector3(b.pos.x, b.pos.y + b.spec.markerY, b.pos.z);
      const mid = Vector3.Center(a, c); mid.y -= 2.5; // sag
      const line = MeshBuilder.CreateLines("pline", { points: [a, mid, c] }, this.scene);
      line.color = Color3.FromHexString("#12161c"); line.parent = this.surfaceRoot; line.isPickable = false;
      this.powerLineMeshes.push(line);
    }
  }

  private updateEconomy() {
    this.hud.setEconomy(this.cash, this.powered, this.total);
    this.hud.setBinder(this.supply.binder.level, this.supply.binder.cap);
    this.hud.setResources({ reserve: this.supply.oreReserve, ore: this.supply.ore, tailings: this.supply.tailings, water: this.supply.water, tsf: this.supply.tsf, income: this.millDayIncome });
    this.updateTsfVisuals();
  }
  /** Raise each TSF's tailings surface to match the site fill fraction. */
  private updateTsfVisuals() {
    const f = this.supply.tsf.cap > 0 ? Math.max(0, Math.min(1, this.supply.tsf.level / this.supply.tsf.cap)) : 0;
    for (const b of this.buildings) {
      if (!b.spec.tsfCap) continue;
      const fill = b.root.getChildMeshes().find((m) => m.name.includes("tsffill"));
      if (fill) { fill.position.y = 1.9 + f * 2.9; fill.setEnabled(f > 0.02); }
    }
  }
  private hasCrusher() { return this.buildings.some((b) => b.spec.type === "crusher" && b.built); }
  /** Effective power radius including upgrades. */
  private radiusOf(b: Placed) {
    const r = b.spec.powerRadius ?? 0;
    const step = b.spec.upgrade?.stat === "power" ? b.spec.upgrade.step : 0;
    return r * (1 + b.tier * step);
  }
  /** A supply work feeds the plant only if it's powered AND close enough to run a feed line. */
  private connected(b: Placed) {
    if (!b.built) return false;
    const plant = this.buildings.find((x) => x.spec.type === "plant" && x.built);
    return !!plant && this.isPowered(b) && Vector3.Distance(b.pos, plant.pos) <= CONNECT_RANGE;
  }
  /** Best upgrade multiplier among the connected buildings of a type (1 = base / none). */
  private tierMult(type: string) {
    let best = 1;
    for (const b of this.buildings) {
      if (b.spec.type !== type || !this.connected(b) || !b.spec.upgrade) continue;
      best = Math.max(best, 1 + b.tier * b.spec.upgrade.step);
    }
    return best;
  }
  /** Effective TSF capacity of a dam, including dam-engineering research. */
  private tsfCapOf(b: Placed) {
    if (!b.spec.tsfCap) return 0;
    return Math.round(b.spec.tsfCap * (1 + b.raises * 0.5 * (this.research.has("dameng") ? 1.5 : 1)));
  }
  /** The connected binder supply with the highest delivery (rail / haulage / isotainer), or null. */
  private activeBinderMode(): { deliveryMult: number; costMult: number; siloCap: number; reliable: boolean; type: string } | null {
    let best: { deliveryMult: number; costMult: number; siloCap: number; reliable: boolean; type: string } | null = null;
    for (const b of this.buildings) {
      if (!b.built || !b.spec.binder || !this.connected(b)) continue;
      const upg = b.spec.type === "rail" ? this.tierMult("rail") : 1;
      const m = { ...b.spec.binder, deliveryMult: b.spec.binder.deliveryMult * upg, type: b.spec.type };
      if (!best || m.deliveryMult > best.deliveryMult) best = m;
    }
    return best;
  }
  /** Which powered supply buildings exist (and their upgrade multipliers), for the economy tick. */
  private supplyState() {
    const live = (t: string) => this.buildings.some((b) => b.spec.type === t && this.connected(b));
    const tsfCap = this.buildings.reduce((a, b) => a + (b.built ? this.tsfCapOf(b) : 0), 0);
    const bm = this.activeBinderMode();
    return {
      mill: live("mill"), rail: live("rail"), water: live("waterpump"), tsfCap,
      millMult: this.tierMult("mill"), waterMult: this.tierMult("waterpump"), binderMult: this.tierMult("rail"),
      binderSupply: !!bm, binderDeliveryMult: bm?.deliveryMult ?? 0, binderSiloCap: bm?.siloCap ?? this.supply.binder.cap,
      waterInflow: this.scenario.wet?.waterInflow ?? 0,
    };
  }
  /** Plant-schematic gating: a source is live only if its surface stock actually holds material. */
  private interiorSupply() {
    return { tailings: this.supply.tailings.level > 1, binder: this.supply.binder.level > 1, water: this.supply.water.level > 1 };
  }
  private refreshSupply() { this.plantInterior.setSupply(this.interiorSupply()); this.drawSupplyLinks(); }

  /** The next thing the player needs to build to stand up the operation, or null when set. */
  private nextObjective(): string | null {
    const has = (t: string) => this.buildings.some((b) => b.spec.type === t);
    const T = this.scenario.wet ? 5 : 6; // wet mines get their water free from groundwater
    const step = (n: number, body: string) => `<span class="objStep">Setup ${n}/${T}</span>${body}`;
    if (!has("power")) return step(1, "Build a <b>⚡ Power station</b> — everything on site runs on power.");
    if (!has("plant")) return step(2, "Build the <b>🏭 Backfill plant</b> on the graded pad.");
    if (!has("mill")) return step(3, "Build a <b>⚙ Mill</b> out on the terrain — it refines ore into cash and makes the tailings you backfill with.");
    if (!has("tsf")) return step(4, "Build a <b>⛰ Tailings dam</b> — only ~half the tailings can go underground; the rest must go to the TSF or the mill chokes.");
    if (!(has("rail") || has("haulage") || has("isotainer"))) return step(5, "Build a <b>binder supply</b> — 🚆 Rail (high throughput, cheap, lead-time risk), 🚛 Road haulage (flexible, pricier), or 📦 Isotainer pad (remote, low capex). Binder is ~70% of your cost.");
    if (!this.scenario.wet && !has("waterpump")) return step(6, "Build a <b>💧 Water pump</b> — the paste mix needs water.");
    const unpowered = this.buildings.filter((b) => b.spec.needsPower && !this.isPowered(b));
    if (unpowered.length) return `<span class="objStep">Power reach</span>${unpowered.length} work(s) out of power range — build a <b>🔌 Substation</b> to relay power out to them.`;
    const disconnected = this.buildings.filter((b) => b.spec.supplies && this.isPowered(b) && !this.connected(b));
    if (disconnected.length) return `<span class="objStep">Connect</span>${disconnected.length} supply work(s) can't reach the plant (red line) — resite them within feed-line range.`;
    return `<span class="objStep">Ready</span>You're set. Press <b>▶</b> to run time, then <b>⛏ go underground</b> to reticulate and pour.`;
  }
  private refreshObjective() {
    if (this.tutorial && this.tutStep < this.tutSteps.length) { this.hud.setObjective(null); return; } // tutorial replaces the objective banner
    this.hud.setObjective(this.mode === "surface" ? this.nextObjective() : null);
  }

  private setupTutorial() {
    const has = (t: string) => this.buildings.some((b) => b.spec.type === t);
    const stopeAt = (...st: string[]) => this.underground.stopes.some((s) => st.includes(s.status));
    this.tutSteps = [
      { text: `Welcome to <b>Wheal Verity</b>. First, power the site — click <b>⚡ Power station</b> in the palette below, then click the graded pad to place it.`, done: () => has("power") },
      { text: `Now the heart of the operation: build the <b>🏭 Backfill plant</b> on the pad.`, done: () => has("plant") },
      { text: `Cash and fill both come from ore. Build a <b>⚙ Mill</b> out on the terrain near the pad — it refines ore into income and makes the tailings you backfill with.`, done: () => has("mill") },
      { text: `Only ~half the tailings can go back underground. Build a <b>⛰ Tailings dam</b> for the rest, or the mill chokes.`, done: () => has("tsf") },
      { text: `Cement (binder) needs a supply. Pick one: <b>🚆 Rail terminal</b> (high throughput, cheap, but lead-time risk), <b>🚛 Road haulage</b> (flexible, pricier), or <b>📦 Isotainer pad</b> (remote, low capex). Binder is ~70% of your cost.`, done: () => has("rail") || has("haulage") || has("isotainer") },
      { text: `The paste mix needs water — build a <b>💧 Water pump</b>. Watch each work links to the plant: a <b>red line</b> means it's too far to connect.`, done: () => has("waterpump") },
      { text: `The plant is an empty shell — it makes <b>no paste yet</b>. Click the <b>🏭 Backfill plant</b> → <b>Enter plant</b>, then build the process line: place a <b>thickener</b>, a <b>filter</b>, a <b>twin-shaft mixer</b> and a <b>pump</b>, and wire each output to the next input (tailings + water + binder → mixer → pump → shaft). You can't pour paste until the plant produces it.`, done: () => this.plantThroughput > 0 },
      { text: `You're stood up! Press <b>▶</b> in the clock (top-left) to start time running.`, done: () => this.day > 1.15 },
      { text: `Now head below — click <b>⛏ Go underground</b>.`, done: () => this.mode === "underground" },
      { text: `Click a <b>ready stope</b> (green outline). Set a pipe <b>class</b> on each leg so it out-rates the pressure it holds, then <b>Build reticulation</b>.`, done: () => stopeAt("piped", "pouring", "curing", "cured") },
      { text: `Design the <b>barricade</b> (type + relief), issue the pour note, then <b>Begin pour</b>. Keep flow low until the plug sets or the barricade inrushes; then keep it in the band and flush a forming plug.`, done: () => stopeAt("pouring", "curing", "cured") },
      { text: `That's the whole loop: fill stopes before they're due, keep the mill fed and the TSF from filling, tune your mix in the 🧪 Lab, and answer to the board. You've got it from here — good luck!`, done: () => false },
    ];
  }
  private checkTutorial() {
    if (!this.tutorial) return;
    let advanced = false;
    while (this.tutStep < this.tutSteps.length - 1 && this.tutSteps[this.tutStep].done()) { this.tutStep++; advanced = true; }
    if (advanced) this.sound.pass();
    this.renderTutorial();
  }
  private renderTutorial() {
    if (!this.tutorial || this.tutStep >= this.tutSteps.length) { this.hud.setTutorial(null); return; }
    const s = this.tutSteps[this.tutStep]; const last = this.tutStep === this.tutSteps.length - 1;
    this.hud.setTutorial(`<div class="tutHead">🎓 Tutorial · step ${this.tutStep + 1}/${this.tutSteps.length}</div><div class="tutBody">${s.text}</div>`
      + (last ? `<button class="pBtn primary tutFinish" data-act="tutdone"><b>Finish ▶</b></button>` : `<button class="tutSkip" data-act="tutskip">Skip tutorial</button>`));
  }
  private endTutorial() { this.tutorial = false; this.hud.setTutorial(null); this.refreshObjective(); }

  private linkMat(hex: string, emit = 0.12): StandardMaterial {
    const m = new StandardMaterial("lk" + hex, this.scene);
    m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black();
    m.emissiveColor = Color3.FromHexString(hex).scale(emit);
    return m;
  }
  private post(p: Vector3) {
    const gy = heightAt(p.x, p.z); const h = Math.max(0.6, p.y - gy);
    const post = MeshBuilder.CreateCylinder("splpost", { diameter: 0.6, height: h, tessellation: 6 }, this.scene);
    post.material = this.linkMat("#5a5148", 0); post.position.set(p.x, gy + h / 2, p.z);
    post.parent = this.surfaceRoot; post.isPickable = false; this.supplyLinkMeshes.push(post);
  }

  /** Build one supply link (pipe for slurry/liquids, conveyor belt for the mill→plant line),
   *  with support posts and travelling flow beads that animate while the source is live. */
  private makeLink(src: Placed, a: Vector3, c: Vector3, hex: string, kind: "pipe" | "conveyor", dia: number, needsConnect = false) {
    const dir = c.subtract(a); const len = dir.length(); if (len < 1) return;
    const nd = dir.normalizeToNew();
    if (kind === "pipe") {
      const pipe = MeshBuilder.CreateCylinder("splink", { diameter: dia, height: len, tessellation: 8 }, this.scene);
      pipe.material = this.linkMat(hex); pipe.position = Vector3.Center(a, c);
      const axis = Vector3.Cross(Vector3.Up(), nd);
      if (axis.lengthSquared() > 1e-6) pipe.rotationQuaternion = Quaternion.RotationAxis(axis.normalize(), Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(Vector3.Up(), nd)))));
      pipe.parent = this.surfaceRoot; pipe.isPickable = false; this.supplyLinkMeshes.push(pipe);
    } else {
      // flat belt on trestles: yaw to heading, pitch to slope (keeps the belt top level)
      const yaw = Math.atan2(dir.x, dir.z), pitch = -Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
      const q = Quaternion.RotationYawPitchRoll(yaw, pitch, 0);
      const belt = MeshBuilder.CreateBox("splbelt", { width: 3, height: 0.5, depth: len }, this.scene);
      belt.material = this.linkMat("#2c3138", 0); belt.position = Vector3.Center(a, c); belt.rotationQuaternion = q.clone();
      belt.parent = this.surfaceRoot; belt.isPickable = false; this.supplyLinkMeshes.push(belt);
      for (const sx of [-1.7, 1.7]) {
        const rail = MeshBuilder.CreateBox("splrail", { width: 0.3, height: 0.8, depth: len }, this.scene);
        rail.material = this.linkMat("#6a7480", 0); rail.rotationQuaternion = q.clone();
        rail.position = Vector3.Center(a, c).add(new Vector3(Math.cos(yaw) * sx, 0.5, -Math.sin(yaw) * sx));
        rail.parent = this.surfaceRoot; rail.isPickable = false; this.supplyLinkMeshes.push(rail);
      }
    }
    const posts = Math.max(1, Math.floor(len / 24));
    for (let i = 1; i <= posts; i++) this.post(Vector3.Lerp(a, c, i / (posts + 1)));
    // flow beads
    const beads: Mesh[] = [];
    const bmat = this.linkMat(hex, 0.9);
    for (let i = 0; i < 4; i++) {
      const bead = kind === "conveyor"
        ? MeshBuilder.CreateBox("splbead", { size: 1.6 }, this.scene)
        : MeshBuilder.CreateSphere("splbead", { diameter: Math.max(1, dia * 0.95), segments: 6 }, this.scene);
      bead.material = bmat; bead.parent = this.surfaceRoot; bead.isPickable = false; bead.setEnabled(false);
      beads.push(bead); this.supplyLinkMeshes.push(bead);
    }
    this.flowLinks.push({ src, a, c, beads, lift: kind === "conveyor" ? 0.6 : 0, needsConnect });
  }

  /** Draw the surface reticulation: mill→plant conveyor + feed pipes to the plant,
   *  and the mill's slurry line out to the TSF (the forced ~half). */
  private drawSupplyLinks() {
    this.supplyLinkMeshes.forEach((m) => m.dispose()); this.supplyLinkMeshes = [];
    this.flowLinks = [];
    const colFor: Record<string, string> = { tailings: "#c2a86a", binder: "#e6d2a0", water: "#5aa0e0" };
    const diaFor: Record<string, number> = { tailings: 2.0, binder: 1.3, water: 1.3 };
    const at = (b: Placed, dy: number) => new Vector3(b.pos.x, b.pos.y + dy, b.pos.z);
    const plant = this.buildings.find((b) => b.spec.type === "plant");
    if (plant) for (const b of this.buildings) {
      const mat = b.spec.supplies; if (!mat) continue;
      // mill's tailings ride a conveyor belt to the plant; binder/water are piped.
      // a work out of feed-line reach shows a red, dead line (it supplies nothing).
      const kind = b.spec.type === "mill" ? "conveyor" : "pipe";
      const col = this.connected(b) ? colFor[mat] : "#ff5a5a";
      this.makeLink(b, at(b, 6), at(plant, 6), col, kind, diaFor[mat], true);
    }
    const mill = this.buildings.find((b) => b.spec.type === "mill");
    // headframe → mill: ore conveyor bringing hoisted ROM ore to be refined
    if (mill) this.makeLink(mill, this.oreHoistAt.clone(), at(mill, 6), "#8a7d68", "conveyor", 2.0);
    // mill → nearest TSF: slurry line for the tailings that can't be reused
    const tsfs = this.buildings.filter((b) => b.spec.tsfCap);
    if (mill && tsfs.length) {
      let best = tsfs[0], bd = Infinity;
      for (const t of tsfs) { const d = Vector3.Distance(mill.pos, t.pos); if (d < bd) { bd = d; best = t; } }
      this.makeLink(mill, at(mill, 6), at(best, 6), "#9a8763", "pipe", 1.8);
    }
  }

  /** Animate flow beads travelling source→destination while the source is powered and time runs. */
  private updateFlow(dt: number) {
    this.flowPhase += dt * this.speed;
    for (const link of this.flowLinks) {
      const active = !this.paused && !this.ended && (link.needsConnect ? this.connected(link.src) : this.isPowered(link.src));
      const n = link.beads.length;
      for (let i = 0; i < n; i++) {
        const bead = link.beads[i];
        if (!active) { bead.setEnabled(false); continue; }
        const t = ((this.flowPhase * 0.16 + i / n) % 1 + 1) % 1;
        const p = Vector3.Lerp(link.a, link.c, t);
        bead.setEnabled(true); bead.position.set(p.x, p.y + link.lift, p.z);
      }
    }
  }
  private isPowered(b: Placed) {
    if (!b.spec.needsPower) return true;
    return this.energized.some((s) => Vector3.Distance(s.pos, b.pos) <= this.radiusOf(s));
  }

  // ---- surface building selection + details ---------------------------------
  private selectBuilding(b: Placed) {
    this.deselectBuilding();
    this.selectedBuilding = b;
    b.root.getChildMeshes().forEach((m) => { m.renderOutline = true; m.outlineColor = Color3.FromHexString("#ffffff"); m.outlineWidth = 0.3; });
    this.hud.setPanel(this.buildingPanel(b));
    this.hud.setPanelVisible(true);
  }
  private deselectBuilding() {
    if (this.selectedBuilding) this.selectedBuilding.root.getChildMeshes().forEach((m) => { m.renderOutline = false; });
    this.selectedBuilding = null;
    this.hud.setPanelVisible(false);
  }
  private buildingPanel(b: Placed): string {
    const s = b.spec;
    const roles: string[] = [];
    if (s.powerRadius) roles.push(`Supplies power to a ${s.powerRadius}-unit radius`);
    if (s.needsPower) roles.push(this.isPowered(b) ? "Powered ✓" : "⚠ Out of power range");
    if (s.spawnsWorkers) roles.push(`Employs ${s.spawnsWorkers} crew`);
    if (s.spawnsTrucks) roles.push(`Runs ${s.spawnsTrucks} haul trucks`);
    if (s.type === "crusher") roles.push("Enables CAF (crushed aggregate) fills");
    if (s.type === "plant") roles.push("The backfill plant — step inside to build the process line");
    if (s.type === "mill") roles.push("Refines hoisted ore into concentrate (income) and makes tailings");
    let extra = "";
    if (s.upgrade) {
      const u = s.upgrade;
      const mkNow = b.tier > 0 ? ` <b>Mk ${b.tier + 1}</b>` : "";
      const effNow = Math.round((1 + b.tier * u.step) * 100);
      const label: Record<string, string> = { mill: "throughput & income", water: "pump rate", binder: "binder delivery", power: "power radius" };
      if (b.tier < u.max) {
        const cost = Math.round(u.cost0 * (1 + b.tier * 0.7));
        const effNext = Math.round((1 + (b.tier + 1) * u.step) * 100);
        extra += `<div class="pSplit"><span>${label[u.stat]}${mkNow}</span><b>${effNow}% → ${effNext}%</b></div>
          <button class="pBtn primary" data-act="upgrade"><b>Upgrade to Mk ${b.tier + 2} ▲</b><span>${label[u.stat]} to ${effNext}% · ${fmtMoney(cost)}</span></button>`;
      } else {
        extra += `<div class="pSplit"><span>${label[u.stat]}${mkNow}</span><b>${effNow}% (max)</b></div>`;
      }
    }
    if (s.tsfCap) {
      const cap = this.tsfCapOf(b);
      const fillPct = this.supply.tsf.cap > 0 ? Math.round((this.supply.tsf.level / this.supply.tsf.cap) * 100) : 0;
      const lift = Math.round(s.tsfCap * 0.5);
      const cost = tsfRaiseCost(b.raises);
      roles.push(`Stores the ~half of tailings that can't go back underground`);
      extra = `<div class="pSplit"><span>This dam holds</span><b>${cap.toLocaleString()} t · ${b.raises}/${TSF_MAX_RAISES} lifts</b></div>
        <div class="pSplit"><span>TSF fill (site)</span><b class="${fillPct > 85 ? "bad" : ""}">${fillPct}%</b></div>
        ${b.raises < TSF_MAX_RAISES
          ? `<button class="pBtn primary" data-act="raisedam"><b>Raise the dam ▲</b><span>+${lift.toLocaleString()} t capacity · ${fmtMoney(cost)}</span></button>`
          : `<div class="pNote">Max practical dam height reached — build another TSF for more storage.</div>`}`;
    }
    return `<div class="pHead">${s.icon} ${s.label} <span class="pClose" data-act="closebuilding">✕</span></div>
      <div class="pMeta">${roles.join("<br>")}</div>
      <div class="pSplit"><span>Upkeep</span><b>${fmtMoney(s.opexPerDay)}/day</b></div>
      <div class="pSplit"><span>Build cost</span><b>${fmtMoney(s.cost)}</b></div>
      ${extra}
      ${s.type === "plant" ? `<button class="pBtn primary" data-act="enterplant"><b>Step inside ▶</b></button>` : ""}`;
  }

  /** Pay to raise the selected TSF's embankment — adds storage, and the dam visibly grows taller. */
  /** Pay to upgrade the selected building a tier — scales its stat, opex, and size. */
  private upgradeBuilding() {
    const b = this.selectedBuilding; const u = b?.spec.upgrade;
    if (!b || !u || b.tier >= u.max) return;
    const cost = Math.round(u.cost0 * (1 + b.tier * 0.7));
    if (this.cash < cost) { this.hud.setStatus(`Not enough cash to upgrade ${b.spec.label} (${fmtMoney(cost)}).`); return; }
    this.cash -= cost; b.tier++;
    this.opexPerDay += Math.round(b.spec.opexPerDay * 0.3); // a bigger machine costs more to run
    b.root.scaling.setAll(1 + b.tier * 0.08); // visibly beefier
    this.recomputePower(); this.refreshSupply(); this.updateEconomy();
    this.hud.setPanel(this.buildingPanel(b)); this.sound.build();
    this.hud.setStatus(`${b.spec.label} upgraded to Mk ${b.tier + 1} for ${fmtMoney(cost)}.`);
  }

  private raiseDam() { const b = this.selectedBuilding; if (b) this.raiseDamOn(b, true); }
  /** Raise a specific TSF's embankment a lift (used by the panel button and the auto-player). */
  private raiseDamOn(b: Placed, fromPanel: boolean): boolean {
    if (!b.spec.tsfCap || b.raises >= TSF_MAX_RAISES) return false;
    const cost = tsfRaiseCost(b.raises);
    if (this.cash < cost) { if (fromPanel) this.hud.setStatus(`Not enough cash to raise the dam (${fmtMoney(cost)}).`); return false; }
    this.cash -= cost; this.sound.damRaise();
    b.raises++;
    b.root.scaling.y = 1 + b.raises * 0.22; // upstream lift — the dam grows upward
    this.refreshSupply();
    this.updateEconomy();
    if (fromPanel) this.hud.setPanel(this.buildingPanel(b));
    this.hud.setStatus(`Dam raised to lift ${b.raises} for ${fmtMoney(cost)} — +${Math.round(b.spec.tsfCap * 0.5).toLocaleString()} t of tailings storage.`);
    return true;
  }

  private updateMarker(b: Placed, showRed: boolean) {
    if (showRed && !b.marker) {
      const s = MeshBuilder.CreateSphere("nopwr", { diameter: 2, segments: 8 }, this.scene);
      const m = new StandardMaterial("nopwrM", this.scene);
      m.diffuseColor = Color3.FromHexString("#ff5a5a"); m.emissiveColor = Color3.FromHexString("#ff3030"); m.specularColor = Color3.Black();
      s.material = m; s.position.set(b.pos.x, b.pos.y + b.spec.markerY + 3, b.pos.z); s.parent = this.surfaceRoot;
      b.marker = s;
    } else if (!showRed && b.marker) { b.marker.dispose(); b.marker = null; }
  }

  // ---- underground: stope panel + actions -----------------------------------

  private selectStope(st: StopeUG) {
    this.underground.select(st);
    this.underground.net.highlightPath(this.underground.stopes.indexOf(st));
    this.selectedStope = st;
    this.renderStopePanel();
  }

  /** HGL chart: pressure held by each leg vs its pipe rating, down the path. */
  private hglChart(idx: number): string {
    const net = this.underground.net;
    const path = net.pathFor(idx);
    const W = 250, H = 112, pad = 16;
    const maxP = Math.max(...path.map((s) => Math.max(net.pressureMpa(s), net.cls(s)?.ratingMpa ?? 0)), 20) * 1.15;
    const n = path.length;
    const xAt = (i: number) => pad + (n > 1 ? (i / (n - 1)) * (W - 2 * pad) : 0);
    const yAt = (p: number) => H - pad - (p / maxP) * (H - 2 * pad);
    const pPts = path.map((s, i) => `${xAt(i).toFixed(0)},${yAt(net.pressureMpa(s)).toFixed(0)}`).join(" ");
    const rPts = path.map((s, i) => `${xAt(i).toFixed(0)},${yAt(net.cls(s)?.ratingMpa ?? 0).toFixed(0)}`).join(" ");
    const dots = path.map((s, i) => {
      const p = net.pressureMpa(s), r = net.cls(s)?.ratingMpa ?? 0;
      const col = r > 0 && p > r ? "#ff5a5a" : p < 3 ? "#ffb020" : "#39d98a";
      return `<circle cx="${xAt(i).toFixed(0)}" cy="${yAt(p).toFixed(0)}" r="3" fill="${col}"/>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="hgl">
      <line class="hglAxis" x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}"/>
      <polyline class="hglRating" points="${rPts}"/>
      <polyline class="hglLine" points="${pPts}"/>${dots}
      <text x="${pad}" y="11" class="hglLbl">HGL — line pressure vs rating (MPa)</text>
      <text x="${pad}" y="${H - 3}" class="hglLbl">shaft → level → stope · green safe · red over · amber slack</text>
    </svg>`;
  }

  private renderStopePanel() {
    const st = this.selectedStope; if (!st) return;
    const idx = this.underground.stopes.indexOf(st);
    const head = staticHeadMpa(st.depthM);
    const dueLate = this.day > st.dueDay && (st.status === "available" || st.status === "piped");
    const due = `<span class="${dueLate ? "pLate" : ""}">${dueLate ? "OVERDUE" : "due day " + st.dueDay}</span>`;
    const ft = FILL_TYPES[st.fillType];
    const badge = st.isPrimary ? `<span class="badgePri">PRIMARY</span>` : `<span class="badgeSec">secondary</span>`;
    const db = this.designBasis(st);
    const meta = `<div class="pMeta">${badge} · ${ft.short} · −${st.depthM} m · ${st.volumeM3.toLocaleString()} m³<br>Static head ρgh: <b>${head.toFixed(1)} MPa</b> · target UCS <b>${st.targetUcsKpa} kPa</b> · ${due}</div>`;
    const basis = `<div class="pBasis">Design basis: ${db.exposure} (${db.faces} ${db.faces === 1 ? "face" : "faces"}). In-situ demand ~${db.inSitu} kPa × SF ${db.sf.toFixed(1)} = <b>${st.targetUcsKpa} kPa</b>.</div>`;
    const suitMark = { good: "✓", ok: "·", bad: "⚠" };
    const fillPick = `<div class="fillPick">${Object.values(FILL_TYPES).map((f) => {
      const s = this.fillSuitability(st, f);
      return `<button class="fillBtn ${st.fillType === f.key ? "on" : ""} suit-${s.verdict}" data-act="fill:${f.key}" title="${s.reason.replace(/"/g, "&quot;")}">${f.short} <i class="suitMark">${suitMark[s.verdict]}</i></button>`;
    }).join("")}</div><div class="pNote ${this.fillSuitability(st, ft).verdict === "bad" ? "pWarnNote" : ""}">${this.fillSuitability(st, ft).reason}</div>`;
    let body = "";
    if (st.status === "locked") {
      body = !st.isPrimary && !this.underground.primaryCured(st.levelIdx)
        ? `<div class="pRow muted">Secondary stope — mining waits until the level's <b>primary</b> is filled and cured.</div>`
        : `<div class="pRow muted">Mining develops this stope around <b>day ${st.availableDay}</b>.</div>`;
    } else if (st.status === "available" && !ft.reticulated) {
      const canCaf = this.hasCrusher();
      body = `${fillPick}${this.recipeSummary(st)}<button class="pBtn primary" data-act="truck" ${canCaf ? "" : "disabled"}><b>Truck-fill (CAF)</b><span>${canCaf ? "no reticulation — hauled and placed" : "needs a Crusher plant on the surface"}</span></button>`;
    } else if (st.status === "available") {
      const net = this.underground.net;
      const rows = net.pathFor(idx).map((seg) => {
        const p = net.pressureMpa(seg);
        const c = net.cls(seg);
        const ok = net.valid(seg);
        const choke = seg.kind === "borehole"
          ? `<button class="segMini ${seg.choke ? "on" : ""}" data-act="choke:${seg.id}" ${seg.built ? "disabled" : ""} title="choke station — sheds head">⌇</button>` : "";
        const boost = seg.kind === "level"
          ? `<button class="segMini ${seg.booster ? "on" : ""}" data-act="boost:${seg.id}" ${seg.built ? "disabled" : ""} title="booster pump — faster pour, stronger pipe">⇪</button>` : "";
        return `<div class="segRow ${seg.built ? "built" : ""}">
          <div class="segMain"><b>${seg.label}</b><span>holds ${p.toFixed(1)} MPa · ${Math.round(seg.lengthM)} m</span></div>
          <button class="segMini cls" data-act="seg:${seg.id}" ${seg.built ? "disabled" : ""}>${c ? c.name : "— set —"}</button>
          ${choke}${boost}
          <span class="segChk ${c ? (ok ? "ok" : "bad") : ""}">${c ? (ok ? "✓" : "✗") : "·"}</span>
        </div>`;
      }).join("");
      const aggBlock = !!ft.needsAggregate && !this.hasCrusher();
      const canBuild = net.pathCanBuild(idx) && !aggBlock;
      const planned = net.pathPlannedCost(idx);
      const drill = net.canDrill(idx)
        ? `<button class="chkBtn ${net.isDrilled(idx) ? "on" : ""}" data-act="drill:${idx}">${net.isDrilled(idx) ? "☑" : "☐"} Dedicated drilled borehole</button>
           <div class="pNote">${net.isDrilled(idx) ? "Sinking a dedicated hole to this stope — short line, less friction, but a steep drilling capex." : "This far stope rides the long shared level run. Drill a dedicated borehole for a shorter, cheaper, safer line."}</div>`
        : "";
      const surfM = this.plantSurfaceRunM();
      const surfMpa = frictionMpa(surfM);
      const surfNote = surfMpa > 0.6
        ? `<div class="pWarn">⚠ Plant sited ${Math.round(surfM)} m from the shaft — that surface run adds <b>${surfMpa.toFixed(1)} MPa</b> to every leg. Site the plant nearer the collar to save pipe.</div>`
        : `<div class="pNote">Plant→shaft surface run: ${Math.round(surfM)} m (+${surfMpa.toFixed(1)} MPa/leg). Sited close — good gravity head.</div>`;
      body = `${fillPick}${this.recipeSummary(st)}
        ${surfNote}
        <div class="pNote">Design each leg: pick a class that out-rates its pressure. A borehole ⌇ choke sheds head (cheaper deep pipe); a level ⇪ booster pours faster but the line must hold more. Legs are shared between stopes.</div>
        ${drill}
        ${this.hglChart(idx)}
        <div class="segList">${rows}</div>
        <button class="pBtn primary" data-act="build" ${canBuild ? "" : "disabled"}><b>Build reticulation</b><span>${canBuild ? fmtMoney(planned) : aggBlock ? "PAF needs a Crusher plant on the surface" : "set a valid class on every leg"}</span></button>`;
    } else if (st.status === "piped") {
      const rev = fillRevenue(st.volumeM3);
      const chk = (key: string, on: boolean, label: string) => `<button class="chkBtn ${on ? "on" : ""}" data-act="sign:${key}">${on ? "☑" : "☐"} ${label}</button>`;
      const bt = st.barricadeType;
      const cap = this.barricadeCap(st);
      const barCost = this.barricadeCost(st);
      const barBtn = (key: "mullock" | "shotcrete") => { const spec = BARRICADE[key]; return `<button class="fillBtn ${bt === key ? "on" : ""}" data-act="bar:${key}" title="${spec.note.replace(/"/g, "&quot;")}">${spec.short}<br><small>${spec.capKpa} kPa</small></button>`; };
      const tog = (key: string, on: boolean, label: string) => `<button class="chkBtn ${on ? "on" : ""}" data-act="bartog:${key}">${on ? "☑" : "☐"} ${label}</button>`;
      const plantReady = !ft.reticulated || this.plantThroughput > 0;
      const ready = !!bt && !!st.signPourNote && plantReady;
      body = `
        <div class="pRow">${ft.reticulated ? "Reticulated · <b>" + (st.cls?.name ?? "") + "</b>" + (st.choke ? " + choke" : "") : "Trucked (CAF) · ready to place"}</div>
        ${ft.reticulated && !plantReady ? `<div class="pWarn">⚠ The plant isn't making paste. Enter the 🏭 Backfill plant and connect tailings + water + binder → mixer → pump before you can pour.</div>` : ""}
        ${ft.reticulated ? this.hglChart(idx) : ""}
        <div class="pNote">Design the barricade — it holds the fluid paste until the plug cures. Rate of rise loads it during the pour; overpressure = <b>inrush</b>.</div>
        <div class="fillPick">${barBtn("mullock")}${barBtn("shotcrete")}</div>
        ${bt ? `<div class="pSplit"><span>Capacity</span><b>${cap} kPa</b></div>` : `<div class="pNote pWarnNote">⚠ Pick a barricade type before pouring.</div>`}
        <div class="chkList">
          ${tog("relief", !!st.barricadeRelief, `Pressure relief / breather (+${fmtMoney(BARRICADE.reliefCost)} · +${BARRICADE.reliefBonusKpa} kPa)`)}
          ${tog("excl", !!st.exclusionZone, `Exclusion zone (+${fmtMoney(BARRICADE.exclusionCost)} · contains a failure)`)}
          ${tog("instr", !!st.barricadeInstr, `Barricade instrumentation (+${fmtMoney(BARRICADE.instrCost)} · live gauge)`)}
        </div>
        <div class="pNote">Pre-pour sign-off:</div>
        <div class="chkList">
          ${chk("PourNote", !!st.signPourNote, "Pour note issued &amp; approved")}
          ${chk("LowStart", !!st.signLowStart, "Low-solids line start")}
        </div>
        <button class="pBtn primary" data-act="pour" ${ready ? "" : "disabled"}><b>Begin pour</b><span>${ready ? `barricade ${fmtMoney(barCost)} → ${fmtMoney(rev)} ore access` : "design the barricade &amp; issue the pour note"}</span></button>`;
    } else if (st.status === "pouring") {
      const pct = Math.round((st.placedM3 / st.volumeM3) * 100);
      const rating = st.cls?.ratingMpa ?? 1;
      const pfrac = Math.min(100, (st.pressureMpa / rating) * 100);
      const margin = 1 - st.pressureMpa / rating;
      const pcls = margin < 0.08 ? "red" : margin < 0.2 ? "amber" : "green";
      const plugTxt = st.plugDrift > 0.5 ? "HIGH — flush!" : st.plugDrift > 0.25 ? "building" : "clear";
      const plugCls = st.plugDrift > 0.5 ? "red" : st.plugDrift > 0.25 ? "amber" : "green";
      const fr = st.placedM3 / st.volumeM3;
      const phase = fr < 0.08 ? "① Plug pour — sealing the barricade" : fr > 0.92 ? "③ Cap pour — working surface" : "② Main pour";
      const bcap = this.barricadeCap(st);
      const bpct = Math.min(100, bcap > 0 ? (st.barricadeKpa / bcap) * 100 : 0);
      const bmargin = bcap > 0 ? 1 - st.barricadeKpa / bcap : 1;
      const bcls = bmargin < 0.12 ? "red" : bmargin < 0.3 ? "amber" : "green";
      const plugTxt2 = st.plugSet >= 1 ? "plug set — barricade isolated, safe to ramp" : "plug sealing — keep flow low";
      const barBlock = st.barricadeInstr
        ? `<div class="pSplit"><span>Barricade (${st.barricadeType === "shotcrete" ? "AS" : "mullock"})</span><b class="${bcls === "red" ? "pLate" : ""}">${Math.round(st.barricadeKpa)} / ${bcap} kPa</b></div>
           <div class="pBar"><div class="pBarFill ${bcls}" style="width:${bpct}%"></div></div>
           <div class="pRow muted">${plugTxt2}</div>`
        : `<div class="pSplit"><span>Barricade</span><b class="${bcls === "red" ? "pLate" : ""}">${bcls === "red" ? "DANGER — ease flow" : bcls === "amber" ? "loading" : "holding"}</b></div>
           <div class="pRow muted">${plugTxt2} · no instrumentation — flying blind</div>`;
      body = `
        <div class="pRow"><b class="cap">${phase}</b></div>
        <div class="pRow">Pouring · <b>${st.cls?.name ?? FILL_TYPES[st.fillType].short}</b>${st.cls ? " · rating " + rating + " MPa" : ""}</div>
        <div class="pSplit"><span>Line pressure</span><b class="${pcls === "red" ? "pLate" : ""}">${st.pressureMpa.toFixed(1)} MPa</b></div>
        <div class="pBar"><div class="pBarFill ${pcls}" style="width:${pfrac}%"></div></div>
        <div class="pSplit"><span>Flow <b>${st.flowFactor.toFixed(2)}×</b></span>
          <span class="pFlow"><button class="pMini" data-act="flow-down">−</button><button class="pMini" data-act="flow-up">+</button></span></div>
        <div class="pSplit"><span><span class="plugDot ${plugCls}"></span>Plug: ${plugTxt}</span>
          <button class="pBtn sm" data-act="flush">💧 Flush</button></div>
        ${barBlock}
        <div class="pBar"><div class="pBarFill" style="width:${pct}%"></div></div>
        <div class="pRow muted">${Math.round(st.placedM3).toLocaleString()} / ${st.volumeM3.toLocaleString()} m³ (${pct}%)</div>
        <div class="pNote">Run too slow and the paste settles into a plug (pressure climbs); push too hard and friction spikes. Keep it in the band, flush a forming plug, or burst the line.</div>`;
    } else if (st.status === "curing") {
      const pct = Math.round(this.underground.cureProgress(st, this.day) * 100);
      const daysLeft = Math.max(0, this.underground.cureDaysFor(st) - (this.day - st.cureStartDay)).toFixed(1);
      const ucs7 = st.ucs7Reported
        ? `<div class="pRow ${(st.ucs7Kpa ?? 0) >= st.targetUcsKpa * 0.6 ? "good" : ""}"><span class="${(st.ucs7Kpa ?? 0) >= st.targetUcsKpa * 0.6 ? "" : "pLate"}">7-day cylinder: ${st.ucs7Kpa} kPa ${(st.ucs7Kpa ?? 0) >= st.targetUcsKpa * 0.6 ? "(on track)" : "(LOW — may fail 28d)"}</span></div>`
        : `<div class="pRow muted">7-day cylinder pending…</div>`;
      body = `
        <div class="pRow">Curing · <b>${ft.short}</b></div>
        <div class="pBar"><div class="pBarFill cure" style="width:${pct}%"></div></div>
        <div class="pRow muted">${pct}% cured · ${daysLeft} d to strength</div>
        ${ucs7}`;
    } else { // cured — reconciliation / stope de-brief
      const onTime = st.cureStartDay <= st.dueDay;
      const binderT = Math.round((st.placedM3 * this.recipeFor(st).binderKgPerM3 * ft.binderMult) / 1000);
      const verdict = st.ucsPass === false
        ? `<span class="pLate">✗ ${st.ucsAchievedKpa}/${st.targetUcsKpa} kPa FAIL</span>`
        : `<span class="good">✓ ${st.ucsAchievedKpa}/${st.targetUcsKpa} kPa</span>`;
      body = `
        <div class="pNote">Reconciliation — stope de-brief:</div>
        <div class="pSplit"><span>Placed</span><b>${Math.round(st.placedM3).toLocaleString()} m³</b></div>
        <div class="pSplit"><span>Fill</span><b>${ft.label}</b></div>
        <div class="pSplit"><span>Binder used</span><b>~${binderT.toLocaleString()} t</b></div>
        <div class="pSplit"><span>28-day UCS</span><b>${verdict}</b></div>
        <div class="pSplit"><span>Hand-back</span><b>${onTime ? "on time" : "late"}</b></div>
        ${st.ucsPass === false ? `<button class="pBtn" data-act="remediate"><b>Remediate &amp; re-pour</b><span>${fmtMoney(2_000_000)} — reset the stope to re-pour</span></button>` : ""}`;
    }
    this.hud.setPanel(`<div class="pHead">${st.id} <span data-act="close" class="pClose">✕</span></div>${meta}${basis}${body}`);
  }

  private onPanelAction(act: string) { this.applyPanelAction(act); this.saveGame(); this.checkTutorial(); }
  private applyPanelAction(act: string) {
    if (act === "restart") { location.reload(); return; }
    if (act === "tutskip" || act === "tutdone") { this.endTutorial(); return; }
    if (act.startsWith("ev:")) { this.resolveEvent(+act.slice(3)); return; }
    if (act === "enterplant") { this.deselectBuilding(); this.enterPlant(); return; }
    if (act === "closebuilding") { this.deselectBuilding(); return; }
    if (act === "raisedam") { this.raiseDam(); return; }
    if (act === "testwork") {
      if (this.testWorkDone) return;
      if (this.cash < TESTWORK_COST) { this.hud.setStatus(`Not enough cash for a test-work campaign (${fmtMoney(TESTWORK_COST)}).`); return; }
      this.cash -= TESTWORK_COST; this.testWorkDone = true; this.day += TESTWORK_DAYS;
      this.updateEconomy(); this.hud.setLabReadout(this.labReadout()); this.saveGame();
      const minl = this.scenario.mineralogy;
      this.hud.setStatus(`Test-work complete — design basis verified${minl ? ` (${minl.label})` : ""}. UCS scatter tightens; trim binder with confidence.`);
      return;
    }
    if (act === "upgrade") { this.upgradeBuilding(); return; }
    const st = this.selectedStope;
    if (act === "close") { this.underground.select(null); this.underground.net.highlightPath(null); this.selectedStope = null; this.hud.setPanel(`<div class="panelHint">Click a stope to design its reticulation and pour it.</div>`); return; }
    if (!st) return;
    if (act === "remediate") {
      if (st.ucsPass !== false) return;
      if (this.cash < 2_000_000) { this.hud.setStatus(`Not enough cash to remediate ${st.id} (${fmtMoney(2_000_000)}).`); return; }
      this.cash -= 2_000_000; this.underground.remediate(st); this.updateEconomy(); this.renderStopePanel();
      this.hud.setStatus(`${st.id} remediation ordered (${fmtMoney(2_000_000)}) — re-pour required.`);
      return;
    }
    if (act.startsWith("fill:")) { this.underground.setFillType(st, act.slice(5)); this.renderStopePanel(); return; }
    if (act === "truck") {
      if (!this.hasCrusher()) { this.hud.setStatus("CAF needs crushed aggregate — build a Crusher plant on the surface first."); return; }
      if (this.underground.readyTrucked(st)) { this.hud.setStatus(`${st.id} set for CAF — trucked, ready to place.`); this.renderStopePanel(); } return;
    }
    if (act.startsWith("sign:")) {
      const k = act.slice(5);
      if (k === "Barricade") st.signBarricade = !st.signBarricade;
      else if (k === "PourNote") st.signPourNote = !st.signPourNote;
      else if (k === "LowStart") st.signLowStart = !st.signLowStart;
      this.renderStopePanel(); return;
    }
    if (act.startsWith("bar:")) {
      if (st.status !== "piped") return;
      st.barricadeType = act.slice(4) as "mullock" | "shotcrete";
      this.renderStopePanel(); return;
    }
    if (act.startsWith("bartog:")) {
      if (st.status !== "piped") return;
      const k = act.slice(7);
      if (k === "relief") st.barricadeRelief = !st.barricadeRelief;
      else if (k === "excl") st.exclusionZone = !st.exclusionZone;
      else if (k === "instr") st.barricadeInstr = !st.barricadeInstr;
      this.renderStopePanel(); return;
    }
    if (act.startsWith("seg:")) { this.underground.net.cycleClass(act.slice(4)); this.renderStopePanel(); return; }
    if (act.startsWith("choke:")) { this.underground.net.toggleChoke(act.slice(6)); this.renderStopePanel(); return; }
    if (act.startsWith("drill:")) { this.underground.net.toggleDrill(+act.slice(6)); this.underground.net.highlightPath(+act.slice(6)); this.renderStopePanel(); return; }
    if (act.startsWith("boost:")) { this.underground.net.toggleBooster(act.slice(6)); this.renderStopePanel(); return; }
    if (act === "build") {
      if (st.status !== "available") return;
      if (FILL_TYPES[st.fillType].needsAggregate && !this.hasCrusher()) { this.hud.setStatus(`${FILL_TYPES[st.fillType].short} needs crushed aggregate — build a Crusher plant on the surface first.`); return; }
      const idx = this.underground.stopes.indexOf(st);
      if (!this.underground.net.pathCanBuild(idx)) { this.hud.setStatus("Every leg needs a class that out-rates its pressure."); return; }
      const planned = this.underground.net.pathPlannedCost(idx);
      if (this.cash < planned) { this.hud.setStatus(`Not enough cash to build the line (${fmtMoney(planned)}).`); return; }
      const res = this.underground.commitReticulation(idx);
      if (!res) return;
      this.cash -= res.cost; this.updateEconomy(); this.renderStopePanel();
      this.hud.setStatus(`${st.id} reticulation built — weakest leg ${res.cls.name}${res.choke ? " (choked)" : ""}, ${fmtMoney(res.cost)}.`);
    } else if (act === "pour") {
      if (st.status === "piped") {
        if (FILL_TYPES[st.fillType].reticulated && this.plantThroughput <= 0) { this.hud.setStatus("No paste yet — the plant isn't making any. Click the 🏭 Backfill plant → Enter plant and connect tailings + water + binder → mixer → pump."); return; }
        if (!st.barricadeType || !st.signPourNote) { this.hud.setStatus("Design the barricade and issue the pour note before pouring."); return; }
        const barCost = this.barricadeCost(st);
        if (this.cash < barCost) { this.hud.setStatus(`Not enough cash to build the barricade (${fmtMoney(barCost)}).`); return; }
        this.cash -= barCost; this.updateEconomy();
      }
      if (!this.underground.startPour(st)) return;
      this.sound.pourStart();
      if (!st.signLowStart) st.plugDrift = 0.25; // skipped the low-solids start — a plug head-start
      this.renderStopePanel();
      this.hud.setStatus(`${st.id} pour started${st.signLowStart ? "" : " without a low-solids start — mind the plug"}. Keep flow low until the plug sets.`);
    } else if (act === "flow-up") {
      if (st.status === "pouring") { st.flowFactor = Math.min(1.6, st.flowFactor + 0.15); this.renderStopePanel(); }
    } else if (act === "flow-down") {
      if (st.status === "pouring") { st.flowFactor = Math.max(0.4, st.flowFactor - 0.15); this.renderStopePanel(); }
    } else if (act === "flush") {
      if (st.status === "pouring") { st.plugDrift = Math.max(0, st.plugDrift - 0.6); this.hud.setStatus(`${st.id} line flushed — plug cleared, pressure eased.`); this.renderStopePanel(); }
    }
  }

  /** Debug/testing hooks. */
  debugBuild(type: string, x: number, z: number) { const spec = specOf(type); const b = this.place(spec, new Vector3(x, heightAt(x, z), z)); if (!b.built) { this.finishBuild(b); this.drawRoads(); this.recomputePower(); this.refreshSupply(); } this.disarm(); }
  debugDescend() { this.descend(); }
  debugEnterPlant() { this.enterPlant(); }
  debugSetRecipe(solids: number, binder: number) { this.recipe.solids = solids; this.recipe.binderKgPerM3 = binder; }
  debugLab() { this.hud.toggleLab(this.labReadout()); }
  debugReticulate(i: number, choke = false) {
    const st = this.underground.stopes[i]; if (st.status === "locked") st.status = "available";
    const net = this.underground.net;
    for (const seg of net.pathFor(i)) {
      if (seg.built) continue;
      if (choke && seg.kind === "borehole") seg.choke = true;
      seg.classId = 0;
      while (seg.classId! < 3 && !net.valid(seg)) seg.classId!++;
    }
    this.underground.commitReticulation(i);
  }
  debugUpgrade(type: string) { const b = this.buildings.find((x) => x.spec.type === type); if (b) { this.selectedBuilding = b; this.upgradeBuilding(); this.selectedBuilding = null; } }
  /** Drive the tutorial through every step to verify the gating advances. */
  debugTutTest() {
    this.testWorkDone = true;
    const L = (s: string) => console.log("TUT|" + s + ` step=${this.tutStep + 1}/${this.tutSteps.length}`);
    L("start");
    for (const [t, x, z] of [["power", 0, 0], ["plant", 24, 0], ["mill", 72, 36], ["tsf", 66, -46], ["rail", -44, 36], ["waterpump", 30, 60]] as [string, number, number][]) { this.debugBuild(t, x, z); L(`built ${t}`); }
    this.debugBuildPlantLine(); this.checkTutorial(); L("plant line built");
    this.debugAdvance(2); this.checkTutorial(); L("pressed play");
    this.descend(); L("descended");
    this.smartReticulate(0); this.checkTutorial(); L("reticulated S1");
    const s0 = this.underground.stopes[0]; s0.signBarricade = s0.signPourNote = true; s0.barricadeType = "shotcrete"; s0.barricadeRelief = true; this.underground.startPour(s0); this.checkTutorial(); L("poured S1");
  }
  /** Build a partial campaign and leave it autosaved (for save/resume testing). */
  debugSeed() {
    this.testWorkDone = true;
    for (const [t, x, z] of [["power", 0, 0], ["plant", 24, 0], ["mill", 72, 36], ["tsf", 66, -46], ["rail", -44, 36], ["waterpump", 30, 60]] as [string, number, number][]) this.debugBuild(t, x, z);
    this.debugBuildPlantLine(); this.debugUpgrade("mill"); this.descend();
    for (let k = 0; k < 8 && !this.ended; k++) {
      this.underground.stopes.forEach((s, i) => { if (s.status === "available") { try { this.smartReticulate(i); } catch { /* not yet */ } } });
      if (!this.underground.stopes.some((s) => s.status === "pouring")) { const n = this.underground.stopes.find((s) => s.status === "piped"); if (n) { n.signBarricade = n.signPourNote = n.signLowStart = true; n.barricadeType = "shotcrete"; n.barricadeRelief = true; this.underground.startPour(n); } }
      this.debugAdvance(2);
    }
    this.saveGame();
    const c = this.underground.counts();
    console.log(`SEEDED|day=${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m buildings=${this.buildings.length} tiers=${this.buildings.map((b) => b.tier).join("")} cured=${c.cured} statuses=${this.underground.stopes.map((s) => s.status[0]).join("")} tsf=${Math.round(this.supply.tsf.level / 1000)}k rp=${Math.floor(this.rp)}`);
  }
  debugBuildPlantLine() {
    this.plantInterior.debugBuildLine();                 // places + wires the line, solves, reports capacity
    this.plantInterior.setSupply(this.interiorSupply()); // schematic gating; plantThroughput stays = capacity
  }
  debugPour(i: number) { const s = this.underground.stopes[i]; s.barricadeType = "shotcrete"; s.barricadeRelief = true; s.barricadeInstr = true; this.underground.startPour(s); }
  debugSelect(i: number) { this.selectStope(this.underground.stopes[i]); }
  debugAdvance(days: number) { this.paused = false; const step = 0.25; for (let d = 0; d < days && !this.ended; d += step) this.advanceTime((SECONDS_PER_DAY * step) / this.speed); }

  /** Headless self-play: stand up the chain, then reticulate + pour every stope as it frees up,
   *  logging the economy each week. Drives the REAL game loop (not a projection). #autorun triggers it. */
  debugAutoRun() {
    this.testWorkDone = true;
    const L = (s: string) => console.log("AUTORUN|" + s);
    try {
      for (const [t, x, z] of [["power", 0, 0], ["plant", 24, 0], ["mill", 72, 36], ["tsf", 66, -46], ["rail", -44, 36], ["waterpump", 30, 60]] as [string, number, number][]) this.debugBuild(t, x, z);
      L(`built cash=${(this.cash / 1e6).toFixed(1)}m powered=${this.powered}/${this.total}`);
      this.descend();
      let guard = 0;
      while (!this.ended && guard++ < 400) {
        if (this.activeEvent) this.resolveEvent(0); // take the first option so the clock keeps running
        this.underground.stopes.forEach((s, i) => { if (s.status === "available") { try { this.debugReticulate(i); } catch { /* path not buildable yet */ } } });
        this.underground.stopes.forEach((s, i) => { if (s.status === "piped") { s.signBarricade = true; s.signPourNote = true; this.debugPour(i); } });
        this.debugAdvance(2);
        if (guard % 4 === 0) L(`day ${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m reserve=${Math.round(this.supply.oreReserve.level / 1000)}k rom=${Math.round(this.supply.ore.level / 1000)}k tsf=${Math.round(this.supply.tsf.level / 1000)}k binder=${Math.round(this.supply.binder.level)}t inc/d=$${Math.round(this.millDayIncome / 1000)}k`);
      }
      const c = this.underground.counts();
      L(`END day=${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m cured=${c.cured}/${this.underground.stopes.length} safety=${this.safetyIncidents} reserveLeft=${Math.round(this.supply.oreReserve.level / 1000)}k`);
      L("DONE");
    } catch (e) { L("ERROR " + ((e as Error)?.message ?? e)); }
  }

  /** Spec a stope's whole reticulation path uniformly to out-rate the FULL stope pressure
   *  (so pathWeakest is safe), choking deep boreholes to relieve head. The skilled way. */
  private smartReticulate(i: number) {
    const net = this.underground.net; const st = this.underground.stopes[i];
    if (st.status === "locked") st.status = "available";
    const legs = net.pathFor(i).filter((s) => !s.built);
    if (!legs.length) return;
    for (const seg of legs) if (seg.kind === "borehole" && st.levelIdx >= 1) seg.choke = true; // relieve static head on deep lines
    // highest class any leg needs, applied uniformly + one step of margin
    let need = 0;
    for (const seg of legs) { let c = 3; for (let k = 0; k < 4; k++) { seg.classId = k; if (net.valid(seg)) { c = k; break; } } need = Math.max(need, c); }
    const cls = Math.min(3, need + 1);
    for (const seg of legs) seg.classId = cls;
    this.underground.commitReticulation(i);
  }

  /** Headless SKILLED self-play: pumpable-yet-strong mix, over-rated uniform lines with chokes,
   *  reinforce on geotech, raise the dam before it chokes the mill. Proves the game rewards skill. */
  debugSmartRun() {
    this.testWorkDone = true;
    const L = (s: string) => console.log("SMARTRUN|" + s);
    try {
      for (const [t, x, z] of [["power", 0, 0], ["plant", 24, 0], ["mill", 72, 36], ["tsf", 66, -46], ["rail", -44, 36], ["waterpump", 30, 60]] as [string, number, number][]) this.debugBuild(t, x, z);
      this.debugSetRecipe(0.73, 320); // pumpable (low friction) yet strong enough for the deepest targets
      this.debugBuildPlantLine(); // stand up the process line so pours run at full plant rate
      L(`built cash=${(this.cash / 1e6).toFixed(1)}m recipe=0.73/320 plantThroughput=${this.plantThroughput.toFixed(0)}m3h`);
      this.descend();
      let guard = 0;
      while (!this.ended && guard++ < 400) {
        if (this.activeEvent) this.resolveEvent(0); // reinforce / mitigate — the safe option
        this.underground.stopes.forEach((s, i) => { if (s.status === "available") { try { this.smartReticulate(i); } catch { /* not buildable yet */ } } });
        // serialize pours: one stope at a time grabs the full tailings feed, completes and cures
        // sooner, and unlocks its secondary earlier — beats splitting the feed across parallel pours
        if (!this.underground.stopes.some((s) => s.status === "pouring")) {
          const next = this.underground.stopes.find((s) => s.status === "piped");
          if (next) { next.signBarricade = true; next.signPourNote = true; next.signLowStart = true; next.barricadeType = "shotcrete"; next.barricadeRelief = true; this.underground.startPour(next); }
        }
        // raise the dam before the TSF chokes the mill
        if (this.supply.tsf.cap > 0 && this.supply.tsf.level > this.supply.tsf.cap * 0.88) { const tsf = this.buildings.find((b) => b.spec.tsfCap); if (tsf) this.raiseDamOn(tsf, false); }
        this.debugAdvance(2);
        if (guard % 4 === 0) L(`day ${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m cured=${this.underground.counts().cured} tsf=${Math.round(this.supply.tsf.level / 1000)}k/${Math.round(this.supply.tsf.cap / 1000)}k safety=${this.safetyIncidents}`);
      }
      const c = this.underground.counts();
      const mined = Math.round((1 - this.supply.oreReserve.level / this.scenario.orebody) * 100);
      L(`END day=${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m cured=${c.cured}/${this.underground.stopes.length} safety=${this.safetyIncidents} orebody=${mined}% rp=${Math.floor(this.rp)} GRADE=${this.lastGrade}`);
      L("DONE");
    } catch (e) { L("ERROR " + ((e as Error)?.message ?? e)); }
  }
}

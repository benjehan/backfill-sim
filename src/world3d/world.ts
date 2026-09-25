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
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import "@babylonjs/core/Culling/ray";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { createTerrain, gradeFlat, heightAt, setRelief, setLand, SEA_LEVEL, PAD_RADIUS, BUILD_RADIUS } from "./terrain.js";
import { Environment } from "./environment.js";
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
import { SupplyChain, tsfRaiseCost, TSF_MAX_RAISES, MILL_NET_PER_T } from "./supplyChain.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { loadCompany, saveCompany, legacyForGrade, hasPerk } from "./company.js";
import { writeSave, clearSave, SAVE_VERSION } from "./savegame.js";
import { CATALOG as PLANT_EQUIP } from "../plant/model.js";
import { difficultyOf, applyDifficulty, applyCostScale, type Difficulty, type DifficultyId } from "./difficulty.js";

// Default surface camera: a three-quarter view with the horizon in frame.
const SURF_VIEW = { alpha: -Math.PI * 0.62, beta: 1.24, radius: 178, target: new Vector3(-14, 10, 6) };
/** Graphics quality (high = SSAO + 4k shadows). Persisted; auto-drops on slow machines. */
function gfxHigh(): boolean { try { return localStorage.getItem("bt_gfx") !== "low"; } catch { return true; } }
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
const ENV_PENALTY_PER_T = 42;    // fine per tonne of reactive (PAG) reject sent to the TSF uncontained
const EXTRACT_ORE_PER_M3 = 2.4;  // t of ore mucked per m³ of void opened (reserve → ROM pad)
const FLOWSHEET_SWITCH_COST = 3_000_000; // reconfiguring a concentrator route
const PERMIT_BASE = 6_000_000;           // mining permit / regulatory approval to begin operations
const PERMIT_ENV_SURCHARGE = 5_000_000;  // stricter conditions if reactive ore has no containment
const DEV_BASE = 1_800_000;      // base capex to develop access to a stope early
const DEV_PER_DAY = 180_000;     // extra per day brought forward (drives, drill/blast/muck)
const SURVEY_COST = 800_000;     // geophysical survey — reveals grade, a first delineation
const DRILL_COST = 1_500_000;    // one reserve-definition drilling campaign
const DRILL_DAYS = 2;            // drilling takes rig time
const DRILL_CONF = 0.12;         // confidence gained per campaign
const DRILL_FIND_BASE = 34_000;  // reserve delineated/extended per campaign (diminishes toward full confidence)

// Deterministic noise so weather (which touches the economy) is stable across save/resume.
function pseudoNoise(x: number): number { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
type Weather = "clear" | "rain" | "storm" | "heat" | "cold";

// Staffing (course Modules 08/20). Each role has a full-operation target headcount,
// a daily wage, and up-front hire/train costs. Understaffed or green crews hurt
// throughput, quality and safety; wages are a real slice of opex.
interface RoleDef { key: string; label: string; required: number; wage: number; hire: number; train: number; note: string; }
const ROLES: RoleDef[] = [
  { key: "operators", label: "Plant operators", required: 3, wage: 950, hire: 400_000, train: 350_000, note: "Run the paste plant — thin/green crews cut throughput and let quality drift." },
  { key: "ugcrew", label: "Underground crew", required: 3, wage: 900, hire: 350_000, train: 300_000, note: "Reticulation, barricades and pours underground." },
  { key: "geotech", label: "Geotechnical", required: 1, wage: 1300, hire: 500_000, train: 450_000, note: "Ground control & barricade sign-off — the buffer against inrush." },
  { key: "lab", label: "Lab technicians", required: 2, wage: 800, hire: 300_000, train: 250_000, note: "QA/QC and test-work — tighten the strength database." },
  { key: "fitters", label: "Fitters (maintenance)", required: 2, wage: 900, hire: 350_000, train: 300_000, note: "Keep the plant and pumps turning." },
];

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
  private phase: "explore" | "setup" | "operate" = "explore"; // clock only runs in "operate"
  private permitObtained = false; // regulatory permit to begin operations
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
  private lastWaterReused = 0; // m³/day of process water recovered by dewatering (HUD)
  private envFinesTotal = 0;   // cumulative environmental fines for uncontained PAG reject
  private envBreachActive = false;
  private oreConfidence = 0.5; // how well the orebody is delineated (0.5 inferred → 1.0 measured)
  private explored = false;    // a geophysical survey has been run (grade revealed)
  private drillHoles = 0;      // drill campaigns run — each plants a visible rig on the exploration ground
  private millGrind = 1;       // concentrator comminution: 0 coarse / 1 standard / 2 fine
  private millRecovery = 1;    // concentration route: 0 gravity / 1 flotation / 2 flotation+regrind
  private millReagent = 0;     // reagent/flocculant suite: 0 general / 1 sulphide / 2 gravity / 3 clay
  private weather: Weather = "clear";
  private weatherUntil = 0;    // day the current weather spell ends
  // staffing: headcount + competency (0..1) per role; starts as a lean, half-trained crew
  private staff: Record<string, { count: number; comp: number }> = {
    operators: { count: 2, comp: 0.55 }, ugcrew: { count: 2, comp: 0.55 }, geotech: { count: 1, comp: 0.5 },
    lab: { count: 1, comp: 0.5 }, fitters: { count: 1, comp: 0.5 },
  };
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
  // difficulty bundle (Hard = the original balance); the scenario is a difficulty-adjusted copy
  private diff: Difficulty;
  private rescuesUsed = 0;   // times the board has topped up the budget (Easy/Normal)
  private loanBalance = 0;   // outstanding board loan (Normal), repaid from mill income
  private cheered = new Set<string>(); // one-off milestone celebrations already shown
  private autoEasedDay = -1; // last day the safety crew stepped in (throttles the message)
  constructor(private root: HTMLElement, private scenario: Scenario = SCENARIOS[0], opts?: { tutorial?: boolean; difficulty?: DifficultyId }) {
    this.tutorial = !!opts?.tutorial;
    this.diff = difficultyOf(opts?.difficulty ?? "hard");
    this.scenario = applyDifficulty(scenario, this.diff);
  }
  /** Capital cost at this difficulty (build multiplier). */
  private capex(n: number) { return Math.round(n * this.diff.build); }
  /** Exploration / test-work cost at this difficulty. */
  private exploreCost(n: number) { return Math.round(n * this.diff.explore); }
  /** Penalty / incident / event cost at this difficulty. */
  private penalty(n: number) { return Math.round(n * this.diff.penalties); }

  start() {
    this.root.classList.add("world-mode");
    const co = loadCompany(); // permanent perks from past campaigns
    applyCostScale(this.diff.build); // difficulty-scaled capital prices (palette, plant line, pipes)
    this.recipe.binderKgPerM3 = this.diff.startBinder; // Easy/Normal start the Lab on a stronger mix
    this.cash = Math.round(this.scenario.startCash * (hasPerk(co, "seed") ? 1.15 : 1));
    this.rp = hasPerk(co, "veterans") ? 8 : 0;
    this.opexMult = hasPerk(co, "lean") ? 0.92 : 1;
    const orebody = this.scenario.orebody + (hasPerk(co, "prospect") ? 30_000 : 0);
    this.supply.oreReserve.level = orebody;
    this.supply.oreReserve.cap = orebody;
    this.canvas = document.createElement("canvas");
    this.canvas.id = "renderCanvas";
    this.root.appendChild(this.canvas);

    this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: false }, false);
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5)); // crisp on hi-DPI, capped for speed
    this.scene = new Scene(this.engine);
    this.setSky(false);

    this.setupCamera();
    this.setupLights();

    this.surfaceRoot = new TransformNode("surface", this.scene);
    setRelief(this.scenario.relief ?? 1); setLand(this.scenario.land ?? "hills"); // biome + ruggedness (before terrain + placements)
    this.ground = createTerrain(this.scene, this.scenario.terrain); this.ground.parent = this.surfaceRoot;
    this.env = new Environment(this.scene, this.camera, this.sun, this.surfaceRoot, (m) => this.shadow.addShadowCaster(m));
    if (this.scenario.wet || this.scenario.land === "seaside") this.env.addWater(SEA_LEVEL); // sea / standing water
    this.env.setupPost(gfxHigh());
    this.applyWeatherVisuals();
    this.autoQuality();
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
    this.underground.net.capexScale = this.diff.build;
    this.underground.cureFactor = this.diff.cure;
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
      onPause: () => {
        if (this.phase === "explore") { this.hud.setStatus("Delineate the orebody first — open 🧭 Geology."); return; }
        if (this.phase === "setup") { this.startOperations(); return; }
        this.paused = !this.paused; this.refreshClock();
      },
      onSpeed: (i) => {
        if (this.phase === "explore") { this.hud.setStatus("Delineate the orebody first — open 🧭 Geology."); return; }
        this.speedIdx = i;
        if (this.phase === "setup") { this.startOperations(); return; }
        this.paused = false; this.refreshClock();
      },
      onLab: () => { const r = this.activeRecipe(); this.hud.setLabRecipe(r.solids, r.binderKgPerM3); this.hud.toggleLab(this.labReadout()); },
      onRecipe: (solids, binder) => { const r = this.activeRecipe(); r.solids = solids; r.binderKgPerM3 = binder; this.hud.setLabReadout(this.labReadout()); if (this.mode === "underground" && this.selectedStope) this.renderStopePanel(); },
      onBinderTopup: () => {
        const topup = this.topupCost();
        if (this.cash < topup) { this.hud.setStatus(`Not enough cash for a binder truck top-up (${fmtMoney(topup)}).`); return; }
        this.cash -= topup; this.supply.topUpBinder(BINDER_TOPUP_TONNES);
        this.updateEconomy(); this.hud.setStatus(`Binder truck top-up: +${BINDER_TOPUP_TONNES} t for ${fmtMoney(topup)}.`);
      },
      onToggleSound: () => { this.soundOn = !this.soundOn; this.sound.setMuted(!this.soundOn); this.sound.toggleAmbient(this.soundOn); this.hud.setSoundIcon(this.soundOn); },
      onHelp: () => this.showEconomyHelp(),
      onResearch: () => this.showResearch(),
      onGeology: () => this.showGeology(),
      onStaff: () => this.showStaff(),
    });
    this.hud.setMine(this.scenario.name);
    this.updateEconomy();
    if (this.tutorial) { this.setupTutorial(); this.renderTutorial(); }
    this.refreshObjective();
    this.underground.updateSchedule(this.day);
    this.refreshClock();
    this.refreshSchedule();
    if (!this.tutorial) this.maybeShowIntro(); // the tutorial replaces the intro card

    this.flyIn();
    this.scene.onPointerObservable.add((pi) => this.onPointer(pi));
    this.engine.runRenderLoop(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      this.advanceTime(dt);
      if (this.mode === "surface") { this.crew.update(dt); this.fleet.update(dt, this.cafPourActive()); this.updateFlow(dt); if (this.pourPS) this.pourPS.emitRate = 0; this.steamPSes.forEach((p) => (p.emitRate = 16)); }
      else if (this.mode === "underground") { this.updatePourFx(); this.underground.updateLife(dt); this.steamPSes.forEach((p) => (p.emitRate = 0)); }
      else { if (this.pourPS) this.pourPS.emitRate = 0; this.steamPSes.forEach((p) => (p.emitRate = 0)); }
      this.sound.setHum(this.phase === "operate" ? 0.05 : 0);
      this.sound.setPourRush(this.anyPourActive() ? 0.12 : 0);
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
    (window as any).__world = this;
    if (typeof location !== "undefined" && location.hash.startsWith("#autorun")) setTimeout(() => this.debugAutoRun(), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#smartrun")) setTimeout(() => this.debugSmartRun(), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#seed")) setTimeout(() => this.debugSeed(), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#tuttest")) setTimeout(() => this.debugTutTest(), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#playsmart")) setTimeout(() => this.debugPlayRun("smart"), 400);
    if (typeof location !== "undefined" && location.hash.startsWith("#playnaive")) setTimeout(() => this.debugPlayRun("naive"), 400);
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
    if (id === "rapidset") this.underground.cureFactor = 0.75 * this.diff.cure;
    if (id === "reserves") { this.supply.oreReserve.level += 50_000; this.supply.oreReserve.cap += 50_000; }
    this.refreshSupply(); this.updateEconomy(); // dam-eng recomputes TSF cap
    this.hud.setStatus(`Researched: ${t.name}.`);
  }

  /** A dismissible card explaining how the money loop works. */
  // ---- staffing / crews -----------------------------------------------------
  private roleAdequacy(key: string): number {
    const r = ROLES.find((x) => x.key === key)!; const c = this.staff[key];
    return Math.min(1, c.count / r.required) * c.comp;
  }
  private crewCompetency(): number { return ROLES.reduce((a, r) => a + this.roleAdequacy(r.key), 0) / ROLES.length; }
  private crewWagesPerDay(): number { return ROLES.reduce((a, r) => a + this.staff[r.key].count * r.wage, 0); }
  private operatorAdequacy() { return this.roleAdequacy("operators"); }
  private geotechAdequacy() { return this.roleAdequacy("geotech"); }

  private showStaff() {
    this.root.querySelector(".staffCard")?.remove();
    const el = document.createElement("div");
    el.className = "whResult staffCard";
    const rows = ROLES.map((r) => {
      const c = this.staff[r.key];
      const adq = Math.round(this.roleAdequacy(r.key) * 100);
      const tone = c.count < r.required ? "amber" : "green";
      return `<div class="techRow"><div class="techMain"><b>${r.label} — ${c.count}/${r.required} · ${Math.round(c.comp * 100)}% skill</b><span>${r.note} · ${fmtMoney(r.wage)}/day ea</span>
        <div class="pBar"><div class="pBarFill ${tone}" style="width:${adq}%"></div></div></div>
        <div class="staffBtns"><button class="pMini" data-act="hire:${r.key}" title="hire (+wage)">＋</button><button class="pMini" data-act="train:${r.key}" title="train (+skill)">🎓</button><button class="pMini" data-act="fire:${r.key}" title="lay off">－</button></div></div>`;
    }).join("");
    el.innerHTML = `<div class="introCard">
      <div class="rsHead">👷 Staff &amp; crews <span class="techRp">${fmtMoney(this.crewWagesPerDay())}/day wages</span></div>
      <div class="pNote">Hire and train your crews. Understaffed or green crews cut plant throughput, let strength scatter, and raise the risk of an inrush. Wages are a real slice of opex.</div>
      <div class="pSplit"><span>Overall crew competency</span><b>${Math.round(this.crewCompetency() * 100)}%</b></div>
      <div class="techList">${rows}</div>
      <button class="pBtn primary" id="staffClose"><b>Close ▶</b></button>
    </div>`;
    this.root.appendChild(el);
    el.querySelector("#staffClose")!.addEventListener("click", () => el.remove());
    el.querySelectorAll<HTMLElement>("[data-act^='hire:'],[data-act^='train:'],[data-act^='fire:']").forEach((b) =>
      b.addEventListener("click", () => { this.crewAction(b.dataset.act!); this.showStaff(); }));
  }
  private crewAction(act: string) {
    const [verb, key] = act.split(":"); const r = ROLES.find((x) => x.key === key); const c = this.staff[key];
    if (!r || !c) return;
    if (verb === "hire") {
      if (this.cash < r.hire) { this.hud.setStatus(`Not enough cash to hire a ${r.label} (${fmtMoney(r.hire)}).`); return; }
      this.cash -= r.hire; c.count++; this.hud.setStatus(`Hired a ${r.label} — now ${c.count}. Wages up ${fmtMoney(r.wage)}/day.`);
    } else if (verb === "train") {
      if (c.comp >= 0.99) { this.hud.setStatus(`${r.label} already fully competent.`); return; }
      if (this.cash < r.train) { this.hud.setStatus(`Not enough cash to train ${r.label} (${fmtMoney(r.train)}).`); return; }
      this.cash -= r.train; c.comp = Math.min(1, c.comp + 0.15); this.hud.setStatus(`${r.label} training — skill now ${Math.round(c.comp * 100)}%.`);
    } else if (verb === "fire") {
      if (c.count <= 0) return; c.count--; this.hud.setStatus(`Laid off a ${r.label} — now ${c.count}. Wages down ${fmtMoney(r.wage)}/day.`);
    }
    this.updateEconomy(); this.saveGame();
  }

  /** Geology & exploration: survey to reveal grade, drill to delineate/extend the reserve. */
  private showGeology() {
    this.root.querySelector(".geologyCard")?.remove();
    const el = document.createElement("div");
    el.className = "whResult geologyCard";
    const conf = Math.round(this.oreConfidence * 100);
    const tier = this.oreConfidence >= 0.85 ? "Measured" : this.oreConfidence >= 0.6 ? "Indicated" : "Inferred";
    const reserve = Math.round(this.supply.oreReserve.level).toLocaleString();
    const cap = Math.round(this.supply.oreReserve.cap).toLocaleString();
    const grade = this.explored ? `~$${MILL_NET_PER_T}/t milled (revealed)` : "unknown — run a survey";
    const full = this.oreConfidence >= 0.99;
    el.innerHTML = `<div class="introCard">
      <div class="rsHead">🧭 Geology &amp; exploration</div>
      <div class="pNote">Delineate the orebody before you commit. A survey reveals the grade; reserve-definition drilling raises confidence (Inferred → Indicated → Measured) and finds more ore to mine.</div>
      <div class="pSplit"><span>Confidence</span><b>${conf}% · ${tier}</b></div>
      <div class="pBar"><div class="pBarFill ${this.oreConfidence >= 0.85 ? "green" : "amber"}" style="width:${conf}%"></div></div>
      <div class="pSplit"><span>Reserve (in ground / total)</span><b>${reserve} / ${cap} t</b></div>
      <div class="pSplit"><span>Grade</span><b>${grade}</b></div>
      <div class="pSplit"><span>Drill holes</span><b>${this.drillHoles}</b></div>
      <button class="pBtn ${this.explored ? "" : "primary"}" data-act="survey" ${this.explored ? "disabled" : ""}><b>Geophysical survey</b><span>${this.explored ? "already surveyed" : `reveal grade + first delineation · ${fmtMoney(this.exploreCost(SURVEY_COST))}`}</span></button>
      <button class="pBtn ${full ? "" : "primary"}" data-act="drill" ${full ? "disabled" : ""}><b>Drill campaign</b><span>${full ? "orebody fully delineated (Measured)" : `+confidence, +reserve · ${fmtMoney(this.exploreCost(DRILL_COST))} · +${DRILL_DAYS} d`}</span></button>
      <button class="pBtn" id="geoClose"><b>Close ▶</b></button>
    </div>`;
    this.root.appendChild(el);
    el.querySelector("#geoClose")!.addEventListener("click", () => el.remove());
    el.querySelector("[data-act='survey']")?.addEventListener("click", () => { this.runSurvey(); this.showGeology(); });
    el.querySelector("[data-act='drill']")?.addEventListener("click", () => { this.drillCampaign(); this.showGeology(); });
  }
  private runSurvey() {
    if (this.explored) return;
    const cost = this.exploreCost(SURVEY_COST);
    if (this.cash < cost) { this.hud.setStatus(`Not enough cash for a survey (${fmtMoney(cost)}).`); return; }
    this.cash -= cost; this.explored = true; this.oreConfidence = Math.max(this.oreConfidence, 0.55);
    this.refreshGradeKnowledge(); this.updateEconomy(); this.saveGame();
    this.hud.setStatus(`Geophysical survey complete — grade revealed (~$${MILL_NET_PER_T}/t), orebody delineation started.`);
  }
  /** Plant a visible drill rig on the exploration ground (off to the side of the pad). */
  private spawnDrillHole(i: number) {
    const cx = -78, cz = 34; // exploration ground, clear of the plant pad
    const a = pseudoNoise(i * 1.7) * Math.PI * 2, d = 6 + pseudoNoise(i * 2.3) * 42;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d, y = heightAt(x, z);
    const mat = new StandardMaterial("dhm" + i, this.scene);
    mat.diffuseColor = Color3.FromHexString("#c9a24b"); mat.specularColor = Color3.Black();
    const rig = MeshBuilder.CreateCylinder("drillhole" + i, { diameter: 0.5, height: 5, tessellation: 6 }, this.scene);
    rig.material = mat; rig.position.set(x, y + 2.4, z); rig.parent = this.surfaceRoot; this.shadow.addShadowCaster(rig);
    const collar = MeshBuilder.CreateBox("dhc" + i, { width: 1.4, height: 0.4, depth: 1.4 }, this.scene);
    collar.material = mat; collar.position.set(x, y + 0.2, z); collar.parent = this.surfaceRoot;
  }
  private drillCampaign() {
    if (this.oreConfidence >= 0.99) { this.hud.setStatus("Orebody already fully delineated (Measured)."); return; }
    const cost = this.exploreCost(DRILL_COST);
    if (this.cash < cost) { this.hud.setStatus(`Not enough cash to drill (${fmtMoney(cost)}).`); return; }
    this.cash -= cost; this.day += DRILL_DAYS; this.drillHoles++; this.spawnDrillHole(this.drillHoles);
    const find = Math.round(DRILL_FIND_BASE * (1 - this.oreConfidence)); // diminishing returns toward full confidence
    this.oreConfidence = Math.min(1, this.oreConfidence + DRILL_CONF);
    this.supply.oreReserve.level += find; this.supply.oreReserve.cap += find;
    this.refreshGradeKnowledge(); this.updateEconomy(); this.saveGame();
    this.hud.setStatus(`Drill campaign — confidence ${Math.round(this.oreConfidence * 100)}%, +${find.toLocaleString()} t reserve delineated.`);
  }

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
      this.scene.clearColor = new Color4(0.07, 0.09, 0.12, 1);
      this.scene.fogColor = Color3.FromHexString("#11161d");
      this.scene.fogMode = Scene.FOGMODE_EXP2; this.scene.fogDensity = 0.0032;
      if (this.rainPS) this.rainPS.emitRate = 0; // no weather fx below ground / in plant
      this.sound.setRain(0);
    } else {
      this.scene.fogMode = Scene.FOGMODE_EXP2; this.scene.fogDensity = 0.0021;
      if (this.env) this.applyWeatherVisuals(); // tint the surface sky by current weather
    }
  }

  private setupCamera() {
    const cam = new ArcRotateCamera("cam", SURF_VIEW.alpha, SURF_VIEW.beta, SURF_VIEW.radius, SURF_VIEW.target.clone(), this.scene);
    cam.attachControl(this.canvas, true);
    cam.lowerRadiusLimit = 30; cam.upperRadiusLimit = 260;
    cam.lowerBetaLimit = 0.2; cam.upperBetaLimit = 1.38;
    cam.wheelDeltaPercentage = 0.012; cam.panningSensibility = 26; cam.inertia = 0.85;
    cam.minZ = 0.5; cam.maxZ = 4000;
    cam.panningDistanceLimit = 160; cam.panningInertia = 0.6;
    this.camera = cam;
  }

  private env!: Environment;
  /** Cinematic opening: sweep in from high over the valley to the working view. */
  private flyIn() {
    if (location.hash) return; // headless test hooks want a static camera
    const cam = this.camera, T = 3.2;
    const from = { a: SURF_VIEW.alpha - 1.1, b: 0.72, r: 330 };
    let t = 0;
    const ease = (k: number) => 1 - Math.pow(1 - k, 3);
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      if (this.mode !== "surface") { this.scene.onBeforeRenderObservable.remove(obs); return; } // left the surface: stop steering
      t += this.engine.getDeltaTime() / 1000; const k = ease(Math.min(1, t / T));
      cam.alpha = from.a + (SURF_VIEW.alpha - from.a) * k;
      cam.beta = from.b + (SURF_VIEW.beta - from.b) * k;
      cam.radius = from.r + (SURF_VIEW.radius - from.r) * k;
      if (k >= 1) this.scene.onBeforeRenderObservable.remove(obs);
    });
    this.canvas.addEventListener("pointerdown", () => { t = T; }, { once: true }); // any click skips it
  }
  /** Watch the frame rate for a few seconds; if it is poor, drop SSAO so it stays smooth. */
  private autoQuality() {
    if (!gfxHigh()) return;
    let frames = 0, t = 0;
    const obs = this.scene.onAfterRenderObservable.add(() => {
      t += this.engine.getDeltaTime(); frames++;
      if (t > 6000) {
        this.scene.onAfterRenderObservable.remove(obs);
        const fps = (frames * 1000) / t;
        if (fps < 28) { this.env.enableSSAO(false); try { localStorage.setItem("bt_gfx", "low"); } catch { /* ignore */ } }
      }
    });
  }
  private hemi!: HemisphericLight;
  private sun!: DirectionalLight;
  private setupLights() {
    this.hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), this.scene);
    this.hemi.intensity = 0.95; this.hemi.diffuse = Color3.FromHexString("#d6e6ff"); this.hemi.groundColor = Color3.FromHexString("#8a7c62");
    this.hemi.specular = Color3.Black();
    // a warm, lowish afternoon sun: long readable shadows across the site
    this.sun = new DirectionalLight("sun", new Vector3(-0.62, -0.72, -0.32), this.scene);
    this.sun.position = new Vector3(160, 190, 85); this.sun.intensity = 1.35; this.sun.diffuse = Color3.FromHexString("#fff0d6");
    this.sun.autoUpdateExtends = false; this.sun.shadowFrustumSize = 300; // fixed ortho box over the playable site
    this.sun.shadowMinZ = 1; this.sun.shadowMaxZ = 600;
    this.shadow = new ShadowGenerator(gfxHigh() ? 4096 : 2048, this.sun);
    this.shadow.usePercentageCloserFiltering = true; this.shadow.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    this.shadow.bias = 0.0006; this.shadow.normalBias = 0.02; this.shadow.darkness = 0.25;
  }
  /** Tint the sky + light by the current weather (call only when on/entering surface). */
  private applyWeatherVisuals() {
    const P: Record<Weather, { zenith: string; horizon: string; glow: number; hemi: number; sun: number }> = {
      clear: { zenith: "#3f86d6", horizon: "#cfe3ef", glow: 1, hemi: 0.95, sun: 1.35 },
      rain:  { zenith: "#5d6b78", horizon: "#9aa6ae", glow: 0.15, hemi: 0.85, sun: 0.5 },
      storm: { zenith: "#2a3038", horizon: "#555d66", glow: 0, hemi: 0.7, sun: 0.28 },
      heat:  { zenith: "#4d8fd0", horizon: "#f1dcb4", glow: 1.3, hemi: 0.95, sun: 1.55 },
      cold:  { zenith: "#6f9cc9", horizon: "#dfe8ef", glow: 0.7, hemi: 0.95, sun: 1.1 },
    };
    const p = P[this.weather];
    this.env.setSky({ zenith: p.zenith, horizon: p.horizon, sun: p.glow });
    this.hemi.intensity = p.hemi; this.sun.intensity = p.sun;
    this.setWeatherFx();
  }
  private dotTex?: DynamicTexture;
  private getDot(): DynamicTexture {
    if (!this.dotTex) {
      this.dotTex = new DynamicTexture("dotTex", 16, this.scene, false);
      const ctx = this.dotTex.getContext(); ctx.fillStyle = "white"; ctx.beginPath(); ctx.arc(8, 8, 6, 0, Math.PI * 2); ctx.fill(); this.dotTex.update();
    }
    return this.dotTex;
  }
  private rainPS?: ParticleSystem;
  private ensureWeatherFx() {
    if (this.rainPS) return;
    const ps = new ParticleSystem("weatherfx", 1600, this.scene);
    ps.particleTexture = this.getDot();
    ps.emitter = new Vector3(30, 90, 8);
    ps.minEmitBox = new Vector3(-130, 0, -130); ps.maxEmitBox = new Vector3(130, 0, 130);
    ps.direction1 = new Vector3(-1, -14, -1); ps.direction2 = new Vector3(1, -16, 1);
    ps.minLifeTime = 3.5; ps.maxLifeTime = 5.5; ps.gravity = new Vector3(0, -60, 0);
    ps.emitRate = 0; ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.start();
    this.rainPS = ps;
  }
  /** Rain/storm/snow particles matched to the current weather (surface only). */
  private setWeatherFx() {
    this.ensureWeatherFx();
    const ps = this.rainPS!;
    const w = this.weather;
    if (w === "rain") { ps.emitRate = 750; ps.gravity = new Vector3(0, -60, 0); ps.minSize = 0.3; ps.maxSize = 0.6; ps.color1 = new Color4(0.7, 0.8, 0.95, 0.6); ps.color2 = new Color4(0.6, 0.7, 0.85, 0.5); }
    else if (w === "storm") { ps.emitRate = 1500; ps.gravity = new Vector3(-8, -78, 0); ps.minSize = 0.35; ps.maxSize = 0.7; ps.color1 = new Color4(0.62, 0.7, 0.85, 0.7); ps.color2 = new Color4(0.5, 0.6, 0.75, 0.6); }
    else if (w === "cold") { ps.emitRate = 320; ps.gravity = new Vector3(2, -7, 1); ps.minSize = 0.4; ps.maxSize = 0.9; ps.color1 = new Color4(1, 1, 1, 0.95); ps.color2 = new Color4(0.9, 0.94, 1, 0.85); } // snow: slow, drifting, white
    else ps.emitRate = 0;
    this.sound.setRain(w === "rain" ? 0.1 : w === "storm" ? 0.2 : 0);
  }

  private pourPS?: ParticleSystem;
  private ensurePourFx() {
    if (this.pourPS) return;
    const ps = new ParticleSystem("poursplash", 500, this.scene);
    ps.particleTexture = this.getDot();
    ps.minEmitBox = new Vector3(-1.6, 0, -1.6); ps.maxEmitBox = new Vector3(1.6, 0, 1.6);
    ps.direction1 = new Vector3(-2.5, 3, -2.5); ps.direction2 = new Vector3(2.5, 5, 2.5);
    ps.minSize = 0.3; ps.maxSize = 0.8; ps.minLifeTime = 0.25; ps.maxLifeTime = 0.7;
    ps.gravity = new Vector3(0, -20, 0); ps.emitRate = 0;
    ps.color1 = new Color4(0.86, 0.62, 0.26, 0.9); ps.color2 = new Color4(0.72, 0.5, 0.2, 0.8); // wet paste splash
    ps.start();
    this.pourPS = ps;
  }
  /** Splash of paste at the top of the fill while a stope is pouring (underground view). */
  private updatePourFx() {
    this.ensurePourFx(); const ps = this.pourPS!;
    const s = this.underground.stopes.find((x) => x.status === "pouring" && x.fillMesh.isEnabled());
    if (s) { const p = s.fillMesh.getAbsolutePosition(); ps.emitter = new Vector3(p.x, p.y + (s.fillMesh.scaling.y * s.chamberH) / 2, p.z); ps.emitRate = 240; }
    else ps.emitRate = 0;
  }

  private createPortal(): Vector3 {
    const x = -66, z = 10, y = heightAt(x + 8, z);
    const mk = (hex: string) => { const m = new StandardMaterial("pm", this.scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = Color3.Black(); return m; };
    const add = (m: Mesh, cast = true) => { m.parent = this.surfaceRoot; m.receiveShadows = true; if (cast) this.shadow.addShadowCaster(m); return m; };
    // gravel apron where trucks turn in front of the adit
    const apron = MeshBuilder.CreateDisc("aditApron", { radius: 11, tessellation: 28 }, this.scene);
    apron.rotation.x = Math.PI / 2; apron.material = mk("#a69a84"); apron.position.set(x + 9, y + 0.06, z); add(apron, false);
    // concrete portal set facing the site (+x), buried into the knoll behind it
    const g = new TransformNode("adit", this.scene); g.parent = this.surfaceRoot; g.position.set(x, y, z);
    const part = (m: Mesh) => { m.parent = g; m.receiveShadows = true; this.shadow.addShadowCaster(m); return m; };
    const wall = MeshBuilder.CreateBox("aditWall", { width: 4, height: 11, depth: 16 }, this.scene); wall.material = mk("#b3ada0"); wall.position.set(-1, 5.5, 0); part(wall);
    for (const s of [-1, 1]) { // wing walls
      const w = MeshBuilder.CreateBox("aditWing", { width: 7, height: 7, depth: 1.2 }, this.scene); w.material = mk("#a7a194"); w.position.set(2, 3.5, s * 7.6); w.rotation.y = s * -0.35; part(w);
    }
    const mouth = MeshBuilder.CreateCylinder("aditMouth", { diameter: 7, height: 4.4, tessellation: 24, arc: 0.5 }, this.scene);
    mouth.rotation.set(0, 0, Math.PI / 2); mouth.material = mk("#101418"); mouth.position.set(0.3, 3.4, 0); part(mouth);
    const mouthLow = MeshBuilder.CreateBox("aditMouthLow", { width: 4.4, height: 3.4, depth: 7 }, this.scene); mouthLow.material = mk("#101418"); mouthLow.position.set(0.3, 1.7, 0); part(mouthLow);
    const lintel = MeshBuilder.CreateBox("aditLintel", { width: 4.6, height: 1.2, depth: 16.6 }, this.scene); lintel.material = mk("#8d877a"); lintel.position.set(-0.8, 11.4, 0); part(lintel);
    const sign = MeshBuilder.CreateBox("aditSign", { width: 0.4, height: 1.6, depth: 7.5 }, this.scene); sign.material = mk("#f2b233"); sign.position.set(1.3, 8.6, 0); part(sign);
    // hazard-striped bollards and a pair of lamps either side of the mouth
    for (const s of [-1, 1]) {
      const b = MeshBuilder.CreateCylinder("bollard", { diameter: 0.7, height: 1.4, tessellation: 10 }, this.scene); b.material = mk("#f2b233"); b.position.set(3, 0.7, s * 4.6); part(b);
      const lamp = MeshBuilder.CreateSphere("aditLamp", { diameter: 0.7, segments: 6 }, this.scene);
      const lm = mk("#fff2c0"); lm.emissiveColor = Color3.FromHexString("#ffd98a"); lamp.material = lm; lamp.position.set(1.3, 7.2, s * 4.4); lamp.parent = g;
    }
    // headframe over the hoisting shaft beside the portal (the ore hoist that feeds the mill)
    const hx = -56, hz = -16;
    const hf = createHeadframe(this.scene, (m) => { this.shadow.addShadowCaster(m); m.receiveShadows = true; });
    hf.position.set(hx, heightAt(hx, hz), hz); hf.parent = this.surfaceRoot;
    const collar = MeshBuilder.CreateBox("collar", { width: 12, height: 0.5, depth: 9 }, this.scene); collar.material = mk("#9d9788"); collar.position.set(hx, heightAt(hx, hz) + 0.2, hz); add(collar, false);
    this.oreHoistAt = new Vector3(hx, heightAt(hx, hz) + 7, hz); // conveyor picks up hoisted ore here
    return new Vector3(x + 9, y, z);
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
    this.camera.radius = 132; this.camera.beta = 1.12; this.camera.alpha = Math.PI * 0.42;
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
    this.camera.setTarget(SURF_VIEW.target.clone()); this.camera.radius = SURF_VIEW.radius; this.camera.beta = SURF_VIEW.beta; this.camera.alpha = SURF_VIEW.alpha;
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
    this.camera.setTarget(c); this.camera.radius = 72; this.camera.beta = 0.86; this.camera.alpha = Math.PI * 0.3;
    this.hud.setHidden(true);
  }

  private exitPlant() {
    this.mode = "surface";
    this.plantInterior.exit();
    this.checkTutorial(); // the plant-line step completes on exit
    this.surfaceRoot.setEnabled(true);
    this.setSky(false);
    this.camera.setTarget(SURF_VIEW.target.clone()); this.camera.radius = SURF_VIEW.radius; this.camera.beta = SURF_VIEW.beta; this.camera.alpha = SURF_VIEW.alpha;
    this.hud.setHidden(false);
    this.refreshObjective();
  }

  /** Pour throughput is set by the plant you build inside: no line = slow contract plant. */
  private pourRatePerDay(): number {
    const base = this.plantThroughput <= 0 ? POUR_RATE_M3_PER_DAY * 0.4 : POUR_RATE_M3_PER_DAY * Math.max(0.4, Math.min(1.2, this.plantThroughput / 55));
    const crew = 0.7 + 0.3 * this.operatorAdequacy(); // thin/green plant crews run slower
    return base * this.pourMult() * crew;
  }

  // ---- live clock -----------------------------------------------------------

  private advanceTime(dt: number) {
    if (this.paused || this.ended || this.activeEvent || this.phase !== "operate") return; // time only runs in the Operate phase
    const prev = this.day;
    this.day += (dt / SECONDS_PER_DAY) * this.speed;
    const dd = this.day - prev;
    this.updateConstruction(dd);
    this.updateWeather();
    // rain fills the pond for free; heat evaporates it (arid mines feel this)
    if (this.weather === "rain") this.supply.water.level = Math.min(this.supply.water.cap, this.supply.water.level + 2600 * dd);
    else if (this.weather === "heat") this.supply.water.level = Math.max(0, this.supply.water.level - 1400 * dd);

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
        const limit = this.pourLimitMpa(s) * this.diff.pressureTol; // Easy/Normal pipes have a little extra margin
        if (this.diff.autoSafety && s.pressureMpa > limit * 0.85) {
          // Easy: the safety crew spots the pressure climbing and flushes + eases the line before it bursts
          s.plugDrift = Math.max(0, s.plugDrift - 0.5); if (s.flowFactor > 1) s.flowFactor = 1;
          s.pressureMpa = pourPressureMpa(s.depthM, s.lengthM, s.choke, s.flowFactor, s.plugDrift, s.cls.ratingMpa, noise, fScale);
          this.safetyAssist(`Pressure was climbing in the ${s.id} line, so your safety crew flushed it and eased the flow. Tip: a low-solids start and a steady flow keep pressure down.`);
        }
        if (s.pressureMpa > limit) {
          const pen = this.penalty(BURST_PENALTY);
          this.burstCount.set(s.id, (this.burstCount.get(s.id) ?? 0) + 1);
          this.underground.net.clearFlow(this.underground.stopes.indexOf(s));
          this.underground.burst(s); this.safetyIncidents++; this.cash -= pen; this.sound.burst();
          const again = (this.burstCount.get(s.id) ?? 0) > 1;
          this.hud.setStatus(again
            ? `⚠ ${s.id} line burst again: the pipe is too weak for this depth. Cost ${fmtMoney(pen)}. Pour a thinner mix (lower solids in the 🧪 Lab), keep the flow low, or use stronger pipe on the next stope.`
            : `⚠ ${s.id} line burst (pressure went over the pipe's ${s.cls.ratingMpa} MPa rating). Cost ${fmtMoney(pen)}. The pipes are fine: press Pour again, tick the low-solids start, keep the flow steady, and flush if pressure climbs.`);
          continue;
        }
        if (s.plugDrift > 0.45 && s.pressureMpa > limit * 0.75 && Math.floor(this.day) !== this.plugWarnDay) { // warn before it bursts
          this.plugWarnDay = Math.floor(this.day);
          this.hud.setStatus(`⚠ ${s.id} line is starting to plug and pressure is rising (${s.pressureMpa.toFixed(1)} of ${limit.toFixed(0)} MPa). Press Flush and keep the flow near 1.0×.`);
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
        this.hud.setStatus(draw.limiting === "binder" ? `⚠ ${s.id} pour slowed: the binder silo is empty. Order a truck top-up (binder button) or build a binder supply.`
          : draw.limiting === "tailings" ? `⏳ ${s.id} pour slowed: waiting for tailings from the Mill. Upgrading the ⚙ Mill makes more.`
          : `⚠ ${s.id} pour slowed: the water pond is dry. Check the 💧 Water pump is built and powered.`);
      }
      s.placedM3 += delta;
      this.cash -= recipeCostPerM3(this.recipeFor(s)) * fill.costMult * delta * this.diff.binderCost;

      // Barricade loading (GDD 09): the rate of rise loads the barricade until the
      // plug sets and isolates it. Pour the plug too fast and it fails — inrush.
      const bfrac = s.placedM3 / s.volumeM3;
      s.plugSet = Math.min(1, bfrac / PLUG_SET_FRAC);
      const preSet = 1 - s.plugSet;
      const fluidMult = fill.reticulated ? 1 : 0.35; // trucked CAF exerts little fluid head
      s.barricadeKpa = (BAR_RISE_K * s.flowFactor + BAR_HEAD_K * bfrac) * preSet * fluidMult;
      const cap = this.barricadeCap(s);
      if (this.diff.autoSafety && cap > 0 && preSet > 0 && s.barricadeKpa > cap * 0.85) {
        // Easy: geotech watches the barricade gauge and slows the pour until the plug sets
        s.flowFactor = Math.max(0.5, s.flowFactor - 0.25); this.autoEased.add(s.id);
        s.barricadeKpa = (BAR_RISE_K * s.flowFactor + BAR_HEAD_K * bfrac) * preSet * fluidMult;
        this.safetyAssist(`The ${s.id} barricade was getting heavy, so your geotech slowed the pour until the plug sets. Tip: pour the first part slowly.`);
      } else if (this.autoEased.has(s.id) && s.plugSet >= 1) {
        s.flowFactor = 1; this.autoEased.delete(s.id); // plug has set: back to full speed
      }
      // grace: the barricade tolerates a brief overload — ease the flow and it recovers
      if (cap > 0 && s.barricadeKpa > cap) s.barricadeOver += dd;
      else s.barricadeOver = Math.max(0, s.barricadeOver - dd * 2);
      const grace = 0.05 * (0.4 + 0.8 * this.geotechAdequacy()); // good geotech spots the overload sooner and reacts
      if (cap > 0 && s.barricadeOver > grace) {
        this.underground.net.clearFlow(this.underground.stopes.indexOf(s));
        this.underground.inrush(s); this.sound.burst();
        if (s.exclusionZone) {
          const pen = this.penalty(INRUSH_PENALTY * 0.4);
          this.cash -= pen;
          this.hud.setStatus(`⚠ ${s.id} barricade gave way, but the exclusion zone kept everyone safe. Cost ${fmtMoney(pen)}. Pick a barricade again and pour the start more slowly.`);
        } else {
          const pen = this.penalty(INRUSH_PENALTY);
          this.cash -= pen; this.safetyIncidents++;
          this.hud.setStatus(`⚠ ${s.id} barricade gave way and paste ran into the drive (a safety incident). Cost ${fmtMoney(pen)}. Pick a stronger barricade (shotcrete, with relief) and pour the start slowly.`);
        }
        continue;
      }

      if (s.placedM3 >= s.volumeM3) {
        this.underground.net.clearFlow(this.underground.stopes.indexOf(s));
        this.underground.completePour(s, this.day);
        const fillRev = Math.round(fillRevenue(s.volumeM3) * this.diff.revenue);
        this.cash += fillRev; this.sound.cash();
        this.hud.setStatus(`${s.id} ${fill.label} complete: ${fmtMoney(fillRev)} ore access unlocked. Curing now.`);
        this.cheer("firstpour", `🎉 Your first stope is full! ${s.id} earned ${fmtMoney(fillRev)}. It cures now, then its strength gets tested.`);
        if (s.barricadeRisk && Math.abs(Math.sin(s.depthM * 12.9 + s.volumeM3)) > 0.5) {
          const pen = this.penalty(900_000);
          this.safetyIncidents++; this.cash -= pen; this.sound.burst();
          this.hud.setStatus(`⚠ ${s.id} barricade seeped as it filled. The spill was contained, but geotech was right (cost ${fmtMoney(pen)}). Next time, reinforce when geotech asks.`);
        }
      }
    }

    // surface materials economy: hoist ore, mill it (concentrate income + tailings), route to TSF, deliver binder, pump water
    const deliveryMult = (this.day < this.tempDeliveryUntil ? this.tempDeliveryMult : 1) * (this.scenario.binder?.deliveryMult ?? 1) * this.diff.binderDelivery;
    const sup = this.supply.tick(dd, this.supplyState(), deliveryMult, this.plantThroughput > 0 ? 0.6 : 0, this.millPasteFrac());
    this.lastWaterReused = dd > 0 ? sup.waterReused / dd : 0; // m³/day recovered, for the HUD
    const revenue = sup.revenue * (this.research.has("recovery") ? 1.15 : 1) * this.millRecoveryMult() * this.millReagentMult() * this.diff.revenue;
    const modeCostMult = this.activeBinderMode()?.costMult ?? 1; // haulage/isotainer cost more per tonne
    const binderCost = sup.binderCost * (this.research.has("binder") ? 0.7 : 1) * (this.scenario.binder?.costMult ?? 1) * modeCostMult * this.diff.binderCost;
    this.cash += revenue - binderCost;
    if (this.loanBalance > 0 && revenue > 0) { // board loan (Normal) is repaid from a quarter of mill income
      const repay = Math.min(this.loanBalance, revenue * 0.25);
      this.loanBalance -= repay; this.cash -= repay;
      if (this.loanBalance <= 1) { this.loanBalance = 0; this.hud.setStatus("🎉 Board loan fully repaid. Nice work!"); }
    }
    if (revenue > 0) this.cheer("income", "🎉 The mill is making money! Ore is turning into cash every day. Watch the cash counter go up.");
    // Reactive (PAG/reagent) reject sent to the TSF without a lined controlled-slurry
    // facility is an environmental breach — an ongoing fine until you contain it.
    const minl = this.scenario.mineralogy;
    if (minl?.reactive && sup.rejectStreamT > 0 && !this.hasControlledSlurry()) {
      const fine = ENV_PENALTY_PER_T * sup.rejectStreamT * this.diff.fines;
      this.cash -= fine; this.envFinesTotal += fine; this.envBreachActive = true;
      if (Math.floor(this.day) !== this.lastDayShown) this.hud.setStatus(`☣ ${minl.label} reject to the TSF uncontained — environmental fine. Build a ☣ Controlled slurry pond to contain the PAG reject.`);
    } else this.envBreachActive = false;
    this.rp += sup.milledT / 4000; // know-how accrues as ore is processed
    this.millDayIncome = dd > 0 ? revenue / dd : 0; // $/day for the HUD readout
    if (sup.notes.length && Math.floor(this.day) !== this.lastDayShown) this.hud.setStatus(sup.notes[0]);
    const ev = this.underground.updateSchedule(this.day);
    this.cash -= (BASE_OPEX_PER_DAY + this.opexPerDay) * this.opexMult * this.diff.opex * dd; // daily running cost
    this.cash -= this.crewWagesPerDay() * this.diff.opex * dd; // crew wages
    this.cash -= this.flowsheetOpexPerDay() * this.diff.opex * dd; // concentrator flowsheet power/reagents
    if (this.scenario.wet) this.cash -= this.scenario.wet.dewaterPerDay * dd; // pumping the flooded workings out (difficulty-scaled in the scenario)
    this.cash -= LATE_COST_PER_DAY * this.diff.fines * ev.overdue.length * dd; // overdue stopes stall mining
    if (ev.overdue.length && Math.floor(this.day) !== this.lastDayShown && Math.floor(this.day) % 3 === 0) this.hud.setStatus(`⏰ ${ev.overdue.map((s) => s.id).join(", ")} ${ev.overdue.length > 1 ? "are" : "is"} past the due date and costing ${fmtMoney(LATE_COST_PER_DAY * this.diff.fines)}/day each. Go underground, build the pipes and pour ${ev.overdue.length > 1 ? "them" : "it"}.`);
    for (const s of ev.newlyAvailable) { const ore = this.grantExtractionOre(s); this.hud.setStatus(`${s.id} mucked out at −${s.depthM} m — ${Math.round(ore).toLocaleString()} t ore to the ROM pad, void ready to reticulate (due day ${s.dueDay}).`); }
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
      this.hud.setStatus(s.ucsPass
        ? `${s.id} strength test: ${s.ucsAchievedKpa}/${s.targetUcsKpa} kPa. PASS ✓`
        : `${s.id} strength test: ${s.ucsAchievedKpa}/${s.targetUcsKpa} kPa. Not strong enough ✗. Next time add more binder in the 🧪 Lab (aim above the target).`);
      if (s.ucsPass) this.cheer("firstpass", `🎉 ${s.id} passed its strength test! The stope is safe and handed back to the miners.`);
    }
    this.updateEconomy();

    // throttled HUD refresh
    if (Math.floor(this.day) !== this.lastDayShown) { this.lastDayShown = Math.floor(this.day); this.refreshClock(); this.refreshSchedule(); this.saveGame(); this.checkTutorial(); if (this.mode === "underground") this.renderStopePanel(); }
    else if (this.mode === "underground" && this.selectedStope?.status === "pouring") this.renderStopePanel();

    this.maybeFireEvent();
    if (this.day >= this.scenario.horizonDays || this.underground.counts().cured === this.underground.stopes.length) this.endCampaign();
  }

  private pourMult() { return this.day < this.tempPourUntil ? this.tempPourMult : 1; }

  // ---- difficulty helpers: safety assist, celebrations, board rescue ---------
  private autoEased = new Set<string>(); // stopes whose flow the Easy safety crew slowed
  private plugWarnDay = -1;
  private burstCount = new Map<string, number>(); // bursts per stope (repeat bursts get a different hint)
  /** Burst limit for a live pour. Hard: the whole stope's pressure against the weakest leg
   *  on the path. Easy/Normal (leg-aware): each leg only has to hold the pressure it
   *  actually sees, so a line whose every leg is ✓ in the designer won't burst at a
   *  steady pour; the limit is the smallest leg margin carried down to the stope. */
  private pourLimitMpa(s: StopeUG): number {
    if (!s.cls) return 0;
    if (!this.diff.legAware) return s.cls.ratingMpa;
    const net = this.underground.net; const path = net.pathFor(this.underground.stopes.indexOf(s));
    let margin = Infinity;
    for (const g of path) { const c = net.cls(g); if (c) margin = Math.min(margin, c.ratingMpa - net.pressureMpa(g)); }
    const atStope = net.pressureMpa(path[path.length - 1]);
    return Number.isFinite(margin) ? Math.max(s.cls.ratingMpa, atStope + margin) : s.cls.ratingMpa;
  }
  /** One-click safe pipe design (Easy/Normal): the cheapest valid class on every unbuilt leg,
   *  adding borehole chokes only if a leg can't be made safe without them. */
  private autoDesignPath(i: number): boolean {
    const net = this.underground.net;
    const legs = () => net.pathFor(i).filter((g) => !g.built);
    const spec = () => { let ok = true; for (const g of legs()) { g.classId = 0; while (g.classId < 3 && !net.valid(g)) g.classId++; if (!net.valid(g)) ok = false; } return ok; };
    for (const g of legs()) if (g.kind === "borehole") g.choke = false;
    if (spec()) return true;
    for (const g of legs()) if (g.kind === "borehole") g.choke = true; // shed static head on the deep legs
    return spec();
  }
  private eventResume = true;            // resume the clock when the active event card is answered
  topupCost() { return Math.round(BINDER_TOPUP_COST * this.diff.binderCost); }
  /** Easy-mode safety crew stepped in: tell the player once a day, kindly. */
  private safetyAssist(msg: string) {
    const d = Math.floor(this.day); if (d === this.autoEasedDay) return;
    this.autoEasedDay = d; this.hud.setStatus(`🦺 ${msg}`);
  }
  /** One-off milestone celebration (first income, first full stope, first pass...). */
  private cheer(key: string, msg: string) {
    if (this.cheered.has(key)) return;
    this.cheered.add(key); this.hud.setStatus(msg); this.sound.pass();
  }
  /** Cash the player needs right now to keep going: the next required build (or the
   *  permit) while setting up, or simply staying above zero once operating. */
  private cashNeeded(): number {
    if (this.phase === "operate") return 0;
    const has = (t: string) => this.buildings.some((b) => b.spec.type === t);
    if (!this.explored || this.oreConfidence < 0.7) return this.exploreCost(this.explored ? DRILL_COST : SURVEY_COST);
    const need: string[] = ["power", "plant", "mill", "tsf"];
    for (const t of need) if (!has(t)) return specOf(t).cost;
    if (!(has("rail") || has("haulage") || has("isotainer"))) return specOf("isotainer").cost;
    if (!this.scenario.wet && !has("waterpump")) return specOf("waterpump").cost;
    return this.permitObtained ? 0 : this.permitCost();
  }
  /** Easy/Normal: when money runs out, the board steps in (a grant on Easy, a loan on
   *  Normal) instead of leaving the player stuck. Hard has no safety net. */
  private maybeRescue() {
    if (this.ended || this.activeEvent || this.rescuesUsed >= this.diff.rescues) return;
    const need = this.cashNeeded();
    if (this.cash >= 0 && this.cash >= need) return;
    const amount = Math.max(this.diff.rescueAmount, Math.ceil((need - this.cash + 8_000_000) / 1e6) * 1e6);
    const loan = this.diff.rescueIsLoan;
    const left = this.diff.rescues - this.rescuesUsed - 1;
    const always = this.diff.rescues >= 99;
    this.fireEvent({
      id: `rescue${this.rescuesUsed + 1}`, title: loan ? "The board offers a loan" : "The board sends help",
      body: loan
        ? `Money is running low (${fmtMoney(this.cash)}). The board will lend you <b>${fmtMoney(amount)}</b> so you can keep going. It is paid back automatically from a quarter of your mill income, plus 10%. ${left > 0 ? `They can help ${left} more time${left > 1 ? "s" : ""}.` : "This is their last offer, so spend carefully."}`
        : `You're running low on money (${fmtMoney(this.cash)}). The board believes in you and is sending <b>${fmtMoney(amount)}</b> so you can keep building. ${always ? "" : left > 0 ? `They can help ${left} more time${left > 1 ? "s" : ""}.` : "This is the last top-up, so spend carefully."} Tip: the ⚙ Mill makes money every day, so build it early.`,
      options: [{ label: loan ? `Accept the loan (+${fmtMoney(amount)})` : `Thank you! (+${fmtMoney(amount)})`, detail: "Back to work.", apply: (w) => {
        w.cash += amount; w.rescuesUsed++; if (loan) w.loanBalance += Math.round(amount * 1.1);
        w.hud.setStatus(loan ? `Board loan received: +${fmtMoney(amount)}.` : `💰 The board sent ${fmtMoney(amount)}. Keep going!`);
      } }],
    });
  }

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
    const wasPaused = this.paused;
    this.activeEvent = ev; this.firedEvents.add(ev.id); this.paused = true; this.eventResume = !wasPaused || this.phase === "operate"; this.refreshClock(); this.sound.event();
    this.hud.showEvent(`<div class="rsHead">⚠ ${ev.title}</div><p class="evBody">${ev.body}</p><div class="evOpts">${ev.options.map((o, i) => `<button class="optBtn" data-act="ev:${i}"><b>${o.label}</b><span>${o.detail}</span></button>`).join("")}</div>`);
  }
  private resolveEvent(i: number) {
    const ev = this.activeEvent; if (!ev) return;
    ev.options[i].apply(this);
    this.activeEvent = null; this.paused = !this.eventResume; this.hud.hideEvent(); this.updateEconomy(); this.refreshClock();
  }
  private evBinderDelay(): GameEvent {
    return {
      id: "binder-delay", title: "Binder rail shipment delayed",
      body: "The rail cement shipment is held up — the silo will run down. Binder is ~70% of your cost, and every pour needs it. Silo capacity vs delivery lead time is the eternal squeeze.",
      options: [
        { label: `Truck top-up (+${BINDER_TOPUP_TONNES} t, ${fmtMoney(this.topupCost())})`, detail: "Short lead, premium price. Keeps pours running.", apply: (w) => { w.cash -= w.topupCost(); w.supply.topUpBinder(BINDER_TOPUP_TONNES); } },
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
        { label: "Emergency flush the line", detail: "Clear the line now. Safe, costs a bit of paste.", apply: (w) => { s.plugDrift = 0; w.cash -= w.penalty(120_000); } },
        { label: "Stand down the pour", detail: "Stop safely — cold joint, re-pour the placed volume.", apply: (w) => { w.underground.burst(s); w.hud.setStatus(`${s.id} stood down through the seismic event — re-pour needed.`); } },
      ],
    };
  }
  private evGeotech(s: StopeUG): GameEvent {
    return {
      id: "geotech", title: `Geotech flag on ${s.id}`,
      body: `Ground control has flagged the barricade footing on ${s.id}. They want it reinforced before you pour fresh fill against it — ignore the geotech at your peril, a barricade breach is a runaway.`,
      options: [
        { label: `Reinforce the barricade (+${fmtMoney(this.penalty(600_000))}, +1 day)`, detail: "Do it right. Removes the failure risk.", apply: (w) => { w.cash -= w.penalty(600_000); w.day += 1; s.barricadeRisk = false; } },
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
        { label: `Draw down tailings buffer (+${fmtMoney(this.penalty(300_000))})`, detail: "Buy stored tailings and keep the full rate.", apply: (w) => { w.cash -= w.penalty(300_000); } },
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
         <button class="pBtn primary" data-act="testwork"><b>Commission test-work (${fmtMoney(this.exploreCost(TESTWORK_COST))})</b><span>reveals the real UCS curve &amp; mineralogy; cuts scatter so you can trim binder · +${TESTWORK_DAYS} days</span></button>`;
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
    const minedFrac = 1 - this.supply.oreReserve.level / Math.max(1, this.supply.oreReserve.cap); // how much of the (delineated) orebody was monetised
    const netCash = this.cash - this.loanBalance; // an unpaid board loan counts against you
    let score = 0;
    score += passed === total ? 3 : passed >= total - 1 ? 2 : passed >= total / 2 ? 1 : 0;
    score += onTime >= total ? 2 : onTime >= total * 0.6 ? 1 : 0;
    score += netCash > 0 ? 2 : 0;
    score += netCash > this.scenario.startCash * 0.3 ? 1 : 0;
    score += minedFrac > 0.8 ? 1 : 0; // reward extracting the resource before the horizon
    const order = ["S", "A", "B", "C", "D"];
    const baseGi = order.indexOf(score >= 8 ? "S" : score >= 6 ? "A" : score >= 4 ? "B" : score >= 2 ? "C" : "D");
    // safety costs grade tiers, monotonically: 1 incident -1, a couple -2, a rash -3
    const steps = this.safetyIncidents >= 4 ? 3 : this.safetyIncidents >= 2 ? 2 : this.safetyIncidents === 1 ? 1 : 0;
    const grade = order[Math.min(order.length - 1, baseGi + steps)];
    this.lastGrade = grade;
    const cheerLine = grade === "S" || grade === "A" ? "🎉 Brilliant work! The board is thrilled."
      : grade === "B" ? "👏 Well done! A solid campaign."
      : grade === "C" ? "👍 You made it through. Try a stronger mix and fill stopes on time for a better grade."
      : "Every engineer has a tough mine. Try Easy mode, build the Mill early, and add binder in the Lab.";
    // bank legacy points into the persistent company
    const earned = legacyForGrade(grade);
    const co = loadCompany(); co.legacy += earned; saveCompany(co);
    this.hud.showResult(`
      <div class="rsHead">Board review · Day ${Math.floor(this.day)}</div>
      <div class="rsGrade grade-${grade}">${grade}</div>
      <div class="pNote">${cheerLine}</div>
      <div class="rsRows">
        <div><span>Difficulty</span><b>${this.diff.label}</b></div>
        <div><span>Cylinders passed</span><b>${passed}/${total}</b></div>
        <div><span>On time</span><b>${onTime}/${total}</b></div>
        <div><span>Orebody extracted</span><b>${Math.round(minedFrac * 100)}%</b></div>
        <div><span>Cash</span><b>${fmtMoney(this.cash)}</b></div>
        ${this.rescuesUsed > 0 ? `<div><span>Board ${this.diff.rescueIsLoan ? "loans" : "top-ups"}</span><b>${this.rescuesUsed}</b></div>` : ""}
        ${this.loanBalance > 0 ? `<div><span>Loan still owed</span><b>${fmtMoney(this.loanBalance)}</b></div>` : ""}
        <div><span>Safety</span><b>${this.safetyIncidents ? this.safetyIncidents + " incident" + (this.safetyIncidents > 1 ? "s" : "") : "clean"}</b></div>
        <div><span>Company legacy</span><b>+${earned} → ${co.legacy}</b></div>
      </div>
      <button class="pBtn primary" data-act="restart"><b>New campaign</b></button>`);
  }

  // ---- save / resume ---------------------------------------------------------
  private serialize() {
    return {
      v: SAVE_VERSION, scenario: this.scenario.id, difficulty: this.diff.id, savedAt: Math.floor(this.day),
      rescuesUsed: this.rescuesUsed, loanBalance: this.loanBalance, cheered: [...this.cheered],
      day: this.day, speedIdx: this.speedIdx, cash: this.cash, opexPerDay: this.opexPerDay,
      rp: this.rp, research: [...this.research], opexMult: this.opexMult,
      safetyIncidents: this.safetyIncidents, testWorkDone: this.testWorkDone, firedEvents: [...this.firedEvents],
      oreConfidence: this.oreConfidence, explored: this.explored, drillHoles: this.drillHoles, weather: this.weather, weatherUntil: this.weatherUntil,
      millGrind: this.millGrind, millRecovery: this.millRecovery, millReagent: this.millReagent, phase: this.phase, permitObtained: this.permitObtained,
      staff: this.staff,
      tempDeliveryMult: this.tempDeliveryMult, tempDeliveryUntil: this.tempDeliveryUntil,
      tempPourMult: this.tempPourMult, tempPourUntil: this.tempPourUntil,
      plantThroughput: this.plantThroughput,
      recipe: { solids: this.recipe.solids, binder: this.recipe.binderKgPerM3 },
      supply: {
        ore: this.supply.ore.level, oreReserve: this.supply.oreReserve.level, oreReserveCap: this.supply.oreReserve.cap,
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
    this.underground.cureFactor = (this.research.has("rapidset") ? 0.75 : 1) * this.diff.cure; // research perk survives a resume
    this.rescuesUsed = s.rescuesUsed ?? 0; this.loanBalance = s.loanBalance ?? 0; this.cheered = new Set(s.cheered || []);
    this.oreConfidence = s.oreConfidence ?? 0.5; this.explored = !!s.explored;
    this.drillHoles = s.drillHoles ?? 0; for (let i = 1; i <= this.drillHoles; i++) this.spawnDrillHole(i);
    this.millGrind = s.millGrind ?? 1; this.millRecovery = s.millRecovery ?? 1; this.millReagent = s.millReagent ?? 0;
    this.phase = s.phase ?? "operate"; this.permitObtained = s.permitObtained ?? true; this.hud.setPhase(this.phase === "operate" ? "▶ Operating" : this.phase === "setup" ? "◑ Set up" : "◐ Explore");
    this.weather = s.weather ?? "clear"; this.weatherUntil = s.weatherUntil ?? 0;
    if (s.staff) for (const k of Object.keys(this.staff)) if (s.staff[k]) this.staff[k] = s.staff[k];
    this.underground.weatherCureMult = this.weather === "heat" ? 0.85 : this.weather === "cold" ? 1.18 : 1;
    this.hud.setWeather(this.weatherLabel());
    this.tempDeliveryMult = s.tempDeliveryMult ?? 1; this.tempDeliveryUntil = s.tempDeliveryUntil ?? 0;
    this.tempPourMult = s.tempPourMult ?? 1; this.tempPourUntil = s.tempPourUntil ?? 0;
    this.plantThroughput = s.plantThroughput ?? this.plantThroughput;
    if (s.recipe) { this.recipe.solids = s.recipe.solids; this.recipe.binderKgPerM3 = s.recipe.binder; }
    this.supply.ore.level = s.supply.ore; this.supply.oreReserve.level = s.supply.oreReserve;
    if (s.supply.oreReserveCap) this.supply.oreReserve.cap = s.supply.oreReserveCap;
    this.supply.tailings.level = s.supply.tailings; this.supply.binder.level = s.supply.binder;
    this.supply.water.level = s.supply.water; this.supply.tsf.level = s.supply.tsf;
    this.paused = true; // resume paused so the player gets their bearings
    this.recomputePower(); this.refreshSupply(); this.updateEconomy(); this.refreshObjective();
    this.refreshClock(); this.refreshSchedule();
    this.hud.setStatus(`Campaign resumed — day ${Math.floor(this.day)}. Press ▶ when ready.`);
    const c = this.underground.counts();
    console.log(`RESUMED|diff=${this.diff.id} day=${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m buildings=${this.buildings.length} tiers=${this.buildings.map((b) => b.tier).join("")} cured=${c.cured} statuses=${this.underground.stopes.map((s) => s.status[0]).join("")} tsf=${Math.round(this.supply.tsf.level / 1000)}k rp=${Math.floor(this.rp)}`);
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
      if (d > BUILD_RADIUS - half) return false;
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
    this.env.clearAround(at.x, at.z, Math.max(spec.fw, spec.fd) * 0.75 + 3); // clear the land for the footprint
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
    b.buildDays = Math.max(1.2, Math.min(4.5, 0.8 + area / 70)); // bigger footprints take longer — long enough for the crew to gather and work
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
    if (b.spec.type === "plant" || b.spec.type === "mill") this.addSteam(b.pos.x, b.pos.y + b.spec.markerY, b.pos.z); // venting steam plume
  }
  private steamPSes: ParticleSystem[] = [];
  private addSteam(x: number, y: number, z: number) {
    const ps = new ParticleSystem("steam" + this.steamPSes.length, 120, this.scene);
    ps.particleTexture = this.getDot();
    ps.emitter = new Vector3(x, y, z);
    ps.minEmitBox = new Vector3(-1, 0, -1); ps.maxEmitBox = new Vector3(1, 0, 1);
    ps.direction1 = new Vector3(-0.4, 3, -0.4); ps.direction2 = new Vector3(0.5, 4.5, 0.5);
    ps.minSize = 1.6; ps.maxSize = 4.2; ps.minLifeTime = 1.6; ps.maxLifeTime = 3.4;
    ps.gravity = new Vector3(0.6, 2.2, 0); ps.emitRate = 16;
    ps.color1 = new Color4(0.92, 0.94, 0.97, 0.32); ps.color2 = new Color4(0.85, 0.88, 0.92, 0.0);
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.start(); this.steamPSes.push(ps);
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
        const plantUp = this.buildings.some((x) => x.spec.type === "plant" && x.built);
        const disc = !b.spec.supplies || this.connected(b) ? ""
          : !plantUp ? " It will hook up to the Backfill plant once the plant is finished."
          : !this.isPowered(b) ? " ⚠ It has no power. Build a 🔌 Substation near it (or move it closer to the power station)."
          : " ⚠ Too far from the plant, so no feed line reaches it. Build it closer to the plant.";
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

  // ---- weather & climate (Epic E) -------------------------------------------
  /** Roll a new weather spell when the current one ends; drives cure + economy. */
  private updateWeather() {
    if (this.day < this.weatherUntil) return;
    const c = this.scenario.climate;
    let w: Weather = c?.cold ? "cold" : "clear";
    if (c) {
      const roll = pseudoNoise(Math.floor(this.day) * 3.7 + 11);
      if (roll < c.storm) w = "storm";
      else if (roll < c.storm + c.rain) w = "rain";
      else if (roll < c.storm + c.rain + c.heat) w = "heat";
    }
    this.weather = w;
    this.weatherUntil = this.day + 1 + pseudoNoise(this.day * 1.3) * 2.5; // 1–3.5 day spells
    this.underground.weatherCureMult = w === "heat" ? 0.85 : w === "cold" ? 1.18 : 1;
    this.hud.setWeather(this.weatherLabel());
    if (this.mode === "surface") this.applyWeatherVisuals(); // live sky/light change
    if (w === "storm" && this.mode === "surface") this.sound.thunder();
  }
  private weatherLabel(): string {
    const m: Record<Weather, string> = { clear: "☀ Clear", rain: "🌧 Rain", storm: "⛈ Storm", heat: "🔥 Heat", cold: "❄ Cold" };
    return m[this.weather] + (this.scenario.climate ? ` · ${this.scenario.climate.label}` : "");
  }
  /** Rain wets stockpiles and storms halt work — a throughput drag on the mill. */
  private weatherMillMult() { return this.weather === "storm" ? 0.7 : this.weather === "rain" ? 0.9 : 1; }

  private anyPourActive() { return this.underground.stopes.some((s) => s.status === "pouring"); }
  private cafPourActive() { return this.underground.stopes.some((s) => s.status === "pouring" && !FILL_TYPES[s.fillType].reticulated); }

  /** Realised UCS factor for a stope's pour: base scatter, widened hugely if no
   *  test-work has been done, plus the scenario's mineralogy risk (sulphide late
   *  strength loss / clay variability). Test-work tightens scatter and halves the
   *  mineralogy penalty — the course's "verify the design basis, then trim binder". */
  private ucsRealised(s: StopeUG): number {
    let v = ucsVariance(s.depthM + s.dueDay);
    const minl = this.scenario.mineralogy;
    const sc = this.diff.scatter; // Easy/Normal soften the price of skipping test-work
    if (!this.testWorkDone) v = 1 + (v - 1) * (1 + 1.5 * sc) - (minl?.varianceAdd ?? 0) * sc; // untested → wide, risky scatter
    const latePen = (minl?.latePenalty ?? 0) * (this.testWorkDone ? 0.4 : 1) * sc;
    const crewPen = (1 - this.crewCompetency()) * 0.08; // green/thin crews mix and QC less consistently
    return Math.max(0.4, v * (1 - latePen - crewPen));
  }

  /** Mucking a newly-opened stope moves its ore from the reserve onto the ROM pad
   *  (a burst to mill) — net-neutral on total ore, capped by pad room. Extraction → ore → void. */
  /** Delineation reveals each stope's grade once the orebody is Indicated (drilled). */
  private refreshGradeKnowledge() {
    const known = this.explored && this.oreConfidence >= 0.7;
    for (const s of this.underground.stopes) s.gradeKnown = known;
    this.underground.refreshVisuals(this.day);
    if (known && this.phase === "explore") { // exploration done → move to the untimed Set-up phase
      this.phase = "setup"; this.hud.setPhase("◑ Set up");
      this.hud.setStatus("Orebody delineated. Set up your operation — it's untimed. Press ▶ to begin operations when ready.");
    }
    this.refreshObjective(); // exploration is objective step 1 — advance once delineated
  }
  /** Cost of the mining permit — dearer if a reactive orebody has no containment. */
  private permitCost() {
    const containment = this.buildings.some((b) => b.spec.type === "controlled"); // a pond under construction counts (it can only finish once operating)
    return Math.round((PERMIT_BASE + (this.scenario.mineralogy?.reactive && !containment ? PERMIT_ENV_SURCHARGE : 0)) * this.diff.permit);
  }
  /** Leave the untimed Set-up phase and start the operating clock (needs the permit). */
  private startOperations() {
    if (!this.permitObtained) {
      const fee = this.permitCost();
      if (this.cash < fee) { this.hud.setStatus(`Operations need a mining permit (${fmtMoney(fee)}) — not enough cash yet.`); return; }
      this.cash -= fee; this.permitObtained = true; this.updateEconomy();
      const surch = fee > PERMIT_BASE * this.diff.permit + 1 ? " (incl. an environmental surcharge: no PAG containment)" : "";
      this.hud.setStatus(`Mining permit granted (−${fmtMoney(fee)})${surch}.`);
    }
    this.phase = "operate"; this.paused = false; this.hud.setPhase("▶ Operating");
    this.refreshClock(); this.refreshObjective();
    this.hud.setStatus("Operations underway — the clock is now running. Fill stopes before their due dates.");
  }
  private grantExtractionOre(s: StopeUG): number {
    const want = s.volumeM3 * EXTRACT_ORE_PER_M3 * s.grade; // richer stopes yield more ore/revenue
    const take = Math.min(want, this.supply.oreReserve.level, this.supply.ore.cap - this.supply.ore.level);
    if (take > 0) { this.supply.oreReserve.level -= take; this.supply.ore.level += take; }
    return take;
  }
  /** Capex to develop access to a stope early (base + per day brought forward). */
  private developCost(s: StopeUG): number {
    const daysEarly = Math.max(0, Math.ceil(s.availableDay - this.day));
    return this.capex(DEV_BASE + DEV_PER_DAY * daysEarly);
  }
  /** How long an access drive takes — deeper levels take longer to reach. */
  private devDays(s: StopeUG): number { return 2 + s.levelIdx; }

  // ---- concentrator flowsheet (D3) ------------------------------------------
  private millRecoveryMult() { return [0.85, 1.0, 1.15][this.millRecovery]; }   // concentrate value per tonne
  /** Matching the reagent/flocculant suite to the ore's mineralogy lifts recovery; a mismatch drops it. */
  private millReagentMult() {
    const chosen = ["general", "sulphide", "gravity", "clay"][this.millReagent];
    if (chosen === "general") return 1.0;
    return chosen === this.scenario.mineralogy?.reagent ? 1.12 : 0.88;
  }
  private millThroughputMult() { return [1.12, 1.0, 0.9][this.millGrind]; }     // coarse grinds faster
  private millPasteFrac() { return Math.min(0.9, [0.45, 0.6, 0.75][this.millGrind] * this.diff.pasteFeed); }         // finer grind → more paste-suitable tailings
  private flowsheetOpexPerDay() { return this.millRecovery * 9_000 + this.millGrind * 6_000; }

  /** Barricade capacity (kPa it can hold) from its type + optional relief. */
  private barricadeCap(s: StopeUG): number {
    if (!s.barricadeType) return 0;
    return (BARRICADE[s.barricadeType].capKpa + (s.barricadeRelief ? BARRICADE.reliefBonusKpa : 0)) * this.diff.barricadeCap;
  }
  /** Up-front cost of the designed barricade (type + relief + exclusion + instrumentation). */
  private barricadeCost(s: StopeUG): number {
    if (!s.barricadeType) return 0;
    return this.capex(BARRICADE[s.barricadeType].cost + (s.barricadeRelief ? BARRICADE.reliefCost : 0)
      + (s.exclusionZone ? BARRICADE.exclusionCost : 0) + (s.barricadeInstr ? BARRICADE.instrCost : 0));
  }

  /** Cut a flat gravel bench into the sloping terrain under an off-pad structure. */
  private gradePlatform(at: Vector3, fw: number, fd: number) {
    gradeFlat(at.x, at.z, fw, fd, at.y); // the land itself is cut + filled flat under the footprint
  }

  /** Haul roads from every building to the mine portal, so the site reads as connected. */
  private drawRoads() {
    this.roadMeshes.forEach((m) => m.dispose()); this.roadMeshes = [];
    const roadMat = new StandardMaterial("roadMat", this.scene);
    roadMat.diffuseColor = Color3.FromHexString("#6f6558"); roadMat.specularColor = Color3.Black(); roadMat.backFaceCulling = false; roadMat.zOffset = -2;
    for (const b of this.buildings) {
      const dx = this.portal.x - b.pos.x, dz = this.portal.z - b.pos.z;
      const len = Math.hypot(dx, dz); if (len < 1) continue;
      // a ribbon that hugs the ground, sampled every ~2.5 m
      const nx = -dz / len, nz = dx / len, n = Math.max(2, Math.ceil(len / 2.5));
      const left: Vector3[] = [], right: Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, cx = b.pos.x + dx * t, cz = b.pos.z + dz * t;
        for (const [arr, s] of [[left, 1], [right, -1]] as [Vector3[], number][]) {
          const px = cx + nx * 2.2 * s, pz = cz + nz * 2.2 * s;
          arr.push(new Vector3(px, heightAt(px, pz) + 0.14, pz));
        }
      }
      const road = MeshBuilder.CreateRibbon("road", { pathArray: [left, right] }, this.scene);
      road.material = roadMat; road.parent = this.surfaceRoot; road.receiveShadows = true;
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
    // a plant still under construction counts: its site is fixed, and pipes designed before it
    // finished used to go invalid (and un-buildable) the moment it came online
    const plant = this.buildings.find((b) => b.spec.type === "plant");
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
    this.maybeRescue();
    this.hud.setEconomy(this.cash, this.powered, this.total);
    this.hud.setBinder(this.supply.binder.level, this.supply.binder.cap);
    this.hud.setResources({ reserve: this.supply.oreReserve, ore: this.supply.ore, tailings: this.supply.tailings, water: this.supply.water, tsf: this.supply.tsf, income: this.millDayIncome, reuse: this.lastWaterReused });
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
  private hasControlledSlurry() { return this.buildings.some((b) => b.spec.type === "controlled" && b.built); }
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
      millMult: this.tierMult("mill") * this.weatherMillMult() * this.millThroughputMult(), waterMult: this.tierMult("waterpump"), binderMult: this.tierMult("rail"),
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
    const T = this.scenario.wet ? 6 : 7; // wet mines get their water free from groundwater
    const step = (n: number, body: string) => `<span class="objStep">Setup ${n}/${T}</span>${body}`;
    // 1) Explore & delineate the orebody FIRST — know the ground before you commit capital.
    if (!this.explored || this.oreConfidence < 0.7) return step(1, "Explore first: open <b>🧭 Geology</b> — run a survey and drill to delineate the orebody (Indicated). Know where the ore is before you build.");
    if (!has("power")) return step(2, "Build a <b>⚡ Power station</b> — everything on site runs on power.");
    if (!has("plant")) return step(3, "Build the <b>🏭 Backfill plant</b> on the graded pad.");
    if (!has("mill")) return step(4, "Build a <b>⚙ Mill</b> out on the terrain — it refines ore into cash and makes the tailings you backfill with.");
    if (!has("tsf")) return step(5, "Build a <b>⛰ Tailings dam</b> — only ~half the tailings can go underground; the rest must go to the TSF or the mill chokes.");
    if (!(has("rail") || has("haulage") || has("isotainer"))) return step(6, "Build a <b>binder supply</b> — 🚆 Rail (high throughput, cheap, lead-time risk), 🚛 Road haulage (flexible, pricier), or 📦 Isotainer pad (remote, low capex). Binder is ~70% of your cost.");
    if (!this.scenario.wet && !has("waterpump")) return step(7, "Build a <b>💧 Water pump</b> — the paste mix needs water.");
    const unpowered = this.buildings.filter((b) => b.spec.needsPower && !this.isPowered(b));
    if (unpowered.length) return `<span class="objStep">Power reach</span>${unpowered.length} work(s) out of power range — build a <b>🔌 Substation</b> to relay power out to them.`;
    const disconnected = this.buildings.filter((b) => b.spec.supplies && this.isPowered(b) && !this.connected(b));
    if (disconnected.length) return `<span class="objStep">Connect</span>${disconnected.length} supply work(s) can't reach the plant (red line) — resite them within feed-line range.`;
    if (this.scenario.mineralogy?.reactive && !this.hasControlledSlurry()) return `<span class="objStep">Environment</span>This ore's reject is <b>reactive (PAG)</b> — build a <b>☣ Controlled slurry pond</b> to contain it, or face ongoing environmental fines.`;
    if (!this.permitObtained) return `<span class="objStep">Ready</span>Set up. Press <b>▶</b> to obtain the <b>mining permit</b> (${fmtMoney(this.permitCost())}${this.permitCost() > PERMIT_BASE * this.diff.permit + 1 ? ", incl. environmental surcharge: build a ☣ Controlled slurry pond to cut it" : ""}) and begin operations.`;
    return `<span class="objStep">Ready</span>Operating. <b>⛏ Go underground</b> to reticulate and pour; fill stopes before their due dates.`;
  }
  private refreshObjective() {
    if (this.tutorial && this.tutStep < this.tutSteps.length) { this.hud.setObjective(null); return; } // tutorial replaces the objective banner
    this.hud.setObjective(this.mode === "surface" ? this.nextObjective() : null);
  }

  private setupTutorial() {
    const has = (t: string) => this.buildings.some((b) => b.spec.type === t);
    const stopeAt = (...st: string[]) => this.underground.stopes.some((s) => st.includes(s.status));
    this.tutSteps = [
      { text: `Welcome to <b>Wheal Verity</b>. Before you spend a penny, know the ground. Open <b>🧭 Geology</b> (top bar), run a <b>Geophysical survey</b>, then <b>Drill</b> to delineate the orebody (Inferred → Indicated). You'll see the rigs go up and the ore grades reveal.`, done: () => this.explored && this.oreConfidence >= 0.7 },
      { text: `Delineated — now stand the site up. Power everything: place a <b>⚡ Power station</b> on the graded pad.`, done: () => has("power") },
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
      const cost = this.capex(tsfRaiseCost(b.raises));
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
      ${s.type === "plant" ? `<button class="pBtn primary" data-act="enterplant"><b>Step inside ▶</b></button>` : ""}
      ${s.type === "mill" ? `<button class="pBtn primary" data-act="flowsheet"><b>⚙ Configure flowsheet ▶</b></button>` : ""}`;
  }

  private showFlowsheet() {
    this.root.querySelector(".flowsheetCard")?.remove();
    const el = document.createElement("div");
    el.className = "whResult flowsheetCard";
    const grinds = ["Coarse (crush + rod)", "Standard (crush + ball)", "Fine (SAG + ball + regrind)"];
    const recovs = ["Gravity only", "Flotation", "Flotation + regrind"];
    const reagents = ["General-purpose", "Sulphide collector (xanthate)", "Gravity / oxide aid", "Clay depressant"];
    const idealName: Record<string, string> = { sulphide: "Sulphide collector", gravity: "Gravity / oxide aid", clay: "Clay depressant", polymetallic: "Polymetallic suite" };
    const ideal = this.scenario.mineralogy?.reagent;
    const idealHint = !this.testWorkDone
      ? "Run <b>test-work</b> (🧪 Lab) to identify the ideal reagent suite for this ore."
      : ideal ? `Test-work: this ore responds best to <b>${idealName[ideal]}</b> — match it for +12% recovery (a mismatch costs 12%).`
      : "This ore is not reagent-sensitive.";
    const opt = (kind: "grind" | "recov" | "reagent", i: number, label: string, sub: string, on: boolean) =>
      `<button class="fillBtn ${on ? "on" : ""}" data-act="${kind}:${i}" style="flex:1 1 100%;text-align:left">${label}<br><small>${sub}</small></button>`;
    el.innerHTML = `<div class="introCard">
      <div class="rsHead">⚙ Concentrator flowsheet</div>
      <div class="pNote">The mill is a design surface. Comminution sets how fine you grind: finer means more of the tailings suit paste, but slower throughput and more power. Concentration sets metal recovery, the concentrate revenue per tonne. Switching a route costs ${fmtMoney(this.capex(FLOWSHEET_SWITCH_COST))}.</div>
      <div class="pSplit"><span>Grind → paste-feed</span><b>${Math.round(this.millPasteFrac() * 100)}% · throughput ${Math.round(this.millThroughputMult() * 100)}%</b></div>
      <div class="fillPick" style="flex-wrap:wrap">${grinds.map((g, i) => opt("grind", i, g, `${[45, 60, 75][i]}% paste feed · ${[112, 100, 90][i]}% throughput`, this.millGrind === i)).join("")}</div>
      <div class="pSplit"><span>Recovery → income</span><b>${Math.round(this.millRecoveryMult() * 100)}%</b></div>
      <div class="fillPick" style="flex-wrap:wrap">${recovs.map((rc, i) => opt("recov", i, rc, `${[85, 100, 115][i]}% concentrate value · +${fmtMoney(i * 9000)}/day`, this.millRecovery === i)).join("")}</div>
      <div class="pSplit"><span>Reagent suite → match</span><b class="${this.millReagentMult() >= 1 ? "good" : "pLate"}">${Math.round(this.millReagentMult() * 100)}%</b></div>
      <div class="fillPick" style="flex-wrap:wrap">${reagents.map((rg, i) => opt("reagent", i, rg, i === 0 ? "safe, no bonus" : "match the ore +12% / mismatch −12%", this.millReagent === i)).join("")}</div>
      <div class="pNote">${idealHint}</div>
      <button class="pBtn primary" id="fsClose"><b>Close ▶</b></button>
    </div>`;
    this.root.appendChild(el);
    el.querySelector("#fsClose")!.addEventListener("click", () => el.remove());
    el.querySelectorAll<HTMLElement>("[data-act^='grind:'],[data-act^='recov:'],[data-act^='reagent:']").forEach((b) =>
      b.addEventListener("click", () => { this.setFlowsheet(b.dataset.act!); this.showFlowsheet(); }));
  }
  private setFlowsheet(act: string) {
    const [kind, vStr] = act.split(":"); const v = +vStr;
    const cur = kind === "grind" ? this.millGrind : kind === "recov" ? this.millRecovery : this.millReagent;
    if (v === cur) return;
    const fsCost = this.capex(FLOWSHEET_SWITCH_COST);
    if (this.cash < fsCost) { this.hud.setStatus(`Not enough cash to reconfigure the flowsheet (${fmtMoney(fsCost)}).`); return; }
    this.cash -= fsCost;
    if (kind === "grind") this.millGrind = v; else if (kind === "recov") this.millRecovery = v; else this.millReagent = v;
    this.updateEconomy(); this.saveGame();
    this.hud.setStatus(`Flowsheet reconfigured: ${kind === "grind" ? "grind" : kind === "recov" ? "recovery route" : "reagent suite"} changed (${fmtMoney(fsCost)}).`);
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
    const cost = this.capex(tsfRaiseCost(b.raises));
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
      const seqOk = st.isPrimary || this.underground.primaryCured(st.levelIdx);
      const daysEarly = Math.max(0, Math.ceil(st.availableDay - this.day));
      const developing = !!st.devUntil && this.day < st.devUntil;
      const devPct = developing ? Math.max(0, Math.min(100, (1 - (st.devUntil! - this.day) / this.devDays(st)) * 100)) : 0;
      const gradeLine = st.gradeKnown
        ? `<div class="pSplit"><span>Ore grade</span><b class="${st.grade >= 1 ? "good" : ""}">${st.grade.toFixed(2)}× (${st.grade >= 1.1 ? "rich" : st.grade <= 0.9 ? "lean" : "average"})</b></div>`
        : `<div class="pRow muted">Ore grade unknown — drill in 🧭 Geology to delineate it.</div>`;
      body = gradeLine + (!seqOk
        ? `<div class="pRow muted">Secondary stope — mining waits until the level's <b>primary</b> is filled and cured.</div>`
        : developing
          ? `<div class="pRow"><b class="cap">⛏ Access drive underway</b></div><div class="pBar"><div class="pBarFill" style="width:${devPct}%"></div></div><div class="pRow muted">void ready ~day ${Math.round(st.devUntil!)}</div>`
          : `<div class="pRow muted">Mining develops this stope around <b>day ${st.availableDay}</b>.</div>`
            + (daysEarly > 0 ? `<div class="pNote">Ahead of the plan? Pay to drive access and extract the void now — keep the plant fed.</div>
             <button class="pBtn primary" data-act="develop"><b>⛏ Develop access early</b><span>open the void ~${this.devDays(st)} d (vs day ${st.availableDay}) · ${fmtMoney(this.developCost(st))}</span></button>` : ""));
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
        ${this.diff.autoDesign ? `<button class="pBtn" data-act="autodesign"><b>✨ Auto-design the pipes</b><span>pick safe pipe for every leg for me</span></button>` : ""}
        <button class="pBtn primary" data-act="build" ${canBuild ? "" : "disabled"}><b>Build reticulation</b><span>${canBuild ? fmtMoney(planned) : aggBlock ? "PAF needs a Crusher plant on the surface" : this.diff.autoDesign ? "set a pipe on every leg (tap a leg's class, or ✨ Auto-design)" : "set a valid class on every leg"}</span></button>`;
    } else if (st.status === "piped") {
      const rev = fillRevenue(st.volumeM3);
      const chk = (key: string, on: boolean, label: string) => `<button class="chkBtn ${on ? "on" : ""}" data-act="sign:${key}">${on ? "☑" : "☐"} ${label}</button>`;
      const bt = st.barricadeType;
      const cap = this.barricadeCap(st);
      const barCost = this.barricadeCost(st);
      const barBtn = (key: "mullock" | "shotcrete") => { const spec = BARRICADE[key]; return `<button class="fillBtn ${bt === key ? "on" : ""}" data-act="bar:${key}" title="${spec.note.replace(/"/g, "&quot;")}">${spec.short}<br><small>${Math.round(spec.capKpa * this.diff.barricadeCap)} kPa</small></button>`; };
      const tog = (key: string, on: boolean, label: string) => `<button class="chkBtn ${on ? "on" : ""}" data-act="bartog:${key}">${on ? "☑" : "☐"} ${label}</button>`;
      const plantReady = !ft.reticulated || this.plantThroughput > 0;
      const ready = !!bt && !!st.signPourNote && plantReady;
      body = `
        <div class="pRow">${ft.reticulated ? "Reticulated · <b>" + (st.cls?.name ?? "") + "</b>" + (st.choke ? " + choke" : "") : "Trucked (CAF) · ready to place"}</div>
        ${ft.reticulated && !plantReady ? `<div class="pWarn">⚠ The plant isn't making paste. Enter the 🏭 Backfill plant and connect tailings + water + binder → mixer → pump before you can pour.</div>` : ""}
        ${ft.reticulated ? this.hglChart(idx) : ""}
        <div class="pNote">Design the barricade — it holds the fluid paste until the plug cures. Rate of rise loads it during the pour; overpressure = <b>inrush</b>.</div>
        <div class="fillPick">${barBtn("mullock")}${barBtn("shotcrete")}</div>
        ${bt ? `<div class="pSplit"><span>Capacity</span><b>${Math.round(cap)} kPa</b></div>` : `<div class="pNote pWarnNote">⚠ Pick a barricade type before pouring.</div>`}
        <div class="chkList">
          ${tog("relief", !!st.barricadeRelief, `Pressure relief / breather (+${fmtMoney(this.capex(BARRICADE.reliefCost))} · +${Math.round(BARRICADE.reliefBonusKpa * this.diff.barricadeCap)} kPa)`)}
          ${tog("excl", !!st.exclusionZone, `Exclusion zone (+${fmtMoney(this.capex(BARRICADE.exclusionCost))} · contains a failure)`)}
          ${tog("instr", !!st.barricadeInstr, `Barricade instrumentation (+${fmtMoney(this.capex(BARRICADE.instrCost))} · live gauge)`)}
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

  private onPanelAction(act: string) { this.sound.select(); this.applyPanelAction(act); this.saveGame(); this.checkTutorial(); }
  private applyPanelAction(act: string) {
    if (act === "restart") { location.reload(); return; }
    if (act === "tutskip" || act === "tutdone") { this.endTutorial(); return; }
    if (act.startsWith("ev:")) { this.resolveEvent(+act.slice(3)); return; }
    if (act === "enterplant") { this.deselectBuilding(); this.enterPlant(); return; }
    if (act === "closebuilding") { this.deselectBuilding(); return; }
    if (act === "raisedam") { this.raiseDam(); return; }
    if (act === "flowsheet") { this.showFlowsheet(); return; }
    if (act === "testwork") {
      if (this.testWorkDone) return;
      const twCost = this.exploreCost(TESTWORK_COST);
      if (this.cash < twCost) { this.hud.setStatus(`Not enough cash for a test-work campaign (${fmtMoney(twCost)}).`); return; }
      this.cash -= twCost; this.testWorkDone = true; this.day += TESTWORK_DAYS;
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
      const remCost = this.capex(2_000_000);
      if (this.cash < remCost) { this.hud.setStatus(`Not enough cash to remediate ${st.id} (${fmtMoney(remCost)}).`); return; }
      this.cash -= remCost; this.underground.remediate(st); this.updateEconomy(); this.renderStopePanel();
      this.hud.setStatus(`${st.id} remediation ordered (${fmtMoney(remCost)}). Re-pour it with a stronger mix (more binder in the 🧪 Lab).`);
      return;
    }
    if (act === "develop") {
      if (st.status !== "locked") return;
      if (st.devUntil && this.day < st.devUntil) return; // drive already underway
      if (!(st.isPrimary || this.underground.primaryCured(st.levelIdx))) { this.hud.setStatus("Secondary — the level's primary must be filled and cured first."); return; }
      const cost = this.developCost(st);
      if (this.cash < cost) { this.hud.setStatus(`Not enough cash to develop ${st.id} (${fmtMoney(cost)}).`); return; }
      this.cash -= cost; st.devUntil = Math.floor(this.day) + this.devDays(st); // an access drive that takes days
      this.updateEconomy(); this.renderStopePanel(); this.saveGame();
      this.hud.setStatus(`${st.id} development started — access drive underway, void ready ~day ${Math.round(st.devUntil)} (${fmtMoney(cost)}).`);
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
    if (act === "autodesign") {
      if (st.status !== "available") return;
      const ok = this.autoDesignPath(this.underground.stopes.indexOf(st)); this.renderStopePanel();
      this.hud.setStatus(ok ? `✨ Pipes designed for ${st.id}. Every leg is safe (✓). Press Build reticulation.` : `${st.id} is too deep for these pipes even with chokes. Try a dedicated drilled borehole.`);
      return;
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
    this.testWorkDone = true; this.phase = "operate"; this.permitObtained = true;
    const L = (s: string) => console.log("TUT|" + s + ` step=${this.tutStep + 1}/${this.tutSteps.length}`);
    L("start");
    this.runSurvey(); this.drillCampaign(); this.drillCampaign(); this.checkTutorial(); L("delineated"); // exploration-first step
    for (const [t, x, z] of [["power", 0, 0], ["plant", 24, 0], ["mill", 72, 36], ["tsf", 66, -46], ["rail", -44, 36], ["waterpump", 30, 60]] as [string, number, number][]) { this.debugBuild(t, x, z); L(`built ${t}`); }
    this.debugBuildPlantLine(); this.checkTutorial(); L("plant line built");
    this.debugAdvance(2); this.checkTutorial(); L("pressed play");
    this.descend(); L("descended");
    this.smartReticulate(0); this.checkTutorial(); L("reticulated S1");
    const s0 = this.underground.stopes[0]; s0.signBarricade = s0.signPourNote = true; s0.barricadeType = "shotcrete"; s0.barricadeRelief = true; this.underground.startPour(s0); this.checkTutorial(); L("poured S1");
  }
  /** Build a partial campaign and leave it autosaved (for save/resume testing). */
  debugSeed() {
    this.testWorkDone = true; this.phase = "operate"; this.permitObtained = true;
    for (const [t, x, z] of [["power", 0, 0], ["plant", 24, 0], ["mill", 72, 36], ["tsf", 66, -46], ["rail", -44, 36], ["waterpump", 30, 60]] as [string, number, number][]) this.debugBuild(t, x, z);
    this.debugBuildPlantLine(); this.debugUpgrade("mill"); this.descend();
    for (let k = 0; k < 8 && !this.ended; k++) {
      this.underground.stopes.forEach((s, i) => { if (s.status === "available") { try { this.smartReticulate(i); } catch { /* not yet */ } } });
      if (!this.underground.stopes.some((s) => s.status === "pouring")) { const n = this.underground.stopes.find((s) => s.status === "piped"); if (n) { n.signBarricade = n.signPourNote = n.signLowStart = true; n.barricadeType = "shotcrete"; n.barricadeRelief = true; this.underground.startPour(n); } }
      this.debugAdvance(2);
    }
    this.saveGame();
    const c = this.underground.counts();
    console.log(`SEEDED|diff=${this.diff.id} day=${Math.floor(this.day)} cash=${(this.cash / 1e6).toFixed(1)}m buildings=${this.buildings.length} tiers=${this.buildings.map((b) => b.tier).join("")} cured=${c.cured} statuses=${this.underground.stopes.map((s) => s.status[0]).join("")} tsf=${Math.round(this.supply.tsf.level / 1000)}k rp=${Math.floor(this.rp)}`);
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
    this.testWorkDone = true; this.phase = "operate"; this.permitObtained = true;
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
    this.testWorkDone = true; this.phase = "operate"; this.permitObtained = true;
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

  /** Headless HONEST self-play: pays for everything a real player pays for (exploration,
   *  every building, the plant process line, the permit, pipes and barricades), and the
   *  clock runs through construction. "smart" plays well; "naive" is a new player who
   *  builds in a sensible order but skips test-work, keeps the default mix, uses cheap
   *  barricades, pours everything at once, answers events with the cheap/risky option and
   *  only raises the dam when it is full (learning from a burst/inrush on the re-pour).
   *  #playsmart / #playnaive trigger it (append easy|normal|hard and a mine digit 1-4). */
  debugPlayRun(style: "smart" | "naive") {
    const smart = style === "smart";
    const m = (n: number) => (n / 1e6).toFixed(1) + "m";
    const L = (s: string) => console.log(`PLAYRUN|${style}|${this.diff.id}|${this.scenario.id}|` + s);
    let minCash = this.cash;
    const track = () => { minCash = Math.min(minCash, this.cash); };
    const answer = () => { for (let k = 0; k < 5 && this.activeEvent; k++) { const n = this.activeEvent.options.length; this.resolveEvent(smart ? 0 : Math.min(1, n - 1)); track(); } };
    const repoured = new Set<string>();
    let msgs = 0; const hudStatus = this.hud.setStatus.bind(this.hud);
    this.hud.setStatus = (t: string) => { if (/⚠|🦺|🎉|💰|☣/.test(t) && !/pour slowed/.test(t) && msgs++ < 30) L(`MSG d${Math.floor(this.day)} ${t}`); hudStatus(t); };
    try {
      this.runSurvey(); answer(); track();
      for (let g = 0; g < 8 && this.oreConfidence < 0.7; g++) { this.drillCampaign(); answer(); track(); }
      const plan: [string, number, number][] = [["power", 0, 0], ["plant", 24, 0], ["mill", 72, 36], ["tsf", 66, -46], ["rail", -44, 36]];
      if (!this.scenario.wet) plan.push(["waterpump", 30, 60]);
      if (this.scenario.mineralogy?.reactive) plan.push(["controlled", -40, -62]); // the objective banner asks for it
      for (const [t, x, z] of plan) {
        const spec = specOf(t); answer();
        if (this.cash < spec.cost) { L(`SKIP ${t} (cost ${m(spec.cost)}, cash ${m(this.cash)})`); continue; }
        this.place(spec, new Vector3(x, heightAt(x, z), z)); this.disarm(); track(); answer();
      }
      const lineCost = ["thickener_hr", "cyclone", "filter_vac", "mixer_twin", "pump_cent"].reduce((a, t) => a + PLANT_EQUIP[t].cost * 100, 0);
      answer();
      if (this.cash >= lineCost) { this.cash -= lineCost; this.debugBuildPlantLine(); this.updateEconomy(); track(); answer(); }
      else L(`SKIP plant line (cost ${m(lineCost)}, cash ${m(this.cash)})`);
      if (smart) { this.applyPanelAction("testwork"); this.debugSetRecipe(0.73, 320); track(); answer(); }
      L(`setup done day=${Math.floor(this.day)} cash=${m(this.cash)} rescues=${this.rescuesUsed}`);
      this.startOperations(); track(); answer();
      if (this.phase !== "operate") { L(`STUCK cannot start operations (permit ${m(this.permitCost())}, cash ${m(this.cash)}) GRADE=none`); L("DONE"); return; }
      this.descend();
      const net = this.underground.net;
      let guard = 0;
      while (!this.ended && guard++ < 700) {
        answer();
        this.underground.stopes.forEach((s, i) => {
          if (s.status !== "available") return;
          const legs = net.pathFor(i).filter((g) => !g.built);
          if (smart) {
            for (const g of legs) if (g.kind === "borehole" && s.levelIdx >= 1) g.choke = true;
            let need = 0;
            for (const g of legs) { let c = 3; for (let k = 0; k < 4; k++) { g.classId = k; if (net.valid(g)) { c = k; break; } } need = Math.max(need, c); }
            for (const g of legs) g.classId = Math.min(3, need + 1);
          } else {
            for (const g of legs) { g.classId = 0; while (g.classId < 3 && !net.valid(g)) g.classId++; }
            if (!net.pathCanBuild(i) && this.diff.autoDesign) this.autoDesignPath(i); // stuck: press the ✨ button
          }
          if (!net.pathCanBuild(i) || this.cash < net.pathPlannedCost(i)) return;
          const res = this.underground.commitReticulation(i);
          if (res) { this.cash -= res.cost; track(); }
        });
        const pour = (s: StopeUG) => {
          if (FILL_TYPES[s.fillType].reticulated && this.plantThroughput <= 0) return;
          const careful = smart || repoured.has(s.id); // naive players learn after the first failure
          s.barricadeType = careful ? "shotcrete" : "mullock"; s.barricadeRelief = careful;
          s.signBarricade = true; s.signPourNote = true; s.signLowStart = careful;
          const bc = this.barricadeCost(s); if (this.cash < bc) return;
          this.cash -= bc; track(); repoured.add(s.id);
          this.underground.startPour(s); if (!s.signLowStart) s.plugDrift = 0.25;
        };
        if (smart) {
          if (!this.underground.stopes.some((s) => s.status === "pouring")) { const next = this.underground.stopes.find((s) => s.status === "piped"); if (next) pour(next); }
        } else this.underground.stopes.filter((s) => s.status === "piped").forEach(pour);
        const tsfFull = this.supply.tsf.cap > 0 && this.supply.tsf.level > this.supply.tsf.cap * (smart ? 0.88 : 0.98);
        if (tsfFull) { const tsf = this.buildings.find((b) => b.spec.tsfCap && b.raises < TSF_MAX_RAISES); if (tsf) { this.raiseDamOn(tsf, false); track(); } }
        this.debugAdvance(1); track(); answer();
        if (guard % 4 === 0) L(`day ${Math.floor(this.day)} st=${this.underground.stopes.map((s) => s.status[0] + (s.status === "pouring" ? Math.round(s.placedM3 / s.volumeM3 * 100) : "")).join("")} thr=${Math.round(this.plantThroughput)} bind=${Math.round(this.supply.binder.level)} tail=${Math.round(this.supply.tailings.level)} cash=${m(this.cash)} cured=${this.underground.counts().cured} safety=${this.safetyIncidents} rescues=${this.rescuesUsed} loan=${m(this.loanBalance)}`);
      }
      const passed = this.underground.stopes.filter((s) => s.status === "cured" && s.ucsPass).length;
      L(`END day=${Math.floor(this.day)} cash=${m(this.cash)} minCash=${m(minCash)} cured=${this.underground.counts().cured}/6 passed=${passed} safety=${this.safetyIncidents} rescues=${this.rescuesUsed} loan=${m(this.loanBalance)} GRADE=${this.lastGrade}`);
      L("DONE");
    } catch (e) { L("ERROR " + ((e as Error)?.stack ?? e)); }
  }
}

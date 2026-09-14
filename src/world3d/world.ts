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
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import "@babylonjs/core/Culling/ray";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { createTerrain, heightAt, PAD_RADIUS } from "./terrain.js";
import { ghostify } from "./buildings.js";
import { CATALOG, specOf, type BuildingSpec } from "./catalog.js";
import { WorkerCrew } from "./workers.js";
import { TruckFleet } from "./trucks.js";
import { Underground, type StopeUG, FILL_TYPES } from "./underground.js";
import { PlantInterior } from "./plantInterior.js";
import {
  DEFAULT_RECIPE, type Recipe, frictionScale, ucs28Kpa, recipeCostPerM3,
  yieldStressPa, frictionKpaPerM, pumpability, ucsVariance,
} from "./labModel.js";
import {
  fmtMoney, fillCost, fillRevenue, CHOKE_CAPEX, staticHeadMpa, PASTE_COST_PER_M3,
  pourPressureMpa, BURST_PENALTY,
  SECONDS_PER_DAY, POUR_RATE_M3_PER_DAY, HORIZON_DAY, LATE_COST_PER_DAY, BASE_OPEX_PER_DAY, CURE_DAYS,
  BINDER_TOPUP_TONNES, BINDER_TOPUP_COST,
} from "./backfillModel.js";
import { Hud } from "./hud.js";
import { SupplyChain } from "./supplyChain.js";

const SKY = "#8ec5e6";
const START_CASH = 150_000_000;
const SPEEDS = [1, 2, 4, 8];

interface Placed { spec: BuildingSpec; root: TransformNode; pos: Vector3; marker: Mesh | null; }
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
  private supply = new SupplyChain();
  private millDayIncome = 0;
  private lastDayShown = 0;
  private roadMeshes: Mesh[] = [];
  private powerLineMeshes: Mesh[] = [];
  private supplyLinkMeshes: Mesh[] = [];
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

  constructor(private root: HTMLElement) {}

  start() {
    this.root.classList.add("world-mode");
    this.canvas = document.createElement("canvas");
    this.canvas.id = "renderCanvas";
    this.root.appendChild(this.canvas);

    this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: false });
    this.scene = new Scene(this.engine);
    this.setSky(false);

    this.setupCamera();
    this.setupLights();

    this.surfaceRoot = new TransformNode("surface", this.scene);
    this.ground = createTerrain(this.scene); this.ground.parent = this.surfaceRoot;
    this.portal = this.createPortal();
    this.crew = new WorkerCrew(
      this.scene, 5, PAD_RADIUS - 6, (m) => this.shadow.addShadowCaster(m), this.surfaceRoot,
      () => [
        ...this.buildings.map((b) => ({ x: b.pos.x, z: b.pos.z, r: Math.max(b.spec.fw, b.spec.fd) / 2 + 1 })),
        { x: this.portal.x, z: this.portal.z, r: 6 },
      ],
    );
    this.fleet = new TruckFleet(this.scene, (m) => this.shadow.addShadowCaster(m), this.surfaceRoot);
    this.underground = new Underground(this.scene, this.shadow);
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
    });
    this.updateEconomy();
    this.underground.updateSchedule(this.day);
    this.refreshClock();
    this.refreshSchedule();
    this.maybeShowIntro();

    this.scene.onPointerObservable.add((pi) => this.onPointer(pi));
    this.engine.runRenderLoop(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      this.advanceTime(dt);
      if (this.mode === "surface") { this.crew.update(dt); this.fleet.update(dt); }
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
    (window as any).__world = this;
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
    const cam = new ArcRotateCamera("cam", -Math.PI * 0.72, 0.86, 96, new Vector3(0, 4, 0), this.scene);
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
    const frame = MeshBuilder.CreateBox("adit", { width: 11, height: 8, depth: 3 }, this.scene);
    frame.material = mk("#5a5148"); frame.position.set(x, y + 3.5, z); frame.parent = this.surfaceRoot; this.shadow.addShadowCaster(frame);
    const mouth = MeshBuilder.CreateBox("aditMouth", { width: 6.5, height: 5.5, depth: 1.2 }, this.scene);
    mouth.material = mk("#14181d"); mouth.position.set(x, y + 3, z + 1.3); mouth.parent = this.surfaceRoot;
    const apron = MeshBuilder.CreateGround("aditApron", { width: 12, height: 14 }, this.scene);
    apron.material = mk("#6b6256"); apron.position.set(x + 5, y + 0.1, z); apron.parent = this.surfaceRoot;
    return new Vector3(x + 7, y, z);
  }

  // ---- mode toggle ----------------------------------------------------------

  private toggleMode() {
    this.mode === "surface" ? this.descend() : this.ascend();
  }

  private descend() {
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
  }

  private ascend() {
    this.mode = "surface";
    this.underground.select(null); this.underground.net.highlightPath(null); this.selectedStope = null;
    this.underground.root.setEnabled(false);
    this.surfaceRoot.setEnabled(true);
    this.setSky(false);
    this.camera.setTarget(new Vector3(0, 4, 0)); this.camera.radius = 96; this.camera.beta = 0.86; this.camera.alpha = -Math.PI * 0.72;
    this.hud.setMode("surface");
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
    this.surfaceRoot.setEnabled(true);
    this.setSky(false);
    this.camera.setTarget(new Vector3(0, 4, 0)); this.camera.radius = 96; this.camera.beta = 0.86; this.camera.alpha = -Math.PI * 0.72;
    this.hud.setHidden(false);
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
        s.pressureMpa = pourPressureMpa(s.depthM, s.lengthM, s.choke, f, s.plugDrift, s.cls.ratingMpa, noise, frictionScale(this.recipeFor(s).solids));
        if (s.pressureMpa > s.cls.ratingMpa) {
          this.underground.burst(s); this.safetyIncidents++; this.cash -= BURST_PENALTY;
          this.hud.setStatus(`⚠ ${s.id} LINE BURST at ${s.cls.ratingMpa} MPa — pour aborted, line isolated. Re-pour needed (−${fmtMoney(BURST_PENALTY)}).`);
          continue;
        }
      } else {
        s.pressureMpa = 0; s.plugDrift = 0; // trucked (CAF) — no pipeline pressure
      }

      // plug (seal the barricade) and cap (working surface) pours are slower/careful
      const frac = s.placedM3 / s.volumeM3;
      const subRate = frac < 0.08 ? 0.5 : frac > 0.92 ? 0.7 : 1;
      const want = Math.min(this.pourRatePerDay() * f * fill.rateMult * subRate * dd, s.volumeM3 - s.placedM3);
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
      if (s.placedM3 >= s.volumeM3) {
        this.underground.completePour(s, this.day);
        this.cash += fillRevenue(s.volumeM3);
        this.hud.setStatus(`${s.id} ${fill.label} complete — ${fmtMoney(fillRevenue(s.volumeM3))} ore access unlocked. Curing now.`);
        if (s.barricadeRisk && Math.abs(Math.sin(s.depthM * 12.9 + s.volumeM3)) > 0.5) {
          this.safetyIncidents++; this.cash -= 900_000;
          this.hud.setStatus(`⚠ ${s.id} barricade seepage on fill — spill contained, but geotech was right (−${fmtMoney(900_000)}).`);
        }
      }
    }

    // surface materials economy: hoist ore, mill it (concentrate income + tailings), route to TSF, deliver binder, pump water
    const deliveryMult = this.day < this.tempDeliveryUntil ? this.tempDeliveryMult : 1;
    const sup = this.supply.tick(dd, this.supplyState(), deliveryMult);
    this.cash += sup.revenue - sup.binderCost;
    this.millDayIncome = dd > 0 ? sup.revenue / dd : 0; // $/day for the HUD readout
    if (sup.notes.length && Math.floor(this.day) !== this.lastDayShown) this.hud.setStatus(sup.notes[0]);
    const ev = this.underground.updateSchedule(this.day);
    this.cash -= (BASE_OPEX_PER_DAY + this.opexPerDay) * dd;             // daily running cost
    this.cash -= LATE_COST_PER_DAY * ev.overdue.length * dd;             // overdue stopes stall mining
    for (const s of ev.newlyAvailable) this.hud.setStatus(`${s.id} mucked out at −${s.depthM} m — ready to reticulate (due day ${s.dueDay}).`);
    // 7-day early cylinder — the course's mid-cure warning that a recipe is short
    for (const s of this.underground.stopes) {
      if (s.status === "curing" && !s.ucs7Reported && this.day - s.cureStartDay >= this.underground.cureDaysFor(s) * 0.5) {
        s.ucs7Reported = true;
        const ucs7 = ucs28Kpa(this.recipeFor(s)) * ucsVariance(s.depthM + s.dueDay) * FILL_TYPES[s.fillType].ucsMult * 0.6;
        s.ucs7Kpa = Math.round(ucs7);
        this.hud.setStatus(`${s.id} 7-day cylinder ${s.ucs7Kpa} kPa — ${ucs7 >= s.targetUcsKpa * 0.6 ? "on track" : "LOW, 28-day may fail"}.`);
      }
    }
    for (const s of ev.newlyCured) {
      const achieved = ucs28Kpa(this.recipeFor(s)) * ucsVariance(s.depthM + s.dueDay) * FILL_TYPES[s.fillType].ucsMult;
      s.ucsAchievedKpa = Math.round(achieved);
      s.ucsPass = achieved >= s.targetUcsKpa;
      this.hud.setStatus(`${s.id} 28-day cylinder ${s.ucsAchievedKpa}/${s.targetUcsKpa} kPa — ${s.ucsPass ? "PASS ✓" : "FAIL ✗ (geotech won't sign the hand-back)"}.`);
    }
    this.updateEconomy();

    // throttled HUD refresh
    if (Math.floor(this.day) !== this.lastDayShown) { this.lastDayShown = Math.floor(this.day); this.refreshClock(); this.refreshSchedule(); if (this.mode === "underground") this.renderStopePanel(); }
    else if (this.mode === "underground" && this.selectedStope?.status === "pouring") this.renderStopePanel();

    this.maybeFireEvent();
    if (this.day >= HORIZON_DAY || this.underground.counts().cured === this.underground.stopes.length) this.endCampaign();
  }

  private pourMult() { return this.day < this.tempPourUntil ? this.tempPourMult : 1; }

  private maybeFireEvent() {
    if (this.activeEvent) return;
    const pouring = this.underground.stopes.find((s) => s.status === "pouring");
    const avail = this.underground.stopes.find((s) => s.status === "available");
    if (this.day >= 20 && pouring && !this.firedEvents.has("seismic")) this.fireEvent(this.evSeismic(pouring));
    else if (this.day >= 16 && avail && !this.firedEvents.has("geotech")) this.fireEvent(this.evGeotech(avail));
    else if (this.day >= 12 && !this.firedEvents.has("binder-delay")) this.fireEvent(this.evBinderDelay());
    else if (this.day >= 24 && !this.firedEvents.has("mill-trip")) this.fireEvent(this.evMillTrip());
  }
  private fireEvent(ev: GameEvent) {
    this.activeEvent = ev; this.firedEvents.add(ev.id); this.paused = true; this.refreshClock();
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
    return `<div class="pSplit"><span>Mix ${(r.solids * 100).toFixed(0)}% · ${r.binderKgPerM3} kg/m³</span><b class="${ok ? "good" : "pLate"}">${ucs.toFixed(0)}/${st.targetUcsKpa} kPa</b></div>
      <div class="pNote">Tune this stope's mix in the 🧪 Lab.</div>`;
  }

  private labReadout(): string {
    const st = this.selectedStope;
    const r = st?.recipe ?? this.recipe;
    const ucs = ucs28Kpa(r);
    const pump = pumpability(r.solids);
    const target = st ? st.targetUcsKpa : Math.max(...this.underground.stopes.map((s) => s.targetUcsKpa));
    const strengthOk = ucs >= target;
    const forWho = st ? `for ${st.id}` : "default mix";
    return `<div class="labFor">Tuning: <b>${forWho}</b></div>` + `
      <div class="labRow"><span>${yieldStressPa(r.solids).toFixed(0)} Pa</span><small>yield stress</small></div>
      <div class="labRow"><span>${frictionKpaPerM(r.solids).toFixed(1)} kPa/m</span><small>friction gradient</small></div>
      <div class="labRow"><span class="${strengthOk ? "good" : "bad"}">${ucs.toFixed(0)} kPa</span><small>predicted 28-day UCS (need ${target})</small></div>
      <div class="labRow"><span>$${recipeCostPerM3(r).toFixed(1)}/m³</span><small>paste cost</small></div>
      <div class="labLight ${pump.level}">Pumpability: ${pump.label}</div>`;
  }

  private refreshClock() { this.hud.setClock(this.day, this.paused, this.speedIdx, SPEEDS); }
  private refreshSchedule() { this.hud.setSchedule(this.underground.counts(), this.day, HORIZON_DAY); }

  private endCampaign() {
    if (this.ended) return;
    this.ended = true; this.paused = true;
    const stopes = this.underground.stopes;
    const total = stopes.length;
    const cured = stopes.filter((s) => s.status === "cured").length;
    const passed = stopes.filter((s) => s.status === "cured" && s.ucsPass).length; // cured AND hit strength
    const onTime = stopes.filter((s) => s.status === "cured" && s.cureStartDay <= s.dueDay).length;
    let score = 0;
    score += passed === total ? 3 : passed >= total - 1 ? 2 : passed >= total / 2 ? 1 : 0;
    score += onTime >= total ? 2 : onTime >= total * 0.6 ? 1 : 0;
    score += this.cash > 0 ? 2 : 0;
    score += this.cash > START_CASH * 0.3 ? 1 : 0;
    let grade = score >= 7 ? "S" : score >= 6 ? "A" : score >= 4 ? "B" : score >= 2 ? "C" : "D";
    if (this.safetyIncidents > 0 && (grade === "S" || grade === "A")) grade = "B"; // a burst caps the review
    this.hud.showResult(`
      <div class="rsHead">Board review · Day ${Math.floor(this.day)}</div>
      <div class="rsGrade grade-${grade}">${grade}</div>
      <div class="rsRows">
        <div><span>Cylinders passed</span><b>${passed}/${total}</b></div>
        <div><span>On time</span><b>${onTime}/${total}</b></div>
        <div><span>Cash</span><b>${fmtMoney(this.cash)}</b></div>
        <div><span>Safety</span><b>${this.safetyIncidents ? this.safetyIncidents + " burst" : "clean"}</b></div>
      </div>
      <button class="pBtn primary" data-act="restart"><b>Run again</b></button>`);
  }

  // ---- pointer --------------------------------------------------------------

  private onPointer(pi: { type: number; event: { button?: number } }) {
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
    this.hud.setStatus(`Placing ${spec.label} — click the graded pad. Right-click to cancel.`);
  }

  private disarm() {
    this.armed = null;
    this.ghost?.dispose(); this.ghost = null; this.ghostPos = null; this.setGhostValid = null;
    this.camera.attachControl(this.canvas, true);
    this.hud.setArmed(null);
  }

  private canPlace(spec: BuildingSpec, x: number, z: number): boolean {
    if (Math.hypot(x, z) > PAD_RADIUS - Math.max(spec.fw, spec.fd) * 0.35) return false;
    for (const b of this.buildings) {
      const gap = 3;
      if (Math.abs(x - b.pos.x) < (spec.fw + b.spec.fw) / 2 + gap &&
          Math.abs(z - b.pos.z) < (spec.fd + b.spec.fd) / 2 + gap) return false;
    }
    return true;
  }

  private place(spec: BuildingSpec, at: Vector3) {
    const bi = this.buildings.length;
    const root = spec.make(this.scene, (m) => { this.shadow.addShadowCaster(m); m.metadata = { buildingType: spec.type, bi }; });
    root.parent = this.surfaceRoot; root.position.copyFrom(at);
    this.cash -= spec.cost;
    this.opexPerDay += spec.opexPerDay;
    this.buildings.push({ spec, root, pos: at, marker: null });
    if (spec.spawnsWorkers) this.crew.add(spec.spawnsWorkers);
    if (spec.spawnsTrucks) { this.fleet.clear(); this.fleet.add(spec.spawnsTrucks, at, this.portal); }
    this.drawRoads();
    this.recomputePower();
    this.refreshSupply();
    this.hud.setStatus(`${spec.label} built.` + (spec.type === "power" ? " It powers everything nearby." : ""));
    if (this.cash >= spec.cost) this.arm(spec); else this.disarm();
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

  private recomputePower() {
    const sources = this.buildings.filter((b) => b.spec.powerRadius);
    this.powered = 0;
    for (const b of this.buildings) {
      const ok = !b.spec.needsPower || sources.some((s) => Vector3.Distance(s.pos, b.pos) <= (s.spec.powerRadius ?? 0));
      this.updateMarker(b, !ok && b.spec.needsPower);
      if (ok) this.powered++;
    }
    this.total = this.buildings.length;
    this.drawPowerLines(sources);
    this.updateEconomy();
  }

  /** Draw sagging cables from the nearest in-range power source to each powered building. */
  private drawPowerLines(sources: Placed[]) {
    this.powerLineMeshes.forEach((m) => m.dispose()); this.powerLineMeshes = [];
    if (!sources.length) return;
    for (const b of this.buildings) {
      if (!b.spec.needsPower) continue;
      let best: Placed | null = null, bd = Infinity;
      for (const s of sources) { const d = Vector3.Distance(s.pos, b.pos); if (d <= (s.spec.powerRadius ?? 0) && d < bd) { bd = d; best = s; } }
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
    this.hud.setResources({ ore: this.supply.ore, tailings: this.supply.tailings, water: this.supply.water, tsf: this.supply.tsf, income: this.millDayIncome });
  }
  private hasCrusher() { return this.buildings.some((b) => b.spec.type === "crusher"); }
  /** Which powered supply buildings exist, for the surface materials economy tick. */
  private supplyState() {
    const powered = (t: string) => this.buildings.some((b) => b.spec.type === t && this.isPowered(b));
    const tsfCap = this.buildings.reduce((a, b) => a + (this.isPowered(b) || !b.spec.needsPower ? (b.spec.tsfCap ?? 0) : 0), 0);
    return {
      mill: powered("mill"), rail: powered("rail"), water: powered("waterpump"),
      reserves: this.underground.counts().cured < this.underground.stopes.length,
      tsfCap,
    };
  }
  /** Plant-schematic gating: a source is live only if its surface stock actually holds material. */
  private interiorSupply() {
    return { tailings: this.supply.tailings.level > 1, binder: this.supply.binder.level > 1, water: this.supply.water.level > 1 };
  }
  private refreshSupply() { this.plantInterior.setSupply(this.interiorSupply()); this.drawSupplyLinks(); }

  /** Draw inbound feed lines from each supply building to the plant. */
  private drawSupplyLinks() {
    this.supplyLinkMeshes.forEach((m) => m.dispose()); this.supplyLinkMeshes = [];
    const plant = this.buildings.find((b) => b.spec.type === "plant"); if (!plant) return;
    const colFor: Record<string, string> = { tailings: "#9a8763", binder: "#e0cd94", water: "#4aa8ff" };
    for (const b of this.buildings) {
      if (!b.spec.supplies) continue;
      const a = new Vector3(b.pos.x, b.pos.y + 2, b.pos.z);
      const c = new Vector3(plant.pos.x, plant.pos.y + 2, plant.pos.z);
      const mid = Vector3.Center(a, c); mid.y += 1.5;
      const line = MeshBuilder.CreateLines("supply", { points: [a, mid, c] }, this.scene);
      line.color = Color3.FromHexString(colFor[b.spec.supplies]); line.parent = this.surfaceRoot; line.isPickable = false;
      this.supplyLinkMeshes.push(line);
    }
  }
  private isPowered(b: Placed) {
    if (!b.spec.needsPower) return true;
    return this.buildings.some((s) => s.spec.powerRadius && Vector3.Distance(s.pos, b.pos) <= (s.spec.powerRadius ?? 0));
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
    return `<div class="pHead">${s.icon} ${s.label} <span class="pClose" data-act="closebuilding">✕</span></div>
      <div class="pMeta">${roles.join("<br>")}</div>
      <div class="pSplit"><span>Upkeep</span><b>${fmtMoney(s.opexPerDay)}/day</b></div>
      <div class="pSplit"><span>Build cost</span><b>${fmtMoney(s.cost)}</b></div>
      ${s.type === "plant" ? `<button class="pBtn primary" data-act="enterplant"><b>Step inside ▶</b></button>` : ""}`;
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
    const meta = `<div class="pMeta">${badge} · ${ft.short} · −${st.depthM} m · ${st.volumeM3.toLocaleString()} m³<br>Static head ρgh: <b>${head.toFixed(1)} MPa</b> · target UCS <b>${st.targetUcsKpa} kPa</b> · ${due}</div>`;
    const fillPick = `<div class="fillPick">${Object.values(FILL_TYPES).map((f) => `<button class="fillBtn ${st.fillType === f.key ? "on" : ""}" data-act="fill:${f.key}">${f.short}</button>`).join("")}</div><div class="pNote">${ft.note}</div>`;
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
          ? `<button class="segMini ${seg.choke ? "on" : ""}" data-act="choke:${seg.id}" ${seg.built ? "disabled" : ""} title="choke station">⌇</button>` : "";
        return `<div class="segRow ${seg.built ? "built" : ""}">
          <div class="segMain"><b>${seg.label}</b><span>holds ${p.toFixed(1)} MPa · ${Math.round(seg.lengthM)} m</span></div>
          <button class="segMini cls" data-act="seg:${seg.id}" ${seg.built ? "disabled" : ""}>${c ? c.name : "— set —"}</button>
          ${choke}
          <span class="segChk ${c ? (ok ? "ok" : "bad") : ""}">${c ? (ok ? "✓" : "✗") : "·"}</span>
        </div>`;
      }).join("");
      const canBuild = net.pathCanBuild(idx);
      const planned = net.pathPlannedCost(idx);
      body = `${fillPick}${this.recipeSummary(st)}
        <div class="pNote">Design each leg: pick a class that out-rates its pressure. Deeper legs carry more head — a borehole ⌇ choke relieves everything below it. Legs are shared between stopes.</div>
        ${this.hglChart(idx)}
        <div class="segList">${rows}</div>
        <button class="pBtn primary" data-act="build" ${canBuild ? "" : "disabled"}><b>Build reticulation</b><span>${canBuild ? fmtMoney(planned) : "set a valid class on every leg"}</span></button>`;
    } else if (st.status === "piped") {
      const cost = fillCost(st.volumeM3), rev = fillRevenue(st.volumeM3);
      const chk = (key: string, on: boolean, label: string) => `<button class="chkBtn ${on ? "on" : ""}" data-act="sign:${key}">${on ? "☑" : "☐"} ${label}</button>`;
      const ready = st.signBarricade && st.signPourNote;
      body = `
        <div class="pRow">${ft.reticulated ? "Reticulated · <b>" + (st.cls?.name ?? "") + "</b>" + (st.choke ? " + choke" : "") : "Trucked (CAF) · ready to place"}</div>
        ${ft.reticulated ? this.hglChart(idx) : ""}
        <div class="pNote">Pre-pour sign-off — skip an item and it bites later:</div>
        <div class="chkList">
          ${chk("Barricade", !!st.signBarricade, "Barricade built &amp; signed off")}
          ${chk("PourNote", !!st.signPourNote, "Pour note issued &amp; approved")}
          ${chk("LowStart", !!st.signLowStart, "Low-solids line start")}
        </div>
        <button class="pBtn primary" data-act="pour" ${ready ? "" : "disabled"}><b>Begin pour</b><span>${ready ? `paste ${fmtMoney(cost)} → ${fmtMoney(rev)} ore access` : "sign the barricade & pour note first"}</span></button>`;
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
      body = `
        <div class="pRow"><b class="cap">${phase}</b></div>
        <div class="pRow">Pouring · <b>${st.cls?.name ?? FILL_TYPES[st.fillType].short}</b>${st.cls ? " · rating " + rating + " MPa" : ""}</div>
        <div class="pSplit"><span>Line pressure</span><b class="${pcls === "red" ? "pLate" : ""}">${st.pressureMpa.toFixed(1)} MPa</b></div>
        <div class="pBar"><div class="pBarFill ${pcls}" style="width:${pfrac}%"></div></div>
        <div class="pSplit"><span>Flow <b>${st.flowFactor.toFixed(2)}×</b></span>
          <span class="pFlow"><button class="pMini" data-act="flow-down">−</button><button class="pMini" data-act="flow-up">+</button></span></div>
        <div class="pSplit"><span><span class="plugDot ${plugCls}"></span>Plug: ${plugTxt}</span>
          <button class="pBtn sm" data-act="flush">💧 Flush</button></div>
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
    this.hud.setPanel(`<div class="pHead">${st.id} <span data-act="close" class="pClose">✕</span></div>${meta}${body}`);
  }

  private onPanelAction(act: string) {
    if (act === "restart") { location.reload(); return; }
    if (act.startsWith("ev:")) { this.resolveEvent(+act.slice(3)); return; }
    if (act === "enterplant") { this.deselectBuilding(); this.enterPlant(); return; }
    if (act === "closebuilding") { this.deselectBuilding(); return; }
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
    if (act.startsWith("seg:")) { this.underground.net.cycleClass(act.slice(4)); this.renderStopePanel(); return; }
    if (act.startsWith("choke:")) { this.underground.net.toggleChoke(act.slice(6)); this.renderStopePanel(); return; }
    if (act === "build") {
      if (st.status !== "available") return;
      const idx = this.underground.stopes.indexOf(st);
      if (!this.underground.net.pathCanBuild(idx)) { this.hud.setStatus("Every leg needs a class that out-rates its pressure."); return; }
      const planned = this.underground.net.pathPlannedCost(idx);
      if (this.cash < planned) { this.hud.setStatus(`Not enough cash to build the line (${fmtMoney(planned)}).`); return; }
      const res = this.underground.commitReticulation(idx);
      if (!res) return;
      this.cash -= res.cost; this.updateEconomy(); this.renderStopePanel();
      this.hud.setStatus(`${st.id} reticulation built — weakest leg ${res.cls.name}${res.choke ? " (choked)" : ""}, ${fmtMoney(res.cost)}.`);
    } else if (act === "pour") {
      if (st.status === "piped" && (!st.signBarricade || !st.signPourNote)) { this.hud.setStatus("Sign the barricade and issue the pour note before pouring."); return; }
      if (!this.underground.startPour(st)) return;
      if (!st.signLowStart) st.plugDrift = 0.25; // skipped the low-solids start — a plug head-start
      this.renderStopePanel();
      this.hud.setStatus(`${st.id} pour started${st.signLowStart ? "" : " without a low-solids start — mind the plug"}. Keep the flow in the band.`);
    } else if (act === "flow-up") {
      if (st.status === "pouring") { st.flowFactor = Math.min(1.6, st.flowFactor + 0.15); this.renderStopePanel(); }
    } else if (act === "flow-down") {
      if (st.status === "pouring") { st.flowFactor = Math.max(0.4, st.flowFactor - 0.15); this.renderStopePanel(); }
    } else if (act === "flush") {
      if (st.status === "pouring") { st.plugDrift = Math.max(0, st.plugDrift - 0.6); this.hud.setStatus(`${st.id} line flushed — plug cleared, pressure eased.`); this.renderStopePanel(); }
    }
  }

  /** Debug/testing hooks. */
  debugBuild(type: string, x: number, z: number) { const spec = specOf(type); this.place(spec, new Vector3(x, heightAt(x, z), z)); this.disarm(); }
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
  debugPour(i: number) { this.underground.startPour(this.underground.stopes[i]); }
  debugSelect(i: number) { this.selectStope(this.underground.stopes[i]); }
  debugAdvance(days: number) { this.paused = false; const step = 0.25; for (let d = 0; d < days && !this.ended; d += step) this.advanceTime((SECONDS_PER_DAY * step) / this.speed); }
}

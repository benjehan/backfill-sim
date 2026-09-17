// DOM overlay above the 3D canvas. SURFACE mode = build palette; UNDERGROUND
// mode = stope panel. A live clock (pause + speed) drives the simulation, a
// schedule strip tracks the stopes, and a board-review modal ends the run.
import { CATALOG } from "./catalog.js";
import { fmtMoney } from "./backfillModel.js";

export interface HudCallbacks {
  onSelect: (type: string) => void;
  onToggleMode: () => void;
  onPanelAction: (act: string) => void;
  onPause: () => void;
  onSpeed: (i: number) => void;
  onLab: () => void;
  onRecipe: (solids: number, binder: number) => void;
  onBinderTopup: () => void;
  onToggleSound: () => void;
  onHelp: () => void;
  onResearch: () => void;
  onGeology: () => void;
}

const SPEED_LABELS = ["1×", "2×", "4×", "8×"];

export class Hud {
  private statusEl: HTMLElement;
  private cashEl: HTMLElement;
  private powerEl: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private palette: HTMLElement;
  private panel: HTMLElement;
  private dayEl: HTMLElement;
  private schedEl: HTMLElement;
  private pauseBtn: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private result: HTMLElement;
  private event!: HTMLElement;
  private rootEl: HTMLElement;
  private labPanel!: HTMLElement;
  private labReadoutEl!: HTMLElement;
  private labS!: HTMLInputElement;
  private labB!: HTMLInputElement;
  private labSV!: HTMLElement;
  private labBV!: HTMLElement;
  private binderV!: HTMLElement;
  private binderBar!: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private soundBtn!: HTMLButtonElement;
  private armed: string | null = null;

  constructor(parent: HTMLElement, cb: HudCallbacks) {
    const root = document.createElement("div");
    root.className = "worldHud";
    this.rootEl = root;
    root.innerHTML = `
      <div class="whBrand">BACKFILL <span>TYCOON</span> <em id="whMine">· Wheal Verity</em></div>
      <div class="whClock">
        <div class="whDay" id="whDay">Day 1</div>
        <button class="whSpd" id="whPause">⏸</button>
        ${SPEED_LABELS.map((l, i) => `<button class="whSpd" data-spd="${i}">${l}</button>`).join("")}
        <button class="whSpd whLab" id="whLab">🧪 Lab</button>
        <button class="whSpd" id="whSound" title="sound on/off">🔊</button>
        <button class="whSpd" id="whHelp" title="how the economy works">💰</button>
        <button class="whSpd" id="whResearch" title="research lab">🔬</button>
        <button class="whSpd" id="whGeology" title="geology &amp; exploration">🧭</button>
      </div>
      <div class="whSched" id="whSched"></div>
      <div class="whLabPanel hidden" id="whLabPanel">
        <div class="pHead">🧪 Lab — mix design <span class="pClose" id="labClose">✕</span></div>
        <div class="pNote">More solids &amp; binder = stronger fill, but stiffer paste (harder to pump). Design against the deepest stope's target.</div>
        <label class="labSlider"><span>Solids <b id="labSolidsV">74.0%</b></span><input type="range" id="inSolids" min="66" max="82" step="0.5" value="74"></label>
        <label class="labSlider"><span>Binder <b id="labBinderV">200 kg/m³</b></span><input type="range" id="inBinder" min="60" max="450" step="5" value="200"></label>
        <div id="labReadout"></div>
      </div>
      <div class="whEcon">
        <div class="whStat"><span>Cash</span><b id="whCash">$0</b></div>
        <div class="whStat"><span>Power</span><b id="whPower">0/0</b></div>
        <div class="whStat binderStat"><span>Binder</span><b id="whBinderV">0 t</b>
          <div class="binderTrack"><div id="binderBar" class="binderFill"></div></div>
          <button class="whTopup" id="whTopup" title="emergency truck top-up">🚚</button></div>
        <div class="whStat"><span>Mill income</span><b id="whIncome">$0/day</b></div>
      </div>
      <div class="whRes" id="whRes"></div>
      <button class="whMode" id="whMode">⛏ Go underground</button>
      <div class="whTutorial hidden" id="whTutorial"></div>
      <div class="whObjective hidden" id="whObjective"></div>
      <div class="whStatus" id="whStatus">Lay out the surface. Start with a power station.</div>
      <div class="whPalette" id="whPalette"></div>
      <div class="whPanel hidden" id="whPanel"></div>
      <div class="whResult hidden" id="whResult"></div>
      <div class="whResult hidden" id="whEvent"></div>
      <div class="whHint">Drag to orbit · scroll to zoom · right-drag to pan</div>`;
    parent.appendChild(root);
    this.statusEl = root.querySelector("#whStatus")!;
    this.cashEl = root.querySelector("#whCash")!;
    this.powerEl = root.querySelector("#whPower")!;
    this.modeBtn = root.querySelector("#whMode")!;
    this.palette = root.querySelector("#whPalette")!;
    this.panel = root.querySelector("#whPanel")!;
    this.dayEl = root.querySelector("#whDay")!;
    this.schedEl = root.querySelector("#whSched")!;
    this.pauseBtn = root.querySelector("#whPause")!;
    this.result = root.querySelector("#whResult")!;

    this.modeBtn.addEventListener("click", cb.onToggleMode);
    this.pauseBtn.addEventListener("click", cb.onPause);
    this.labPanel = root.querySelector("#whLabPanel")!;
    const labReadout = root.querySelector("#labReadout")!;
    root.querySelector("#whLab")!.addEventListener("click", cb.onLab);
    root.querySelector("#labClose")!.addEventListener("click", () => this.labPanel.classList.add("hidden"));
    const inS = root.querySelector("#inSolids") as HTMLInputElement;
    const inB = root.querySelector("#inBinder") as HTMLInputElement;
    const sV = root.querySelector("#labSolidsV") as HTMLElement, bV = root.querySelector("#labBinderV") as HTMLElement;
    this.labS = inS; this.labB = inB; this.labSV = sV; this.labBV = bV;
    const emit = () => { sV.textContent = (+inS.value).toFixed(1) + "%"; bV.textContent = inB.value + " kg/m³"; cb.onRecipe(+inS.value / 100, +inB.value); };
    inS.addEventListener("input", emit); inB.addEventListener("input", emit);
    this.labReadoutEl = labReadout as HTMLElement;
    this.binderV = root.querySelector("#whBinderV")!;
    this.binderBar = root.querySelector("#binderBar")!;
    root.querySelector("#whTopup")!.addEventListener("click", cb.onBinderTopup);
    const soundBtn = root.querySelector("#whSound") as HTMLButtonElement;
    soundBtn.addEventListener("click", () => cb.onToggleSound());
    this.soundBtn = soundBtn;
    root.querySelector("#whHelp")!.addEventListener("click", () => cb.onHelp());
    root.querySelector("#whResearch")!.addEventListener("click", () => cb.onResearch());
    root.querySelector("#whGeology")!.addEventListener("click", () => cb.onGeology());
    root.querySelectorAll<HTMLButtonElement>(".whSpd[data-spd]").forEach((b) => {
      this.speedBtns.push(b);
      b.addEventListener("click", () => cb.onSpeed(+b.dataset.spd!));
    });
    const delegate = (host: HTMLElement) => host.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (el) cb.onPanelAction(el.dataset.act!);
    });
    this.event = root.querySelector("#whEvent")!;
    this.tutorialEl = root.querySelector("#whTutorial")!;
    delegate(this.panel); delegate(this.result); delegate(this.event); delegate(this.tutorialEl); delegate(this.labReadoutEl);

    for (const s of CATALOG) {
      const b = document.createElement("button");
      b.className = "palBtn";
      b.innerHTML = `<span class="palI">${s.icon}</span><span class="palN">${s.label}</span><span class="palC">${fmtMoney(s.cost)}</span>`;
      b.addEventListener("click", () => cb.onSelect(s.type));
      this.palette.appendChild(b);
      this.buttons.set(s.type, b);
    }
  }

  setMode(mode: "surface" | "underground") {
    const ug = mode === "underground";
    this.palette.classList.toggle("hidden", ug);
    this.panel.classList.toggle("hidden", !ug);
    this.modeBtn.textContent = ug ? "☀ Back to surface" : "⛏ Go underground";
    this.statusEl.textContent = ug ? "Underground — click a stope to reticulate and pour it." : "Surface — lay out the plant and services.";
  }

  setArmed(type: string | null) {
    this.armed = type;
    for (const [t, b] of this.buttons) b.classList.toggle("on", t === type);
  }

  setStatus(text: string) { this.statusEl.textContent = text; }
  setPanel(html: string) { this.panel.innerHTML = html; }
  setPanelVisible(v: boolean) { this.panel.classList.toggle("hidden", !v); }

  setClock(day: number, paused: boolean, speedIdx: number, _speeds: number[]) {
    this.dayEl.textContent = `Day ${Math.floor(day)}`;
    this.pauseBtn.classList.toggle("on", paused);
    this.speedBtns.forEach((b, i) => b.classList.toggle("on", !paused && i === speedIdx));
  }

  setSchedule(c: { locked: number; available: number; piped: number; pouring: number; curing: number; cured: number }, day: number, horizon: number) {
    const pct = Math.min(100, (day / horizon) * 100);
    this.schedEl.innerHTML = `
      <div class="schBar"><div class="schFill" style="width:${pct}%"></div></div>
      <div class="schCounts">✓ ${c.cured} · ◍ ${c.curing + c.pouring} · ○ ${c.available + c.piped} · lock ${c.locked} <span>day ${Math.floor(day)}/${horizon}</span></div>`;
  }

  setEconomy(cash: number, powered: number, total: number) {
    this.cashEl.textContent = fmtMoney(cash);
    this.cashEl.classList.toggle("bad", cash < 0);
    this.powerEl.textContent = `${powered}/${total}`;
    this.powerEl.classList.toggle("bad", powered < total);
    for (const s of CATALOG) {
      const b = this.buttons.get(s.type)!;
      b.classList.toggle("poor", cash < s.cost && this.armed !== s.type);
    }
  }

  showResult(html: string) { this.result.innerHTML = html; this.result.classList.remove("hidden"); }
  showEvent(html: string) { this.event.innerHTML = html; this.event.classList.remove("hidden"); }
  hideEvent() { this.event.classList.add("hidden"); }
  setBinder(tonnes: number, cap: number) {
    this.binderV.textContent = `${Math.round(tonnes)} t`;
    const f = Math.max(0, Math.min(100, (tonnes / cap) * 100));
    this.binderBar.style.width = `${f}%`;
    this.binderBar.className = `binderFill ${f < 12 ? "red" : f < 30 ? "amber" : "green"}`;
  }

  private resEl?: HTMLElement;
  private incomeEl?: HTMLElement;
  setResources(r: {
    reserve: { level: number; cap: number }; ore: { level: number; cap: number }; tailings: { level: number; cap: number };
    water: { level: number; cap: number }; tsf: { level: number; cap: number }; income: number; reuse?: number;
  }) {
    this.incomeEl ??= this.rootEl.querySelector("#whIncome") as HTMLElement;
    if (this.incomeEl) { this.incomeEl.textContent = `${fmtMoney(r.income)}/day`; this.incomeEl.classList.toggle("bad", r.income <= 0); }
    this.resEl ??= this.rootEl.querySelector("#whRes") as HTMLElement;
    if (!this.resEl) return;
    const bar = (label: string, unit: string, s: { level: number; cap: number }, hi = false) => {
      const pct = s.cap > 0 ? Math.max(0, Math.min(100, (s.level / s.cap) * 100)) : 0;
      // for the TSF, a HIGH bar is bad (it fills up); for feed stocks, a LOW bar is bad
      const tone = hi ? (pct > 88 ? "red" : pct > 70 ? "amber" : "green")
        : (s.cap === 0 ? "red" : pct < 12 ? "red" : pct < 30 ? "amber" : "green");
      const val = s.cap > 0 ? `${Math.round(s.level).toLocaleString()} ${unit}` : "— none —";
      return `<div class="resRow"><span class="resL">${label}</span><div class="resTrack"><div class="resFill ${tone}" style="width:${pct}%"></div></div><b class="resV">${val}</b></div>`;
    };
    const reuse = (r.reuse ?? 0) > 1 ? `<div class="resReuse">♻ reusing ${Math.round(r.reuse!).toLocaleString()} m³/day process water</div>` : "";
    this.resEl.innerHTML =
      bar("Orebody", "t", r.reserve) +
      bar("Ore (ROM)", "t", r.ore) +
      bar("Tailings buf", "t", r.tailings) +
      bar("Water pond", "m³", r.water) + reuse +
      bar("TSF", "t", r.tsf, true);
  }

  private tutorialEl!: HTMLElement;
  setTutorial(html: string | null) {
    if (html) { this.tutorialEl.innerHTML = html; this.tutorialEl.classList.remove("hidden"); }
    else this.tutorialEl.classList.add("hidden");
  }

  private objectiveEl?: HTMLElement;
  /** Show the current build objective, or pass null when the operation is fully stood up. */
  setObjective(text: string | null) {
    this.objectiveEl ??= this.rootEl.querySelector("#whObjective") as HTMLElement;
    if (!this.objectiveEl) return;
    if (text) { this.objectiveEl.innerHTML = text; this.objectiveEl.classList.remove("hidden"); }
    else this.objectiveEl.classList.add("hidden");
  }

  setSoundIcon(on: boolean) { this.soundBtn.textContent = on ? "🔊" : "🔇"; this.soundBtn.classList.toggle("on", on); }
  setMine(name: string) { const el = this.rootEl.querySelector("#whMine"); if (el) el.textContent = "· " + name; }

  setHidden(hidden: boolean) { this.rootEl.classList.toggle("hidden", hidden); }
  toggleLab(readout: string) { this.labPanel.classList.toggle("hidden"); if (!this.labPanel.classList.contains("hidden")) this.setLabReadout(readout); }
  setLabReadout(html: string) { this.labReadoutEl.innerHTML = html; }
  setLabRecipe(solids: number, binder: number) {
    this.labS.value = String(solids * 100); this.labB.value = String(binder);
    this.labSV.textContent = (solids * 100).toFixed(1) + "%"; this.labBV.textContent = binder + " kg/m³";
  }
}

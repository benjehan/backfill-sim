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
  private binderV!: HTMLElement;
  private binderBar!: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private armed: string | null = null;

  constructor(parent: HTMLElement, cb: HudCallbacks) {
    const root = document.createElement("div");
    root.className = "worldHud";
    this.rootEl = root;
    root.innerHTML = `
      <div class="whBrand">CUT &amp; <span>FILL</span> <em>· Wheal Verity</em></div>
      <div class="whClock">
        <div class="whDay" id="whDay">Day 1</div>
        <button class="whSpd" id="whPause">⏸</button>
        ${SPEED_LABELS.map((l, i) => `<button class="whSpd" data-spd="${i}">${l}</button>`).join("")}
        <button class="whSpd whLab" id="whLab">🧪 Lab</button>
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
      </div>
      <button class="whMode" id="whMode">⛏ Go underground</button>
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
    const sV = root.querySelector("#labSolidsV")!, bV = root.querySelector("#labBinderV")!;
    const emit = () => { sV.textContent = (+inS.value).toFixed(1) + "%"; bV.textContent = inB.value + " kg/m³"; cb.onRecipe(+inS.value / 100, +inB.value); };
    inS.addEventListener("input", emit); inB.addEventListener("input", emit);
    this.labReadoutEl = labReadout as HTMLElement;
    this.binderV = root.querySelector("#whBinderV")!;
    this.binderBar = root.querySelector("#binderBar")!;
    root.querySelector("#whTopup")!.addEventListener("click", cb.onBinderTopup);
    root.querySelectorAll<HTMLButtonElement>(".whSpd[data-spd]").forEach((b) => {
      this.speedBtns.push(b);
      b.addEventListener("click", () => cb.onSpeed(+b.dataset.spd!));
    });
    const delegate = (host: HTMLElement) => host.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (el) cb.onPanelAction(el.dataset.act!);
    });
    this.event = root.querySelector("#whEvent")!;
    delegate(this.panel); delegate(this.result); delegate(this.event);

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

  setHidden(hidden: boolean) { this.rootEl.classList.toggle("hidden", hidden); }
  toggleLab(readout: string) { this.labPanel.classList.toggle("hidden"); if (!this.labPanel.classList.contains("hidden")) this.setLabReadout(readout); }
  setLabReadout(html: string) { this.labReadoutEl.innerHTML = html; }
}

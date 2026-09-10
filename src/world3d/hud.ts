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
  private buttons = new Map<string, HTMLButtonElement>();
  private armed: string | null = null;

  constructor(parent: HTMLElement, cb: HudCallbacks) {
    const root = document.createElement("div");
    root.className = "worldHud";
    root.innerHTML = `
      <div class="whBrand">CUT &amp; <span>FILL</span> <em>· Wheal Verity</em></div>
      <div class="whClock">
        <div class="whDay" id="whDay">Day 1</div>
        <button class="whSpd" id="whPause">⏸</button>
        ${SPEED_LABELS.map((l, i) => `<button class="whSpd" data-spd="${i}">${l}</button>`).join("")}
      </div>
      <div class="whSched" id="whSched"></div>
      <div class="whEcon">
        <div class="whStat"><span>Cash</span><b id="whCash">$0</b></div>
        <div class="whStat"><span>Power</span><b id="whPower">0/0</b></div>
      </div>
      <button class="whMode" id="whMode">⛏ Go underground</button>
      <div class="whStatus" id="whStatus">Lay out the surface. Start with a power station.</div>
      <div class="whPalette" id="whPalette"></div>
      <div class="whPanel hidden" id="whPanel"></div>
      <div class="whResult hidden" id="whResult"></div>
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
    root.querySelectorAll<HTMLButtonElement>(".whSpd[data-spd]").forEach((b) => {
      this.speedBtns.push(b);
      b.addEventListener("click", () => cb.onSpeed(+b.dataset.spd!));
    });
    const delegate = (host: HTMLElement) => host.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (el) cb.onPanelAction(el.dataset.act!);
    });
    delegate(this.panel); delegate(this.result);

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
}

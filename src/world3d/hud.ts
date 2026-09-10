// DOM overlay above the 3D canvas. Two modes: SURFACE (build palette + economy)
// and UNDERGROUND (a stope panel for reticulate/fill). A descend/ascend toggle
// switches between them.
import { CATALOG } from "./catalog.js";
import { fmtMoney } from "./backfillModel.js";

export interface HudCallbacks {
  onSelect: (type: string) => void;
  onToggleMode: () => void;
  onPanelAction: (act: string) => void;
}

export class Hud {
  private statusEl: HTMLElement;
  private cashEl: HTMLElement;
  private powerEl: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private palette: HTMLElement;
  private panel: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private armed: string | null = null;

  constructor(parent: HTMLElement, cb: HudCallbacks) {
    const root = document.createElement("div");
    root.className = "worldHud";
    root.innerHTML = `
      <div class="whBrand">CUT &amp; <span>FILL</span> <em>· Wheal Verity</em></div>
      <div class="whEcon">
        <div class="whStat"><span>Cash</span><b id="whCash">$0</b></div>
        <div class="whStat"><span>Power</span><b id="whPower">0/0</b></div>
      </div>
      <button class="whMode" id="whMode">⛏ Go underground</button>
      <div class="whStatus" id="whStatus">Lay out the surface. Start with a power station.</div>
      <div class="whPalette" id="whPalette"></div>
      <div class="whPanel hidden" id="whPanel"></div>
      <div class="whHint">Drag to orbit · scroll to zoom · right-drag to pan</div>`;
    parent.appendChild(root);
    this.statusEl = root.querySelector("#whStatus")!;
    this.cashEl = root.querySelector("#whCash")!;
    this.powerEl = root.querySelector("#whPower")!;
    this.modeBtn = root.querySelector("#whMode")!;
    this.palette = root.querySelector("#whPalette")!;
    this.panel = root.querySelector("#whPanel")!;

    this.modeBtn.addEventListener("click", cb.onToggleMode);
    this.panel.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (el) cb.onPanelAction(el.dataset.act!);
    });

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
    this.statusEl.textContent = ug
      ? "Underground — click a stope to reticulate and fill it."
      : "Surface — lay out the plant and services.";
  }

  setArmed(type: string | null) {
    this.armed = type;
    for (const [t, b] of this.buttons) b.classList.toggle("on", t === type);
  }

  setStatus(text: string) { this.statusEl.textContent = text; }
  setPanel(html: string) { this.panel.innerHTML = html; }

  setEconomy(cash: number, powered: number, total: number) {
    this.cashEl.textContent = fmtMoney(cash);
    this.powerEl.textContent = `${powered}/${total}`;
    this.powerEl.classList.toggle("bad", powered < total);
    for (const s of CATALOG) {
      const b = this.buttons.get(s.type)!;
      b.classList.toggle("poor", cash < s.cost && this.armed !== s.type);
    }
  }
}

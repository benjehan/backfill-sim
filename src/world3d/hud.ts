// DOM overlay above the 3D canvas: brand, economy readout, a build palette of
// catalog buttons, status line and camera hints.
import { CATALOG } from "./catalog.js";

export class Hud {
  private statusEl: HTMLElement;
  private cashEl: HTMLElement;
  private powerEl: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private armed: string | null = null;

  constructor(parent: HTMLElement, onSelect: (type: string) => void) {
    const root = document.createElement("div");
    root.className = "worldHud";
    root.innerHTML = `
      <div class="whBrand">CUT &amp; <span>FILL</span> <em>· Wheal Verity</em></div>
      <div class="whEcon">
        <div class="whStat"><span>Cash</span><b id="whCash">$0</b></div>
        <div class="whStat"><span>Power</span><b id="whPower">0/0</b></div>
      </div>
      <div class="whStatus" id="whStatus">Lay out the surface. Start with a power station.</div>
      <div class="whPalette" id="whPalette"></div>
      <div class="whHint">Drag to orbit · scroll to zoom · right-drag to pan</div>`;
    parent.appendChild(root);
    this.statusEl = root.querySelector("#whStatus")!;
    this.cashEl = root.querySelector("#whCash")!;
    this.powerEl = root.querySelector("#whPower")!;

    const pal = root.querySelector("#whPalette")!;
    for (const s of CATALOG) {
      const b = document.createElement("button");
      b.className = "palBtn";
      b.innerHTML = `<span class="palI">${s.icon}</span><span class="palN">${s.label}</span><span class="palC">$${(s.cost / 1000).toFixed(0)}k</span>`;
      b.addEventListener("click", () => onSelect(s.type));
      pal.appendChild(b);
      this.buttons.set(s.type, b);
    }
  }

  setArmed(type: string | null) {
    this.armed = type;
    for (const [t, b] of this.buttons) b.classList.toggle("on", t === type);
  }

  setStatus(text: string) { this.statusEl.textContent = text; }

  setEconomy(cash: number, powered: number, total: number) {
    this.cashEl.textContent = `$${Math.round(cash).toLocaleString()}`;
    this.powerEl.textContent = `${powered}/${total}`;
    this.powerEl.classList.toggle("bad", powered < total);
    for (const s of CATALOG) {
      const b = this.buttons.get(s.type)!;
      b.classList.toggle("poor", cash < s.cost && this.armed !== s.type);
    }
  }
}

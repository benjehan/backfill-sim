// DOM overlay above the 3D canvas: brand, build control, status + camera hints.
export class Hud {
  private buildBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private hintEl: HTMLElement;

  constructor(parent: HTMLElement, onBuild: () => void) {
    const root = document.createElement("div");
    root.className = "worldHud";
    root.innerHTML = `
      <div class="whBrand">CUT &amp; <span>FILL</span> <em>· Wheal Verity</em></div>
      <div class="whControls">
        <button class="whBtn" id="whBuild">🏭 Build plant</button>
        <div class="whStatus" id="whStatus">Site survey — choose where to build the surface plant.</div>
      </div>
      <div class="whHint">Drag to orbit · scroll to zoom · right-drag to pan</div>`;
    parent.appendChild(root);
    this.buildBtn = root.querySelector("#whBuild")!;
    this.statusEl = root.querySelector("#whStatus")!;
    this.hintEl = root.querySelector(".whHint")!;
    this.buildBtn.addEventListener("click", onBuild);
  }

  setArmed(armed: boolean) {
    this.buildBtn.classList.toggle("on", armed);
    this.buildBtn.textContent = armed ? "✖ Cancel siting" : "🏭 Build plant";
    this.statusEl.textContent = armed
      ? "Click the flat pad to set the plant. It must sit inside the graded area."
      : "Site survey — choose where to build the surface plant.";
  }

  setBuilt() {
    this.buildBtn.textContent = "✓ Plant sited";
    this.buildBtn.classList.remove("on");
    this.buildBtn.disabled = true;
    this.statusEl.textContent = "Plant sited. Next: step inside to install equipment (coming soon).";
  }

  setStatus(text: string) { this.statusEl.textContent = text; }
}

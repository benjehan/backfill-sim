// Top-down surface-plant builder (GDD 05). A self-contained buildable screen:
// arm a machine from the palette and click the grid to place it, click an output
// port then a matching input port to run a pipe, and material flows from the
// sources through to the shaft. Throughput to the shaft is the score.
//
// UI-only: all physics/economy lives in ../plant/model.ts. The view mounts into a
// host element, owns its own DOM and listeners, and tears them down on destroy().

import {
  Plant, CATALOG, MAT, TILE, COLS, ROWS, WORLD_W, WORLD_H,
  type Machine,
} from "../plant/model.js";

const BUILDABLE = ["thickener", "mixer", "pump"];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class PlantView {
  private host: HTMLElement;
  private plant: Plant;
  private svg: SVGSVGElement | null = null;

  // interaction state
  private tool: string | null = null;                       // armed build type
  private pending: { mId: string; port: number } | null = null; // pipe start (output port)
  private selected: { kind: "machine" | "pipe"; id: string } | null = null;

  constructor(host: HTMLElement, plant: Plant) {
    this.host = host;
    this.plant = plant;
    this.plant.solve();
    this.render();
    host.addEventListener("click", this.onClick);
    host.addEventListener("mousemove", this.onMove);
    host.addEventListener("contextmenu", this.onContext);
    window.addEventListener("keydown", this.onKey);
    (window as any).__plant = plant; // exposed for debugging / headless testing
  }

  destroy() {
    this.host.removeEventListener("click", this.onClick);
    this.host.removeEventListener("mousemove", this.onMove);
    this.host.removeEventListener("contextmenu", this.onContext);
    window.removeEventListener("keydown", this.onKey);
    this.host.innerHTML = "";
    this.svg = null;
  }

  // ---- render ---------------------------------------------------------------

  private render() {
    this.host.innerHTML = `
      <div class="plantStage">${this.svgMarkup()}</div>
      <div class="plantPanel">${this.panelMarkup()}</div>`;
    this.svg = this.host.querySelector("svg");
  }

  private svgMarkup(): string {
    const p = this.plant;
    const pipes = p.pipes.map((pi) => {
      const fm = p.getMachine(pi.from.m), tm = p.getMachine(pi.to.m);
      if (!fm || !tm) return "";
      const a = p.portPos(fm, "out", pi.from.port);
      const b = p.portPos(tm, "in", pi.to.port);
      const midx = (a.x + b.x) / 2;
      const d = `M${a.x} ${a.y} H${midx} V${b.y} H${b.x}`;
      const flowing = pi.flow > 0.05;
      const sel = this.selected?.kind === "pipe" && this.selected.id === pi.id;
      return `<path class="pipehit" data-action="pipe" data-id="${pi.id}" d="${d}"/>
        <path class="pipe ${flowing ? "flowing" : ""} ${sel ? "sel" : ""}" d="${d}" style="stroke:${MAT[pi.material].color}"/>`;
    }).join("");

    const machines = p.machines.map((m) => this.machineMarkup(m)).join("");

    return `<svg viewBox="0 0 ${WORLD_W} ${WORLD_H}" class="plantSvg" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="pgrid" width="${TILE}" height="${TILE}" patternUnits="userSpaceOnUse">
          <path d="M ${TILE} 0 L 0 0 0 ${TILE}" fill="none" stroke="#1c2b38" stroke-width="1"/>
        </pattern>
      </defs>
      <rect data-action="grid" x="0" y="0" width="${WORLD_W}" height="${WORLD_H}" fill="url(#pgrid)"/>
      <g id="pipeLayer">${pipes}</g>
      <g id="machineLayer">${machines}</g>
      <g id="ovl"></g>
    </svg>`;
  }

  private machineMarkup(m: Machine): string {
    const p = this.plant;
    const s = p.spec(m);
    const x = m.col * TILE, y = m.row * TILE, w = s.w * TILE, h = s.h * TILE;
    const sel = this.selected?.kind === "machine" && this.selected.id === m.id ? "sel" : "";
    const rateTxt = m.rate > 0.05 ? `${m.rate.toFixed(0)} m³/h` : "";

    const inPorts = m.inputs.map((sl, i) => {
      const pt = p.portPos(m, "in", i);
      const canTarget = !!this.pending && this.canTarget(m.id, i);
      return `<circle class="port ${sl.pipeId ? "wired" : ""} ${canTarget ? "target" : ""}"
        data-action="port" data-id="${m.id}" data-port="${i}" data-side="in"
        cx="${pt.x}" cy="${pt.y}" r="7" style="fill:${MAT[sl.material].color}"/>`;
    }).join("");

    const outPorts = m.outputs.map((sl, i) => {
      const pt = p.portPos(m, "out", i);
      const active = this.pending?.mId === m.id && this.pending?.port === i ? "active" : "";
      return `<circle class="port ${sl.pipeId ? "wired" : ""} ${active}"
        data-action="port" data-id="${m.id}" data-port="${i}" data-side="out"
        cx="${pt.x}" cy="${pt.y}" r="7" style="fill:${MAT[sl.material].color}"/>`;
    }).join("");

    return `<g class="machine st-${m.state} ${sel}">
      <rect data-action="machine" data-id="${m.id}" x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" rx="9" fill="${s.color}" class="mBody"/>
      <text class="mIcon" x="${x + w / 2}" y="${y + h / 2 + 2}" text-anchor="middle">${s.icon}</text>
      <text class="mLabel" x="${x + w / 2}" y="${y + h - 12}" text-anchor="middle">${s.label}</text>
      ${rateTxt ? `<text class="mRate" x="${x + w / 2}" y="${y + 16}" text-anchor="middle">${rateTxt}</text>` : ""}
      ${inPorts}${outPorts}
    </g>`;
  }

  private panelMarkup(): string {
    const p = this.plant;
    const met = p.deliveredM3h >= p.targetM3h - 0.5;
    const palette = BUILDABLE.map((t) => {
      const s = CATALOG[t];
      const armed = this.tool === t;
      const afford = p.cash >= s.cost;
      return `<button class="palItem ${armed ? "on" : ""}" data-action="tool" data-t="${t}" ${afford ? "" : "disabled"}>
        <span class="palIcon" style="background:${s.color}">${s.icon}</span>
        <span class="palText"><b>${s.label}</b><small>$${(s.cost / 1000).toFixed(0)}k · ${s.cap} m³/h</small></span>
      </button>`;
    }).join("");

    return `
      <div class="card">
        <h3>Surface plant <span class="hint">GDD 05</span></h3>
        <div class="plantHud">
          <div class="phBig ${met ? "good" : ""}">
            <span>To shaft</span>
            <b>${p.deliveredM3h.toFixed(0)}<em> / ${p.targetM3h} m³/h</em></b>
          </div>
          <div class="phRow"><span>Cash</span><b>$${p.cash.toLocaleString()}</b></div>
          <div class="phRow"><span>Capex spent</span><b>$${p.totalSpent.toLocaleString()}</b></div>
        </div>
        <div class="warnbox ${met ? "ok" : ""}">${met
          ? "✓ Target met — the plant feeds the shaft at rate."
          : "Chain it up: tailings → thickener → mixer (+binder +water) → pump → shaft."}</div>
      </div>

      <div class="card">
        <h3>Build</h3>
        <div class="palette">${palette}</div>
        <p class="muted small">Arm a machine, then click the grid to place it. Click an <b>output</b> port then a matching <b>input</b> port to run a pipe. Right-click or Esc cancels.</p>
      </div>

      ${this.contextCard()}`;
  }

  private contextCard(): string {
    const p = this.plant;
    if (this.pending) {
      const m = p.getMachine(this.pending.mId);
      const mat = m ? MAT[m.outputs[this.pending.port].material].label : "";
      return `<div class="card">
        <h3>Laying pipe</h3>
        <p class="muted small">Carrying <b>${mat}</b>. Click a matching (highlighted) input port to connect.</p>
        <button class="btn" data-action="cancel">Cancel</button>
      </div>`;
    }
    if (this.selected?.kind === "machine") {
      const m = p.getMachine(this.selected.id);
      if (!m) return "";
      const s = p.spec(m);
      const fixture = s.kind === "source" || s.kind === "sink";
      return `<div class="card">
        <h3>${s.label} <span class="hint">${m.state}</span></h3>
        <div class="phRow"><span>Throughput</span><b>${m.rate.toFixed(1)} m³/h</b></div>
        <div class="phRow"><span>Capacity</span><b>${s.cap} m³/h</b></div>
        ${fixture
          ? `<p class="muted small">Fixed plant infrastructure — cannot be removed.</p>`
          : `<button class="btn danger" data-action="remove">Remove (50% refund)</button>`}
      </div>`;
    }
    if (this.selected?.kind === "pipe") {
      const pi = p.getPipe(this.selected.id);
      if (!pi) return "";
      return `<div class="card">
        <h3>Pipe <span class="hint">${MAT[pi.material].label}</span></h3>
        <div class="phRow"><span>Flow</span><b>${pi.flow.toFixed(1)} m³/h</b></div>
        <button class="btn danger" data-action="remove">Remove pipe</button>
      </div>`;
    }
    return "";
  }

  // ---- overlay (ghost + rubber-band), updated on mousemove ------------------

  private onMove = (e: MouseEvent) => {
    if (!this.svg) return;
    const ovl = this.svg.querySelector("#ovl");
    if (!ovl) return;
    const { x, y } = this.worldXY(e);
    let s = "";
    if (this.tool) {
      const { col, row } = this.snap(this.tool, x, y);
      const spec = CATALOG[this.tool];
      const ok = this.plant.canPlace(this.tool, col, row);
      s += `<rect class="ghost ${ok ? "ok" : "bad"}" x="${col * TILE + 4}" y="${row * TILE + 4}"
        width="${spec.w * TILE - 8}" height="${spec.h * TILE - 8}" rx="9"/>`;
    }
    if (this.pending) {
      const m = this.plant.getMachine(this.pending.mId);
      if (m) {
        const a = this.plant.portPos(m, "out", this.pending.port);
        s += `<line class="rubber" x1="${a.x}" y1="${a.y}" x2="${x}" y2="${y}"/>`;
      }
    }
    ovl.innerHTML = s;
  };

  // ---- clicks / actions -----------------------------------------------------

  private onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    const act = el?.dataset.action;

    // palette toggle always wins
    if (act === "tool") {
      const t = el!.dataset.t!;
      this.tool = this.tool === t ? null : t;
      this.pending = null; this.selected = null;
      this.render();
      return;
    }
    if (act === "cancel") { this.pending = null; this.tool = null; this.render(); return; }
    if (act === "remove") { this.removeSelected(); return; }

    // if a machine is armed, any click in the play area places it
    if (this.tool) {
      if (act === "grid" || act === "machine" || act === "port" || act === "pipe") this.place(e);
      return;
    }

    if (act === "port") { this.onPort(el!); return; }
    if (act === "pipe") { this.selected = { kind: "pipe", id: el!.dataset.id! }; this.pending = null; this.render(); return; }
    if (act === "machine") { this.selected = { kind: "machine", id: el!.dataset.id! }; this.pending = null; this.render(); return; }
    if (act === "grid") { this.selected = null; this.pending = null; this.render(); return; }
  };

  private onPort(el: HTMLElement) {
    const mId = el.dataset.id!;
    const port = +el.dataset.port!;
    const side = el.dataset.side!;
    const m = this.plant.getMachine(mId);
    if (!m) return;

    if (side === "out") {
      if (m.outputs[port]?.pipeId) return;               // already piped
      this.pending = { mId, port };
      this.selected = null;
      this.render();
      return;
    }
    // input port
    if (!this.pending) return;                            // nothing to connect
    this.plant.connect(this.pending.mId, this.pending.port, mId, port);
    this.pending = null;
    this.plant.solve();
    this.render();
  }

  private place(e: MouseEvent) {
    if (!this.tool) return;
    const { x, y } = this.worldXY(e);
    const { col, row } = this.snap(this.tool, x, y);
    if (this.plant.place(this.tool, col, row)) {
      this.plant.solve();
      this.render(); // keep tool armed for rapid placement
    }
  }

  private removeSelected() {
    if (!this.selected) return;
    if (this.selected.kind === "machine") this.plant.removeMachine(this.selected.id);
    else this.plant.removePipe(this.selected.id);
    this.selected = null;
    this.plant.solve();
    this.render();
  }

  private onContext = (e: MouseEvent) => {
    e.preventDefault();
    this.tool = null; this.pending = null;
    this.render();
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { this.tool = null; this.pending = null; this.selected = null; this.render(); }
  };

  // ---- helpers --------------------------------------------------------------

  /** Is machine `mId` input `port` a legal drop target for the pending pipe? */
  private canTarget(mId: string, port: number): boolean {
    if (!this.pending) return false;
    return this.plant.canConnect(this.pending.mId, this.pending.port, mId, port).ok;
  }

  private worldXY(e: MouseEvent): { x: number; y: number } {
    const r = this.svg!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * WORLD_W,
      y: ((e.clientY - r.top) / r.height) * WORLD_H,
    };
  }

  /** Snap cursor to a footprint-aligned, in-bounds top-left cell. */
  private snap(type: string, x: number, y: number): { col: number; row: number } {
    const s = CATALOG[type];
    const col = clamp(Math.round(x / TILE - s.w / 2), 0, COLS - s.w);
    const row = clamp(Math.round(y / TILE - s.h / 2), 0, ROWS - s.h);
    return { col, row };
  }
}

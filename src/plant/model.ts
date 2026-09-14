// Top-down plant builder — model & flow simulation (GDD 05).
// A buildable world: buy machines, place them on the grid, connect with pipes,
// and material flows through. Pull-based rate solve from the shaft back to the
// sources, so bottlenecks and missing connections are felt immediately.

export const TILE = 48;
export const COLS = 20;
export const ROWS = 12;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

export type Mat = "tailings" | "water" | "binder" | "thick" | "sized" | "cake" | "paste" | "pasteHP";

export const MAT: Record<Mat, { color: string; label: string }> = {
  tailings: { color: "#9a8763", label: "tailings" },
  water: { color: "#4aa8ff", label: "water" },
  binder: { color: "#e0cd94", label: "binder" },
  thick: { color: "#b58a4f", label: "thickened" },
  sized: { color: "#7fae86", label: "classified" },
  cake: { color: "#c9b98f", label: "filter cake" },
  paste: { color: "#d98b2e", label: "paste" },
  pasteHP: { color: "#ffa733", label: "paste" },
};

export type Kind = "source" | "transform" | "sink";

export interface Spec {
  type: string;
  label: string;
  kind: Kind;
  w: number; h: number;        // footprint in tiles
  cost: number;
  cap: number;                 // max throughput (m³/h)
  inputs: Mat[];
  ratios?: number[];           // input volume per unit output
  output: Mat | null;
  color: string;
  icon: string;                // short glyph for the machine face
  buildable?: boolean;
}

export const CATALOG: Record<string, Spec> = {
  src_tailings: { type: "src_tailings", label: "Tailings", kind: "source", w: 2, h: 2, cost: 0, cap: 90, inputs: [], output: "tailings", color: "#5b6b52", icon: "⛏" },
  src_water: { type: "src_water", label: "Water", kind: "source", w: 2, h: 2, cost: 0, cap: 200, inputs: [], output: "water", color: "#2f5f86", icon: "≈" },
  src_binder: { type: "src_binder", label: "Binder silo", kind: "source", w: 2, h: 2, cost: 0, cap: 200, inputs: [], output: "binder", color: "#7a6a3f", icon: "⬢" },
  // Thickeners — high-rate (cheap, lower density) vs paste/UHD (dearer, higher throughput)
  thickener_hr: { type: "thickener_hr", label: "High-rate thickener", kind: "transform", w: 2, h: 2, cost: 30000, cap: 65, inputs: ["tailings"], ratios: [1.0], output: "thick", color: "#3f5566", icon: "◍", buildable: true },
  thickener_uhd: { type: "thickener_uhd", label: "Paste thickener (UHD)", kind: "transform", w: 2, h: 2, cost: 55000, cap: 90, inputs: ["tailings"], ratios: [1.0], output: "thick", color: "#4a6273", icon: "◍", buildable: true },
  cyclone: { type: "cyclone", label: "Cyclone", kind: "transform", w: 2, h: 2, cost: 38000, cap: 72, inputs: ["thick"], ratios: [1.0], output: "sized", color: "#4a6b7a", icon: "◐", buildable: true },
  // Filters — vacuum disc (cheap, continuous) vs pressure (dearer, drier/higher)
  filter_vac: { type: "filter_vac", label: "Vacuum disc filter", kind: "transform", w: 2, h: 2, cost: 40000, cap: 60, inputs: ["sized"], ratios: [1.0], output: "cake", color: "#3f6653", icon: "▤", buildable: true },
  filter_press: { type: "filter_press", label: "Pressure filter", kind: "transform", w: 2, h: 2, cost: 62000, cap: 78, inputs: ["sized"], ratios: [1.0], output: "cake", color: "#4a7a5f", icon: "▦", buildable: true },
  // Mixers — twin-shaft (standard) vs continuous (higher throughput)
  mixer_twin: { type: "mixer_twin", label: "Twin-shaft mixer", kind: "transform", w: 2, h: 2, cost: 55000, cap: 60, inputs: ["cake", "binder", "water"], ratios: [0.82, 0.06, 0.12], output: "paste", color: "#5a4a63", icon: "✳", buildable: true },
  mixer_cont: { type: "mixer_cont", label: "Continuous mixer", kind: "transform", w: 2, h: 2, cost: 78000, cap: 85, inputs: ["cake", "binder", "water"], ratios: [0.82, 0.06, 0.12], output: "paste", color: "#6a5573", icon: "✳", buildable: true },
  // Pumps — centrifugal (cheap, lower duty) vs positive-displacement piston (high duty)
  pump_cent: { type: "pump_cent", label: "Centrifugal pump", kind: "transform", w: 2, h: 2, cost: 30000, cap: 60, inputs: ["paste"], ratios: [1.0], output: "pasteHP", color: "#664338", icon: "⚙", buildable: true },
  pump_pd: { type: "pump_pd", label: "PD piston pump", kind: "transform", w: 2, h: 2, cost: 48000, cap: 88, inputs: ["paste"], ratios: [1.0], output: "pasteHP", color: "#71493c", icon: "⚙", buildable: true },
  shaft: { type: "shaft", label: "Shaft", kind: "sink", w: 2, h: 2, cost: 0, cap: 999, inputs: ["pasteHP"], output: null, color: "#3a3f4a", icon: "▼" },
};

export interface Slot { material: Mat; pipeId: string | null; }
export type MachineState = "off" | "running" | "throttled" | "starved" | "idle";

export interface Machine {
  id: string;
  type: string;
  col: number; row: number;
  inputs: Slot[];
  outputs: Slot[];
  rate: number;
  state: MachineState;
  anim: number; // animation phase
  capOverride?: number; // set by the surface supply chain (0 = starved)
}

export interface Pipe {
  id: string;
  from: { m: string; port: number };
  to: { m: string; port: number };
  material: Mat;
  flow: number;
}

export interface PlacePreview { type: string; col: number; row: number; valid: boolean; }

let idc = 1;
const nid = (p: string) => `${p}${idc++}`;

export class Plant {
  cash = 240_000;
  targetM3h = 55;
  deliveredM3h = 0;
  machines: Machine[] = [];
  pipes: Pipe[] = [];
  totalSpent = 0;

  constructor() {
    // pre-placed sources on the left, shaft on the right
    this.add("src_tailings", 0, 1);
    this.add("src_water", 0, 5);
    this.add("src_binder", 0, 9);
    this.add("shaft", COLS - 2, 5);
  }

  private add(type: string, col: number, row: number): Machine {
    const spec = CATALOG[type];
    const m: Machine = {
      id: nid("m"), type, col, row,
      inputs: spec.inputs.map((mat) => ({ material: mat, pipeId: null })),
      outputs: spec.output ? [{ material: spec.output, pipeId: null }] : [],
      rate: 0, state: "off", anim: 0,
    };
    this.machines.push(m);
    return m;
  }

  getMachine(id: string) { return this.machines.find((m) => m.id === id); }
  getPipe(id: string) { return this.pipes.find((p) => p.id === id); }
  spec(m: Machine) { return CATALOG[m.type]; }

  // ---- placement ----------------------------------------------------------

  footprintFree(col: number, row: number, w: number, h: number, ignore?: string): boolean {
    if (col < 0 || row < 0 || col + w > COLS || row + h > ROWS) return false;
    for (const m of this.machines) {
      if (m.id === ignore) continue;
      const s = this.spec(m);
      if (col < m.col + s.w && col + w > m.col && row < m.row + s.h && row + h > m.row) return false;
    }
    return true;
  }

  canPlace(type: string, col: number, row: number): boolean {
    const s = CATALOG[type];
    return !!s?.buildable && this.cash >= s.cost && this.footprintFree(col, row, s.w, s.h);
  }

  place(type: string, col: number, row: number): Machine | null {
    if (!this.canPlace(type, col, row)) return null;
    const s = CATALOG[type];
    this.cash -= s.cost; this.totalSpent += s.cost;
    return this.add(type, col, row);
  }

  /** Relocate a machine (keeping its connections) if the new footprint is free. */
  move(id: string, col: number, row: number): boolean {
    const m = this.getMachine(id);
    if (!m) return false;
    const s = this.spec(m);
    if (s.kind === "source" || s.kind === "sink") return false; // fixtures stay
    if (!this.footprintFree(col, row, s.w, s.h, id)) return false;
    m.col = col; m.row = row;
    return true;
  }

  removeMachine(id: string) {
    const m = this.getMachine(id);
    if (!m) return;
    const s = this.spec(m);
    if (s.kind === "source" || s.kind === "sink") return; // fixtures stay
    // remove attached pipes (refund pipe cost is skipped for simplicity)
    this.pipes = this.pipes.filter((p) => {
      if (p.from.m === id || p.to.m === id) { this.detach(p); return false; }
      return true;
    });
    this.cash += Math.round(s.cost * 0.5); // 50% refund
    this.machines = this.machines.filter((x) => x.id !== id);
  }

  private detach(p: Pipe) {
    const fm = this.getMachine(p.from.m); if (fm && fm.outputs[p.from.port]) fm.outputs[p.from.port].pipeId = null;
    const tm = this.getMachine(p.to.m); if (tm && tm.inputs[p.to.port]) tm.inputs[p.to.port].pipeId = null;
  }

  // ---- connections --------------------------------------------------------

  pipeCost(a: Machine, b: Machine): number {
    const dist = Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
    return 800 + dist * 120;
  }

  canConnect(fromId: string, fromPort: number, toId: string, toPort: number): { ok: boolean; reason?: string; cost?: number } {
    const fm = this.getMachine(fromId), tm = this.getMachine(toId);
    if (!fm || !tm || fromId === toId) return { ok: false, reason: "invalid" };
    const fs = this.spec(fm), ts = this.spec(tm);
    if (!fm.outputs[fromPort]) return { ok: false, reason: "no output" };
    if (!tm.inputs[toPort]) return { ok: false, reason: "no input" };
    if (fm.outputs[fromPort].pipeId) return { ok: false, reason: "output already piped" };
    if (tm.inputs[toPort].pipeId) return { ok: false, reason: "input already piped" };
    if (fm.outputs[fromPort].material !== tm.inputs[toPort].material)
      return { ok: false, reason: `needs ${tm.inputs[toPort].material}, this carries ${fm.outputs[fromPort].material}` };
    const cost = this.pipeCost(fm, tm);
    if (this.cash < cost) return { ok: false, reason: "not enough cash" };
    return { ok: true, cost };
  }

  connect(fromId: string, fromPort: number, toId: string, toPort: number): boolean {
    const chk = this.canConnect(fromId, fromPort, toId, toPort);
    if (!chk.ok) return false;
    const fm = this.getMachine(fromId)!, tm = this.getMachine(toId)!;
    const p: Pipe = { id: nid("p"), from: { m: fromId, port: fromPort }, to: { m: toId, port: toPort }, material: fm.outputs[fromPort].material, flow: 0 };
    fm.outputs[fromPort].pipeId = p.id;
    tm.inputs[toPort].pipeId = p.id;
    this.pipes.push(p);
    this.cash -= chk.cost!; this.totalSpent += chk.cost!;
    return true;
  }

  removePipe(id: string) {
    const p = this.getPipe(id); if (!p) return;
    this.detach(p);
    this.pipes = this.pipes.filter((x) => x.id !== id);
  }

  // ---- flow solve (pull from the shaft) -----------------------------------

  solve() {
    for (const m of this.machines) { m.rate = 0; m.state = "off"; }
    for (const p of this.pipes) p.flow = 0;

    const shaft = this.machines.find((m) => this.spec(m).kind === "sink");
    let delivered = 0;
    if (shaft) {
      const feedPipe = shaft.inputs[0]?.pipeId ? this.getPipe(shaft.inputs[0].pipeId!) : null;
      if (feedPipe) {
        const feeder = this.getMachine(feedPipe.from.m);
        if (feeder) delivered = this.pull(feeder, Infinity, new Set());
        shaft.state = delivered > 0 ? "running" : "idle";
        shaft.rate = delivered;
        feedPipe.flow = delivered;
      }
    }
    this.deliveredM3h = delivered;

    // classify machines that weren't pulled (not delivering) for readable state
    for (const m of this.machines) {
      const s = this.spec(m);
      if (s.kind === "source") { if (m.state === "off") m.state = "idle"; continue; }
      if (s.kind === "sink") continue;
      if (m.rate > 0) continue;
      const missingInput = m.inputs.some((sl) => !sl.pipeId);
      const noOutput = m.outputs.length > 0 && !m.outputs[0].pipeId;
      m.state = missingInput ? "starved" : noOutput ? "idle" : "idle";
    }
  }

  private pull(m: Machine, demand: number, seen: Set<string>): number {
    if (seen.has(m.id)) return 0; // guard against cycles
    seen.add(m.id);
    const s = this.spec(m);
    const cap = m.capOverride ?? s.cap;
    if (s.kind === "source") {
      const out = Math.min(cap, demand);
      m.rate = out; m.state = out > 0.01 ? "running" : cap <= 0 ? "starved" : "idle";
      seen.delete(m.id);
      return out;
    }
    const want = Math.min(cap, demand);
    let producible = want;
    let anyMissing = false;
    s.inputs.forEach((_mat, i) => {
      const slot = m.inputs[i];
      const ratio = s.ratios ? s.ratios[i] : 1;
      if (!slot.pipeId) { producible = 0; anyMissing = true; return; }
      const pipe = this.getPipe(slot.pipeId)!;
      const from = this.getMachine(pipe.from.m)!;
      const got = this.pull(from, want * ratio, seen);
      producible = Math.min(producible, ratio > 0 ? got / ratio : Infinity);
    });
    producible = Math.max(0, producible);
    m.rate = producible;
    m.state = anyMissing ? "starved" : producible <= 0.01 ? "starved" : producible < want - 0.05 ? "throttled" : "running";
    // set pipe flows for animation
    s.inputs.forEach((_mat, i) => {
      const slot = m.inputs[i];
      if (slot.pipeId) this.getPipe(slot.pipeId)!.flow = producible * (s.ratios ? s.ratios[i] : 1);
    });
    if (m.outputs[0]?.pipeId) this.getPipe(m.outputs[0].pipeId)!.flow = producible;
    seen.delete(m.id);
    return producible;
  }

  // ---- geometry -----------------------------------------------------------

  portPos(m: Machine, side: "in" | "out", index: number): { x: number; y: number } {
    const s = this.spec(m);
    const n = side === "in" ? Math.max(1, m.inputs.length) : Math.max(1, m.outputs.length);
    const x = side === "in" ? m.col * TILE : (m.col + s.w) * TILE;
    const y = (m.row + ((index + 0.5) / n) * s.h) * TILE;
    return { x, y };
  }
}

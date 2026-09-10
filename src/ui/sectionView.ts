// Stage rendering (GDD 02/06).
//  - board: living-mine overview (shaft, levels, stopes, built trunk).
//  - design/pour: the interactive UDS section — lay pipe, place chokes/boosters,
//    watch the HGL recolour and paste flow. This is the puzzle you build.

import type { Game, StopeRun, StopeStatus } from "../sim/state.js";
import type { PathProfile, SegProfile } from "../sim/types.js";
import { pathSegmentsFor, segmentById, nodeById, PIPE_CLASSES, UDS_SEGMENTS } from "../sim/scenario.js";

const TOP = 48, BOT = 300, MAXDEPTH = 450, SHAFTX = 74, PXH = 1.15;
const py = (d: number) => TOP + (d / MAXDEPTH) * (BOT - TOP);
const nodePx = (id: string) => { const n = nodeById(id); return { x: SHAFTX + n.xM * PXH, y: py(n.depthM) }; };

export function stageSvg(game: Game): string {
  return game.view === "pour" && game.activeStope() ? pathEditorSvg(game) : mineOverviewSvg(game);
}

// ---- pressure colour --------------------------------------------------------
function segColor(s: SegProfile): string {
  if (s.classIndex == null) return "#3a4e5e";
  if (s.burst) return "#ff4d4d";
  if (s.slack) return "#4aa8ff";
  const ratio = s.maxP / (s.ratingMpa || 1);
  return ratio > 0.85 ? "#ffb020" : "#39d98a";
}
const classWidth = (ci: number | null) => (ci == null ? 3 : PIPE_CLASSES[ci].diameterMm >= 200 ? 8 : 5.5);

// ============================ INTERACTIVE EDITOR =============================

function pathEditorSvg(game: Game): string {
  const st = game.activeStope()!;
  const editing = game.pourPhase === "design";
  const pouring = game.pourPhase === "pouring";
  const pp: PathProfile = game.designProfile(st.spec.id);
  const segIds = pathSegmentsFor(st.spec.id);

  let out = svgHead();

  // level guide lines for the depths this path touches
  const depths = new Set<number>([0]);
  segIds.forEach((id) => { depths.add(nodeById(segmentById(id).to).depthM); });
  for (const d of depths) {
    if (d === 0) continue;
    out += `<line x1="0" y1="${py(d)}" x2="480" y2="${py(d)}" stroke="#243645" stroke-width="1" stroke-dasharray="3 5"/>
      <text x="6" y="${py(d) - 5}" class="svg-label dim">−${d} m</text>`;
  }

  // HGL polyline (offset from the pipe by pressure) — the signature overlay
  out += hglOverlay(pp);

  // segments
  for (const s of pp.segs) {
    const spec = segmentById(s.segId);
    const a = nodePx(spec.from), b = nodePx(spec.to);
    const built = game.builtSegs.has(s.segId);
    const color = segColor(s);
    const w = classWidth(s.classIndex);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;

    if (s.classIndex == null) {
      // ghost slot — click to lay pipe
      out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#2c3f4e" stroke-width="3" stroke-dasharray="5 6"/>`;
      if (editing) out += `<text x="${mx + 8}" y="${my}" class="svg-label" fill="#7f93a5">＋ lay pipe</text>`;
    } else {
      out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#4a5f70" stroke-width="${w + 3}" stroke-linecap="round"/>`;
      out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
      // paste flow if the whole line is good and (pouring or previewing)
      if (pp.reticulated && !s.burst && !s.slack) {
        const cls = pouring && game.pour.currentFlowM3h > 1 ? "paste-flow" : "paste-flow slow";
        out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#e0a84f" stroke-width="${Math.max(2, w - 3)}" stroke-linecap="round" class="${cls}"/>`;
      }
      // class label
      out += `<text x="${mx}" y="${my - 7}" class="svg-label center" fill="#c7d6e2">${PIPE_CLASSES[s.classIndex].ratingMpa}·bar</text>`;
      if (built) out += `<text x="${mx}" y="${my + 12}" class="svg-label center dim">built</text>`;
    }

    // station marker at the head
    out += stationMarker(a, b, spec.kind, s.station, editing);

    // click hitboxes (segment = cycle pipe; station tab = cycle station)
    if (editing && !built) {
      out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="transparent" stroke-width="18" style="cursor:pointer" data-action="seg" data-id="${s.segId}"/>`;
      const hx = a.x + (b.x - a.x) * 0.22, hy = a.y + (b.y - a.y) * 0.22;
      out += `<circle cx="${hx}" cy="${hy}" r="11" fill="transparent" style="cursor:pointer" data-action="station" data-id="${s.segId}"/>`;
    }
  }

  // node pressure chips
  for (const n of pp.nodes) {
    const p = nodePx(n.id);
    const spec = nodeById(n.id);
    if (spec.kind === "collar") {
      out += `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#0c1620" stroke="#4a687f"/>
        <text x="${p.x - 8}" y="${p.y + 3}" class="svg-label" text-anchor="end" fill="#9fb3c4">${n.P.toFixed(1)}</text>`;
    }
  }

  // plant
  const plant = nodePx("plant");
  out += `<rect x="${plant.x - 34}" y="${plant.y - 30}" width="68" height="26" rx="3" fill="#243646" stroke="#4a687f"/>
    <text x="${plant.x}" y="${plant.y - 13}" class="svg-label center">PLANT</text>`;

  // stope box (filling)
  const lastNode = pp.nodes[pp.nodes.length - 1];
  const sp = nodePx(lastNode ? lastNode.id : "s150-1");
  const placed = pouring ? game.pour.placedM3 : st.placedM3;
  const frac = Math.max(0, Math.min(1, placed / st.spec.volumeM3));
  const bx = sp.x - 26, bt = sp.y - 26, bh = 52;
  out += `<rect x="${bx}" y="${bt}" width="52" height="${bh}" rx="2" fill="#0d1620" stroke="#3a5266"/>
    <rect x="${bx}" y="${bt + bh - bh * frac}" width="52" height="${bh * frac}" fill="#b5822f" opacity="0.9"/>
    <text x="${sp.x}" y="${bt - 5}" class="svg-label center">${st.spec.id}</text>
    <text x="${sp.x}" y="${bt + bh + 13}" class="svg-label center dim">${Math.round(frac * 100)}%</text>`;

  return out + "</svg>";
}

function hglOverlay(pp: PathProfile): string {
  // Draw an HGL line offset from the pipe by pressure: boreholes offset left,
  // level runs offset up. Colour by the worst margin on the path.
  const PSCALE = 5.2; // px per MPa
  const pts: string[] = [];
  const color = pp.burst ? "#ff4d4d" : pp.slack ? "#4aa8ff" : (pp.peakP / (pp.minRating || 1)) > 0.85 ? "#ffb020" : "#39d98a";
  for (let i = 0; i < pp.nodes.length; i++) {
    const n = pp.nodes[i];
    const p = nodePx(n.id);
    const spec = nodeById(n.id);
    const off = n.P * PSCALE;
    // offset left for shaft nodes, up for stope taps
    if (spec.kind === "stope") pts.push(`${p.x},${p.y - 14 - off}`);
    else pts.push(`${p.x - 12 - off},${p.y}`);
  }
  if (pts.length < 2 || !pp.allBuilt) return "";
  return `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" opacity="0.85" class="hgl-line"/>
    <text x="${pts[1].split(",")[0]}" y="${+pts[Math.floor(pts.length / 2)].split(",")[1] - 4}" class="svg-label" fill="${color}">HGL</text>`;
}

function stationMarker(a: { x: number; y: number }, b: { x: number; y: number }, kind: string, station: string | null, editing: boolean): string {
  const hx = a.x + (b.x - a.x) * 0.22, hy = a.y + (b.y - a.y) * 0.22;
  if (station === "choke") {
    return `<g><rect x="${hx - 6}" y="${hy - 6}" width="12" height="12" rx="2" fill="#3a2a12" stroke="#ffb020" stroke-width="1.5"/>
      <path d="M${hx - 4},${hy - 4} L${hx + 4},${hy + 4} M${hx + 4},${hy - 4} L${hx - 4},${hy + 4}" stroke="#ffb020" stroke-width="1.3"/>
      <text x="${hx + 10}" y="${hy + 3}" class="svg-label" fill="#ffb020">choke</text></g>`;
  }
  if (station === "booster") {
    return `<g><circle cx="${hx}" cy="${hy}" r="7" fill="#0d2b45" stroke="#4aa8ff" stroke-width="1.5"/>
      <path d="M${hx},${hy + 3} L${hx},${hy - 3} M${hx - 3},${hy} L${hx},${hy - 3} L${hx + 3},${hy}" stroke="#4aa8ff" stroke-width="1.3" fill="none"/>
      <text x="${hx + 10}" y="${hy + 3}" class="svg-label" fill="#4aa8ff">pump</text></g>`;
  }
  if (editing) return `<circle cx="${hx}" cy="${hy}" r="6" fill="none" stroke="#3a5266" stroke-width="1" stroke-dasharray="2 2"/>`;
  return "";
}

// ============================ MINE OVERVIEW (board) =========================

const STATUS_FILL: Record<StopeStatus, string> = { scheduled: "#16232f", available: "#1d2b38", filling: "#274b6e", curing: "#7a5a2e", "handed-back": "#2f6b45", failed: "#5a2330" };
const STATUS_STROKE: Record<StopeStatus, string> = { scheduled: "#33485a", available: "#ffb020", filling: "#4aa8ff", curing: "#b5822f", "handed-back": "#39d98a", failed: "#ff5a5a" };

function mineOverviewSvg(game: Game): string {
  let out = svgHead();
  // shaft
  const plant = nodePx("plant");
  out += `<rect x="${SHAFTX - 14}" y="${plant.y - 26}" width="28" height="24" fill="#243646" stroke="#4a687f"/>
    <text x="${SHAFTX}" y="${plant.y - 10}" class="svg-label center">HOIST</text>
    <line x1="${SHAFTX}" y1="${plant.y}" x2="${SHAFTX}" y2="${py(450)}" stroke="#33485a" stroke-width="6"/>`;

  // built pipes on the network (progress viz)
  for (const seg of UDS_SEGMENTS) {
    if (!game.builtSegs.has(seg.id)) continue;
    const a = nodePx(seg.from), b = nodePx(seg.to);
    out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#4a687f" stroke-width="4" stroke-linecap="round"/>
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#39d98a" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>`;
  }

  // levels + stope boxes
  for (const depth of [150, 300, 450]) {
    out += `<line x1="0" y1="${py(depth)}" x2="480" y2="${py(depth)}" stroke="#243645" stroke-width="1" stroke-dasharray="3 5"/>
      <text x="6" y="${py(depth) - 5}" class="svg-label dim">LEVEL −${depth} m</text>`;
    const stopes = game.stopes.filter((s) => s.spec.level === depth);
    stopes.forEach((st) => { out += overviewStope(st); });
  }
  return out + "</svg>";
}

function overviewStope(st: StopeRun): string {
  const p = nodePx(`s${st.spec.id}`);
  const w = 84, h = 46, x = p.x - w / 2, y = p.y - h / 2;
  const fill = STATUS_FILL[st.status], stroke = STATUS_STROKE[st.status];
  const ucs28 = st.ucsResults.find((r) => r.ageDays === 28);
  const sub = st.status === "scheduled" ? `day ${st.spec.availableDay}` : st.status === "available" ? `due ${st.spec.dueDay}` : st.status === "curing" ? "curing…" : ucs28 ? `${ucs28.achievedKpa} kPa` : st.status;
  const badge = { scheduled: "▣ mining", available: "◆ READY", filling: "▶ fill", curing: "◷ cure", "handed-back": "✔ done", failed: "✖ FAIL" }[st.status];
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${st.status === "available" ? 2 : 1}"/>
    <text x="${p.x}" y="${y + 16}" class="svg-label center">${st.spec.id}</text>
    <text x="${p.x}" y="${y + 30}" class="svg-label center dim">${sub}</text>
    <text x="${p.x}" y="${y + 42}" class="svg-label center" fill="${stroke}">${badge}</text>
  </g>`;
}

function svgHead(): string {
  return `<svg viewBox="0 0 480 340" class="section-svg" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="rock" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14202b"/><stop offset="1" stop-color="#0a121a"/></linearGradient></defs>
    <rect x="0" y="0" width="480" height="${TOP}" fill="#1b2a38"/>
    <rect x="0" y="${TOP}" width="480" height="${340 - TOP}" fill="url(#rock)"/>
    <line x1="0" y1="${TOP}" x2="480" y2="${TOP}" stroke="#3a5266" stroke-width="1.5"/>
    <text x="6" y="16" class="svg-label dim">SURFACE</text>`;
}

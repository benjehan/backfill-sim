// Stage rendering (GDD 02/06). Two drawings:
//  - the living-mine overview (board): shaft, levels, stopes coloured by status.
//  - the pour section (active stope): the engineering drawing with the HGL.

import type { Game, StopeRun, StopeStatus } from "../sim/state.js";

export function stageSvg(game: Game): string {
  return game.view === "pour" && game.activeStope() ? pourSectionSvg(game) : mineOverviewSvg(game);
}

const STATUS_FILL: Record<StopeStatus, string> = {
  scheduled: "#16232f",
  available: "#1d2b38",
  filling: "#274b6e",
  curing: "#7a5a2e",
  "handed-back": "#2f6b45",
  failed: "#5a2330",
};
const STATUS_STROKE: Record<StopeStatus, string> = {
  scheduled: "#33485a",
  available: "#ffb020",
  filling: "#4aa8ff",
  curing: "#b5822f",
  "handed-back": "#39d98a",
  failed: "#ff5a5a",
};

function mineOverviewSvg(game: Game): string {
  const surfaceY = 42;
  const shaftX = 66;
  const levels = [
    { depth: 150, y: 130 },
    { depth: 300, y: 210 },
    { depth: 450, y: 292 },
  ];
  const colX = [190, 330];

  const levelRows = levels
    .map((lv) => {
      const stopes = game.stopes.filter((s) => s.spec.level === lv.depth);
      const line = `<line x1="${shaftX}" y1="${lv.y}" x2="460" y2="${lv.y}" stroke="#2a3d4d" stroke-width="1" stroke-dasharray="4 4"/>
        <text x="8" y="${lv.y - 6}" class="svg-label dim">LEVEL · −${lv.depth} m</text>`;
      const boxes = stopes
        .map((st, i) => stopeBox(st, colX[i] ?? 190 + i * 140, lv.y - 26, st.spec.id === game.activeStopeId))
        .join("");
      return line + boxes;
    })
    .join("");

  const blasts = game.stopes.length ? "" : ""; // placeholder (blast flavour is in the log)

  return `
<svg viewBox="0 0 480 340" class="section-svg" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="rock" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#14202b"/><stop offset="1" stop-color="#0a121a"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="480" height="${surfaceY}" fill="#1b2a38"/>
  <rect x="0" y="${surfaceY}" width="480" height="${340 - surfaceY}" fill="url(#rock)"/>
  <line x1="0" y1="${surfaceY}" x2="480" y2="${surfaceY}" stroke="#3a5266" stroke-width="1.5"/>
  <text x="8" y="18" class="svg-label dim">SURFACE</text>

  <!-- headframe + shaft -->
  <rect x="${shaftX - 14}" y="${surfaceY - 26}" width="28" height="24" fill="#243646" stroke="#4a687f"/>
  <text x="${shaftX}" y="${surfaceY - 10}" class="svg-label center">HOIST</text>
  <line x1="${shaftX}" y1="${surfaceY}" x2="${shaftX}" y2="302" stroke="#3a4e5e" stroke-width="6"/>
  <rect x="${shaftX - 4}" y="${surfaceY}" width="8" height="16" fill="#8fa9bd" class="skip"/>

  ${levelRows}
  ${blasts}
</svg>`;
}

function stopeBox(st: StopeRun, x: number, y: number, active: boolean): string {
  const w = 96, h = 52;
  const fill = STATUS_FILL[st.status];
  const stroke = STATUS_STROKE[st.status];
  const sw = active ? 3 : st.status === "available" ? 2 : 1;
  // curing / handed-back show a paste fill level
  const filled = st.status === "curing" || st.status === "handed-back" || st.status === "failed";
  const fillRect = filled
    ? `<rect x="${x}" y="${y + 6}" width="${w}" height="${h - 6}" fill="${stroke}" opacity="0.28"/>`
    : "";
  const badge = statusBadge(st.status);
  const ucs28 = st.ucsResults.find((r) => r.ageDays === 28);
  const sub =
    st.status === "scheduled" ? `avail day ${st.spec.availableDay}` :
    st.status === "available" ? `due day ${st.spec.dueDay}` :
    st.status === "curing" ? `curing…` :
    ucs28 ? `${ucs28.achievedKpa} kPa` : st.status;
  return `
    <g class="${active ? "stope-active" : ""}">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
      ${fillRect}
      <text x="${x + w / 2}" y="${y + 18}" class="svg-label center">${st.spec.id}</text>
      <text x="${x + w / 2}" y="${y + 33}" class="svg-label center dim">${sub}</text>
      <text x="${x + w / 2}" y="${y + 47}" class="svg-label center" fill="${stroke}">${badge}</text>
    </g>`;
}

function statusBadge(s: StopeStatus): string {
  return {
    scheduled: "▣ mining", available: "◆ READY", filling: "▶ filling",
    curing: "◷ curing", "handed-back": "✔ done", failed: "✖ FAILED",
  }[s];
}

function pourSectionSvg(game: Game): string {
  const st = game.activeStope()!;
  const ev = game.evalRecipe(st);
  const peak = ev.peakPressureMpa;
  const rating = ev.ratingMpa;
  const margin = ev.hglMargin;

  const surfaceY = 50, plantX = 62, boreX = 62, stopeX = 350;
  const drop = st.spec.verticalDropM;
  const boreBottomY = surfaceY + 20 + (drop / 450) * 210; // deeper = longer borehole
  const levelY = boreBottomY;

  const hglColor = peak > rating ? "#ff4d4d" : margin < 0.15 ? "#ffb020" : "#39d98a";
  const flowing = game.pourPhase === "pouring" && game.pour.currentFlowM3h > 1;
  const slack = ev.regime === "slack-risk";
  const pipeFlowClass = flowing ? (slack ? "paste-flow slack" : "paste-flow") : "paste-idle";

  const placed = game.pourPhase === "pouring" ? game.pour.placedM3 : st.placedM3;
  const fillFrac = Math.max(0, Math.min(1, placed / st.spec.volumeM3));
  const stopeTop = boreBottomY - 40, stopeBot = boreBottomY + 40, stopeH = stopeBot - stopeTop;
  const fillY = stopeBot - stopeH * fillFrac;

  const scale = 70 / Math.max(rating, peak, 6);
  const hglBore = boreBottomY - peak * scale;
  const ratingLineBore = boreBottomY - rating * scale;

  return `
<svg viewBox="0 0 480 340" class="section-svg" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="rock2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#14202b"/><stop offset="1" stop-color="#0a121a"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="480" height="${surfaceY}" fill="#1b2a38"/>
  <rect x="0" y="${surfaceY}" width="480" height="${340 - surfaceY}" fill="url(#rock2)"/>
  <line x1="0" y1="${surfaceY}" x2="480" y2="${surfaceY}" stroke="#3a5266" stroke-width="1.5"/>
  <text x="8" y="18" class="svg-label dim">SURFACE</text>
  <line x1="0" y1="${levelY}" x2="480" y2="${levelY}" stroke="#2a3d4d" stroke-width="1" stroke-dasharray="4 4"/>
  <text x="8" y="${levelY - 8}" class="svg-label dim">LEVEL · −${drop} m</text>

  <polyline points="${plantX},${surfaceY} ${boreX},${boreBottomY} ${stopeX},${levelY}"
    fill="none" stroke="#5b7387" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="${plantX},${surfaceY} ${boreX},${boreBottomY} ${stopeX},${levelY}"
    fill="none" stroke="#8fa9bd" stroke-width="3" stroke-linejoin="round" class="${pipeFlowClass}"/>

  <polyline points="${plantX},${surfaceY - 4} ${boreX + 8},${hglBore} ${stopeX},${levelY - Math.max(0, peak - ev.frictionLossMpa * 0.5) * scale * 0.4}"
    fill="none" stroke="${hglColor}" stroke-width="2.5" opacity="0.95"/>
  <circle cx="${boreX + 8}" cy="${hglBore}" r="4" fill="${hglColor}"/>
  <text x="${boreX + 16}" y="${hglBore - 6}" class="svg-label" fill="${hglColor}">HGL ${peak.toFixed(1)} MPa</text>
  <line x1="${boreX - 6}" y1="${ratingLineBore}" x2="${boreX + 60}" y2="${ratingLineBore}" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
  <text x="${boreX + 62}" y="${ratingLineBore + 3}" class="svg-label" fill="#ff8f8f">rating ${rating} MPa</text>

  <rect x="${plantX - 40}" y="${surfaceY - 30}" width="80" height="28" rx="3" fill="#243646" stroke="#4a687f"/>
  <text x="${plantX}" y="${surfaceY - 12}" class="svg-label center">PLANT</text>

  <rect x="${stopeX - 40}" y="${stopeTop}" width="80" height="${stopeH}" rx="2" fill="#0d1620" stroke="#3a5266"/>
  <rect x="${stopeX - 40}" y="${fillY}" width="80" height="${stopeBot - fillY}" fill="#b5822f" opacity="0.9"/>
  <text x="${stopeX}" y="${stopeTop - 6}" class="svg-label center">${st.spec.id}</text>
  <text x="${stopeX}" y="${stopeBot + 14}" class="svg-label center dim">${Math.round(fillFrac * 100)}% filled</text>
</svg>`;
}

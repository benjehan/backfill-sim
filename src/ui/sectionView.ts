// The underground section view (GDD 06): the engineering drawing.
// Plant on surface -> borehole down -> on-level run -> stope. HGL drawn over the
// profile, coloured green/amber/red vs the pipe rating. Paste flows when pouring.

import type { Game } from "../sim/state.js";

export function sectionSvg(game: Game): string {
  const ev = game.evalRecipe();
  const peak = ev.peakPressureMpa;
  const rating = ev.ratingMpa;
  const margin = ev.hglMargin;

  // Layout coordinates (viewBox 0 0 420 320)
  const plantX = 60, surfaceY = 58;
  const boreX = 60, boreBottomY = 250;
  const stopeX = 340, levelY = 250;

  // HGL colour by margin (GDD 06)
  const hglColor =
    peak > rating ? "#ff4d4d" : margin < 0.15 ? "#ffb020" : "#39d98a";

  // Paste flow state
  const flowing = game.phase === "pouring" && game.pour.currentFlowM3h > 1;
  const slack = ev.regime === "slack-risk";
  const pipeFlowClass = flowing ? (slack ? "paste-flow slack" : "paste-flow") : "paste-idle";

  // Stope fill level (rises during pour and stays for cure)
  const fillFrac = clamp(
    (game.phase === "pouring" ? game.pour.placedM3 : (game.kpis?.volumePlacedM3 ?? (game.phase === "curing" || game.phase === "qaqc" || game.phase === "reconcile" ? game.pour.placedM3 : 0))) /
      game.stope.volumeM3,
    0,
    1,
  );
  const stopeTop = 205, stopeBot = 285, stopeH = stopeBot - stopeTop;
  const fillY = stopeBot - stopeH * fillFrac;

  // HGL profile: pressure ~0 at plant, peaks at borehole base, ~0 at stope.
  const scale = 70 / Math.max(rating, peak, 6); // px per MPa above the pipe
  const hglPlant = surfaceY - 4;
  const hglBore = boreBottomY - peak * scale;
  const hglStope = levelY - Math.max(0, peak - ev.frictionLossMpa * 0.5) * scale * 0.4;
  const ratingLineBore = boreBottomY - rating * scale;

  return `
<svg viewBox="0 0 420 320" class="section-svg" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="rock" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#14202b"/>
      <stop offset="1" stop-color="#0a121a"/>
    </linearGradient>
  </defs>

  <!-- sky / surface -->
  <rect x="0" y="0" width="420" height="${surfaceY}" fill="#1b2a38"/>
  <rect x="0" y="${surfaceY}" width="420" height="${320 - surfaceY}" fill="url(#rock)"/>
  <line x1="0" y1="${surfaceY}" x2="420" y2="${surfaceY}" stroke="#3a5266" stroke-width="1.5"/>
  <text x="8" y="18" class="svg-label dim">SURFACE</text>
  <text x="8" y="${levelY - 8}" class="svg-label dim">LEVEL 1 · −150 m</text>
  <line x1="0" y1="${levelY}" x2="420" y2="${levelY}" stroke="#2a3d4d" stroke-width="1" stroke-dasharray="4 4"/>

  <!-- pipe profile -->
  <polyline points="${plantX},${surfaceY} ${boreX},${boreBottomY} ${stopeX},${levelY}"
    fill="none" stroke="#5b7387" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="${plantX},${surfaceY} ${boreX},${boreBottomY} ${stopeX},${levelY}"
    fill="none" stroke="#8fa9bd" stroke-width="3" stroke-linejoin="round" class="${pipeFlowClass}"/>

  <!-- HGL overlay (green/amber/red vs rating) -->
  <polyline points="${plantX},${hglPlant} ${boreX + 8},${hglBore} ${stopeX},${hglStope}"
    fill="none" stroke="${hglColor}" stroke-width="2.5" stroke-dasharray="1 0" opacity="0.95"/>
  <circle cx="${boreX + 8}" cy="${hglBore}" r="4" fill="${hglColor}"/>
  <text x="${boreX + 16}" y="${hglBore - 6}" class="svg-label" fill="${hglColor}">HGL ${peak.toFixed(1)} MPa</text>
  <!-- rating reference at the critical point -->
  <line x1="${boreX - 6}" y1="${ratingLineBore}" x2="${boreX + 60}" y2="${ratingLineBore}"
    stroke="#ff6b6b" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
  <text x="${boreX + 62}" y="${ratingLineBore + 3}" class="svg-label" fill="#ff8f8f">rating ${rating} MPa</text>

  <!-- plant -->
  <rect x="${plantX - 40}" y="${surfaceY - 30}" width="80" height="28" rx="3" fill="#243646" stroke="#4a687f"/>
  <text x="${plantX}" y="${surfaceY - 12}" class="svg-label center">PLANT</text>

  <!-- stope -->
  <rect x="${stopeX - 40}" y="${stopeTop}" width="80" height="${stopeH}" rx="2" fill="#0d1620" stroke="#3a5266"/>
  <rect x="${stopeX - 40}" y="${fillY}" width="80" height="${stopeBot - fillY}" fill="${game.phase === "curing" ? "#7a5a2e" : "#b5822f"}" opacity="0.9"/>
  <text x="${stopeX}" y="${stopeTop - 6}" class="svg-label center">${game.stope.id}</text>
  <text x="${stopeX}" y="${stopeBot + 14}" class="svg-label center dim">${Math.round(fillFrac * 100)}% filled</text>
</svg>`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

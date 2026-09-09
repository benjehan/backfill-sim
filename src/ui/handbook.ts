// The Backfill Handbook (GDD 10): in-game encyclopedia. Hover any term to learn it.
// Stealth-academy layer — engineers verify correctness, new players learn for free.

export const GLOSSARY: Record<string, string> = {
  paste:
    "Paste backfill: 70–80% solids by mass, laminar flow, all water stays in the stope so it MUST be cemented. The dense, modern fill.",
  "yield-stress":
    "Yield stress: the shear stress that must be exceeded before paste flows. Rises steeply near maximum solids — the core of the recipe tension.",
  friction:
    "Friction gradient (kPa/m): pressure lost per metre of pipe as paste flows. Paste sits in a 3–8 kPa/m band, climbing sharply when the mix is too thick.",
  "static-head":
    "Static head (ρgh): pressure from the vertical column of paste. 150 m of paste at ρ=1800 kg/m³ ≈ 2.6 MPa. Gravity gives you head for free — and a pressure problem at the bottom.",
  hgl:
    "Hydraulic Grade Line: the pressure profile drawn over the pipe. Kept below the pipe's pressure rating (green), it flows safely. Touch the rating (red) and the line bursts.",
  ucs:
    "Unconfined Compressive Strength (kPa): how strong the cured fill is. Develops over cure time — cylinders are crushed at 7 and 28 days to prove the recipe worked.",
  binder:
    "Binder (cement): what gives fill its strength. It is ~70% of operating cost, so every kilo you cut — without losing strength — is money saved.",
  "cure-time":
    "Cure time: fill gains strength over days after the pour. The stope cannot be handed back to mining until it meets its strength gate. The master clock of the game.",
  plug:
    "Plug: a blockage in the pipe. Signalled by pressure rising while flow falls. Clear it before it sets, or you're cutting steel out of a 2 km line.",
  rating:
    "Pipe pressure rating: the maximum pressure the pipe can hold (50 / 100 / 150 bar classes). Exceed it and the line bursts under pressure.",
  slack:
    "Slack flow: the line isn't running full, paste free-falls with an air interface. Accelerates wear and risks blockages. Keep the line full.",
  reconciliation:
    "Reconciliation: tonnes out of the plant vs tonnes placed in the stope. A gap means losses — wastage, metering error, or worse.",
  "pour-note":
    "Pour note (fill note): the instruction for a pour — stope, phase, mix design, flow, volume, dates. Issued, approved, then executed and reconciled.",
  barricade:
    "Barricade / fill fence: the wall that retains fresh paste in the stope. It must be installed, cured and signed off by geotech before a pour. A failure is a runaway.",
  "low-solids-start":
    "Low-solids start-up: begin a pour with water then a thinner mix to fill the line safely, before ramping to the main recipe. Skipping it spikes plug risk.",
};

export function term(key: keyof typeof GLOSSARY | string, label?: string): string {
  const def = GLOSSARY[key] ?? "";
  const text = label ?? key;
  return `<span class="term" data-tip="${escapeAttr(def)}">${text}</span>`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

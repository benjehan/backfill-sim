// Campaign scenarios. Both keep the 3-level / 6-stope cutaway geometry, but vary
// the numbers that change how the operation plays: mine depth (static head — the
// reticulation puzzle), budget, horizon, orebody, schedule pressure, strength
// targets and terrain look. Deepstar is the harder deep mine that leans on the
// UDS tools (chokes, drilled boreholes, boosters).

export interface TerrainTheme { gravel: string; dirt: string; scrub: string; hills: string; rock: string; }

export interface Scenario {
  id: string;
  name: string;        // mine name (HUD brand)
  blurb: string;       // one-line pitch on the select screen
  difficulty: string;
  startCash: number;
  horizonDays: number;
  orebody: number;     // tonnes in the ground
  depths: [number, number, number];  // real depth of each level (drives static head)
  schedule: { a: number; d: number }[]; // 6 stopes: availableDay, dueDay
  vol: { base: number; sx: number; depth: number };  // stope volume formula
  ucs: { base: number; perLevel: number; primary: number }; // 28-day strength targets
  terrain: TerrainTheme;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "wheal-verity",
    name: "Wheal Verity",
    blurb: "A steady Cornish tin mine. Room to learn the trade.",
    difficulty: "Standard",
    startCash: 150_000_000,
    horizonDays: 60,
    orebody: 230_000,
    depths: [150, 300, 450],
    schedule: [{ a: 1, d: 12 }, { a: 4, d: 18 }, { a: 8, d: 26 }, { a: 12, d: 32 }, { a: 18, d: 42 }, { a: 24, d: 50 }],
    vol: { base: 6000, sx: 55, depth: 3.5 },
    ucs: { base: 500, perLevel: 120, primary: 180 },
    terrain: { gravel: "#8f8578", dirt: "#7c6b4c", scrub: "#6f8a4e", hills: "#516d3c", rock: "#948a7a" },
  },
  {
    id: "deepstar-deeps",
    name: "Deepstar Deeps",
    blurb: "A deep, arid gold mine — huge static head, tight budget, ruthless schedule. Master the boreholes.",
    difficulty: "Hard",
    startCash: 120_000_000,
    horizonDays: 52,
    orebody: 300_000,
    depths: [300, 550, 800],
    schedule: [{ a: 1, d: 10 }, { a: 3, d: 15 }, { a: 7, d: 22 }, { a: 10, d: 27 }, { a: 15, d: 36 }, { a: 20, d: 42 }],
    vol: { base: 6500, sx: 60, depth: 3 },
    ucs: { base: 600, perLevel: 150, primary: 220 },
    terrain: { gravel: "#9a8e78", dirt: "#8a6f4a", scrub: "#9a8f5a", hills: "#6e6a42", rock: "#a89876" },
  },
];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];

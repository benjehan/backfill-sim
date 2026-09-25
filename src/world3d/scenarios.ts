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
  wet?: { dewaterPerDay: number; waterInflow: number }; // flooded mine: $/day to pump out + m³/day groundwater into the pond
  binder?: { deliveryMult: number; costMult: number };  // remote mine: throttled + pricier cement, pushing you to CAF/HF
  mineralogy?: { label: string; note: string; varianceAdd: number; latePenalty: number; reactive?: boolean; reagent?: "sulphide" | "gravity" | "clay" | "polymetallic" }; // tailings risk revealed by test-work; reactive ⇒ reject needs containment; reagent = the ore's ideal flotation/flocculant suite
  climate?: { label: string; rain: number; storm: number; heat: number; cold?: boolean }; // per-roll weather probabilities; cold ⇒ baseline slow cure
  relief?: number; // terrain ruggedness multiplier (<1 low wetlands, >1 rugged); default 1
  land?: "hills" | "mountains" | "seaside" | "valley" | "desert"; // biome shape of the terrain
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
    mineralogy: { label: "Clean tin tailings", note: "low sulphide, predictable — a forgiving material", varianceAdd: 0, latePenalty: 0.03, reagent: "gravity" },
    climate: { label: "Temperate", rain: 0.3, storm: 0.05, heat: 0 },
    relief: 1.0, land: "hills",
  },
  {
    id: "deepstar-deeps",
    name: "Deepstar Deeps",
    blurb: "A deep, arid gold mine — huge static head, tight budget, ruthless schedule. Master the boreholes.",
    difficulty: "Deep",
    startCash: 120_000_000,
    horizonDays: 52,
    orebody: 300_000,
    depths: [300, 550, 800],
    schedule: [{ a: 1, d: 10 }, { a: 3, d: 15 }, { a: 7, d: 22 }, { a: 10, d: 27 }, { a: 15, d: 36 }, { a: 20, d: 42 }],
    vol: { base: 6500, sx: 60, depth: 3 },
    ucs: { base: 600, perLevel: 150, primary: 220 },
    terrain: { gravel: "#9a8e78", dirt: "#8a6f4a", scrub: "#9a8f5a", hills: "#6e6a42", rock: "#a89876" },
    mineralogy: { label: "Sulphidic (pyrite)", note: "sulphide oxidation → internal sulphate attack; delayed strength loss unless you design for it. PAG reject needs containment", varianceAdd: 0.02, latePenalty: 0.14, reactive: true, reagent: "sulphide" },
    climate: { label: "Arid", rain: 0.05, storm: 0.05, heat: 0.35 },
    relief: 1.6, land: "desert",
  },
  {
    id: "drowned-level",
    name: "The Drowned Level",
    blurb: "A mine below the water table. Groundwater floods the pond (free mixing water) but never stops rising — dewater or drown.",
    difficulty: "Flooded",
    startCash: 135_000_000,
    horizonDays: 56,
    orebody: 260_000,
    depths: [200, 380, 560],
    schedule: [{ a: 1, d: 11 }, { a: 4, d: 17 }, { a: 8, d: 24 }, { a: 12, d: 30 }, { a: 17, d: 40 }, { a: 22, d: 46 }],
    vol: { base: 6200, sx: 58, depth: 3.2 },
    ucs: { base: 560, perLevel: 135, primary: 200 },
    terrain: { gravel: "#6f7378", dirt: "#5a5f52", scrub: "#4e6a4a", hills: "#3d5340", rock: "#6a7078" },
    wet: { dewaterPerDay: 190_000, waterInflow: 16_000 },
    mineralogy: { label: "Clay-rich", note: "high water demand & swelling clays — variable rheology, harder to control", varianceAdd: 0.06, latePenalty: 0.04, reagent: "clay" },
    climate: { label: "Tropical (wet)", rain: 0.5, storm: 0.15, heat: 0.05 },
    relief: 0.5, land: "seaside",
  },
  {
    id: "wolfram-reach",
    name: "Wolfram Reach",
    blurb: "A remote tungsten mine at the end of the line. Cement barely trickles in and costs a fortune — go easy on the paste, lean on CAF and hydraulic fill.",
    difficulty: "Remote",
    startCash: 140_000_000,
    horizonDays: 58,
    orebody: 250_000,
    depths: [200, 350, 500],
    schedule: [{ a: 1, d: 12 }, { a: 4, d: 18 }, { a: 8, d: 25 }, { a: 12, d: 31 }, { a: 18, d: 41 }, { a: 24, d: 48 }],
    vol: { base: 6000, sx: 55, depth: 3.4 },
    ucs: { base: 520, perLevel: 130, primary: 190 },
    terrain: { gravel: "#7a8088", dirt: "#6a6a62", scrub: "#6a7a6e", hills: "#4f5a54", rock: "#8a9098" },
    binder: { deliveryMult: 0.45, costMult: 1.7 },
    mineralogy: { label: "Variable tungsten tails", note: "inconsistent PSD run to run — variance is the enemy; consistently bad beats highly variable. Reagent-bearing reject needs containment", varianceAdd: 0.05, latePenalty: 0.06, reactive: true, reagent: "gravity" },
    climate: { label: "Cold &amp; remote", rain: 0.2, storm: 0.2, heat: 0, cold: true },
    relief: 1.9, land: "mountains",
  },
];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];

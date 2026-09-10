# Backfill Sim

A pauseable **backfill management simulation** — you are the Backfill Operations Manager
of a working mine, and you design the mix, build the line, run the pour, cure the fill and
answer for the numbers. Factorio's body, Frostpunk's event beats, Papers-Please paperwork
with soul. Built from the GDD v1 package in `~/hermes-docs/backfill-game/gdd-v1/`.

## Status: v1 — campaign slice ("living mine") on top of the full pour loop

**Slice 2 (current): the multi-stope schedule & living mine (GDD 02/03/10).**
Wheal Verity now runs as a **campaign**: a rolling schedule of 6 stopes across three
levels (−150/−300/−450 m) becomes available on a staggered plan. One global clock never
stops — you fill stopes while others cure in the background, due dates bite (late fills
stall mining: cost/day + the manager's mood), the mine blasts, hoists and develops around
you, and **earned, telegraphed events** interrupt with real decisions (binder-rail delay,
mill trip, geotech barricade flag, seismic-during-pour). Deeper stopes carry more static
head (ρgh), forcing higher-rated pipe — difficulty escalates with depth. The campaign ends
in a **board review** graded S–D across fill rate, schedule adherence, cost vs budget,
safety and manager mood.

The board is the mission control: a **living-mine section** (shaft, levels, stopes coloured
by lifecycle) beside the **schedule board**, budget/mood meters and a mine-activity log.

### Slice 1: the complete pour loop (folded in, runs per stope)

Each stope you select runs the full loop from the first slice:

1. **Briefing** — the mine manager hands you the stope, target UCS and due date.
2. **Design** — tune % solids and binder dose against a real rheology curve. Live readout
   of yield stress, friction gradient, static head (ρgh), the HGL vs pipe rating, predicted
   28-day UCS and cost/m³. **Both Manager and Engineer presentation modes** from the start
   (gauges + lights vs raw kPa/m tables). Auto-recipe helper proposes the lowest-binder mix.
3. **Pre-pour** — checklist (skip an item and it bites later), pour note issue + approval.
4. **The pour** — the tense verb: watch pressure and the HGL, manage flow, flush a forming
   plug, or push too hard and burst the line.
5. **Flush & cure** — clean the line, then fill gains strength over the cure clock.
6. **QA/QC** — cylinders crushed at 7 and 28 days reveal whether the recipe *actually* hit
   strength. The signature delayed consequence: cut binder to save money, fail a month later.
7. **Reconcile** — scorecard (cost/tonne, UCS pass rate, schedule, reconciliation gap,
   safety) graded S–D, plus the mine manager's verdict.

The **Backfill Handbook** is wired in: hover any dotted term for a plain-language definition.

## Design principle

A **pure-TypeScript simulation core** (`src/sim/`) holds all the real physics and economy,
UI-agnostic and portable. The presentation (`src/ui/`) is SVG (the section view + HGL) and
DOM (dashboards). If a future v2 wants a 3D cutaway, the sim brain ports unchanged.

Real-number anchors (GDD 04/06/09): paste 70–80% solids, ρ≈1800 kg/m³, friction 3–8 kPa/m,
pipe ratings 50/100/150 bar, UCS design ages 7/28 days, binder ≈70% of opex.

## Run it

```bash
npm install
npm run dev      # esbuild dev server + live rebuild -> http://localhost:5173
# or a static build:
npm run build    # -> public/bundle.js
npx serve public # (or: python3 -m http.server --directory public)
```

Toggle Manager/Engineer top-right. Pause/1×/2×/4×/8× control time.

## Layout

| Path | GDD doc | Content |
|---|---|---|
| `src/sim/constants.ts` | 04/06/09 | Real-number balance anchors |
| `src/sim/physics.ts` | 04/06 | Rheology, friction, HGL, UCS/cure, auto-recipe |
| `src/sim/state.ts` | 03/07 | Clock, phase machine, pour dynamics, QA/QC, reconcile |
| `src/sim/scenario.ts` | 02 | Tutorial mine, stope, pipes, checklist, briefing |
| `src/ui/sectionView.ts` | 06 | The engineering section drawing + HGL overlay |
| `src/ui/app.ts` | 03/08 | Layout, both modes, live pour HUD, scorecard |
| `src/ui/handbook.ts` | 10 | In-game encyclopedia tooltips |

## Not yet built (next from the GDD, all scoped in the docs)

- The **UDS routing puzzle** (place boreholes/pipes/boosters yourself) — the Factorio heart.
  Today the line is abstracted to a per-stope pipe-class choice + line-prep cost.
- The **surface plant builder** (thickener/mixer/pump choices, redundancy).
- **Crews & tactical orders** (dispatch with travel time), fatigue/morale as first-class.
- Deeper **binder supply chain** (truck vs rail sourcing) and the **tech/IoT tree**.
- Scenarios 2 (deep, boosters, transients) and 3 (hydraulic-to-paste brownfield).

## Verifying

`node` + Chromium drive the whole thing headlessly. The scratchpad `campaign-check.js`
plays a full campaign end-to-end (select → design → pour → cure → events → board review)
and asserts zero JS errors; `smoke.ts` exercises the physics/balance across recipe extremes.

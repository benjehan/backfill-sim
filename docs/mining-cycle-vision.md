# Backfill Tycoon → Full Mine Tycoon — Vision & Phased Roadmap

The game today is a **backfill** tycoon: the mine, its stopes, levels and orebody
are pre-defined; you design reticulation, run the plant, pour and cure. The vision
is to **step up a level** and simulate the *whole mining cycle* that produces the
voids and the tailings in the first place — so backfill becomes the closing loop
of a real operation, not the whole game.

This doc captures the expanded vision and a build order. It is a map, not a
promise of scope. Legend: ✅ built · 🟡 partial · ❌ new.

---

## The real cycle we're modelling

Explore → Drill → define **orebody** → choose **mining method** → **develop**
access → **extract** ore (drill/blast/muck, trucks, hoist) → **process** it
(comminution → classification → concentration/flotation) → produce **concentrate**
(revenue) + **tailings streams** (various %solids slurries) → **water balance**
(thickening, dewatering, reuse, controlled slurry for reagent-bearing streams,
TSF for the rest) → the extraction leaves **voids (stopes)** → **backfill** them
(the game we have) → re-enter and mine on.

Everything downstream of "tailings streams" already exists in the game. The new
work is everything upstream, plus the world it sits in.

---

## Epic A — Backfill depth (finish the current list)
The agreed shortlist, still in flight. Small, self-contained, ship first.
- ✅ Fill-type & strength design · ✅ Barricade design + inrush · ✅ Plant-process gating + tutorial
- ❌ **A1 Plant siting → gravity head** — where you place the plant sets UDS head.
- ❌ **A2 Cement supply mode** — rail vs road vs Isotainer; silo buffer.
- ❌ **A3 Test-work + mineralogy** — a paid lab campaign reveals the true
  rheology/UCS curve and de-risks design before you can design a good mix. (This
  is also the *front door* to the upstream story — see Epic D.)

## Epic B — Exploration & the orebody (the mine stops being pre-baked)
Today the 6 stopes/levels are hard-coded. Make them *emerge*.
- ❌ **B1 Exploration** — spend on surface geophysics / soil geochem to reveal
  anomalies on the terrain; pick where to drill.
- ❌ **B2 Drilling** — drill holes into an anomaly; each hole returns assays that
  progressively reveal a 3D **orebody** (grade, tonnage, dip, depth, mineralogy).
  Confidence rises with drilling density (inferred → indicated → measured).
- ❌ **B3 Orebody model** — grade shells, ore vs waste, a real geometry the mine
  plan is cut from. Feeds cut-off grade, mining method, and eventually the stopes.
- ❌ **B4 Mineralogy from the orebody** — sulphides/clays/oxide vs sulphide ore
  set the processing route AND the tailings/backfill behaviour (ties to A3).

## Epic C — Mine design & extraction (voids are *earned*)
- ❌ **C1 Mining method choice** — open stoping (primary/secondary), cut-and-fill,
  post-pillar, etc., driven by orebody geometry/dip/ground — this is what decides
  whether/what backfill is needed (course Module 02).
- ❌ **C2 Development** — drives, cross-cuts, ore passes, ramps: the access you
  must build (cost/time) before a stope can be mined.
- ❌ **C3 Extraction loop** — drill → blast → muck → haul (LHD/trucks) → hoist/
  conveyor to surface; production rate, dilution, ground support.
- ❌ **C4 Voids → stopes** — mined-out volumes become the fillable stopes we
  already model. The backfill schedule now comes from *your* mining, not a script.

## Epic D — Processing plant & the stream network (feeds backfill)
The heart Ben described: the flowsheet that turns ore into concentrate + the
**family of slurry streams**.
- ❌ **D1 Comminution** — crushers → mills (SAG/ball); conveyors, stockpiles; power.
- ❌ **D2 Classification & concentration** — cyclones, flotation cells (or leach),
  producing **concentrate** (the revenue) and **tailings**.
- ❌ **D3 Tailings streams by %solids** — the mill throws several streams at
  different densities. Route each: the one that suits paste → to the backfill
  plant; reagent/chemical-bearing streams → **controlled/lined slurry systems**;
  the rest → **TSF**. This is the junction that connects the whole game to the
  backfill half.
- 🟡 **D4 Water balance & reuse** — thickeners/dewatering recover water; pumps and
  collection ponds return it to the process; wet mines add inflow. (Partly present
  as buildings; make it a real balance you manage.)
- 🟡 **D5 Flowsheet as a design surface** — extend the plant-interior builder from
  "backfill line" to the *whole* concentrator flowsheet, with equipment choices,
  bottlenecks, and utilisation (course Modules 11–14 apply here too).

## Epic E — Living world (terrain, land, weather, constraints)
Campaigns should differ by *place*, not just numbers.
- ❌ **E1 Varied terrain & land types** — real topography (hills/valleys/benches),
  ground/rock conditions, water table, existing land use — affecting siting,
  development cost, gravity head (ties to A1), and ground support.
- ❌ **E2 Weather & climate** — rain (stockpile moisture, roads, TSF inflow),
  heat/cold (cure temperature, freezing), storms/seasons; arid vs tropical mines.
- ❌ **E3 Real-life constraints** — permitting/regulatory, environmental limits
  (PAG encapsulation, water discharge), remoteness/logistics, power availability,
  community/land access.
- ❌ **E4 Campaign variety on top of the above** — each scenario a distinct place +
  orebody + climate + constraint set, not just budget/schedule tweaks. (Builds on
  the 4 scenarios we have.)

---

## Suggested build order (why this order)

1. **Finish Epic A** (A1→A3) — small, ships value now, and A3 (test-work +
   mineralogy) is the natural bridge into the upstream story.
2. **Epic D3 + D5 first slice** — make the mill emit *multiple tailings streams*
   you route (paste feed / controlled slurry / TSF) + water reuse. This is the
   connective tissue Ben most wants and it upgrades systems we already have.
3. **Epic B** (explore → drill → orebody) — the biggest single new subsystem; do
   it once D can consume its mineralogy.
4. **Epic C** (mine design → extraction → voids) — turns the orebody into the
   stopes backfill fills; closes the loop end-to-end.
5. **Epic E** (world/terrain/weather/constraints) — layer realism and campaign
   variety over the working cycle; E1 (terrain→gravity head) pairs with A1.

Each epic is several features; we build and verify one slice at a time, commit per
slice, deploy at checkpoints. The north star is unchanged: *a mining engineer nods,
and a newcomer learns how a real mine — and its backfill — actually works.*

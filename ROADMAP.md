# Cut & Fill — Gameplay Roadmap & Backlog

The long list. Grounded in the Paterson & Cooke backfill course (20 modules) and
the real backfill value chain. This is the design surface we can build toward —
not a promise of scope, but the map. Items are grouped by system; each is a
candidate feature, roughly ordered within a group from foundational to advanced.

Legend: ✅ built · 🔨 in progress · ⭐ high-impact next · 💤 later

---

## 0. Where we are (built)

- ✅ 3D world (Babylon.js), RTS camera, low-poly art, GitHub Pages deploy
- ✅ Surface build-out: build palette, power/electricity, haulage trucks, workers
- ✅ Underground cutaway: shaft, 3 levels, stopes
- ✅ Live clock (pause / 1·2·4·8×), scheduled mining, curing over days, due dates
- ✅ Reticulation **design**: leg-by-leg pipe classes + chokes, pressure vs rating
- ✅ Timed **pour** with pressure/plug/flush/burst realism
- ✅ Economy at mining scale (capex + daily opex + ore-access revenue), board review S–D

---

## 1. Materials & tailings (Modules 03, 04, 05, 12A, 13)

- ⭐ Tailings **source & stream**: mill feed rate, SG, PSD (% passing 20 µm), variability
- The **50% rule**: only ~half the tailings fit underground; a TSF always remains — manage the split
- Material **predictability**: "consistently bad beats highly variable" — variance as a risk stat
- Tailings **harvesting** from the TSF vs fresh mill feed (cost/quality trade-off)
- **Cast-in problems**: sulphide content → internal sulphate attack (delayed strength loss)
- Cyclone **desliming** for hydraulic fill (PSD tailoring), imported aggregate/sand
- Water balance: process water quality, decant, recycling

## 2. The Lab (Modules 05, 06, 07, 21)

- ⭐ **Rheology testing**: yield stress vs % solids curve (the paste band 75–83%)
- **UCS testing**: cylinders crushed at 3 / 7 / 28 / 90 / 180 / 360 days; the UCS = A·(w:b)^−n law
- **Slump** as a proxy for yield stress; **UCS** as a proxy for shear strength
- Sample **scheduling & backlog**: tests take time and lab capacity; results lag reality (delayed consequence)
- Test-work **campaigns** before a new mine/recipe (pay for a lab program, unlock reliable design)
- QA/QC rhythm: slump hourly, %solids every 2 h, PSD daily, binder/water vs standards 2–3×/week
- **External consultants / labs** to pay for a design basis, an audit, or an incident investigation

## 3. Backfill selection & mine design (Modules 02, 03, 07, 08, 09, 19)

- ⭐ **Fill-type choice** per mine/stope: Hydraulic (HF) · Paste (CPB) · Cemented Rock/Aggregate (CRF/CAF) · Paste-Aggregate (PAF) — each with real trade-offs
- **Stope design**: geometry, exposure, vertical vs sidewall, undercut/adjacent mining
- **Primary vs secondary stopes**: primaries need high early strength (later exposed on all sides); secondaries can be leaner — sequencing puzzle
- **Strength design**: target UCS by exposure, safety factor 1.3–2.0, liquefaction floor >100 kPa
- **Access & development**: drives, cross-cuts, ore passes — where the mine can even reach
- Mining **sequence & schedule** that backfill must keep pace with ("catch-up mode")

## 4. Surface plant design (Modules 11, 12A–D, 14)

The plant is a buildable, configurable factory. "The mixer is the heart."

- ⭐ **Enter the plant** (interior view) and place/connect equipment
- **Dewatering — thickeners**: type by target density (conventional → UHD paste thickener with full-length pickets); flocculant dosing, optimum feed %solids
- **Dewatering — filters**: vacuum disc (cheap, continuous) vs pressure (batch, driest cake) — first decision
- **Cyclones**: classification, underflow 70–75% solids
- **Binder handling**: silos (moisture is the enemy), rotary feeder + weigh-belt dosing, air slide
- **Mixing**: twin-shaft, retention time (~150 s), "stretch × fold × repeat"; under-mix → variable rheology
- **Pumps**: centrifugal / diaphragm charge / PD paste pumps; poppet vs swing-tube; transient control
- **Aggregate line** (for CAF/PAF): crushers, screens, conveyors, bins — crushing cost ≈ cement cost
- **Layout & flow**: connect units, avoid dead legs, size surge capacity; "always oversize dewatering"
- **Utilisation**: 50–60% (5000–6000 h/yr) — the plant must be right-sized to catch up
- Plant **capacity → pour rate** feedback (the plant you build gates throughput)

## 5. Reticulation & UDS — deeper (Modules 15, 16, 17)

- ✅ Leg-by-leg class + choke design (done)
- ⭐ **Borehole design**: the player drills and cases the borehole; pipe-in-pipe, wear liners
- **Pipe types** in full: HDPE, Sch 40/80/120, stub-ended couplings (~250 bar), grooved joints, hoop-stress sizing
- **Boosters** (add head/flow) vs **chokes** (burn head) — full HGL editor with node pressures
- **Level loops** that hold back fill to keep the line full (avoid slack/free-fall)
- **Slack flow / free fall**: pressure < vapour pressure → column separation, hammering, accelerated wear
- **Surge / water hammer** (Joukowsky ~2 MPa per 2 m/s) — pipe restraint sized for transients
- **Flush system**: dedicated flush-water pump (redundancy non-negotiable), flush after every pour
- Distance vs pump window: deliver every recipe to the nearest AND furthest stope

## 6. The pour & placement (Modules 07, 09, 10, 17)

- ✅ Pressure / plug / flush / burst (done)
- ⭐ **Pour sequence**: plug pour (seals the brow, cures to ~150 kPa) → main → sill → cap pour
- **Pour note / instruction**: sign-off procedure before start (Papers-Please beat)
- **Barricades / bulkheads**: mullock vs shotcrete, must be installed/cured/signed before start
- **Crown pressure relief / breather holes** — leading cause of barricade failure is tight filling with no relief
- **Exclusion zones** sized to the fluid-paste volume; safety discipline
- **Instrumentation & gauge diagnostics**: pressure trace where blockage = rise, burst = drop-then-decay, partial hole = gauge sets disconnect
- **Cold joints**: pour in fewest runs; over-flushing into a stope creates weak joints
- **Blind pour** (up-holes): breather monitoring, overfill risk

## 7. Curing & QA/QC (Modules 06, 09, 21)

- ✅ Cure clock (done)
- ⭐ **Cylinder results** at 7/28 d reveal whether the recipe actually hit strength (cut binder to save → fail a month later)
- **Re-entry** decisions justified by QA/QC + documented rules
- **Reconciliation** ("stope de-brief"): plan vs actual tonnes/binder/%solids/UCS — the incident evidence
- In-situ vs cylinder strength (consolidation effect)
- Curing temperature/pressure effects; **curing cannot be accelerated**

## 8. People, crews & procedures (Modules 08, 20)

- ⭐ **Worker/vehicle AI + anti-collision** (pathfinding, real tasks — not random wander)
- **Roles**: plant operators, UG crews, geotech, lab techs, fitters — assigned to tasks
- **Shifts & handover** (filling through shift change adds ~15% time), fatigue, night-shift risk
- **Dispatch & travel time** underground
- **Training / competency**: unfamiliar operators → incidents (case studies)
- **External consultants**: design basis, audits, incident investigation, questionnaires
- **Procedures & sign-offs**: permits, pour notes, barricade sign-off, exclusion-zone control

## 9. Economy & business (Modules 03, 18)

- ✅ Capex + daily opex + ore revenue (done)
- ⭐ **Binder supply chain**: silo capacity vs delivery lead time; rail vs truck top-up; binder ≈ 70% of opex
- **Cost/tonne** and cost breakdown (binder, crushing/haulage, power, labour)
- **Dilution**: 5% dilution = 5% less ore + 5% more backfill
- **Budgets & study stages**: conceptual ±30–50% → detailed ±5–10%; contingency
- **Financing / contracts**: board mandate, capex approval, service contracts
- **Extenders / PLC** trade-offs (limestone cement is a false economy in paste)
- Revenue: ore access unlocked as stopes are filled; production keeps advancing

## 10. Events & scenarios (Modules 09, 10, 14, 20)

- ⭐ **Earned, telegraphed events**: binder rail delay, mill trip (tailings cut), seismic during pour, geotech barricade flag
- **Barricade breach / inrush** (the runaway failure) with exclusion-zone payoff
- **Plugged borehole** = a month's production lost
- **Weather / power / water** interruptions
- **Real-mine scenarios**: escalating campaigns (shallow → deep, HF → paste → CAF), different orebodies
- **Regulatory / audit** events (vendor questionnaires, safety audits)

## 11. Simulation, planning & meta

- ⭐ **Planning tools**: schedule board, fill plan, forecast vs actual, alerts
- **Save / load**, multiple mines, sandbox vs campaign
- **Tech tree / upgrades**: better thickeners, automation, instrumentation, IoT/monitoring
- **Difficulty / modifiers**; **achievements**; leaderboards for grade/efficiency
- **Tutorial / onboarding** that teaches the real concepts (the game as a training tool)

## 12. Presentation & polish

- ⭐ Worker/vehicle animation + anti-collision; day/night; weather
- Building **selection & info panels** on the surface (click a building → status/throughput/upkeep)
- Sound design (plant hum, pour, alarms), music
- Camera bookmarks, minimap, overview mode
- Art pass: textures, decals, particle (dust, water, paste), better models
- Accessibility, colourblind-safe status colours, tooltips (the Backfill Handbook)

---

## Suggested near-term order (⭐ picks)

1. **Enter the plant** — interior equipment placement (thickener → mixer → pumps), plant capacity feeds pour rate
2. **The Lab + rheology** — %solids/binder design against a real yield-stress & UCS curve; cylinders at 7/28 d
3. **Worker/vehicle AI + anti-collision** — the world stops feeling static
4. **Binder supply chain + richer events** — the management tension the course keeps pointing at
5. **Fill-type & stope design** — choose HF/paste/CAF per stope; primary/secondary sequencing

Everything here traces back to the course. The north star: a game where a mining
engineer nods, and a player who's never seen a mine *learns how backfill actually works.*

# Backfill Tycoon — Course 360° Design Audit

A gap analysis of the game against the full Paterson & Cooke backfill course
(20 modules, decks 02–21, Cape Town 2026). The lens is deliberately **"what
decision does the player make, and does it have a real consequence?"** — because
that is where the game teaches the engineering, and where the course is richest.

Legend: ✅ modelled well · 🟡 shallow / partial · ❌ missing decision surface

---

## 1. The value chain — coverage at a glance

| Course node (modules) | In-game today | Depth |
|---|---|---|
| Backfill selection & fill type (02, 03, 08, 13, 19) | HF / Paste / PAF / CAF per stope, real trade-off multipliers, suitability advice | ✅ |
| Strength design (07) | Target UCS = in-situ demand × safety factor by exposure; liquefaction floor 100 kPa; primary/secondary sequencing | ✅ |
| Materials & rheology datasets (04, 05, 06) | One rheology curve per stream; lab %solids+binder → UCS/yield/pumpability | 🟡 |
| Plant design & placement (11, 14) | Interior 5-stage line; throughput caps pour rate; plot-anywhere surface siting | 🟡 |
| Key equipment (12A–D) | Line stages abstracted; no per-unit equipment choice (thickener/filter/mixer/pump class) | 🟡 |
| Reticulation / UDS (15, 16) | Per-leg pipe class, choke, booster, drilled borehole, HGL, static head, friction, slack/burst | ✅ (some gaps) |
| Reticulation operation (17) | Timed pour, plug/main/cap sub-phases, flush action, burst | 🟡 |
| Placement & barricades (09, 10) | Barricade = a checkbox sign-off + one geotech risk event | ❌ |
| Curing & QA/QC (06, 21) | Cure clock, 7/28-day cylinders pass/fail, reconciliation panel | 🟡 |
| Economics (18) | Capex/opex, ore revenue, budget, board grade | 🟡 |
| Operation management (20) | Schedule board, events, catch-up implied | 🟡 |
| Cement / binder logistics (03, 12C, 18) | Rail building + emergency truck top-up event | 🟡 |

**Verdict:** the *spine* of the value chain is present and, in a few places
(fill-type/strength design, UDS routing), genuinely deep. But there are **two
decision surfaces that are essentially missing** — the two Ben flagged by
instinct — plus several nodes that exist but don't yet ask the player to
*decide* anything the course says matters.

---

## 2. The headline gaps (biggest teaching value)

### 2.1 Barricade design — ❌ the #1 gap
The course treats containment as a safety-critical **design** task, and
**tight filling with no pressure relief is named the leading cause of barricade
failure** (inrush — the runaway catastrophe; case studies Cannington, Jabal
Sayid). Today the game reduces all of that to a "barricade signed off?" tick and
a single reinforce-or-not event. The real decisions the course exposes:

- **Type:** consolidated waste ("mullock") — cheap, material on hand, but
  variable, higher risk, ties up the loader fleet, must be re-excavated for
  access; **vs arched shotcrete (AS)** — engineered, fast cycle, QA/QC-able,
  monitorable, but higher cost/skill and can't be built at drift intersections.
- **Capacity vs load:** the barricade is rated for the **fluid head of the plug**;
  loading is a function of **rate of rise × strength development**. Plug pour must
  cure to ~150 kPa before the main pour — a real gate, not a sub-phase.
- **Set-back distance** from the brow (drives plug design and berms).
- **Pressure relief / breather holes** — the missing crown relief is the direct
  cause in both inrush case studies. Blind/up-hole pours need breather monitoring.
- **Exclusion zone** sized to the full fluid-paste volume (the payoff: no one hurt
  even when a barricade fails).
- **Instrumentation:** TEPC pressure cells feeding the operator, trigger levels
  ("stop if bulkhead > 20 psi").
- **Hydraulic fill specifics:** barricade must be *permeable* (release water,
  retain solids); "piping" failure; weeping-tile drains.

**Recommendation:** make barricade a designed object — pick type, size capacity,
set relief — and let **rate-of-rise during the pour load it toward failure**.
Inrush becomes the earned catastrophe, and the exclusion zone is what saves you.
Highest realism-per-effort of anything on this list.

### 2.2 Real spatial / layout design — ❌ (plot-anywhere today)
Today buildings plot anywhere and link if within a power radius / connect range.
The course makes **location a design lever** (modules 03, 11, 14):

- **Plant siting → gravity head:** locating the plant high / near the shaft
  collar can *eliminate pumping* or allow a thicker (cheaper) paste; siting low or
  far forces booster pumps on the UDS. This is the cleanest way to make surface
  placement matter — tie plant position to the head available on the reticulation.
- **Distance to the mill** gates tailings feed; **borehole replacement** needs
  reserved space; stockpiles / dump ponds / filter-cake load-out need room.
- **Adjacency & order:** dosing silo next to the mixer; thickener → filter →
  mixer ordering; **dead legs / blanked stubs = plugs waiting to happen**;
  minimise transfer points; don't put wet processes over electrical.

**Recommendation:** two separable pieces — (a) **surface siting affects UDS
hydraulics** (plant elevation/offset sets gravity head, so a bad site forces
pumps); (b) **plant-interior adjacency/order** matters (correct sequence + no
dead legs). (a) is higher value and smaller; (b) deepens the existing plant view.

### 2.3 Cement / binder logistics as a strategic choice — 🟡→ worth deepening
Binder is ~70% of opex; "silo capacity vs delivery lead time is the eternal
squeeze." Today: a rail building + an emergency truck top-up event. Make the
**supply mode a real decision** the course spells out:

- **Rail terminal** (high capex, low $/t, but lead-time slips you can't control) ·
  **road haulage fleet** (low capex, higher $/t, flexible) · **Isotainers**
  (remote sites, dry inventory, recyclable) — Wolfram Reach ("binder-scarce
  remote") is the natural showcase.
- **Silo sizing** vs delivery cadence (buffer for the slip you can't control);
  moisture ingress is the enemy; count truck trips (site traffic).

**Recommendation:** a supply-mode choice with capex / $-per-tonne / lead-time /
reliability trade-offs and silo-buffer sizing. Small, and it plugs straight into
the existing binder-supply + events systems.

---

## 3. Nodes that exist but are shallow (deepen if we go further)

- **Rheology datasets (04–06):** today one curve per stream. The course:
  characterisation *drives everything* — PSD (%<20 µm decides paste vs HF), SG,
  **mineralogy** (sulfides → internal sulfate attack / delayed strength loss;
  heavy metals retard set; clays/micas = weak planes), water chemistry, the
  **w:b power law**, and the **steepness of the yield-stress vs %solids curve**
  (steep = tiny operating window, hard to control — "consistently bad beats
  highly variable"). *Deepen:* a paid **test-work campaign** per mine that reveals
  the true curve and de-risks design; problematic minerals as scenario modifiers;
  variability as a risk stat; cyclone/desliming to tailor PSD for HF.

- **Plant equipment (12A–D):** the line is abstracted. *Deepen:* real per-unit
  choices — **thickener** type by target density (conventional → UHD paste w/ full
  pickets), **filter** vacuum-disc vs pressure-batch ("the first decision"),
  **cyclones** for desliming, **binder handling** (weigh-belt vs air-slide), and
  **"the mixer is the heart"** (twin-shaft, ~150 s retention; a cheap mixer =
  variable rheology = UCS scatter). "Always oversize dewatering."

- **UDS operation (17):** *Deepen:* **flush-water system as a design case +
  redundancy** (flush after every pour; a deep line needs extra flush-pump head);
  **transient / water-hammer** (Joukowsky surge → pipe restraint / rupture discs);
  **level loops** that hold back fill to avoid slack; **pipe wear tracking** over
  tonnage → proactive replacement; **pump envelope** (min/max flow window; poppet
  vs swing-tube for aggregate).

- **QA/QC & reconciliation (21):** *Deepen:* full cure suite (3/7/28/90/180/360),
  the QC rhythm (slump hourly, %solids every 2 h, PSD daily, binder/water 2–3×/wk),
  **control charts**, plant-vs-in-situ strength (consolidation), and the real
  optimisation loop — **tighter control shrinks variance → trim binder** without
  missing target.

- **Economics (18):** *Deepen:* study-stage estimate accuracy (±30–50% → ±5–10%),
  contingency, capex-vs-opex character per fill type, sustaining capital, and the
  secondary costs that decide NPV (dilution, water management, cycle time).

- **Operation management (20):** *Deepen:* downtime tracking by area, explicit
  **catch-up mode**, **filling through shift change (+~15% time)**, void tracking
  (ready-to-fill), and instrumentation-reliability decay ("always zero" syndrome).

---

## 4. Smaller course elements not yet present

- **Cold joints** — pour in fewest runs; over-flushing into a stope washes out
  cement → weak joint (partially in via flush→UCS; could be explicit).
- **Cap / sill pours** as *player* high-binder decisions (today auto sub-phases).
- **Waste-rock co-disposal (UWRS)** — fill unexposed secondaries with development
  waste (cheap, PAG encapsulation).
- **Dilution** — 5% dilution = 5% less ore + 5% more fill.
- **Void survey (CMS)** before a pour (today volume is simply known).
- **Admixtures** — plasticisers / retarders / accelerators.

---

## 5. Suggested priority order (by teaching value ÷ effort)

1. **Barricade design + rate-of-rise loading + inrush** (2.1) — the biggest
   missing safety decision; makes the pour genuinely tense and course-true.
2. **Plant siting → UDS gravity head** (2.2a) — makes *where* you build matter
   with a small, elegant coupling to systems that already exist.
3. **Cement supply mode** (2.3) — small, high-flavour, showcases Wolfram Reach.
4. **Flush system + transients** in the UDS (3) — completes the reticulation story.
5. **Test-work campaign + mineralogy risk** (rheology datasets, 3) — turns the lab
   into a real de-risking decision.
6. **Plant equipment choices** incl. "the mixer is the heart" (3).

Everything here traces to a specific module. The north star stays: *a mining
engineer nods, and a player who's never seen a mine learns how backfill actually
works.*

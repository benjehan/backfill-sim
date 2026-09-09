// Presentation layer. Structural DOM is (re)built on phase/mode change; volatile
// numbers are patched each frame so sliders keep focus and the Pi stays smooth.

import { Game } from "../sim/state.js";
import { autoRecipe } from "../sim/physics.js";
import { sectionSvg } from "./sectionView.js";
import { term, GLOSSARY } from "./handbook.js";
import { TUTORIAL_BRIEFING } from "../sim/scenario.js";

export class App {
  private root: HTMLElement;
  private game: Game;
  private mountedKey = "";
  private tip!: HTMLElement;

  constructor(root: HTMLElement, game: Game) {
    this.root = root;
    this.game = game;
    game.subscribe(() => this.sync());
    this.buildShell();
    this.sync();
    this.loop();
  }

  private buildShell() {
    this.root.innerHTML = `
      <div id="topbar"></div>
      <div id="stage">
        <div id="section"></div>
        <div id="stageOverlay"></div>
      </div>
      <div id="panel"></div>
      <div id="tooltip" class="tooltip hidden"></div>
    `;
    this.tip = document.getElementById("tooltip")!;
    // Delegated clicks
    this.root.addEventListener("click", (e) => this.onClick(e));
    // Tooltips for handbook terms
    this.root.addEventListener("mouseover", (e) => this.onHover(e));
    this.root.addEventListener("mouseout", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains("term")) this.tip.classList.add("hidden");
    });
    this.root.addEventListener("mousemove", (e) => {
      if (!this.tip.classList.contains("hidden")) {
        this.tip.style.left = e.pageX + 14 + "px";
        this.tip.style.top = e.pageY + 14 + "px";
      }
    });
  }

  private loop = () => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      this.game.tick(dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // ---- sync: remount on structural change, else patch --------------------

  private sync() {
    const g = this.game;
    // Pre-pour control availability (issue/approve/checklist) changes the panel's
    // enabled states, so fold that state into the mount key to force a re-render.
    const prepourSig =
      g.phase === "prepour"
        ? `|${g.pourNote.issued}|${g.pourNote.approved}|${g.checklist.map((c) => (c.checked ? 1 : 0)).join("")}`
        : "";
    const key = `${g.phase}|${g.mode}${prepourSig}`;
    if (key !== this.mountedKey) {
      this.mountedKey = key;
      this.mount();
    }
    this.patch();
  }

  private mount() {
    document.getElementById("topbar")!.innerHTML = this.topbar();
    document.getElementById("panel")!.innerHTML = this.panel();
    document.getElementById("stageOverlay")!.innerHTML = this.overlay();
    this.attachInputs();
  }

  private patch() {
    const g = this.game;
    // clock
    setText("clockDay", `Day ${g.day}`);
    setText("clockDue", `fill due day ${g.stope.dueDay}`);
    // section always reflects live state
    const sec = document.getElementById("section");
    if (sec) sec.innerHTML = sectionSvg(g);

    if (g.phase === "design") this.patchDesign();
    if (g.phase === "pouring") this.patchPour();
    if (g.phase === "curing") this.patchCure();
  }

  // ---- top bar ------------------------------------------------------------

  private topbar(): string {
    const g = this.game;
    return `
      <div class="brand">BACKFILL <span>SIM</span> <em>· Wheal Verity</em></div>
      <div class="clock">
        <span id="clockDay">Day ${g.day}</span>
        <span class="muted" id="clockDue">fill due day ${g.stope.dueDay}</span>
      </div>
      <div class="speeds">
        <button data-action="pause" class="btn ${g.paused ? "on" : ""}">⏸</button>
        ${[1, 2, 4, 8].map((s, i) => `<button data-action="speed" data-i="${i}" class="btn ${!g.paused && g.speed === s ? "on" : ""}">${s}×</button>`).join("")}
      </div>
      <div class="modeToggle">
        <button data-action="mode" data-m="manager" class="btn ${g.mode === "manager" ? "on" : ""}">Manager</button>
        <button data-action="mode" data-m="engineer" class="btn ${g.mode === "engineer" ? "on" : ""}">Engineer</button>
      </div>`;
  }

  private overlay(): string {
    const g = this.game;
    const titles: Record<string, string> = {
      briefing: "Briefing",
      design: "Recipe & Line Design",
      prepour: "Pre-Pour Checks",
      pouring: "POUR IN PROGRESS",
      flushing: "Flush & Shutdown",
      curing: "Curing",
      qaqc: "QA/QC — Cylinder Results",
      reconcile: "Reconciliation",
    };
    return `<div class="stageTitle">${titles[g.phase] ?? ""}</div>`;
  }

  // ---- panels per phase ---------------------------------------------------

  private panel(): string {
    switch (this.game.phase) {
      case "briefing": return this.pBriefing();
      case "design": return this.pDesign();
      case "prepour": return this.pPrepour();
      case "pouring": return this.pPour();
      case "flushing": return this.pFlush();
      case "curing": return this.pCure();
      case "qaqc": return this.pQaqc();
      case "reconcile": return this.pReconcile();
      default: return "";
    }
  }

  private pBriefing(): string {
    const b = TUTORIAL_BRIEFING;
    const s = this.game.stope;
    return `
      <div class="card briefing">
        <div class="portrait">🪖</div>
        <h2>${b.title}</h2>
        <p class="from">${b.from}</p>
        <p class="body">${b.body}</p>
        <div class="targets">
          <div><b>${s.volumeM3} m³</b><span>volume</span></div>
          <div><b>${s.targetUcsKpa} kPa</b><span>${term("ucs", "target UCS")}</span></div>
          <div><b>−${s.level} m</b><span>depth</span></div>
          <div><b>day ${s.dueDay}</b><span>fill due</span></div>
        </div>
        <button class="btn primary big" data-action="startDesign">Take the job →</button>
      </div>`;
  }

  private pDesign(): string {
    const g = this.game;
    return `
      <div class="card">
        <h3>${term("pour-note", "Design the mix")} <span class="hint">${g.mode} view</span></h3>
        <label class="slider">
          <span>Solids concentration <b id="dSolidsVal"></b></span>
          <input type="range" id="sSolids" min="66" max="82" step="0.5" value="${g.recipe.solids * 100}">
          <small>${term("yield-stress", "yield stress")} rises steeply past 78%</small>
        </label>
        <label class="slider">
          <span>${term("binder", "Binder dose")} <b id="dBinderVal"></b></span>
          <input type="range" id="sBinder" min="60" max="400" step="5" value="${g.recipe.binderKgPerM3}">
          <small>~70% of your ${"opex"} — cut it without losing strength</small>
        </label>
        <label class="field">
          <span>Pipe (${term("rating", "diameter & rating")})</span>
          <select id="selPipe">
            ${g.pipeOptions.map((p, i) => `<option value="${i}" ${p === g.pipe ? "selected" : ""}>${p.label} — $${p.costPerMetre}/m</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Target flow (m³/h)</span>
          <input type="number" id="inFlow" min="10" max="80" step="5" value="${g.pourNote.targetFlowM3h}">
        </label>

        <div id="designReadout"></div>

        <div class="row">
          <button class="btn" data-action="autoRecipe">✨ Auto-recipe (lowest binder)</button>
        </div>
        <button class="btn primary big" data-action="toPrepour" id="btnToPrepour">Issue pour note →</button>
      </div>`;
  }

  private pPrepour(): string {
    const g = this.game;
    return `
      <div class="card">
        <h3>Pre-pour checklist</h3>
        <p class="muted small">Skip an item to save time — but it can bite later.</p>
        <div class="checklist">
          ${g.checklist.map((c) => `
            <label class="check ${c.checked ? "done" : ""}">
              <input type="checkbox" data-action="check" data-key="${c.key}" ${c.checked ? "checked" : ""}>
              <span>${c.label}</span>
            </label>`).join("")}
        </div>
        <div class="pourNote">
          <div class="pnHead">${term("pour-note", "POUR NOTE")} · ${g.stope.id}</div>
          <div class="pnRow"><span>Mix</span><b>${(g.pourNote.recipe.solids * 100).toFixed(1)}% solids · ${g.pourNote.recipe.binderKgPerM3} kg/m³ binder</b></div>
          <div class="pnRow"><span>Volume / flow</span><b>${g.pourNote.plannedVolumeM3} m³ @ ${g.pourNote.targetFlowM3h} m³/h</b></div>
          <div class="pnActions">
            <button class="btn ${g.pourNote.issued ? "on" : ""}" data-action="issue">${g.pourNote.issued ? "✓ Issued" : "Issue"}</button>
            <button class="btn ${g.pourNote.approved ? "on" : ""}" data-action="approve" ${g.pourNote.issued ? "" : "disabled"}>${g.pourNote.approved ? "✓ Approved" : "Approve (supervisor)"}</button>
          </div>
        </div>
        <button class="btn primary big" data-action="beginPour" ${g.pourNote.approved ? "" : "disabled"}>Begin pour ▶</button>
        <button class="btn ghost" data-action="startDesign">← back to design</button>
      </div>`;
  }

  private pPour(): string {
    return `
      <div class="card pourhud">
        <div class="subphase" id="subPhase"></div>
        <div id="pourGauges"></div>
        <label class="slider">
          <span>Flow rate <b id="flowVal"></b></span>
          <input type="range" id="sFlow" min="0" max="80" step="1" value="${this.game.pour.targetFlowM3h}">
        </label>
        <div class="row">
          <button class="btn warn" data-action="flush">💧 Flush line</button>
          <button class="btn" data-action="pause">⏸ Hold</button>
        </div>
        <div class="alarms" id="alarms"></div>
      </div>`;
  }

  private pFlush(): string {
    return `
      <div class="card">
        <h3>Pour complete — flush & shut down</h3>
        <p>Stope <b>${this.game.stope.id}</b> is filled. Clean the line with water and divert the flush, or the next pour starts with a ${term("plug", "plug")}.</p>
        <button class="btn primary big" data-action="completeFlush">Flush line & start cure →</button>
      </div>`;
  }

  private pCure(): string {
    return `
      <div class="card">
        <h3>${term("cure-time", "Curing")}</h3>
        <p class="muted small">Fill gains strength over days. Cylinders are crushed at 7 and 28 days. Speed up time to reach the results.</p>
        <div id="cureReadout"></div>
        <button class="btn primary big" data-action="skipTest">⏩ Skip to next cylinder test</button>
        <div class="speeds big">
          ${[1, 2, 4, 8].map((s, i) => `<button data-action="speed" data-i="${i}" class="btn">${s}×</button>`).join("")}
          <button class="btn" data-action="unpause">▶ Run</button>
        </div>
        <div id="cureResults"></div>
      </div>`;
  }

  private pQaqc(): string {
    const g = this.game;
    return `
      <div class="card">
        <h3>QA/QC — ${term("ucs", "UCS")} cylinder results</h3>
        ${g.ucsResults.map((r) => `
          <div class="ucsRow ${r.pass ? "pass" : "fail"}">
            <span>${r.ageDays}-day</span>
            <b>${r.achievedKpa} kPa</b>
            <span class="muted">vs ${r.targetKpa} target</span>
            <span class="badge">${r.pass ? "PASS" : "FAIL"}</span>
          </div>`).join("")}
        <button class="btn primary big" data-action="toReconcile">Close out the pour →</button>
      </div>`;
  }

  private pReconcile(): string {
    const g = this.game;
    const k = g.kpis;
    if (!k) return "";
    const grade = this.grade(k);
    return `
      <div class="card">
        <h3>${term("reconciliation", "Reconciliation")} & scorecard</h3>
        <div class="scorecard">
          <div class="grade grade-${grade}">${grade}</div>
          <div class="kpis">
            ${kpi("Volume placed", `${k.volumePlacedM3.toFixed(0)} / ${k.volumePlannedM3} m³`)}
            ${kpi("Cost / tonne", `$${k.costPerTonne.toFixed(1)}`)}
            ${kpi("Binder used", `${k.binderTonnes.toFixed(1)} t`)}
            ${kpi("UCS pass rate", `${(k.ucsPassRate * 100).toFixed(0)}%`)}
            ${kpi("Schedule", k.scheduleAdherence ? "on time" : "LATE")}
            ${kpi("Recon. gap", `${k.reconciliationGapM3.toFixed(0)} m³`)}
            ${kpi("Safety", k.safetyIncidents ? `${k.safetyIncidents} incident` : "clean")}
          </div>
        </div>
        <div class="verdict">
          <div class="portrait small">🪖</div>
          <p>${g.managerVerdict}</p>
        </div>
        <button class="btn primary big" data-action="restart">▶ Play again</button>
      </div>`;
  }

  // ---- patches (volatile numbers) -----------------------------------------

  private patchDesign() {
    const g = this.game;
    const ev = g.evalRecipe();
    setText("dSolidsVal", `${(g.recipe.solids * 100).toFixed(1)}%`);
    setText("dBinderVal", `${g.recipe.binderKgPerM3} kg/m³`);
    const ro = document.getElementById("designReadout");
    if (!ro) return;
    const ucsOk = ev.ucs28Predicted >= g.stope.targetUcsKpa;
    const pressOk = ev.peakPressureMpa <= ev.ratingMpa;

    if (g.mode === "manager") {
      ro.innerHTML = `
        <div class="gauges">
          ${gauge("Strength (UCS 28d)", ev.ucs28Predicted, g.stope.targetUcsKpa * 1.4, g.stope.targetUcsKpa, "kPa", ucsOk)}
          ${gauge("Cost / m³", ev.costPerM3, 60, 40, "$", ev.costPerM3 < 40)}
          ${light(term("hgl", "Line pressure"), pressOk ? (ev.hglMargin < 0.15 ? "amber" : "green") : "red", pressOk ? (ev.hglMargin < 0.15 ? "tight" : "OK") : "OVER")}
          ${light(term("plug", "Plug risk"), ev.regime === "plug-risk" ? "red" : ev.regime === "slack-risk" ? "amber" : "green", ev.regime === "laminar" ? "low" : ev.regime)}
        </div>
        ${warnBlock(ev.warnings)}`;
    } else {
      ro.innerHTML = `
        <table class="engtable">
          ${row(term("yield-stress", "Yield stress"), ev.yieldStressKpa.toFixed(2), "kPa")}
          ${row(term("friction", "Friction gradient"), ev.frictionKpaPerM.toFixed(2), "kPa/m", ev.frictionKpaPerM > 8.5)}
          ${row(term("static-head", "Static head ρgh"), ev.staticHeadMpa.toFixed(2), "MPa")}
          ${row("Friction loss", ev.frictionLossMpa.toFixed(2), "MPa")}
          ${row("Peak pressure", ev.peakPressureMpa.toFixed(2), "MPa", ev.peakPressureMpa > ev.ratingMpa)}
          ${row(term("rating", "Pipe rating"), ev.ratingMpa.toFixed(0), "MPa")}
          ${row(term("hgl", "HGL margin"), (ev.hglMargin * 100).toFixed(0), "%", ev.hglMargin < 0.15)}
          ${row("Flow regime", ev.regime, "", ev.regime !== "laminar")}
          ${row("Predicted UCS 28d", ev.ucs28Predicted.toFixed(0), "kPa", !ucsOk)}
          ${row("Binder cost share", (ev.binderCostShare * 100).toFixed(0), "%")}
          ${row("Cost / m³", ev.costPerM3.toFixed(2), "$")}
        </table>
        ${warnBlock(ev.warnings)}`;
    }
    const btn = document.getElementById("btnToPrepour") as HTMLButtonElement | null;
    if (btn) btn.classList.toggle("danger", !ev.feasible);
  }

  private patchPour() {
    const g = this.game;
    const p = g.pour;
    const ev = g.evalRecipe();
    const names: Record<string, string> = {
      "water-test": "① Water test",
      "line-fill": `② ${term("low-solids-start", "Low-solids line fill")}`,
      "main": "③ Main recipe",
      "done": "Done",
    };
    setText("subPhase", names[p.subPhase] ?? "");
    setText("flowVal", `${p.currentFlowM3h.toFixed(0)} m³/h`);

    const margin = (ev.ratingMpa - p.pressureMpa) / ev.ratingMpa;
    const pressColor = p.pressureMpa > ev.ratingMpa ? "red" : margin < 0.15 ? "amber" : "green";
    const gaugesEl = document.getElementById("pourGauges");
    if (gaugesEl) {
      const volFrac = p.placedM3 / g.pourNote.plannedVolumeM3;
      if (g.mode === "engineer") {
        gaugesEl.innerHTML = `
          ${bar(term("hgl", "Pressure"), p.pressureMpa, ev.ratingMpa, `${p.pressureMpa.toFixed(1)} / ${ev.ratingMpa} MPa`, pressColor)}
          ${bar("Volume placed", volFrac, 1, `${p.placedM3.toFixed(0)} / ${g.pourNote.plannedVolumeM3} m³`, "blue")}
          ${bar("Plug drift", p.plugDrift, 1, `${(p.plugDrift * 100).toFixed(0)}%`, p.plugDrift > 0.5 ? "red" : "green")}
        `;
      } else {
        gaugesEl.innerHTML = `
          ${light(term("hgl", "Line pressure"), pressColor, pressColor === "green" ? "OK" : pressColor === "amber" ? "HIGH — ease off" : "CRITICAL")}
          ${bar("Volume placed", volFrac, 1, `${(volFrac * 100).toFixed(0)}%`, "blue")}
          ${light(term("plug", "Plug forming?"), p.plugDrift > 0.5 ? "red" : p.plugDrift > 0.25 ? "amber" : "green", p.plugDrift > 0.5 ? "YES — flush!" : p.plugDrift > 0.25 ? "building" : "clear")}
        `;
      }
    }
    const al = document.getElementById("alarms");
    if (al) al.innerHTML = p.alarms.slice(-4).map((a) => `<div class="alarm">${a}</div>`).join("");
  }

  private patchCure() {
    const g = this.game;
    const age = g.day - g.cureStartDay + g.dayFraction;
    const ro = document.getElementById("cureReadout");
    if (ro) {
      const frac = Math.min(1, Math.log(1 + age) / Math.log(1 + 28));
      ro.innerHTML = `
        ${bar("Cure age", Math.min(age, 28), 28, `${age.toFixed(1)} days`, "blue")}
        ${bar("Strength developing", frac, 1, `${(frac * 100).toFixed(0)}% of design`, "green")}
        <p class="muted small">Hand-back gate at 28 days. Next test at ${age < 7 ? "7" : "28"} days.</p>`;
    }
    const res = document.getElementById("cureResults");
    if (res) {
      res.innerHTML = g.ucsResults.map((r) => `
        <div class="ucsRow ${r.pass ? "pass" : "fail"}">
          <span>${r.ageDays}-day</span><b>${r.achievedKpa} kPa</b>
          <span class="muted">vs ${r.targetKpa}</span>
          <span class="badge">${r.pass ? "PASS" : "FAIL"}</span>
        </div>`).join("");
    }
  }

  // ---- inputs & actions ---------------------------------------------------

  private attachInputs() {
    const g = this.game;
    if (g.phase === "design") {
      bindRange("sSolids", (v) => { g.recipe.solids = v / 100; this.patchDesign(); this.refreshSection(); });
      bindRange("sBinder", (v) => { g.recipe.binderKgPerM3 = v; this.patchDesign(); this.refreshSection(); });
      const pipe = document.getElementById("selPipe") as HTMLSelectElement | null;
      pipe?.addEventListener("change", () => { g.pipe = g.pipeOptions[+pipe.value]; this.patchDesign(); this.refreshSection(); });
      const flow = document.getElementById("inFlow") as HTMLInputElement | null;
      flow?.addEventListener("change", () => { g.pourNote.targetFlowM3h = +flow.value; });
    }
    if (g.phase === "pouring") {
      bindRange("sFlow", (v) => g.setPourFlow(v));
    }
  }

  private refreshSection() {
    const sec = document.getElementById("section");
    if (sec) sec.innerHTML = sectionSvg(this.game);
  }

  private onClick(e: Event) {
    const t = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!t) return;
    const g = this.game;
    const a = t.dataset.action!;
    switch (a) {
      case "mode": g.mode = t.dataset.m as any; g.touch(); break;
      case "pause": g.paused = !g.paused; g.touch(); break;
      case "unpause": g.paused = false; g.touch(); break;
      case "speed": g.speedIndex = +(t.dataset.i!); g.paused = false; g.touch(); break;
      case "startDesign": g.startDesign(); break;
      case "autoRecipe": g.recipe = autoRecipe(g.stream, g.pipe, g.stope); this.remountDesign(); break;
      case "toPrepour": g.proceedToPrepour(); break;
      case "check": g.toggleChecklist(t.dataset.key!); break;
      case "issue": g.issuePourNote(); break;
      case "approve": g.approvePourNote(); break;
      case "beginPour": g.beginPour(); break;
      case "flush": g.flushLine(); break;
      case "completeFlush": g.completeFlush(); break;
      case "skipTest": g.skipToNextTest(); break;
      case "toReconcile": g.goToReconcile(); break;
      case "restart": g.restart(); break;
    }
  }

  private remountDesign() {
    // Auto-recipe changes slider values -> rebuild the panel then patch.
    document.getElementById("panel")!.innerHTML = this.panel();
    this.attachInputs();
    this.patchDesign();
    this.refreshSection();
  }

  private onHover(e: Event) {
    const t = e.target as HTMLElement;
    if (t.classList?.contains("term")) {
      const tip = t.dataset.tip;
      if (tip) {
        this.tip.textContent = tip;
        this.tip.classList.remove("hidden");
      }
    }
  }

  private grade(k: NonNullable<Game["kpis"]>): string {
    // A strength failure (geotech won't sign the hand-back) or a safety incident
    // are hard caps — you cannot score well on a stope that failed its cylinders.
    if (k.safetyIncidents > 0) return "D";
    if (k.ucsPassRate === 0) return "D";
    let score = 0;
    if (k.ucsPassRate >= 1) score += 2; else score += 1;
    if (k.scheduleAdherence) score += 1;
    if (k.reconciliationGapM3 < 20) score += 1;
    if (k.costPerTonne < 18) score += 2; else if (k.costPerTonne < 22) score += 1;
    let g = score >= 6 ? "S" : score >= 5 ? "A" : score >= 3 ? "B" : "C";
    if (k.ucsPassRate < 1 && (g === "S" || g === "A" || g === "B")) g = "C";
    return g;
  }
}

// ---- tiny html helpers ----------------------------------------------------

function setText(id: string, v: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

function bindRange(id: string, cb: (v: number) => void) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  el?.addEventListener("input", () => cb(+el.value));
}

function kpi(label: string, val: string): string {
  return `<div class="kpi"><span>${label}</span><b>${val}</b></div>`;
}

function gauge(label: string, val: number, max: number, target: number, unit: string, ok: boolean): string {
  const pct = Math.max(0, Math.min(100, (val / max) * 100));
  const tpct = Math.max(0, Math.min(100, (target / max) * 100));
  return `
    <div class="gaugeWrap">
      <div class="gaugeLabel">${label} <b class="${ok ? "good" : "bad"}">${val.toFixed(0)}${unit}</b></div>
      <div class="gaugeTrack">
        <div class="gaugeFill ${ok ? "good" : "bad"}" style="width:${pct}%"></div>
        <div class="gaugeTarget" style="left:${tpct}%" title="target ${target}${unit}"></div>
      </div>
    </div>`;
}

function bar(label: string, val: number, max: number, text: string, color: string): string {
  const pct = Math.max(0, Math.min(100, (val / max) * 100));
  return `
    <div class="gaugeWrap">
      <div class="gaugeLabel">${label} <b>${text}</b></div>
      <div class="gaugeTrack"><div class="gaugeFill ${color}" style="width:${pct}%"></div></div>
    </div>`;
}

function light(label: string, color: string, text: string): string {
  return `<div class="lightRow"><span class="dot ${color}"></span><span>${label}</span><b>${text}</b></div>`;
}

function row(label: string, val: string, unit: string, bad = false): string {
  return `<tr><td>${label}</td><td class="num ${bad ? "bad" : ""}">${val} <span class="unit">${unit}</span></td></tr>`;
}

function warnBlock(warnings: string[]): string {
  if (!warnings.length) return `<div class="warnbox ok">✓ Design is within limits.</div>`;
  return `<div class="warnbox">${warnings.map((w) => `<div>⚠ ${w}</div>`).join("")}</div>`;
}

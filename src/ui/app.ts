// Presentation layer for the campaign. Board (schedule/KPIs/log/mine overview)
// and the pour flow share one shell; volatile numbers patch each frame.

import { Game, type StopeRun } from "../sim/state.js";
import { autoRecipe } from "../sim/physics.js";
import { stageSvg } from "./sectionView.js";
import { term } from "./handbook.js";
import { CAMPAIGN } from "../sim/scenario.js";
import { Plant } from "../plant/model.js";
import { PlantView } from "./plantView.js";

type Screen = "mine" | "plant";

export class App {
  private root: HTMLElement;
  private game: Game;
  private mountedKey = "";
  private tip!: HTMLElement;

  // the surface-plant builder lives on its own screen, toggled from the topbar
  private screen: Screen = "mine";
  private plant = new Plant();
  private plantView: PlantView | null = null;

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
      <div id="stage"><div id="section"></div><div id="stageOverlay"></div></div>
      <div id="panel"></div>
      <div id="plantScreen"></div>
      <div id="modal" class="modal-wrap hidden"></div>
      <div id="tooltip" class="tooltip hidden"></div>`;
    this.tip = document.getElementById("tooltip")!;
    this.root.addEventListener("click", (e) => this.onClick(e));
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
      this.game.tick(Math.min(dt, 0.1));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // ---- sync -----------------------------------------------------------------

  // ---- screen switch (mine campaign <-> surface-plant builder) --------------

  private setScreen(s: Screen) {
    if (s === this.screen) return;
    this.screen = s;
    if (s === "plant") {
      this.game.paused = true; // freeze the campaign clock while you build
      this.root.classList.add("showPlant");
      this.renderTopbar();
      this.plantView = new PlantView(document.getElementById("plantScreen")!, this.plant);
    } else {
      this.plantView?.destroy();
      this.plantView = null;
      this.root.classList.remove("showPlant");
      this.mountedKey = ""; // force a full campaign remount
      this.sync();
    }
  }

  private renderTopbar() { document.getElementById("topbar")!.innerHTML = this.topbar(); }

  private sync() {
    if (this.screen === "plant") return; // PlantView drives its own screen
    const g = this.game;
    const boardSig = `${g.day}|${Math.round(g.mood)}|${g.stopes.map((s) => s.status).join("")}|${g.log.length}`;
    const prepourSig = g.pourPhase === "prepour"
      ? `|${g.pourNote.issued}|${g.pourNote.approved}|${g.checklist.map((c) => (c.checked ? 1 : 0)).join("")}` : "";
    const key = g.campaignOver ? "over"
      : g.activeEvent ? `event|${g.activeEvent.id}`
      : g.view === "board" ? `board|${g.mode}|${boardSig}`
      : `pour|${g.mode}|${g.pourPhase}${prepourSig}`;
    if (key !== this.mountedKey) { this.mountedKey = key; this.mount(); }
    this.patch();
  }

  private mount() {
    document.getElementById("topbar")!.innerHTML = this.topbar();
    document.getElementById("panel")!.innerHTML = this.panel();
    document.getElementById("stageOverlay")!.innerHTML = this.overlay();
    const modal = document.getElementById("modal")!;
    if (this.game.campaignOver) { modal.innerHTML = this.reviewModal(); modal.classList.remove("hidden"); }
    else if (this.game.activeEvent) { modal.innerHTML = this.eventModal(); modal.classList.remove("hidden"); }
    else { modal.innerHTML = ""; modal.classList.add("hidden"); }
    this.attachInputs();
  }

  private patch() {
    const g = this.game;
    const st = g.stopes;
    setText("clockDay", `Day ${g.day}`);
    setText("clockHorizon", `of ${CAMPAIGN.horizonDay}`);
    setText("moodVal", `${Math.round(g.mood)}`);
    setText("spendVal", `$${Math.round(g.spend / 1000)}k / ${Math.round(CAMPAIGN.budget / 1000)}k`);
    const moodBar = document.getElementById("moodBar"); if (moodBar) moodBar.style.width = `${g.mood}%`;
    const spendBar = document.getElementById("spendBar");
    if (spendBar) { const f = Math.min(100, (g.spend / CAMPAIGN.budget) * 100); spendBar.style.width = `${f}%`; spendBar.className = `miniFill ${f > 100 ? "red" : f > 85 ? "amber" : "green"}`; }
    const sec = document.getElementById("section"); if (sec) sec.innerHTML = stageSvg(g);
    if (g.view === "pour" && g.pourPhase === "design") this.patchDesign();
    if (g.view === "pour" && g.pourPhase === "pouring") this.patchPour();
  }

  // ---- top bar --------------------------------------------------------------

  private topbar(): string {
    const g = this.game;
    return `
      <div class="brand">CUT &amp; <span>FILL</span> <em>· Wheal Verity</em></div>
      <div class="screenToggle">
        <button data-action="screen" data-s="mine" class="btn ${this.screen === "mine" ? "on" : ""}">⛏ Mine</button>
        <button data-action="screen" data-s="plant" class="btn ${this.screen === "plant" ? "on" : ""}">🏭 Plant</button>
      </div>
      <div class="clock"><span id="clockDay">Day ${g.day}</span><span class="muted" id="clockHorizon">of ${CAMPAIGN.horizonDay}</span></div>
      <div class="mini"><span class="miniLabel">Budget</span><div class="miniTrack"><div id="spendBar" class="miniFill green"></div></div><b id="spendVal"></b></div>
      <div class="mini"><span class="miniLabel">Mgr mood</span><div class="miniTrack"><div id="moodBar" class="miniFill amber"></div></div><b id="moodVal"></b></div>
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
    if (g.view === "board") return `<div class="stageTitle">The Mine — Wheal Verity</div>`;
    const st = g.activeStope();
    const titles: Record<string, string> = { design: "Recipe & Line Design", prepour: "Pre-Pour Checks", pouring: "POUR IN PROGRESS", flushing: "Flush & Shutdown" };
    return `<div class="stageTitle">${st ? st.spec.id + " · " : ""}${titles[g.pourPhase ?? ""] ?? ""}</div>`;
  }

  // ---- panels ---------------------------------------------------------------

  private panel(): string {
    const g = this.game;
    if (g.view === "board") return this.pBoard();
    switch (g.pourPhase) {
      case "design": return this.pDesign();
      case "prepour": return this.pPrepour();
      case "pouring": return this.pPour();
      case "flushing": return this.pFlush();
      default: return "";
    }
  }

  private pBoard(): string {
    const g = this.game;
    const s = g.campaignStats();
    const rows = g.stopes.map((st) => this.stopeRow(st)).join("");
    const logHtml = g.log.slice(-9).reverse().map((l) => `<div class="logline ${l.kind}">${l.text}</div>`).join("");
    return `
      <div class="card boardCard">
        <h3>Stope schedule <span class="hint">${s.passed}/${s.scheduled} handed back</span></h3>
        <div class="board">${rows}</div>
        <button class="btn" data-action="skip3">⏩ Advance 3 days (wait for cures / mucking)</button>
      </div>
      <div class="card logCard">
        <h3>Mine activity</h3>
        <div class="log">${logHtml}</div>
      </div>`;
  }

  private stopeRow(st: StopeRun): string {
    const g = this.game;
    const days = st.spec.dueDay - g.day;
    const ucs28 = st.ucsResults.find((r) => r.ageDays === 28);
    const ucs7 = st.ucsResults.find((r) => r.ageDays === 7);
    let right = "";
    if (st.status === "available") {
      const late = g.day > st.spec.dueDay;
      right = `<button class="btn primary sm" data-action="select" data-id="${st.spec.id}">Design & fill →</button>
               <span class="due ${late ? "late" : days <= 3 ? "soon" : ""}">${late ? "LATE" : "due in " + days + "d"}</span>`;
    } else if (st.status === "scheduled") {
      right = `<span class="due muted">mucked day ${st.spec.availableDay}</span>`;
    } else if (st.status === "curing") {
      const age = (g.day - (st.cureStartDay ?? g.day)).toFixed(0);
      right = `<span class="due">curing ${age}/28d${ucs7 ? " · 7d " + ucs7.achievedKpa : ""}</span>`;
    } else if (st.status === "handed-back") {
      right = `<span class="due pass">✔ ${ucs28?.achievedKpa} kPa</span>`;
    } else if (st.status === "failed") {
      right = `<span class="due fail">✖ ${ucs28?.achievedKpa} kPa</span>`;
    } else if (st.status === "filling") {
      right = `<span class="due">▶ filling…</span>`;
    }
    return `
      <div class="stopeRow status-${st.status}">
        <div class="srMain">
          <b>${st.spec.id}</b>
          <span class="srMeta">−${st.spec.level}m · ${st.spec.volumeM3} m³ · ${term("ucs", st.spec.targetUcsKpa + " kPa")}</span>
        </div>
        <div class="srRight">${right}</div>
      </div>`;
  }

  private stopeHeader(): string {
    const st = this.game.activeStope();
    if (!st) return "";
    return `<div class="pnRow"><span>${st.spec.name}</span><b>${st.spec.volumeM3} m³ · target ${st.spec.targetUcsKpa} kPa · due day ${st.spec.dueDay}</b></div>`;
  }

  private pDesign(): string {
    const g = this.game;
    return `
      <div class="card">
        <h3>① Build the line (${term("hgl", "UDS")}) <span class="hint">${g.mode}</span></h3>
        ${this.stopeHeader()}
        <p class="muted small">Click a pipe on the section to set its class (rating &amp; bore). Click the ring at a pipe's head to drop a choke (cuts head) or a booster. Stage cheap pipe up high, strong pipe deep, or choke the deep leg to run it cheap.</p>
        <div id="lineStatus"></div>
        <div class="row"><button class="btn" data-action="autoLine">✨ Auto-line (safe)</button></div>

        <h3 style="margin-top:16px">② Mix (recipe)</h3>
        <label class="slider"><span>Solids concentration <b id="dSolidsVal"></b></span>
          <input type="range" id="sSolids" min="66" max="82" step="0.5" value="${g.recipe.solids * 100}">
          <small>${term("yield-stress", "yield stress")} rises steeply past 78%</small></label>
        <label class="slider"><span>${term("binder", "Binder dose")} <b id="dBinderVal"></b></span>
          <input type="range" id="sBinder" min="60" max="450" step="5" value="${g.recipe.binderKgPerM3}">
          <small>~70% of opex — deeper stopes want more strength</small></label>
        <label class="field"><span>Target flow (m³/h)</span>
          <input type="number" id="inFlow" min="10" max="80" step="5" value="${g.pourNote.targetFlowM3h}"></label>
        <div id="designReadout"></div>
        <div class="row"><button class="btn" data-action="autoRecipe">✨ Auto-recipe</button></div>
        <button class="btn primary big" data-action="toPrepour" id="btnProceed">Issue pour note →</button>
        <button class="btn ghost" data-action="backBoard">← back to the board</button>
      </div>`;
  }

  private pPrepour(): string {
    const g = this.game;
    return `
      <div class="card">
        <h3>Pre-pour checklist</h3>
        <div class="checklist">
          ${g.checklist.map((c) => `<label class="check ${c.checked ? "done" : ""}"><input type="checkbox" data-action="check" data-key="${c.key}" ${c.checked ? "checked" : ""}><span>${c.label}</span></label>`).join("")}
        </div>
        <div class="pourNote">
          <div class="pnHead">${term("pour-note", "POUR NOTE")} · ${g.pourNote.stopeId}</div>
          <div class="pnRow"><span>Mix</span><b>${(g.pourNote.recipe.solids * 100).toFixed(1)}% · ${g.pourNote.recipe.binderKgPerM3} kg/m³</b></div>
          <div class="pnRow"><span>Volume / flow</span><b>${g.pourNote.plannedVolumeM3} m³ @ ${g.pourNote.targetFlowM3h} m³/h</b></div>
          <div class="pnActions">
            <button class="btn ${g.pourNote.issued ? "on" : ""}" data-action="issue">${g.pourNote.issued ? "✓ Issued" : "Issue"}</button>
            <button class="btn ${g.pourNote.approved ? "on" : ""}" data-action="approve" ${g.pourNote.issued ? "" : "disabled"}>${g.pourNote.approved ? "✓ Approved" : "Approve"}</button>
          </div>
        </div>
        <button class="btn primary big" data-action="beginPour" ${g.pourNote.approved ? "" : "disabled"}>Begin pour ▶</button>
        <button class="btn ghost" data-action="backDesign">← back to design</button>
      </div>`;
  }

  private pPour(): string {
    return `
      <div class="card pourhud">
        <div class="subphase" id="subPhase"></div>
        <div id="pourGauges"></div>
        <label class="slider"><span>Flow rate <b id="flowVal"></b></span>
          <input type="range" id="sFlow" min="0" max="80" step="1" value="${this.game.pour.targetFlowM3h}"></label>
        <div class="row"><button class="btn warn" data-action="flush">💧 Flush line</button><button class="btn" data-action="pause">⏸ Hold</button></div>
        <div class="alarms" id="alarms"></div>
      </div>`;
  }

  private pFlush(): string {
    const st = this.game.activeStope();
    return `
      <div class="card">
        <h3>Pour complete — flush & shut down</h3>
        <p><b>${st?.spec.id}</b> is filled. Clean the line, then it cures in the background while you work the next stope.</p>
        <button class="btn primary big" data-action="completeFlush">Flush line & start cure →</button>
      </div>`;
  }

  // ---- modals ---------------------------------------------------------------

  private eventModal(): string {
    const ev = this.game.activeEvent!;
    return `
      <div class="modal event">
        <div class="modalHead">⚠ EVENT · ${ev.title}</div>
        <p class="modalBody">${ev.body}</p>
        <div class="options">
          ${ev.options.map((o, i) => `<button class="optBtn" data-action="resolveEvent" data-i="${i}"><b>${o.label}</b><span>${o.detail}</span></button>`).join("")}
        </div>
      </div>`;
  }

  private reviewModal(): string {
    const g = this.game;
    const s = g.campaignStats();
    return `
      <div class="modal review">
        <div class="modalHead">Board Review · End of Campaign</div>
        <div class="scorecard">
          <div class="grade grade-${g.finalGrade}">${g.finalGrade}</div>
          <div class="kpis">
            ${kpi("Stopes handed back", `${s.passed}/${s.scheduled}`)}
            ${kpi("On time", `${s.onTime}/${s.scheduled}`)}
            ${kpi("Cost / tonne", `$${s.costPerTonne.toFixed(1)}`)}
            ${kpi("Total spend", `$${Math.round(s.spend / 1000)}k / ${Math.round(s.budget / 1000)}k`)}
            ${kpi("Late-fill cost", `$${Math.round(s.lateCost / 1000)}k`)}
            ${kpi("Safety", s.safetyIncidents ? `${s.safetyIncidents} incident` : "clean")}
          </div>
        </div>
        <div class="verdict"><div class="portrait small">🪖</div><p>${g.boardVerdict}</p></div>
        <button class="btn primary big" data-action="restart">▶ Run the campaign again</button>
      </div>`;
  }

  // ---- patches --------------------------------------------------------------

  private patchDesign() {
    const g = this.game;
    const st = g.activeStope(); if (!st) return;
    const ev = g.evalRecipe(st);
    setText("dSolidsVal", `${(g.recipe.solids * 100).toFixed(1)}%`);
    setText("dBinderVal", `${g.recipe.binderKgPerM3} kg/m³`);

    // ---- line status ----
    const pp = g.designProfile(st.spec.id);
    const cost = g.plannedLineCost(st.spec.id);
    const ls = document.getElementById("lineStatus");
    if (ls) {
      const statusCls = pp.reticulated ? "ok" : "";
      const statusTxt = !pp.allBuilt ? `Incomplete — ${pp.issue}` : pp.burst ? `⚠ ${pp.issue}` : pp.slack ? `⚠ ${pp.issue}` : pp.reticulated ? `✓ Line good — peak ${pp.peakP.toFixed(1)} MPa, delivers ${pp.deliveredP.toFixed(1)} MPa` : pp.issue;
      ls.innerHTML = `<div class="warnbox ${statusCls}">${statusTxt}</div>
        <div class="lineCost"><span>Line capex to build</span><b>${cost > 0 ? "$" + cost.toLocaleString() : "— (already built)"}</b></div>`;
    }
    const proceed = document.getElementById("btnProceed") as HTMLButtonElement | null;
    if (proceed) {
      const ready = pp.reticulated;
      proceed.disabled = !ready;
      proceed.textContent = ready ? "Issue pour note →" : "Build a valid line first";
    }

    const ro = document.getElementById("designReadout"); if (!ro) return;
    const ucsOk = ev.ucs28Predicted >= st.spec.targetUcsKpa;
    const pressOk = ev.peakPressureMpa <= ev.ratingMpa;
    if (g.mode === "manager") {
      ro.innerHTML = `
        <div class="gauges">
          ${gauge("Strength (UCS 28d)", ev.ucs28Predicted, st.spec.targetUcsKpa * 1.5, st.spec.targetUcsKpa, "kPa", ucsOk)}
          ${gauge("Cost / m³", ev.costPerM3, 90, 45, "$", ev.costPerM3 < 55)}
          ${light(term("hgl", "Line pressure"), pressOk ? (ev.hglMargin < 0.15 ? "amber" : "green") : "red", pressOk ? (ev.hglMargin < 0.15 ? "tight" : "OK") : "OVER")}
          ${light(term("plug", "Plug risk"), ev.regime === "plug-risk" ? "red" : ev.regime === "slack-risk" ? "amber" : "green", ev.regime === "laminar" ? "low" : ev.regime)}
        </div>${warnBlock(ev.warnings)}`;
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
          ${row("Predicted UCS 28d", ev.ucs28Predicted.toFixed(0), "kPa", !ucsOk)}
          ${row("Cost / m³", ev.costPerM3.toFixed(2), "$")}
        </table>${warnBlock(ev.warnings)}`;
    }
  }

  private patchPour() {
    const g = this.game;
    const p = g.pour;
    const st = g.activeStope(); if (!st) return;
    const ev = g.evalRecipe(st);
    const names: Record<string, string> = { "water-test": "① Water test", "line-fill": `② ${term("low-solids-start", "Low-solids line fill")}`, main: "③ Main recipe", done: "Done" };
    const sub = document.getElementById("subPhase"); if (sub) sub.innerHTML = names[p.subPhase] ?? "";
    setText("flowVal", `${p.currentFlowM3h.toFixed(0)} m³/h`);
    const margin = (ev.ratingMpa - p.pressureMpa) / ev.ratingMpa;
    const pressColor = p.pressureMpa > ev.ratingMpa ? "red" : margin < 0.15 ? "amber" : "green";
    const gaugesEl = document.getElementById("pourGauges");
    if (gaugesEl) {
      const volFrac = p.placedM3 / st.spec.volumeM3;
      gaugesEl.innerHTML = g.mode === "engineer"
        ? `${bar(term("hgl", "Pressure"), p.pressureMpa, ev.ratingMpa, `${p.pressureMpa.toFixed(1)} / ${ev.ratingMpa} MPa`, pressColor)}
           ${bar("Volume placed", volFrac, 1, `${p.placedM3.toFixed(0)} / ${st.spec.volumeM3} m³`, "blue")}
           ${bar("Plug drift", p.plugDrift, 1, `${(p.plugDrift * 100).toFixed(0)}%`, p.plugDrift > 0.5 ? "red" : "green")}`
        : `${light(term("hgl", "Line pressure"), pressColor, pressColor === "green" ? "OK" : pressColor === "amber" ? "HIGH — ease off" : "CRITICAL")}
           ${bar("Volume placed", volFrac, 1, `${(volFrac * 100).toFixed(0)}%`, "blue")}
           ${light(term("plug", "Plug forming?"), p.plugDrift > 0.5 ? "red" : p.plugDrift > 0.25 ? "amber" : "green", p.plugDrift > 0.5 ? "YES — flush!" : p.plugDrift > 0.25 ? "building" : "clear")}`;
    }
    const al = document.getElementById("alarms");
    if (al) al.innerHTML = p.alarms.slice(-4).map((a) => `<div class="alarm">${a}</div>`).join("");
  }

  // ---- inputs & actions -----------------------------------------------------

  private attachInputs() {
    const g = this.game;
    if (g.view === "pour" && g.pourPhase === "design") {
      bindRange("sSolids", (v) => { g.recipe.solids = v / 100; this.patchDesign(); this.refreshSection(); });
      bindRange("sBinder", (v) => { g.recipe.binderKgPerM3 = v; this.patchDesign(); this.refreshSection(); });
      const flow = document.getElementById("inFlow") as HTMLInputElement | null;
      flow?.addEventListener("change", () => { g.pourNote.targetFlowM3h = +flow.value; });
    }
    if (g.view === "pour" && g.pourPhase === "pouring") bindRange("sFlow", (v) => g.setPourFlow(v));
  }

  private refreshSection() { const sec = document.getElementById("section"); if (sec) sec.innerHTML = stageSvg(this.game); }

  private onClick(e: Event) {
    const t = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!t) return;
    const g = this.game;
    switch (t.dataset.action!) {
      case "screen": this.setScreen(t.dataset.s as Screen); break;
      case "mode": g.mode = t.dataset.m as any; g.touch(); break;
      case "pause": g.paused = !g.paused; g.touch(); break;
      case "speed": g.speedIndex = +t.dataset.i!; g.paused = false; g.touch(); break;
      case "select": g.selectStope(t.dataset.id!); break;
      case "backBoard": g.backToBoard(); break;
      case "skip3": g.skipDays(3); break;
      case "seg": g.cycleSegment(t.dataset.id!); this.patchDesign(); this.refreshSection(); break;
      case "station": g.toggleStation(t.dataset.id!); this.patchDesign(); this.refreshSection(); break;
      case "autoLine": g.autoLine(g.activeStope()!.spec.id); this.patchDesign(); this.refreshSection(); break;
      case "autoRecipe": g.recipe = autoRecipe(g.activeStope()!.spec); this.remountDesign(); break;
      case "toPrepour": g.proceedToPrepour(); break;
      case "backDesign": g.backToDesign(); break;
      case "check": g.toggleChecklist(t.dataset.key!); break;
      case "issue": g.issuePourNote(); break;
      case "approve": g.approvePourNote(); break;
      case "beginPour": g.beginPour(); break;
      case "flush": g.flushLine(); break;
      case "completeFlush": g.completeFlush(); break;
      case "resolveEvent": g.resolveEvent(+t.dataset.i!); break;
      case "restart": g.restart(); break;
    }
  }

  private remountDesign() {
    document.getElementById("panel")!.innerHTML = this.panel();
    this.attachInputs(); this.patchDesign(); this.refreshSection();
  }

  private onHover(e: Event) {
    const t = e.target as HTMLElement;
    if (t.classList?.contains("term")) { const tip = t.dataset.tip; if (tip) { this.tip.textContent = tip; this.tip.classList.remove("hidden"); } }
  }
}

// ---- html helpers ---------------------------------------------------------

function setText(id: string, v: string) { const el = document.getElementById(id); if (el) el.textContent = v; }
function bindRange(id: string, cb: (v: number) => void) { const el = document.getElementById(id) as HTMLInputElement | null; el?.addEventListener("input", () => cb(+el.value)); }
function kpi(label: string, val: string) { return `<div class="kpi"><span>${label}</span><b>${val}</b></div>`; }
function gauge(label: string, val: number, max: number, target: number, unit: string, ok: boolean) {
  const pct = Math.max(0, Math.min(100, (val / max) * 100));
  const tpct = Math.max(0, Math.min(100, (target / max) * 100));
  return `<div class="gaugeWrap"><div class="gaugeLabel">${label} <b class="${ok ? "good" : "bad"}">${val.toFixed(0)}${unit}</b></div>
    <div class="gaugeTrack"><div class="gaugeFill ${ok ? "good" : "bad"}" style="width:${pct}%"></div><div class="gaugeTarget" style="left:${tpct}%"></div></div></div>`;
}
function bar(label: string, val: number, max: number, text: string, color: string) {
  const pct = Math.max(0, Math.min(100, (val / max) * 100));
  return `<div class="gaugeWrap"><div class="gaugeLabel">${label} <b>${text}</b></div><div class="gaugeTrack"><div class="gaugeFill ${color}" style="width:${pct}%"></div></div></div>`;
}
function light(label: string, color: string, text: string) { return `<div class="lightRow"><span class="dot ${color}"></span><span>${label}</span><b>${text}</b></div>`; }
function row(label: string, val: string, unit: string, bad = false) { return `<tr><td>${label}</td><td class="num ${bad ? "bad" : ""}">${val} <span class="unit">${unit}</span></td></tr>`; }
function warnBlock(warnings: string[]) { return warnings.length ? `<div class="warnbox">${warnings.map((w) => `<div>⚠ ${w}</div>`).join("")}</div>` : `<div class="warnbox ok">✓ Design is within limits.</div>`; }

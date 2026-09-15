import { World } from "./world3d/world.js";
import { SCENARIOS } from "./world3d/scenarios.js";
import { loadCompany, saveCompany, META_PERKS, hasPerk } from "./world3d/company.js";

// Passcode gate. We store only a SHA-256 hash of the code, never the plaintext.
// This is light protection (obscures a static site from casual visitors) — it is
// not server-side security. Change the code by updating PASS_HASH below.
const PASS_HASH = "1fe12337f2441b5deb8b6920505a4b2911e2dd900674d3e3b12e831e0501e912"; // "wheal-verity"
const STORE_KEY = "bf_unlock";

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const normalise = (s: string) => s.trim().toLowerCase();

let started = false;
function startGame() {
  if (started) return;
  started = true;
  const root = document.getElementById("app")!;
  root.classList.remove("locked");
  document.getElementById("gate")?.remove();
  // headless test hooks boot the default mine straight away (no select screen to click)
  if (location.hash.startsWith("#autorun") || location.hash.startsWith("#smartrun")) {
    new World(root, location.hash.endsWith("2") ? SCENARIOS[1] : SCENARIOS[0]).start(); return;
  }
  showScenarioSelect(root);
}

function showScenarioSelect(root: HTMLElement) {
  const el = document.createElement("div");
  el.className = "scenarioSelect";
  const render = () => {
    const co = loadCompany();
    const hq = `<div class="hqPanel">
      <div class="hqHead">🏢 Company HQ <span class="hqLegacy">${co.legacy} legacy</span></div>
      <div class="hqSub">Permanent perks, earned from every board review. Applied to all future campaigns.</div>
      <div class="hqPerks">${META_PERKS.map((p) => {
        const owned = hasPerk(co, p.id); const afford = co.legacy >= p.cost;
        const btn = owned ? `<span class="hqOwned">✓ owned</span>` : `<button class="hqBuy ${afford ? "on" : ""}" data-perk="${p.id}" ${afford ? "" : "disabled"}>${p.cost}</button>`;
        return `<div class="hqPerk ${owned ? "owned" : ""}"><div><b>${p.name}</b><span>${p.desc}</span></div>${btn}</div>`;
      }).join("")}</div>
    </div>`;
    el.innerHTML = `<div class="scWrap">
      <div class="scTitle">BACKFILL <span>TYCOON</span></div>
      <div class="scSub">Choose your operation</div>
      <div class="scCards">${SCENARIOS.map((s, i) => `
        <button class="scCard" data-i="${i}">
          <div class="scName">${s.name}</div>
          <div class="scDiff ${s.difficulty.toLowerCase()}">${s.difficulty}</div>
          <div class="scBlurb">${s.blurb}</div>
          <div class="scStats">$${Math.round(s.startCash / 1e6)}m budget · ${s.horizonDays} days · levels ${s.depths.join(" / ")} m</div>
        </button>`).join("")}</div>
      ${hq}
    </div>`;
    el.querySelectorAll<HTMLElement>("[data-i]").forEach((b) => b.addEventListener("click", () => {
      const s = SCENARIOS[+b.dataset.i!]; el.remove(); new World(root, s).start();
    }));
    el.querySelectorAll<HTMLElement>("[data-perk]").forEach((b) => b.addEventListener("click", () => {
      const p = META_PERKS.find((x) => x.id === b.dataset.perk); const c = loadCompany();
      if (p && !hasPerk(c, p.id) && c.legacy >= p.cost) { c.legacy -= p.cost; c.perks.push(p.id); saveCompany(c); render(); }
    }));
  };
  render();
  root.appendChild(el);
}

async function tryUnlock(code: string): Promise<boolean> {
  const h = await sha256(normalise(code));
  if (h === PASS_HASH) {
    try { localStorage.setItem(STORE_KEY, h); } catch {}
    return true;
  }
  return false;
}

async function boot() {
  // Already unlocked this browser?
  try { if (localStorage.getItem(STORE_KEY) === PASS_HASH) { startGame(); return; } } catch {}

  const input = document.getElementById("gateInput") as HTMLInputElement | null;
  const btn = document.getElementById("gateBtn");
  const err = document.getElementById("gateErr");
  const submit = async () => {
    if (!input) return;
    if (await tryUnlock(input.value)) startGame();
    else { if (err) err.textContent = "Wrong passcode."; input.value = ""; input.focus(); }
  };
  btn?.addEventListener("click", submit);
  input?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  input?.focus();
}

boot();

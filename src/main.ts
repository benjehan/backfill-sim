import { Game } from "./sim/state.js";
import { App } from "./ui/app.js";

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
  const gate = document.getElementById("gate");
  if (gate) gate.remove();
  const game = new Game();
  new App(root, game);
  (window as any).__game = game; // exposed for debugging / headless testing
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

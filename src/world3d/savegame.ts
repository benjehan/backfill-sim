// Save/resume via localStorage. One in-progress campaign is kept under bt_save;
// it is written on every meaningful change and cleared when the campaign ends.
// The shape is loose (a plain snapshot) — World owns serialize()/loadSave().

export const SAVE_KEY = "bt_save";
export const SAVE_VERSION = 1;

export function writeSave(state: object) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch { /* private mode / quota */ }
}
export function readSave(): any | null {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); return s && s.v === SAVE_VERSION ? s : null; }
  catch { return null; }
}
export function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } }

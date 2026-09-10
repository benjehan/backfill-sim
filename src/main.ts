import { Game } from "./sim/state.js";
import { App } from "./ui/app.js";

const root = document.getElementById("app");
if (root) {
  const game = new Game();
  new App(root, game);
  (window as any).__game = game; // exposed for debugging / headless testing
}

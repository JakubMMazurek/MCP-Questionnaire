/**
 * Entry point for the `ui://forms/renderer` bundle.
 *
 * One resource serves every form type forever: the rendering engine ships in the
 * bundle, the schema arrives as data over the host bridge (§7.1).
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createEngineStore } from "./engine/index.js";
import { createBridge, parentTransport } from "./host/index.js";
import { AppProvider } from "./state";
import "./styles.css";

const store = createEngineStore();
const bridge = createBridge({ transport: parentTransport(), store });
const container = document.getElementById("root");

if (container) {
  createRoot(container).render(
    <AppProvider value={{ store, bridge }}>
      <App />
    </AppProvider>,
  );
  // The handshake must run before the host will send us anything (§7.2).
  void bridge.start();
}

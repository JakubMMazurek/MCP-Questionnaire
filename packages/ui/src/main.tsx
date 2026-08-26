/**
 * Entry point for the `ui://forms/renderer` bundle.
 *
 * One resource serves every form type forever: the rendering engine ships in the
 * bundle, the schema arrives as data over the host bridge (§7.1).
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createEngineStore } from "./engine/index.js";
import { createBridge } from "./host/index.js";
import { AppProvider } from "./state";
import "./styles.css";

const store = createEngineStore();
// No transport: the SDK's default is `PostMessageTransport(window.parent,
// window.parent)` — talk to whatever framed us, and validate that the replies
// come back from it.
const bridge = createBridge({ store });
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

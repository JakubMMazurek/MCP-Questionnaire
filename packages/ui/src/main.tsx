/**
 * Entry point for the one bundle, which serves both carriers.
 *
 * Mounted by a host as `ui://forms/renderer`, the schema arrives over the
 * postMessage handshake and drafts travel as `save_draft` tool calls (§7.1).
 * Served by the Worker as a page — for Claude Code, which mounts no `ui://`
 * resource at all — the schema is already inlined in the document and drafts
 * POST to our own origin (PROPOSAL-standalone-route.md).
 *
 * Nothing above this file knows the difference. The bundle stays ONE file for
 * the same reason §7.1 gives for one resource: the rendering engine ships in
 * it, the schema is data, and a second build would be a second thing to keep
 * true.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createEngineStore } from "./engine/index.js";
import { createBridge, createStandaloneBridge, readBootstrap } from "./host/index.js";
import { AppProvider } from "./state";
import "./styles.css";

const store = createEngineStore();
const bootstrap = readBootstrap();
// A bootstrap in the document means the Worker served this page. Without one,
// no transport is passed and the SDK's default applies —
// `PostMessageTransport(window.parent, window.parent)`, i.e. "talk to whatever
// framed us", which is exactly right for a host-mounted resource.
const bridge = bootstrap ? createStandaloneBridge({ store, bootstrap }) : createBridge({ store });
const container = document.getElementById("root");

if (container) {
  createRoot(container).render(
    <AppProvider value={{ store, bridge }}>
      <App />
    </AppProvider>,
  );
  // On the host carrier this runs the §7.2 handshake, without which the host
  // sends nothing. On the standalone carrier it renders what the page arrived
  // holding.
  void bridge.start();
}

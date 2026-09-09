/**
 * The standalone carrier, previewable before the Worker route exists.
 *
 * `main.tsx` decides its carrier by reading the bootstrap out of the document
 * at import time, because in production the Worker has already written it
 * there. So this page writes it first and imports the real entry after —
 * exercising the actual selection path rather than a copy of it that could
 * drift.
 *
 * Not part of the production build: `vite.config.ts` pins the input to
 * `index.html`, and `/dev/save-draft` exists only under `vite dev` (see the
 * `mcpq-dev-endpoints` plugin).
 */

import { archetypes } from "@mcpq/schema";
import type { StandaloneBootstrap } from "../src/host/index.js";

type FixtureKey = keyof typeof archetypes;

const requested = new URLSearchParams(location.search).get("fixture");
const key: FixtureKey =
  requested && requested in archetypes ? (requested as FixtureKey) : "assumptionLedger";

const bootstrap: StandaloneBootstrap = {
  form: archetypes[key],
  formId: `f_${key.toLowerCase()}_preview`,
  endpoint: "/dev/save-draft",
};

const element = document.getElementById("mcpq-bootstrap");
if (element) element.textContent = JSON.stringify(bootstrap);

await import("../src/main.js");

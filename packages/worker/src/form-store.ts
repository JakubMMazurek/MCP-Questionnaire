/**
 * The Durable Object handle (§3 addressing).
 *
 * `getByName(formId)` is the current sugar for `get(idFromName(formId))`: every
 * request for one id reaches one instance, so writes serialise and reads are
 * strongly consistent. It lives in its own module because two carriers now
 * address the same store — the MCP tools and the standalone page's HTTP routes
 * — and they must address it identically.
 */

import type { WorkerEnv } from "./env.js";
import type { FormStore } from "./form-do.js";

export function formStore(env: WorkerEnv, formId: string): FormStore {
  // The cast is explained on `FormStore`: DO RPC's `Serializable` constraint
  // rejects the `unknown` an answer value legitimately is (§4.3), collapsing
  // the inferred return to `never`. Everything crossing the wire is plain JSON.
  return env.FORM_DO.getByName(formId) as unknown as FormStore;
}

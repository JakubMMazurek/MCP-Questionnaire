/**
 * Form ids (§3 — "Server-minted form ids", decided).
 *
 * The id IS the capability: no auth exists, so form state at rest is reachable
 * only by knowing the id. Agent-authored ids ("fls-review") would be
 * low-entropy and guessable, which is fatal under that model — so the Worker
 * mints them and returns the id in the stub result, which is also how the agent
 * learns it (to pass to `load_form`, and to chain forms, §5.6).
 *
 * 128 bits from `crypto.getRandomValues`, hex. Not a UUID: a v4 UUID spends 6
 * of its 128 bits on version/variant bits and adds hyphens, for no benefit here.
 */

const FORM_ID_BYTES = 16;

export const FORM_ID_PATTERN = /^[0-9a-f]{32}$/;

export function mintFormId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(FORM_ID_BYTES));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function isFormId(value: unknown): value is string {
  return typeof value === "string" && FORM_ID_PATTERN.test(value);
}

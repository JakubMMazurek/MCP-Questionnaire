/**
 * The Worker's view of its bindings.
 *
 * `wrangler types` infers `BASE_PATH` as the string LITERAL in wrangler.jsonc
 * (`"local-dev"`), which is exactly wrong for a value production overrides with
 * a secret — comparisons against a real path would narrow to `never`. So the
 * generated `Env` is widened here, and this type is what the code uses.
 */
export type WorkerEnv = Omit<Env, "BASE_PATH"> & {
  /** §3 — the unguessable path segment. Absent = serve nothing (fail closed). */
  BASE_PATH?: string;
};

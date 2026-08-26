/**
 * The five §5 archetypes written out in full against the meta-schema — build
 * step 2, the archetype audit. These double as the worked examples the server
 * will serve from `get_form_guide` (§6.2), so they use real content, real
 * provenance and real rules, never placeholders.
 *
 * Anything an archetype could NOT express cleanly is recorded in
 * `archetypes.test.ts` next to the assertion that documents the workaround.
 */

import type { Form } from "../types.js";
import { FORM_SCHEMA_VERSION } from "../vocab.js";

/**
 * §5.1 Assumption ledger — build this first.
 *
 * Shape: columns+data (§4.2). The verdict options are declared once as a
 * column; rows are data. Row provenance is NOT a row property: each verdict is
 * prefilled `confirm` with `source: "inferred"` + rationale + needsReview, so
 * the provenance chip, the review counter and bulk affirm all read the §4.7
 * envelope. "TBD" is an ordinary defer option (§4.3).
 */
export const assumptionLedger = {
  version: FORM_SCHEMA_VERSION,
  title: "Before I draft the rollout plan…",
  description:
    "I inferred these from our conversation. Fix anything wrong — or confirm the lot. Or just tell me in chat.",
  display: "fullscreen",
  submitLabel: "Use these assumptions",
  sections: [
    {
      id: "review",
      title: "Assumptions",
      fields: [
        {
          type: "computed",
          id: "unreviewed",
          label: "needing review",
          compute: { op: "count_needs_review", targets: ["assumptions.verdict"] },
        },
        {
          type: "computed",
          id: "tbd",
          label: "marked TBD",
          compute: { op: "count_value", targets: ["assumptions.verdict"], value: "tbd" },
        },
        {
          type: "table",
          id: "assumptions",
          label: "Inferred while planning",
          columns: [
            {
              type: "single_select",
              id: "verdict",
              label: "Verdict",
              render: "segmented",
              options: [
                { value: "confirm", label: "Confirm" },
                { value: "fix", label: "Fix" },
                { value: "tbd", label: "TBD" },
              ],
            },
            {
              type: "short_text",
              id: "correction",
              label: "What's right instead?",
              placeholder: "the corrected assumption",
            },
          ],
          rows: [
            {
              id: "r_eu",
              label: "Rollout targets the EU org only",
              description: "you mentioned EU customers twice",
            },
            {
              id: "r_salesops",
              label: "Sales Ops keeps edit access during migration",
              description: "current profile config",
            },
            {
              id: "r_cutover",
              label: "Cutover happens outside UK business hours",
              description: "inferred from your timezone",
            },
            {
              id: "r_legacy",
              label: "Legacy discount codes are frozen, not migrated",
              description: "you said “we never cleaned those up”",
            },
            {
              id: "r_revops",
              label: "Rev Ops signs off before production deploy",
              description: "assumed from previous projects",
            },
          ],
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "$self.verdict", op: "eq", value: "fix" },
      then: { action: "show", targets: ["$self.correction"] },
    },
  ],
  prefill: {
    "assumptions[r_eu].verdict": {
      value: "confirm",
      source: "inferred",
      confidence: "high",
      rationale: "you mentioned EU customers twice",
      needsReview: true,
    },
    "assumptions[r_salesops].verdict": {
      value: "confirm",
      source: "existing",
      rationale: "current profile config",
      needsReview: true,
    },
    "assumptions[r_cutover].verdict": {
      value: "confirm",
      source: "inferred",
      confidence: "low",
      rationale: "inferred from your timezone",
      needsReview: true,
    },
    "assumptions[r_legacy].verdict": {
      value: "confirm",
      source: "user",
      rationale: "you said “we never cleaned those up”",
      needsReview: true,
    },
    "assumptions[r_revops].verdict": {
      value: "confirm",
      source: "inferred",
      confidence: "low",
      rationale: "assumed from previous projects",
      needsReview: true,
    },
  },
} satisfies Form;

/**
 * §5.2 Elicitation — inline card, never fullscreen. 4–6 fields, defaults
 * prefilled, a tradeoff slider, "You decide" as an ordinary skip option,
 * `filter_options` doing the half of the mechanic people forget.
 */
export const elicitation = {
  version: FORM_SCHEMA_VERSION,
  title: "Quick setup for the data migration",
  description: "I've guessed where I could — check the amber ones. Or just tell me.",
  display: "inline",
  submitLabel: "Looks right — go",
  sections: [
    {
      id: "setup",
      title: "Setup",
      fields: [
        {
          type: "single_select",
          id: "scope",
          label: "Scope",
          render: "segmented",
          options: [
            { value: "accounts", label: "Accounts only" },
            { value: "accounts_contacts", label: "+ Contacts" },
            { value: "everything", label: "Everything" },
          ],
        },
        {
          type: "single_select",
          id: "environment",
          label: "Environment",
          render: "segmented",
          options: [
            { value: "sandbox", label: "Sandbox" },
            { value: "production", label: "Production" },
          ],
          skipOptions: [{ value: "claude_decides", label: "You decide" }],
        },
        {
          type: "single_select",
          id: "sandbox_name",
          label: "Which sandbox?",
          render: "segmented",
          options: [
            { value: "uat", label: "UAT" },
            { value: "dev", label: "Dev" },
            { value: "staging", label: "Staging" },
          ],
        },
        {
          type: "slider",
          id: "tradeoff",
          label: "Speed ↔ thoroughness",
          min: 0,
          max: 10,
          minLabel: "fast",
          maxLabel: "exhaustive",
        },
        {
          type: "date",
          id: "cutover",
          label: "Cutover",
          presets: [
            { value: "2026-09-30", label: "End of Q3" },
            { value: "2026-08-30", label: "Next weekend" },
          ],
          skipOptions: [{ value: "tbd", label: "TBD" }],
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "environment", op: "eq", value: "sandbox" },
      then: { action: "show", targets: ["sandbox_name"] },
    },
    {
      when: { field: "scope", op: "eq", value: "everything" },
      then: { action: "filter_options", targets: ["sandbox_name"], options: ["uat", "staging"] },
    },
  ],
  prefill: {
    scope: { value: "accounts", source: "user", rationale: "you said accounts first" },
    environment: {
      value: "sandbox",
      source: "inferred",
      confidence: "low",
      rationale: "you mentioned the July sandbox refresh",
      needsReview: true,
    },
    tradeoff: { value: 3, source: "default" },
    cutover: {
      value: "2026-09-30",
      source: "inferred",
      confidence: "high",
      rationale: "you mentioned end of quarter twice",
    },
  },
} satisfies Form;

/**
 * §5.3 Brainstorm convergence — prune, capture WHY the dead options died, add
 * your own. Written as a table (keep + one-tap rejection reason per row), NOT a
 * multi_select: rules can't test membership of a multi-valued answer, and the
 * per-candidate reason needs `$self` row scope anyway. Ranking the survivors is
 * the NEXT form in the chain (§5.6) — rank items are declared at authoring
 * time, and the survivors aren't known until this form comes back.
 */
export const convergence = {
  version: FORM_SCHEMA_VERSION,
  title: "Fifteen became five — now prune",
  description:
    "Keep what's worth pursuing. For the rest, one tap on why it died tells me the shape of the constraint.",
  display: "fullscreen",
  submitLabel: "Prune",
  sections: [
    {
      id: "prune",
      title: "Candidates",
      fields: [
        {
          type: "computed",
          id: "kept",
          label: "kept",
          compute: { op: "count_value", targets: ["candidates.keep"], value: true },
        },
        {
          type: "table",
          id: "candidates",
          label: "From our conversation",
          columns: [
            {
              type: "boolean",
              id: "keep",
              label: "Keep",
              render: "toggle",
            },
            {
              type: "single_select",
              id: "why_killed",
              label: "Why it died",
              render: "list",
              options: [
                { value: "too_expensive", label: "Too expensive" },
                { value: "too_slow", label: "Too slow" },
                { value: "wrong_team", label: "Wrong team" },
                { value: "already_tried", label: "Already tried" },
                { value: "not_the_problem", label: "Not the problem" },
              ],
            },
          ],
          rows: [
            {
              id: "r_selfserve",
              label: "Self-serve onboarding flow",
              description: "cuts support load at the source",
            },
            {
              id: "r_pricing",
              label: "Usage-based pricing tier",
              description: "aligns cost with the small accounts",
            },
            {
              id: "r_partner",
              label: "Partner-led implementation",
              description: "offloads services work",
            },
            { id: "r_docs", label: "Docs overhaul", description: "cheapest; unclear leverage" },
            {
              id: "r_csm",
              label: "Dedicated CSM for top 20",
              description: "expensive; retention play",
            },
          ],
        },
        {
          type: "repeatable",
          id: "additions",
          label: "Add your own",
          addLabel: "Add a candidate",
          max: 5,
          fields: [
            { type: "short_text", id: "idea", label: "Candidate" },
            { type: "short_text", id: "why", label: "Why it belongs on the list" },
          ],
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "$self.keep", op: "eq", value: false },
      then: { action: "show", targets: ["$self.why_killed"] },
    },
  ],
  prefill: {
    "candidates[r_selfserve].keep": {
      value: true,
      source: "inferred",
      confidence: "high",
      rationale: "you kept returning to support load",
      needsReview: true,
    },
    "candidates[r_docs].keep": {
      value: false,
      source: "inferred",
      confidence: "low",
      rationale: "you called it a band-aid",
      needsReview: true,
    },
  },
} satisfies Form;

/**
 * §5.3 + §5.6 Brainstorm convergence, FORM TWO — the chained rank.
 *
 * This is the archetype the audit found could not be one form: `rank` items are
 * declared at authoring time, and the survivors are not known until the prune
 * (`convergence`, above) comes back. So ranking and resourcing them is the NEXT
 * form in the chain, and this fixture is what that hand-off actually looks like.
 *
 * What makes it a chained form rather than a fresh one:
 *  - The rank items and the allocation members carry the SAME ids the prune's
 *    table rows had (`r_selfserve`, `r_pricing`, `r_partner`). Continuity is
 *    ids, not prose: the agent passes the first form's `formId` forward and
 *    reads its answers, so form two can be prefilled from form one (§5.6).
 *  - Every prefill here is a first-form OUTCOME wearing its provenance — the
 *    proposed order is `inferred` from what the user kept, the effort split is a
 *    `default` proposal, and the `info` block quotes what came back, so the user
 *    can see the premise they are ranking under.
 *  - The `set_default` rule shows the §4.6 overlay doing real work: choosing to
 *    run all three in parallel proposes an even split without writing an answer,
 *    and the proposal disappears the moment the condition flips.
 */
export const convergenceRank = {
  version: FORM_SCHEMA_VERSION,
  title: "Three survived — now order and resource them",
  description:
    "From the prune. Drag to set the order, then split the effort. Or just tell me in chat.",
  display: "fullscreen",
  submitLabel: "Lock the plan",
  sections: [
    {
      id: "order",
      title: "Priority",
      fields: [
        {
          type: "computed",
          id: "unreviewed",
          label: "needing review",
          compute: { op: "count_needs_review", targets: ["survivors", "sequencing"] },
        },
        {
          type: "info",
          id: "carried",
          label: "What came back from the prune",
          markdown:
            "**Kept:** self-serve onboarding, usage-based pricing, partner-led implementation.\n\n**Killed:** docs overhaul (*too slow*), dedicated CSM (*too expensive*). Both reasons point the same way — you are optimising for time-to-value, not for coverage.",
        },
        {
          type: "rank",
          id: "survivors",
          label: "Order of attack",
          description: "Position is the answer — drag, or use the handle and the arrow keys.",
          items: [
            {
              id: "r_selfserve",
              label: "Self-serve onboarding flow",
              description: "cuts support load at the source",
            },
            {
              id: "r_pricing",
              label: "Usage-based pricing tier",
              description: "aligns cost with the small accounts",
            },
            {
              id: "r_partner",
              label: "Partner-led implementation",
              description: "offloads services work",
            },
          ],
        },
      ],
    },
    {
      id: "resource",
      title: "Effort",
      fields: [
        {
          type: "computed",
          id: "allocated",
          label: "% of effort allocated",
          compute: { op: "sum", targets: ["effort"] },
        },
        {
          type: "single_select",
          id: "sequencing",
          label: "How do these run?",
          render: "segmented",
          options: [
            { value: "one_at_a_time", label: "One at a time" },
            { value: "parallel", label: "All three in parallel" },
          ],
          skipOptions: [{ value: "you_decide", label: "You decide" }],
        },
        {
          type: "allocation",
          id: "effort",
          label: "Engineering effort",
          description: "Under-allocate freely — I will read the remainder as slack.",
          total: 100,
          unit: "%",
          members: [
            { id: "r_selfserve", label: "Self-serve onboarding flow" },
            { id: "r_pricing", label: "Usage-based pricing tier" },
            { id: "r_partner", label: "Partner-led implementation" },
          ],
        },
        {
          type: "date",
          id: "first_checkpoint",
          label: "First checkpoint",
          presets: [
            { value: "2026-09-30", label: "End of Q3" },
            { value: "2026-10-31", label: "End of October" },
          ],
          skipOptions: [{ value: "tbd", label: "TBD" }],
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "sequencing", op: "eq", value: "one_at_a_time" },
      then: { action: "show", targets: ["first_checkpoint"] },
    },
    {
      when: { field: "sequencing", op: "eq", value: "parallel" },
      then: { action: "set_default", targets: ["effort"], value: 33 },
    },
  ],
  prefill: {
    survivors: {
      value: ["r_selfserve", "r_pricing", "r_partner"],
      source: "inferred",
      confidence: "high",
      rationale: "you kept returning to support load, and priced second",
      needsReview: true,
    },
    sequencing: {
      value: "one_at_a_time",
      source: "inferred",
      confidence: "low",
      rationale: "your team of four cannot run three tracks; say so if I have that wrong",
      needsReview: true,
    },
    "effort[r_selfserve]": { value: 60, source: "default" },
    "effort[r_pricing]": { value: 25, source: "default" },
    "effort[r_partner]": { value: 15, source: "default" },
  },
} satisfies Form;

/**
 * §5.4 Plan confirmation / draft review — plan sections are `info` fields with
 * ids; approve/revise anchors to each. Fully prefilled, diff-shaped, explicit
 * commit action. Verbose but expressible: one info + one verdict select per
 * plan part, sharing a section.
 */
export const planConfirmation = {
  version: FORM_SCHEMA_VERSION,
  title: "The migration plan, for sign-off",
  description:
    "Everything below is inferred — rationale on every verdict. Approve, or revise with a note anchored where it's wrong.",
  display: "fullscreen",
  submitLabel: "Commit the plan",
  sections: [
    {
      id: "phase1",
      title: "Phase 1 — sandbox dry run",
      fields: [
        {
          type: "computed",
          id: "revisions",
          label: "sections marked revise",
          compute: {
            op: "count_value",
            targets: ["phase1_verdict", "phase2_verdict", "rollback_verdict"],
            value: "revise",
          },
        },
        {
          type: "info",
          id: "phase1_plan",
          markdown:
            "**Week 1.** Full export of Accounts, dedupe pass, import into UAT with validation rules off. Success = row counts match and spot-check of 50 records.",
        },
        {
          type: "single_select",
          id: "phase1_verdict",
          label: "Phase 1",
          render: "segmented",
          options: [
            { value: "approve", label: "Approve" },
            { value: "revise", label: "Revise" },
          ],
        },
        {
          type: "short_text",
          id: "phase1_revision",
          label: "What changes?",
        },
      ],
    },
    {
      id: "phase2",
      title: "Phase 2 — production cutover",
      fields: [
        {
          type: "info",
          id: "phase2_plan",
          markdown:
            "**End of Q3, outside UK hours.** Freeze writes, final delta sync, switch integrations. Legacy discount codes stay frozen (your call from earlier).",
        },
        {
          type: "single_select",
          id: "phase2_verdict",
          label: "Phase 2",
          render: "segmented",
          options: [
            { value: "approve", label: "Approve" },
            { value: "revise", label: "Revise" },
          ],
        },
        {
          type: "short_text",
          id: "phase2_revision",
          label: "What changes?",
        },
      ],
    },
    {
      id: "rollback",
      title: "Rollback",
      fields: [
        {
          type: "info",
          id: "rollback_plan",
          markdown:
            "**If row counts diverge >0.1%** — restore from the pre-freeze snapshot, unfreeze writes, post-mortem before retry.",
        },
        {
          type: "single_select",
          id: "rollback_verdict",
          label: "Rollback",
          render: "segmented",
          options: [
            { value: "approve", label: "Approve" },
            { value: "revise", label: "Revise" },
          ],
        },
        {
          type: "short_text",
          id: "rollback_revision",
          label: "What changes?",
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "phase1_verdict", op: "eq", value: "revise" },
      then: { action: "show", targets: ["phase1_revision"] },
    },
    {
      when: { field: "phase2_verdict", op: "eq", value: "revise" },
      then: { action: "show", targets: ["phase2_revision"] },
    },
    {
      when: { field: "rollback_verdict", op: "eq", value: "revise" },
      then: { action: "show", targets: ["rollback_revision"] },
    },
  ],
  prefill: {
    phase1_verdict: {
      value: "approve",
      source: "inferred",
      confidence: "high",
      rationale: "follows the sandbox-first call you made",
      needsReview: true,
    },
    phase2_verdict: {
      value: "approve",
      source: "inferred",
      confidence: "low",
      rationale: "cutover window is my inference from your timezone",
      needsReview: true,
    },
    rollback_verdict: { value: "approve", source: "default", needsReview: true },
  },
} satisfies Form;

/**
 * §5.5 Matrix — FLS review. One cellType, options once, per-cell constraints
 * the renderer enforces without knowing the domain, baseline diff via
 * `source: "existing"` prefill on every cell, count_changed over the grid.
 */
export const matrixFls = {
  version: FORM_SCHEMA_VERSION,
  title: "Discount fields — profile access",
  description:
    "Current access prefilled as the baseline; changed cells render dirty with per-cell revert.",
  display: "fullscreen",
  submitLabel: "Apply 0 changes",
  sections: [
    {
      id: "fls",
      title: "Field-level security",
      fields: [
        {
          type: "computed",
          id: "changes",
          label: "changes vs current",
          compute: { op: "count_changed", targets: ["grid"] },
        },
        {
          type: "matrix",
          id: "grid",
          label: "Access by profile",
          cellType: "single_select",
          render: "cycle",
          cellOptions: [
            { value: "none", label: "–", description: "hidden" },
            { value: "r", label: "R", description: "read" },
            { value: "rw", label: "RW", description: "read + write" },
          ],
          rows: [
            { id: "Discount__c", label: "Discount__c" },
            { id: "Discount_Reason__c", label: "Discount_Reason__c" },
            { id: "Approval_Level__c", label: "Approval_Level__c" },
            { id: "Margin_Floor__c", label: "Margin_Floor__c", description: "formula field" },
          ],
          cols: [
            { id: "sales_ops", label: "Sales Ops" },
            { id: "rev_ops", label: "Rev Ops" },
            { id: "support", label: "Support" },
          ],
          constraints: [
            {
              row: "Margin_Floor__c",
              col: "sales_ops",
              allowed: ["none", "r"],
              readOnly: false,
              reason: "formula fields can't be written",
            },
            {
              row: "Margin_Floor__c",
              col: "rev_ops",
              allowed: ["none", "r"],
              reason: "formula fields can't be written",
            },
            {
              row: "Margin_Floor__c",
              col: "support",
              allowed: ["none", "r"],
              reason: "formula fields can't be written",
            },
            {
              row: "Discount__c",
              col: "rev_ops",
              readOnly: true,
              reason: "owned by the pricing team's permission set",
            },
          ],
        },
      ],
    },
  ],
  prefill: {
    "grid[Discount__c][sales_ops]": { value: "rw", source: "existing" },
    "grid[Discount__c][rev_ops]": { value: "rw", source: "existing" },
    "grid[Discount__c][support]": { value: "r", source: "existing" },
    "grid[Discount_Reason__c][sales_ops]": { value: "rw", source: "existing" },
    "grid[Discount_Reason__c][rev_ops]": { value: "r", source: "existing" },
    "grid[Discount_Reason__c][support]": { value: "r", source: "existing" },
    "grid[Approval_Level__c][sales_ops]": { value: "r", source: "existing" },
    "grid[Approval_Level__c][rev_ops]": { value: "rw", source: "existing" },
    "grid[Approval_Level__c][support]": { value: "none", source: "existing" },
    "grid[Margin_Floor__c][sales_ops]": { value: "r", source: "existing" },
    "grid[Margin_Floor__c][rev_ops]": { value: "r", source: "existing" },
    "grid[Margin_Floor__c][support]": { value: "none", source: "existing" },
  },
} satisfies Form;

export const archetypes = {
  assumptionLedger,
  elicitation,
  convergence,
  convergenceRank,
  planConfirmation,
  matrixFls,
} as const;

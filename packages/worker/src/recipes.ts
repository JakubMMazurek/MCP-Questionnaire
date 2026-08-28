/**
 * Layer 2 of five (§6.2) — `get_form_guide(archetype)` carries the CRAFT.
 *
 * This, not a skill, is the primary guidance channel: a tool call is far more
 * reliably performed than a file read, it is host-agnostic (no plugin, no
 * install), it updates by deploying a Worker, and it costs nothing standing.
 *
 * Each recipe is prose distilled from DESIGN.html §5.1–§5.5 plus §5.6, and
 * carries the findings of the 2026-08-26 archetype audit — the notes that are
 * exactly what a fresh author gets wrong: row provenance lives in the prefill
 * envelope and not on rows; convergence is a table plus a chained rank form,
 * not a multi_select; never ship a blank form; partial submit is the norm; keep
 * the chat escape hatch.
 *
 * The worked examples are the audited archetype fixtures from `@mcpq/schema`
 * — the same objects the validator's own test suite proves valid, so the
 * examples cannot rot away from the meta-schema.
 */

import {
  assumptionLedger,
  conditionalBranching,
  convergence,
  convergenceRank,
  elicitation,
  FORM_SCHEMA_VERSION,
  type Form,
  matrixFls,
  planConfirmation,
} from "@mcpq/schema";

/** The public vocabulary of `get_form_guide`. Named for the moment, not the type. */
export const ARCHETYPES = [
  "ledger",
  "elicitation",
  "convergence",
  "plan_confirmation",
  "matrix",
] as const;

export type ArchetypeName = (typeof ARCHETYPES)[number];

/* -------------------------------------------------------------------------- */
/* the shared half — §5.6, true of every archetype                            */
/* -------------------------------------------------------------------------- */

const CROSS_CUTTING = `ALWAYS, IN EVERY ARCHETYPE (§5.6 — more important than any field type)
- Never ship a blank form. Prefill everything you can infer, mark it source "inferred" with a rationale and confidence, and set needsReview on anything you want a human eye on. A form of empty fields is worse than the prose it replaced.
- Partial submit is the norm. required MARKS, it never blocks: it feeds the section rail, the asterisk and computed counters. Unanswered fields come back as { state: "empty" } and you decide whether to pick for them or ask. Only malformed values (wrong type, out of range, failed regex) gate submit.
- Leave the chat escape hatch. Put a line in the description — "…or just tell me in chat". It costs nothing and turns a mistriggered form from a dead end into a minor annoyance.
- Give the user a skip affordance rather than inventing one. skipOptions, or ordinary agent-defined options like "You decide" / "TBD". There is no special deferred state; you interpret those values yourself.
- Forms chain. elicitation -> draft -> convergence -> plan -> confirmation. Pass formIds forward instead of re-serialising answer maps and minted row ids through your own context, and prefill form three from form one's answers.
- Paths are a closed grammar, not JSONPath: field.sub, table[rowId].column, matrix[rowId][colId]. Row ids are ids, never ordinals — table[2].owner is rejected with a teaching error.
- Rules are one flat list of { when, then }; inside a table row, $self scopes to that row ($self.verdict -> $self.correction). Hidden fields contribute empty; set_default only writes into empty fields.
- NEVER ask for a secret itself. Passwords, API keys, tokens and card numbers must not be form fields: answers travel into your context and rest in the form's store. Ask for the SHAPE — "where does the key live?" with options like env var / secret manager / prompt at runtime — and let the user wire the value up themselves.`;

/* -------------------------------------------------------------------------- */
/* the rules half — §4.6, and the reason a form beats a list of questions      */
/* -------------------------------------------------------------------------- */

/**
 * Appended to every recipe. Branching is not an archetype — it is the mechanic
 * that makes all five of them worth more than prose, and the audited fixtures
 * only gestured at it. A twelve-field form that asks everything at once is the
 * thing this tool exists to replace, and an author who has not seen `show`
 * pointed at a SECTION will write one.
 */
const RULES = `RULES — ONE ANSWER RESHAPES THE FORM (§4.6). Read this even if you think you only need fields.

A form that asks for every branch at once is barely better than the prose it replaced. The user should see the four fields their situation needs, not the twelve that cover every situation.

TARGET SECTIONS, NOT JUST FIELDS. "targets" takes section ids as happily as field ids, so a branch arrives as a titled block with its own description:
  { when: { field: "auth_method", op: "eq", value: "oauth" }, then: { action: "show", targets: ["oauth_details"] } }
A "show" target STARTS HIDDEN — inferred from the rule list, so you need no matching "hide" rule and nothing flashes on first render. Same for "enable": an "enable" target starts disabled.

A SECTION GOVERNS WHAT IS INSIDE IT. Hiding or disabling a section hides or disables everything in it, whatever narrower rule a field in there carries — visibility is a precondition, not a competition, so rule order cannot change the answer. The useful half of that: branches NEST. Show a section on one answer and a single field inside it on another, and the field waits for its own condition instead of arriving with the section. What a closed section holds still submits empty (§4.6).

THE OPS: eq, neq, in, contains, not_contains, contains_all, contains_any, contains_none, gt, lt, empty, filled. "in" takes an array and is how two branches share a section ("value": ["api_key", "oauth"]). "empty"/"filled" take no value and are how you react to the user having answered at all.

BRANCHING ON A multi_select TAKES THE SET OPS, NOT "in". A multi_select holds a SET, and "in" asks whether the field's whole value is one of your candidates — against a set that is never true, so the rule silently never fires and the branch never appears. Which one:
- "contains" / "not_contains" — ONE option value. { when: { field: "toppings", op: "contains", value: "pepperoni" }, then: { action: "show", targets: ["meat_note"] } }
- "contains_all" — a list, every one of them present. The only way to say AND, because a rule list cannot: two rules with the same target mean OR.
- "contains_any" — a list, at least one present. Same meaning as one "contains" rule per value; use it when that would be three lines of noise.
- "contains_none" — a list, none of them present. Also a conjunction, so also not writable any other way.
- "eq" with the full array — exactly this selection, order-insensitive.
There is no "does not contain all of these" on purpose: it is the OR-shaped negation, so two "not_contains" rules with the same target already say it, and the name reads to almost everyone as "contains none". Every one of these is FALSE on a field the user has not answered, "contains_none" included — presence is what "empty"/"filled" are for.

THE ACTIONS, and what each is actually for:
- show / hide — the branch itself. Prefer show, so the default state is "not asked".
- require / optional — mark a field inside the live branch. required MARKS, never gates (§6.3): it drives the asterisk, the section rail and count_empty. A blank required field still submits.
- filter_options — narrow a select from an earlier answer (region -> datacentre, environment -> instance size). Two filters on one target INTERSECT rather than overwrite. You need no clear rule for the stale value: an answer that no longer survives its filter reads as absent everywhere, including in the payload.
- set_default — propose a value. Writes ONLY into an empty field, so it can never overrule the user; it is a proposal with a rule behind it, not an answer.
- clear — blank a field the new answer invalidated. EDGE-triggered (fires on the condition going false -> true, never for as long as it holds, and never on the form's first evaluation), or it would blank a field the user is trying to type into. Only worth aiming at a field that STAYS VISIBLE: what a branch hides already submits empty, so clearing it is redundant.
- enable / disable — grey a control out while leaving it legible. Use it when the user should see that something exists and why they cannot touch it yet; use hide when it is simply not their business.

BRANCHES COMPOSE. The list is flat and re-evaluated until the rendered state is stable, so two independent conditions on two different fields need no nesting, and a rule may read a field a rule revealed. Don't build a cycle (A shows B, B hides A) — the validator warns, and the engine caps the iterations.

WHAT A CLOSED BRANCH SUBMITS. Empty, whatever the user typed there before switching (§4.6 — the payload is a function of the rendered view). The client keeps the typing so flipping back is lossless, but you never receive answers from a path the user abandoned. That is what makes branching safe to use freely.

WORKED: call get_form_guide("elicitation") — its second example is a branching connection form with sections per credential kind, "in" for the shared endpoint, a filter_options cascade, require, set_default and clear, all in one valid envelope.`;

/* -------------------------------------------------------------------------- */
/* the recipes                                                                */
/* -------------------------------------------------------------------------- */

const LEDGER = `ASSUMPTION LEDGER (§5.1) — the highest-value form, and the one to reach for first.

THE FAILURE MODE IT FIXES
A plan rests on forty small inferences. The user catches two wrong ones on read-through and the other thirty-eight stay wrong silently — not agreed to, just invisible. Nobody audits a paragraph for premises. A ledger makes every premise a thing you can click.

SHAPE
Generate it columns+data, not forty fields: one table whose columns are declared once and whose rows are data. That is what makes forty rows cheap.
- Column 1: single_select, render "segmented", options like Confirm / Fix / TBD. Add your own defer option ("TBD", "You decide") — it is an ordinary option, and you interpret it.
- Column 2: short_text for the correction, hidden until it is needed.
- Rows: one per inference. id is a stable minted id (r_eu, r_cutover), label is the assumption in the user's own terms, description is where it came from.
- A rule with $self row scope reveals the correction column only on the row the user marked wrong:
  { when: { field: "$self.verdict", op: "eq", value: "fix" }, then: { action: "show", targets: ["$self.correction"] } }

ROW PROVENANCE LIVES IN THE PREFILL ENVELOPE — audited 2026-08-26, and the one thing authors get wrong.
Do NOT put source/confidence/rationale on the row. Prefill each verdict cell instead:
  "assumptions[r_eu].verdict": { value: "confirm", source: "inferred", confidence: "high", rationale: "you mentioned EU customers twice", needsReview: true }
One envelope then drives three things at once: the provenance chip on the row, the count_needs_review counter, and bulk affirm — which is precisely "accept the needs-review prefills". Split provenance across rows and prefills and all three break.

COUNTERS
Add computed fields in the same section: { op: "count_needs_review", targets: ["assumptions.verdict"] } for the review counter, and { op: "count_value", targets: ["assumptions.verdict"], value: "tbd" } to surface deferrals. Counting is by value equality — no expression language.

DISPLAY
display "fullscreen". Forty rows is not an inline card.`;

const ELICITATION = `ELICITATION (§5.2) — you need input before you can start.

SHAPE
4-8 fields, 1-2 sections, display "inline". Never fullscreen: this is replacing three turns of question-and-answer, not running a project kickoff.
- Mostly single_select and boolean, with defaults prefilled. Prefill from the conversation and mark what you guessed: source "inferred", low or high confidence, a one-line rationale. The renderer shows those as provenance chips, which is what makes "check the two amber ones" possible.
- Include a forced tradeoff where one exists — a slider or an allocation over speed / cost / thoroughness. Forced tradeoffs beat stated preferences: asking "what matters to you?" in prose returns "all of them".
- "You decide" / "TBD" as an ordinary option on anything you can proceed without.
- Use filter_options or show/hide rules when one answer narrows another — the half of the mechanic people forget.

DISPLAY
display "inline", a warm one-line description, submitLabel in the user's voice ("Looks right — go"), and the escape hatch in the description.`;

const CONVERGENCE = `BRAINSTORM CONVERGENCE (§5.3) — you just produced fifteen options in prose and the user must prune.

SHAPE — audited 2026-08-26, and it is NOT a multi_select.
Candidates are a TABLE with:
- a boolean "keep" column, and
- a single_select rejection-reason column, revealed per row by a $self rule when keep is false.
Why not multi_select: rule ops have no membership test over multi-valued answers, so you could not attach a per-candidate follow-up; and the reason needs row scope anyway.
Add a repeatable field for "add your own" — the options came from the conversation, not a catalogue, so the user will have one you missed.

CAPTURE REJECTION REASONS. When twelve options become two, why the other ten died is more informative than the pick — it reveals the shape of the constraint. Make them one tap: too expensive / too slow / wrong team / already tried / not the problem.

RANKING IS THE NEXT FORM, NOT THIS ONE
rank items are declared at authoring time, and the survivors are not known until the prune comes back. So chain: this form prunes, then a second form ranks the survivors (and carries the allocation for effort split). Pass the formId forward and prefill form two from form one.`;

const PLAN_CONFIRMATION = `PLAN CONFIRMATION / DRAFT REVIEW (§5.4) — a plan or draft to approve, not compose.

SHAPE
Fully prefilled, diff-shaped, display "fullscreen". Everything carries source "inferred" with a rationale, so the whole form reads as "here is what I concluded and why".
- One info field per plan part, each with an id, each followed by an approve/revise single_select and an optional note.
- That is the whole trick: "the third bit is off" is unresolvable in prose; a note anchored to section three is not. Draft review needs no separate shape — it is this one.
- computed totals where the plan has numbers (sum, count_value), and an explicit commit action as submitLabel.

CAP THE SIZE
This archetype is expressible but verbose — the audit's finding. Cap plan parts per form (roughly 6-8) and chain a second form rather than shipping thirty parts in one.`;

const MATRIX = `MATRIX (§5.5) — a 2D grid, and the best single argument for the whole pattern. Awkward in chat (it is inherently 2D), awkward in the source system (per-field clicking), awkward in a spreadsheet (the spreadsheet does not know the rules).

SHAPE
One matrix field: rows and cols are declared Members with stable ids and labels, and ONE cellType with one option set (uniform by construction). Do not build it out of nested fields.
- Cell interaction is the renderer's business, picked from the option count: <=4 options cycle on click, 5+ get a value palette in the toolbar. You do not choose it; you can hint with render. There are no dropdowns in cells.
- Header click bulk-applies down a column or across a row. That is 90% of real editing, and it is why the option set must be uniform.
- Per-cell constraints belong in the schema (constraints: [{ row, col, allowed?, readOnly?, reason? }]), so illegal combinations explain themselves — "Edit implies Read", "a required field cannot be hidden". The renderer enforces them and skips constrained cells on bulk apply with feedback; it does not know your domain.
- Prefill the current state with source "existing". That baseline is what makes dirty cells, the N-changes counter and per-cell revert work, and { op: "count_changed", targets: [...] } is the counter for it.

NEVER SEND THE GRID BACK
A thousand cells burns thousands of tokens and invites hallucinated cells. The renderer summarises the DIFF for you ("38 fields; default read-only; Edit for Sales Ops and Rev Ops; 4 exceptions"). Read the summary, not the grid.

DISPLAY
display "fullscreen", and expect a per-field summary list instead of a grid on a phone — editing a matrix is a desktop/tablet affordance.`;

const RECIPE_TEXT: Record<ArchetypeName, string> = {
  ledger: LEDGER,
  elicitation: ELICITATION,
  convergence: CONVERGENCE,
  plan_confirmation: PLAN_CONFIRMATION,
  matrix: MATRIX,
};

/* -------------------------------------------------------------------------- */
/* worked examples                                                            */
/* -------------------------------------------------------------------------- */

/**
 * §6.2 asks for TWO worked examples for the ledger: the full audited fixture,
 * and a minimal one. The minimal variant exists because the fixture teaches
 * "forty rows of provenance" and a first-time author also needs to see how
 * little is actually required — three rows, one verdict column, one prefill
 * each. It is validated in the test suite like every other example.
 */
export const minimalLedger = {
  version: FORM_SCHEMA_VERSION,
  title: "Two things I assumed",
  description: "Correct anything wrong, or confirm the lot. Or just tell me in chat.",
  display: "inline",
  submitLabel: "Confirm",
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
          type: "table",
          id: "assumptions",
          label: "Inferred from what you said",
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
              id: "r_staging",
              label: "We deploy to staging first",
              description: "your usual flow",
            },
            { id: "r_node", label: "Node 22 is the runtime", description: "from package.json" },
            { id: "r_pnpm", label: "pnpm, not npm", description: "there is a pnpm-lock.yaml" },
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
    "assumptions[r_staging].verdict": {
      value: "confirm",
      source: "inferred",
      confidence: "low",
      rationale: "your usual flow",
      needsReview: true,
    },
    "assumptions[r_node].verdict": {
      value: "confirm",
      source: "existing",
      rationale: "engines.node in package.json",
    },
    "assumptions[r_pnpm].verdict": {
      value: "confirm",
      source: "existing",
      rationale: "there is a pnpm-lock.yaml",
    },
  },
} satisfies Form;

export type WorkedExample = { title: string; note: string; form: Form };

const EXAMPLES: Record<ArchetypeName, WorkedExample[]> = {
  ledger: [
    {
      title: "Assumption ledger — the audited reference",
      note: "Five rows, provenance in the prefill envelope, two computed counters, a $self rule for the correction column.",
      form: assumptionLedger,
    },
    {
      title: "Assumption ledger — minimal",
      note: "The same shape at three rows and one counter. This is the floor; anything smaller should just be a question in chat.",
      form: minimalLedger,
    },
  ],
  elicitation: [
    {
      title: "Elicitation — inline card",
      note: "Six fields, defaults prefilled and marked, a tradeoff slider, filter_options narrowing one answer by another.",
      form: elicitation,
    },
    {
      title: "Elicitation — branching: one answer reshapes the form",
      note: "The §4.6 mechanic composed: `show` pointed at whole SECTIONS so each credential kind is its own titled block, `in` for the endpoint section two branches share, a filter_options cascade from region to datacentre (no clear rule needed — a value that fails its filter reads as absent), `require` inside the live branch only, `set_default` proposing a dry run without overruling an answer, and an edge-triggered `clear` on the one field the switch invalidates while leaving it on screen. Note what it never asks for: the password or the key, only where they live. This is the example to copy when the questions depend on each other, which is most of the time.",
      form: conditionalBranching,
    },
  ],
  convergence: [
    {
      title: "Convergence — prune, with reasons",
      note: "A table with a keep boolean and a $self-scoped rejection reason, plus repeatable 'add your own'. Ranking is the next form.",
      form: convergence,
    },
    {
      title: "Convergence — form two: rank and resource the survivors",
      note: "The chained second form (§5.6). Rank items and allocation members reuse the prune's row ids, every prefill is a first-form outcome wearing its provenance, and set_default proposes an even split without writing answers. Send the prune first, then this, prefilled from what came back.",
      form: convergenceRank,
    },
  ],
  plan_confirmation: [
    {
      title: "Plan confirmation — diff-shaped",
      note: "info parts with ids, each with approve/revise plus an anchored note, computed totals, explicit commit.",
      form: planConfirmation,
    },
  ],
  matrix: [
    {
      title: "Matrix — field-level security",
      note: "One matrix field, uniform cellType, per-cell constraints, an 'existing' baseline so the diff counter works.",
      form: matrixFls,
    },
  ],
};

export function recipeFor(archetype: ArchetypeName): string {
  return `${RECIPE_TEXT[archetype]}\n\n${RULES}\n\n${CROSS_CUTTING}`;
}

export function examplesFor(archetype: ArchetypeName): WorkedExample[] {
  return EXAMPLES[archetype];
}

/** All examples, so a test can assert every one of them still validates. */
export const ALL_EXAMPLES: WorkedExample[] = ARCHETYPES.flatMap((a) => EXAMPLES[a]);

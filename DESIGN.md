# Structured Input MCP App — Design

> Status: design converged, not yet implemented. This document is the input to
> implementation. Where it says **DECIDED**, don't re-litigate without a reason.
> Where it says **OPEN**, decide during implementation and record the answer here.
> Open questions resolved 2026-08-26 (§9); defer/`blocking` reworked in §4.3;
> `table` moved to a columns+data shape (§4.2).

---

## 1. The idea

An MCP App that renders **structured input surfaces inside the Claude
conversation** — forms, matrices, review ledgers — instead of the agent asking
six clarifying questions as prose bullets.

It is best understood as **an advanced `ask_user_input`**: a generic renderer
driven entirely by a schema the agent emits at call time. It is not a Salesforce
tool, not a planning tool, not a survey product. Those are schemas, not features.

**The core inversion.** A blank intake form throws away everything chat is good
at. The agent should infer as much as it can, then render a form **already
prefilled**, with provenance visible on every inferred value. The user's job is
*auditing a proposal*, not *authoring one*. Reviewing is cheap; authoring is
expensive.

**Why in-conversation rather than a web app:**

- Context preservation — lives in the thread that produced it.
- The agent generates the schema, so the form is bespoke to the moment.
- Answers flow back into model context, so the next turn is informed without the
  user re-narrating what they just clicked.

That last point is the whole thesis. A standalone form collects data. This closes
a loop.

---

## 2. Non-goals

- **Not a form designer.** No end-user schema authoring UI. The agent writes
  schemas.
- **Not general-purpose expressiveness.** Five opinionated archetypes beat an
  engine that can render anything mediocrely.
- **No freeform-first forms.** If the primary input is prose, it should have been
  a conversation. Freeform is allowed only *anchored to a specific item*
  (per-row correction, per-item note).
- **No gating.** Partial submit is a first-class path (§5.6). A form that
  requires completion is worse than chat.
- **No auth, no writes, no credentials** in v1 (§3).
- **Mobile is view-only in practice** for dense views. Don't design for phone
  editing of a matrix.

---

## 3. Architecture

The server computes nothing about the domain and holds no credentials. It
stores form state — schema plus answers — in KV under unguessable form ids, and
nothing else.

```
Claude ──tools/call(render_form, schema)──▶ Worker ──▶ stub text result
                                                  │
   host fetches ui:// resource (static HTML bundle)┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  iframe: renderer               │
        │  schema in  ← tool-input        │
        │  answers out → update-model-... │
        └─────────────────────────────────┘
                          │
   answers go browser → model context; drafts autosave to KV under the form id.
```

**DECIDED**

- **Host:** Cloudflare Workers. Static HTML/JS/CSS bundle + a small MCP handler.
- **Document mode (OPEN-2/3 → DECIDED 2026-08-26).** Forms are re-openable
  documents, not one-shot events: a KV namespace holds form state keyed by an
  unguessable `formId`; `load_form(id)` re-renders with accumulated state. The
  id *is* the capability, so no auth is reintroduced.
- **No auth.** No domain credentials; form state at rest is reachable only via
  its unguessable id. (Custom connectors are reached from Anthropic's cloud, not
  from the local machine, so the endpoint *is* public regardless — see §9.
  DECIDED: unguessable base path, no IP allowlist.)
- **No CSP domains declared.** `_meta.ui.csp` omitted, so the host's restrictive
  default applies (`default-src 'none'; connect-src 'none'`). The app physically
  cannot phone home. Self-contained bundle, no CDN, no external fonts.
- **No logging of payloads.** Document mode means answers *do* rest in KV, so
  the privacy story is restated honestly: stored only under the unguessable id,
  never logged, TTL'd. Weaker than "never touch the server" — accepted as the
  cost of re-openable forms.
- **The schema arrives as tool *input*.** Not as a tool result. The tool result
  is a short stub string (`"Form displayed; awaiting input."`) because that text
  lands in model context and must not echo the schema back into it.
- **Build a real bundle.** Claude's iframe sandbox blocks HTTP script sources, so
  a Vite dev server won't load. Serve a prebuilt production bundle; send
  `notifications/resources/list_changed` on change so the host re-fetches.

**Consequence of document mode:** autosave falls out for free — debounced KV
writes kill the half-filled-form data-loss risk, and `ui/resource-teardown`
becomes a final flush rather than the only one. The costs: a store to operate,
and the weaker privacy story above.

---

## 4. The meta-schema

### 4.1 Closed vs free — the sorting rule

**DECIDED.** The single most useful constraint in the whole design:

| | Contents | Validated |
|---|---|---|
| **Closed vocabularies** | field types, render hints, answer states, rule ops, rule actions, `source` values | Yes, strictly. Renderer switches on these. |
| **Free text** | labels, titles, descriptions, option display text, `rationale`, notes, placeholders | No, beyond length limits |

The agent gets total latitude over what the form *says*. The renderer only ever
branches on things it can actually understand. If the renderer or a `computed`
counter must act on it, it's typed. If a human reads it, it's free.

Corollary: the agent decides button labels *and* their values ("Confirm / Fix /
Later", "Yep / Nope / TBD") — defer options are ordinary agent-defined options,
not a fixed state (§4.3).

### 4.2 Field types

Deliberately biased toward structured input.

**Selection** — one type each, with a `render` hint rather than separate types.

| Type | `render` options | Notes |
|---|---|---|
| `single_select` | `cards` \| `segmented` \| `radio` \| `list` | cards for ≤6 with descriptions; segmented for ≤4 short labels; searchable `list` above ~15 |
| `multi_select` | `chips` \| `checkboxes` \| `list` | |
| `boolean` | `toggle` \| `segmented` | |

**Ordered**

| Type | Notes |
|---|---|
| `rank` | drag to prioritise. Position *is* the value — never use ordinals as addresses (§4.5) |

**Numeric**

| Type | Notes |
|---|---|
| `number` | min/max/step |
| `slider` | good for tradeoff elicitation (§5.2) |
| `allocation` | split N across members; constraint is on the *set*, not the field |

**Temporal**

| Type | Notes |
|---|---|
| `date` | named presets ("end of Q3") matter more than the picker |
| `date_range` | |

**Composite** — where the value is.

| Type | Shape | Notes |
|---|---|---|
| `matrix` | `rows` × `cols`, one `cellType`, per-cell `constraints` | row/col ids are agent-declared and fixed |
| `repeatable` | array of sub-field groups | "add another stakeholder". Rows are user-mutable → minted ids |
| `table` | column definitions + data rows | LWC-Datatable-shaped: type, options, render hint and constraints declared **once per column**; rows are plain data arrays. `multi_select` columns allowed (OPEN-1 → DECIDED). A 40-row form is 3 column defs + 40 short rows, and `filter_options` targets a column, not N fields |

**Text** — support, discourage.

| Type | Notes |
|---|---|
| `short_text` | |
| `long_text` | smell. If a form is mostly these, it should have been a conversation |

**Non-input**

| Type | Notes |
|---|---|
| `info` | markdown block. Makes draft-review an ordinary form (§5.4) |
| `computed` | read-only derived value over other fields. Totals, deltas, "4 unresolved, 2 marked 'let's talk'" — counts by equality on agent-declared values (§4.3) |

`computed` counting *answer states* rather than summing numbers is what makes a
form feel alive. Don't skip it.

### 4.3 Answer shape

**DECIDED.** Flat map, path-keyed, uniform across values, notes and states:

```ts
type AnswerState = "answered" | "empty";

type Answer = {
  state: AnswerState;
  value?: unknown;      // absent when empty
  note?: string;        // free text, anchored to this path
};

type Answers = Record<Path, Answer>;
```

**Defer is not a special state (OPEN-6 → dissolved, DECIDED 2026-08-26).**
"You decide", "Let's talk" and "TBD" are ordinary agent-defined options: a field
with four options accepts five states — each option plus `empty` — and that's
it. The agent authors the label/value pairs at creation time and is the party
that interprets them on the return trip; the renderer never assigns meaning to
them. The formerly proposed `blocking` boolean disappears — the agent knows what
its own `lets_talk` value demands downstream because it authored it, and the
recipes (§6.2) carry the conventions.

Two mechanics preserve what a special state would have provided:

- **`skipOptions` on any field.** Non-select fields (date, number, matrix cell)
  may declare agent-defined label/value pairs rendered as a skip affordance
  beside the input. "Let Claude decide" in an elicitation form and "TBD" in a
  ledger are the same mechanism with different agent-authored pairs.
- **`computed` counts by equality, never meaning.** "Count answers where value =
  `lets_talk`" is an equality match on an agent-declared identifier — the same
  thing the renderer already does with field ids, so §4.1 holds.

The open-questions register is therefore not an archetype — it's the agent
filtering its own defer values across the session (which persist in the form
document, §3).

### 4.4 Notes

Free-text `note` on any path. Sparse by design.

- **Rendering:** an icon that expands, with a visually distinct filled state.
  Never forty visible textareas — that makes a form look like homework.
- **Transport:** push back as `{path, label, note}` triples so the agent can open
  directly on them ("you flagged rollout timing: 'depends on Legal'"), not as an
  opaque blob it must re-read. The anchor surviving is the entire value over
  prose.

### 4.5 Path grammar

**DECIDED.** Closed, parseable, validated against the schema. Not JSONPath — no
wildcards, no filters.

```
path    := segment ( "[" id "]" | "." id )*
segment := id | "$self" | "$parent"
```

Examples:

```
region
fls[Discount__c][SalesOps]
stakeholders[r_7f3a].owner
$self.detail
```

**Ordinal vs stable id — the rule that prevents silent corruption:**

| Structure | Addressing | Why |
|---|---|---|
| `matrix` rows/cols | agent-declared ids | fixed for the life of the view |
| `repeatable`, `table` rows | **client-minted ids** (`r_7f3a`) | user-mutable; deleting row 2 must not re-point notes anchored at `[3]` |
| `rank` | minted ids | position is the value being edited, so it can't also be the address |

**Ordinals are for display, never for persistence.**

Nice side effect: this addressing scheme *is* the sparse-exception format the
matrix needs. Dense grids are never serialised.

### 4.6 Rules — flat list, `$self` for row scope

**DECIDED.** Nested boolean trees are where model-generated schemas fall apart.
Flat list, evaluated in order:

```ts
type Rule = {
  when: {
    field: Path;                                    // may use $self
    op: "eq"|"neq"|"in"|"gt"|"lt"|"empty"|"filled";
    value?: unknown;
  };
  then: {
    action: "show"|"hide"|"enable"|"disable"|"require"|"optional"
          | "filter_options"|"set_default"|"clear";
    targets: Path[];
  };
};
```

- **Not rendered = `empty`; the user submits exactly what they see (DECIDED
  2026-08-26).** The submit payload is a function of the rendered view and
  nothing else. A hidden field contributes `empty` no matter what it held
  before; no cached or invisible state is ever submitted. If a re-shown field
  restores a prior value, that's fine *because the user sees it* before
  submitting. Corollaries: `set_default` writes only into `empty` fields — it
  never overwrites a value the user entered; and rule evaluation re-runs the
  flat list after every change until the rendered state is stable (small
  iteration cap; the validator warns on rules that could cycle).
- **`require`/`optional` mark, they never gate.** Partial submit is always
  available (§5.6); required-ness renders as a marker and feeds `computed`
  counters and section status. Only malformed values block submit (§6.3).
- **`filter_options` is half the value** and is the one people forget. Pick "AWS"
  → the region field only offers AWS regions. Without it you get invalid
  combinations and a form nobody trusts.
- Rules target **fields or sections**, so whole sections appear from one answer.
- **`$self` resolves to the current row** inside a `repeatable`/`table`. This is
  what makes per-row conditional follow-up work at all — the agent can't emit one
  rule per row when the user adds rows at runtime.

### 4.7 Prefill envelope

**DECIDED.** Every prefilled value carries provenance. This is what makes it a
Claude-native form rather than a web form.

```ts
type Prefill = {
  value: unknown;
  source: "user" | "inferred" | "default" | "existing";
  confidence?: "high" | "low";
  rationale?: string;      // "you mentioned EU customers"
  needsReview?: boolean;
};
```

- Render `inferred` + `low` visibly distinct, `rationale` on hover/expand.
- Header shows a `computed` "N inferred values need review" counter.
- `existing` gives baseline-diff behaviour for free — dirty-cell rendering in a
  matrix, changed-value marks elsewhere.

**Never emit a blank form.** If there's nothing to prefill, the form probably
shouldn't exist.

### 4.8 Sections

```ts
type Section = {
  id: string;
  title: string;
  description?: string;
  fields: Field[];
  layout?: "stack" | "two_col";
  initially?: "expanded" | "collapsed";
};
```

Persistent left rail in fullscreen, with per-section status: untouched / in
progress / complete / has errors. That rail is the single biggest usability
difference between this and a long scroll. Guideline-compatible too — collapsible
sidebars, tabs and pagination are the sanctioned disclosure patterns; floating
panels are not.

Soft limit ~7 fields per section. Never a section with one field.

---

## 5. Archetypes

**DECIDED.** These are **generation recipes, not code paths.** One renderer, one
meta-schema, N markdown recipes. Adding an archetype costs a file, not a deploy.

### 5.1 Assumption ledger — *build this first*

The highest-value surface, and the one that justifies the project.

The failure mode it fixes: a plan requires forty small inferences. The user
catches two wrong ones on read-through and the other thirty-eight stay wrong
*silently* — not agreed to, just invisible. Nobody audits a paragraph for
premises.

Shape: dense list of inferences, each a `single_select` with `render: segmented`,
plus agent-defined defer options ("You decide" / "TBD"), plus optional per-row
`note` and a conditional correction input. Every row carries `source` +
`rationale`. With forty rows of identical shape, generate it columns+data
(§4.2 `table`): the segmented options are declared once as a column definition,
rows are data.

Requirements it drives:

- per-row conditional follow-up → `$self` (§4.6)
- **bulk affirm** — "confirm all" / "confirm all high-confidence". With forty rows
  where thirty-eight are right, *this is the primary interaction*.
- `computed` header: "4 unresolved, 2 marked 'let's talk'"

Small enough to be v1 on its own: one field type, one archetype, no sections.

### 5.2 Elicitation

Agent needs input to start. 4–8 fields, 1–2 sections, **inline card, never
fullscreen** — it's replacing three turns of Q&A, not running a project kickoff.
Mostly `single_select` and `boolean`, defaults prefilled.

Include a **tradeoff control** where relevant — sliders or `allocation` over
speed / cost / thoroughness. Forced tradeoffs beat stated preferences; asking
"what matters?" in prose returns "all of them".

### 5.3 Brainstorm convergence

The agent has just produced fifteen options in prose and the user must prune,
rank and combine. Options **come from the conversation**, not a catalog.

`multi_select` over generated candidates + `rank` for priority + `allocation` for
effort split + `repeatable` "add your own".

**Capture rejection reasons.** When twelve options become two, *why the other ten
died* is more informative than the pick — it reveals the shape of the constraint.
One-tap reasons: too expensive / too slow / wrong team / already tried / not the
problem. Cheap for the user, disproportionately useful for the agent.

### 5.4 Plan confirmation / draft review

Fully prefilled, diff-shaped, fullscreen. Everything `source: "inferred"` with
rationale, `computed` totals, explicit commit action.

Draft review collapses into this: **plan sections are `info` fields with ids**,
each with approve/revise + note. "The third bit is off" is unresolvable in prose;
a note anchored to section three is not. No separate renderer needed.

### 5.5 Matrix

The hard field type, and the best single argument for the whole pattern. Awkward
in chat (inherently 2D), awkward in the source system (per-field clicking),
awkward in a spreadsheet (the spreadsheet doesn't know the rules).

- **Tri-state click-to-cycle cells**, not dropdowns. Two clicks × 800 cells is
  untenable, and dropdowns clip. Cycling is faster, keyboard-friendly, and
  drag-fills well.
- **Header-click bulk apply** (column, row) — 90% of real editing.
- **Rectangle fill** — shift-click or drag to paint a region.
- **Diff against baseline** — `source: "existing"` renders dirty cells distinctly,
  with an N-changes counter and per-cell revert.
- **Column collapsing** — 30 columns don't fit; group, and offer "hide columns
  with no exceptions".
- **Keyboard nav** — arrows + space. Required for accessibility anyway.
- **Per-cell constraints in the schema**, so illegal combinations auto-correct and
  explain themselves. (Domain example: Edit implies Read; required and
  master-detail fields can't be hidden; formula fields are read-only.) The
  renderer enforces; it doesn't know the domain.
- **Never send the grid to the model.** `content` gets a policy *summary* ("38
  fields; default read-only; Edit for Sales Ops and Rev Ops; 4 exceptions").
  Dumping 1,000 cells burns thousands of tokens and invites hallucinated cells.
- Direct DOM mutation on changed cells. No full reconcile per click — hosts are
  expected to impose resource limits on views.

### 5.6 Cross-archetype mechanics

**DECIDED, and more important than any field type.**

- **Partial submit.** "Answered three of ten, continue." Unanswered fields are
  enumerated as `empty` in the submit payload; the agent decides whether to pick
  for them or ask. Preserving the chat affordance of "just pick something for
  the rest" is what keeps this better than software.
- **Always leave the chat escape hatch.** A line in the card — "or just tell me" —
  costs nothing and turns a mistriggered form from a dead end into a minor
  annoyance.
- **Forms chain.** elicitation → draft → convergence → plan → confirmation.
  Continuity is twofold: `ui/update-model-context` for what the *agent* must
  know, and the KV form document for exact state (§3) — the agent passes
  `formId`s forward instead of re-serialising answer maps and minted row ids
  through its own context. **Push back structured state, not a prose summary**,
  or form three can't be prefilled from form one.

---

## 6. Guidance: five layers

The trigger is a *conversational moment*, not a topic — the user asks for
clarification, a brainstorm, or plan confirmation. They will **never** say
"questionnaire". This breaks skill-description matching as the primary trigger,
so the layers split by what's in context when.

### 6.1 Tool description — carries the trigger

Always in context, so it costs tokens every conversation. Keep it minimal but put
the **trigger logic** here, because nothing else is loaded at decision time.

Write it **behaviourally and negatively** — fire on something the model can notice
itself doing:

> If you are about to write clarifying questions as prose bullets, stop — those
> go in this tool instead. Same if you are about to list options for the user to
> pick from, or summarise a plan for approval.

And the **don'ts**, which matter more, because a needless 18-field form reads as
bureaucracy. False positives cost more than false negatives:

- One question → just ask it.
- "A or B?" → they want analysis, not their options back as radio buttons.
- User already gave detailed constraints → don't second-guess with an intake form.
- Venting, exploring, thinking out loud → a form is a wall.

**Name the tool for the behaviour.** `gather_decisions` or `ask_structured` gets
selected at the right moments. `render_questionnaire` gets selected when someone
says "questionnaire", which never happens.

### 6.2 `get_form_guide(archetype)` — carries the craft

**DECIDED: this, not a skill, is the primary guidance channel.**

A model-visible tool returning the archetype recipe + two worked examples. The
render tool says: *"If you have not called `get_form_guide` in this conversation,
call it first."*

Why it beats a skill pointer:

- A tool call is far more reliably performed than a file read — it's what the
  model is already doing.
- Host-agnostic. No plugin, no install, no Claude-only dependency.
- Updated by deploying a Worker, not by asking teammates to re-upload a skill.
- Zero standing token cost.

Costs one round trip, which is nothing next to a human filling a form.

### 6.3 Validator — enforces, and teaches

**Two loops, both required.**

*Schema validation (agent → app).* Malformed definitions come back as text in the
tool result: `unknown field type 'slider_group'`, `rule 3 references missing field
'region'`, `matrix 'fls' declares 12 cols but 3 col labels`, `path
'stakeholders[2].owner' uses an ordinal — use a minted row id`. The agent
self-corrects on the next call. **Without this the tool silently renders garbage
and you never learn why.**

Return the **matching worked example alongside the errors**. That makes
convergence work even with no skill and no guide call — it's the layer that
actually guarantees correctness.

Design the `inputSchema` **loose** and validate **strict** in the app. Deeply
nested recursive JSON Schema degrades model output quality; accept an object and
police it yourself.

*Answer validation (user → app).* **Format only gates (DECIDED 2026-08-26).**
Malformed values — wrong type, out of range, failed regex — block submit and
jump the section rail to the error, because submitting garbage helps nobody.
Required-ness never gates: partial submit is the norm (§5.6), `require` is a
marker that feeds the rail, the asterisk and `computed` counters, and unanswered
required fields simply return `empty`. The agent reads "3 of 4 required fields
empty" in the payload and decides what to do — that decision is its business,
not the renderer's.

### 6.4 Skill — carries the *whether*

Not examples; the server serves those. The skill's job is the thing the server
can't see: the §6.1 negative rules about the agent's own output, loaded before
any tool is selected. Metadata is ~100 tokens always-loaded; the body loads on
trigger.

Package as a **plugin** (connector + skill + `/…` command) so a teammate installs
one thing. Plugins can pull from a git repo, which matters for a skill iterated
weekly; org-level skills must be uploaded and updated manually. Note plugins are
Claude-specific — the portable equivalent is the MCP prompts primitive.

**Write the skill after the validator.** The validator's error log tells you which
mistakes to write guidance against, instead of guessing.

### 6.5 Memory / CLAUDE.md — carries the user's process

**DECIDED 2026-08-26.** How the agent *interprets* answers is not the server's
business. "When I defer, just pick something", "anything marked 'let's talk'
means stop and ask", "never render a form for fewer than 3 questions" — these
are per-user/per-team process preferences and live in CLAUDE.md or agent
memory, not in recipes.

The split: recipes (§6.2) ship user-agnostic *defaults* so a fresh user with an
empty CLAUDE.md gets coherent behaviour; memory/CLAUDE.md *overrides* them.
Repeated form sessions are high-signal preference data — "this user defers all
budget questions every time" — and memory is the intended place for that
learning to accumulate.

---

## 7. Host integration (MCP Apps)

Extension `io.modelcontextprotocol/ui` (SEP-1865, Stable 2026-01-26).

### 7.1 Declaration

```ts
// resource
{
  uri: "ui://forms/renderer",
  name: "Structured input renderer",
  mimeType: "text/html;profile=mcp-app",
  _meta: { ui: { prefersBorder: true /* per display mode; see below */ } }
}

// tool
{
  name: "gather_decisions",
  description: "…trigger logic from §6.1…",
  inputSchema: { /* loose */ },
  _meta: { ui: { resourceUri: "ui://forms/renderer", visibility: ["model","app"] } }
}
```

One UI resource serves every form type forever: **rendering engine ships in the
bundle, schema arrives as data.** Host reviews the template once; new archetypes
are server-side only.

Use `visibility: ["app"]` for anything the UI needs but the model shouldn't see
(validation helpers, option lookups). App-scope is per-server; cross-server calls
from apps are blocked.

### 7.2 Messages used

| Direction | Method | Use here |
|---|---|---|
| host → app | `ui/notifications/tool-input` | the schema |
| host → app | `ui/notifications/tool-input-partial` | render sections progressively while a long schema streams |
| host → app | `ui/notifications/tool-result` | stub; largely ignored |
| host → app | `ui/notifications/host-context-changed` | theme, resize, display mode, orientation |
| host → app | `ui/resource-teardown` | last chance to flush |
| app → host | `ui/update-model-context` | debounced progress summary; full answers on submit |
| app → host | `ui/message` | submit — triggers the next turn |
| app → host | `ui/request-display-mode` | inline → fullscreen |
| app → host | `ui/notifications/size-changed` | inline auto-fit |

**Context discipline:** debounced mid-fill pushes carry a *summary* ("section 2 of
5 complete; 3 inferred values unreviewed"), not the payload. Full structured
answers only on submit. `ui/update-model-context` overwrites each time and does
not trigger a turn — that's exactly the semantics wanted.

### 7.3 Display modes and constraints

**Inline card** — progress/summary surface and small elicitation forms.
Auto-fit height, no nested vertical scroll, ~2 actions at the bottom, 4–5 data
points, no drill-ins, **no menus or popovers** (clipped by the host container,
z-index conflicts).

**Fullscreen** — everything dense. Composer stays visible. No floating panels;
use the section rail, tabs or pagination. The app supplies its own fullscreen
button; the host supplies close.

Menus in fullscreen: the hard prohibition is scoped to inline cards; in
fullscreen it's a *preference*. Your view is the viewport, so host clipping
mostly disappears — but **your own** `overflow: auto` still clips, and there's no
portaling out of the sandbox. Use the Popover API / CSS anchor positioning /
top-layer `<dialog>`, which escape ancestor overflow within your document. Keep
menus to genuinely secondary actions (column header options, row overflow); never
the core loop.

**Mobile** — native WebView, not an iframe. No camera/mic/geolocation. Connectors
must be added on web or desktop first. Critically: **vertical pan gestures inside
an inline app go to the conversation scroll**, so inline apps must fit their
content height; request fullscreen if you need your own scroll viewport. 44pt tap
targets, honour `hostContext.safeAreaInsets` (not mobile-only — the composer can
overlay the bottom of an inline app on web too).

Dense matrix on a phone: render a per-field summary list instead. Editing is a
desktop/tablet affordance.

### 7.4 Theming

Host supplies CSS custom properties via `hostContext.styles.variables` — colors,
typography, radii, shadows — plus `theme`, `locale`, `timeZone`,
`containerDimensions`, `safeAreaInsets`, `platform`, `deviceCapabilities`.

**Never hardcode colors.** Structural elements (backgrounds, text, borders,
icons) use host tokens; brand colors only for accents. Set your own `:root`
fallbacks for every variable used, since hosts may supply a partial set. Support
light and dark; test both. Skeleton loaders, not spinners.

---

## 8. Build order

1. **Meta-schema + validator.** TypeScript types, Zod (or equivalent) validator,
   path parser and resolver. No UI. Get the error messages good — they're a
   product surface (§6.3).
2. **Archetype audit.** Write all five archetypes as JSON against the meta-schema
   and run them through the validator. **Do this before the renderer.** One
   archetype surfaced three gaps in a minute of conversation; the other four will
   surface the rest. This is how the real primitive set gets found instead of
   guessed.
3. **Renderer v1 — assumption ledger only.** One field type (`single_select`
   segmented) + defer options + notes + bulk affirm + `computed` counter. Inline
   and fullscreen. Proves the whole loop end to end.
4. **Worker + MCP handler.** `gather_decisions`, `get_form_guide`, `load_form`,
   the KV form store, `ui://forms/renderer`. Deploy. Connect as a custom
   connector.
5. **Remaining archetypes**, in order of use: elicitation → confirmation →
   convergence → matrix.
6. **Skill + plugin packaging**, last, informed by the validator's error log.

---

## 9. Open questions

- **OPEN-1 — Composite table cells. DECIDED 2026-08-26: allowed.** With the
  columns+data pattern the options live once in the column definition, so a
  `multi_select` column is cheap. Costs one extra path level in the answer map —
  accepted.
- **OPEN-2 — Form as event or document. DECIDED 2026-08-26: document.** Forms
  are re-openable and re-renderable with accumulated state — the session's
  shared artifact. Stable `formId`s and the KV store follow (§3).
- **OPEN-3 — Draft persistence. DECIDED 2026-08-26: subsumed by OPEN-2.** The KV
  namespace keyed by an unguessable id is in from the start; the id *is* the
  capability, so no auth is reintroduced.
- **OPEN-4 — Endpoint exposure. DECIDED 2026-08-26: unguessable base path
  only.** No IP allowlist — Anthropic's egress ranges are shared infrastructure,
  so allowlisting never isolated to one org and adds maintenance for little
  benefit.
- **OPEN-5 — Audit attribution.** Still open, still deferred: with no
  domain-write path nothing needs attribution. Revisit the moment one is added.
- **OPEN-6 — Deferred label taxonomy. DISSOLVED 2026-08-26.** No `blocking`
  boolean, no special deferred state: defer options are ordinary agent-defined
  label/value pairs the agent interprets itself (§4.3).

---

## 10. Decision log (short form)

| Decision | Rationale |
|---|---|
| Generic renderer, schema as tool input | one UI resource serves every form type; new archetypes need no deploy |
| No credentials, no auth | form state rests in KV under unguessable ids; nothing else touches the server |
| Document mode + KV store from v1 | re-openable forms as session artifacts; unguessable `formId` is the capability; autosave for free |
| `table` = column definitions + data rows | LWC Datatable shape; options declared once per column; 40-row schemas stay small; `multi_select` columns cheap |
| Closed vocabularies / free labels | renderer only branches on what it can understand; agent keeps expressive latitude |
| Defer options are ordinary agent-defined options | agent authors and interprets its own values; renderer matches by equality, never meaning |
| `skipOptions` on any field | non-select fields get the same defer affordance without a special state |
| Path-keyed flat answer map | one addressing scheme for values, notes and states; sparse matrix format falls out free |
| Minted row ids, never ordinals | user-mutable rows would silently re-point anchored notes |
| Flat rule list + `$self` | nested trees degrade model output; `$self` is the only way to scope per-row rules at runtime |
| Loose `inputSchema`, strict app validation | deep recursive JSON Schema hurts generation quality |
| Guidance via `get_form_guide`, not just a skill | tool calls are more reliably performed than file reads; host-agnostic; deploy to update |
| Validator returns errors **+ example** | guarantees convergence with no skill and no guide call |
| Trigger logic in the tool description | the moment is conversational; only the tool description is in context at decision time |
| Archetypes as recipes, not code paths | draft review and the open-questions register already collapsed into the meta-schema |
| Prefill always, with provenance | reviewing is cheap, authoring is expensive; makes inferences auditable |
| Partial submit is first-class | a form that gates progress is worse than chat |
| Required marks, only malformed gates | required-ness feeds counters and the rail; the agent decides what empty means |
| Not rendered = `empty`; submit = what the user sees | no invisible state: hiding clears, defaults never clobber user input, evaluation settles to a stable view |
| Interpretation conventions live in memory/CLAUDE.md | per-user process preference; recipes ship user-agnostic defaults, memory overrides |
| Assumption ledger first | highest value, smallest surface, proves the loop |

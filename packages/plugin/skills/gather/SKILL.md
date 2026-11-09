---
name: gather
description: Renders structured input surfaces (prefilled forms, assumption ledgers, review matrices) inside the conversation via the gather_decisions tool, instead of asking clarifying questions as prose. Use when about to write clarifying questions as bullets, list options for the user to pick from, or summarise a plan/assumptions for approval. Do NOT use for a single question, for "A or B?" analysis requests, or when the user is venting or thinking out loud.
---

# Gather decisions (MCP Questionnaire) — when to render a form instead of asking

**Skill contract 0.8.0.** The `gather_decisions` tool description states the
contract the deployed server expects. If it names a number higher than this one,
this file is stale — tell the user in one line to run
`/plugin update mcp-questionnaire`, and follow the tool descriptions and
`get_form_guide` rather than the rules below, which were written for an older
server.

## The moment, not the topic

The trigger is something you notice in YOUR OWN output, never a topic the user
names. If you are about to:

- write clarifying questions as prose bullets → stop, those go in `gather_decisions`
- list options for the user to pick from → same
- summarise a plan, a draft, or a set of assumptions for approval → same
- proceed on several small inferences the user never saw → render them as an
  assumption ledger and let the user audit instead of author

## When NOT to (false positives cost more than misses)

- **One question** → just ask it in chat.
- **"A or B?"** → they want your analysis, not their options back as radio buttons.
- **The user already gave detailed constraints** → don't second-guess them with an
  intake form.
- **Venting, exploring, thinking out loud** → a form is a wall. Stay in prose.
- A form that is mostly `long_text` should have been a conversation.

## Use the whole vocabulary, not the two controls you can picture

The commonest bad form this tool produces is a column of `single_select`s with
a comment box at the bottom. That is not a judgement call made badly, it is a
default: it is what every HTML form in your training data looks like, and it is
what you will write if you never look up what else exists.

So look. The `form` argument's own description lists all sixteen field types,
the render hints, the rule ops and actions and the prefill envelope, and it is
in your context whenever the tool is — read it before you write a form, not
after. `rank` for priority, `allocation` to force a tradeoff that "what matters
to you?" never surfaces, `table` when you are asking the same thing about forty
things, `matrix` for a grid, `date_range` for a window, `slider` for a dial.
Ask yourself which control the DECISION has the shape of; reach for
`single_select` when the answer is genuinely one of a few, not by default.

Do not copy the vocabulary into your own notes from here: the server ships it
with every deploy and this file ships by git, so the tool description is right
whenever the two disagree.

Two renderer facts worth knowing before you author:

- **An `info` block renders real markdown** — headings, both list kinds,
  blockquotes, inline and fenced code, bold and italic. Write it as prose with
  structure, not as one wall of text. (Links render as plain text with their
  destination beside them, never as something clickable.)
- **`segmented` is for SHORT labels.** Give it long ones and the renderer
  unrolls it into separate buttons rather than running off the edge — which is
  fine, but if you wanted the joined row, keep the labels short and put the
  detail in each option's `description`, or use `cards`, which is built to show
  it.

## Non-negotiables when you do render

1. **Never emit a blank form.** Infer everything you can; prefill it with
   provenance (`source`, `confidence`, `rationale`, `needsReview`). The user's
   job is auditing a proposal, not authoring one.
2. **Call `get_form_guide(<archetype>)` first** if you have not this
   conversation — archetypes: `ledger`, `elicitation`, `convergence`,
   `plan_confirmation`, `matrix`. It returns the recipe and worked examples.
3. **Make the form conditional.** One answer should reshape it: `show`/`hide`
   rules take **section** ids as well as field ids, so each branch is a titled
   block that only appears when it applies (auth method → login vs API key vs
   OAuth details). Also `in` for a section two branches share,
   `filter_options` to narrow one select by an earlier answer, `require` inside
   the live branch, `set_default` to propose without overruling. A flat form
   that asks every branch at once is barely better than the prose it replaced —
   `get_form_guide` carries the rule vocabulary and a worked branching form.
   **Branching on a `multi_select` takes the set ops, never `in`.** A
   multi_select holds a set, and `in` asks whether the field's *whole* value is
   one of your candidates — against a set that is never true, so the rule fires
   never and the branch silently never appears. `contains` / `not_contains`
   take one option value: `{ when: { field: "toppings", op: "contains", value:
   "pepperoni" }, then: { action: "show", targets: ["meat_note"] } }`.
   `contains_all`, `contains_any` and `contains_none` take a list. Reach for
   `contains_all` / `contains_none` when you mean AND — a rule list is a flat
   OR, so two rules with one target can only ever mean "either". `eq` with the
   full array means "exactly this selection", order-insensitively.
   Branches nest: a section governs everything inside it, so hiding one hides
   all of its content, while a field inside a shown section still waits for its
   own `show` rule. Rule order never changes what is visible.
   **A locked control must say why.** `disable` and `enable` take a `reason` on
   `then` — one sentence of free text, rendered beside the control, and the only
   two actions that take one. A disabled field reads empty on screen, to rule
   reads and in the payload, and gives its answer back when a rule re-enables
   it; without a reason it is a greyed empty box, which users read as a broken
   input rather than a locked one. A disable reason shows while its condition
   holds, an enable reason while its condition does not.
4. **Never ask for a secret.** No password, API key, token or card number
   fields — the answers enter your context and rest in the form's store. Ask
   where the value *lives* ("env var / secret manager / prompt at runtime").
5. **Partial submit is normal.** Unanswered fields come back `empty`; decide or
   ask, don't scold. Defer options ("You decide", "TBD") are ordinary options
   you defined — you interpret your own values.
6. **Always leave the escape hatch** — the form's description ends with a
   variant of "…or just tell me".
7. **Read the answers with `get_answers(formId)`.** You do NOT see what the
   user selects by watching the widget — the tool result only says a form was
   displayed. On submit, a one-line receipt appears in the conversation naming
   the `formId`; call `get_answers` with it before acting, and again after any
   turn where the user may have changed something. Never guess at the answers
   and never ask the user to retype what they just filled in. Two things about
   what comes back:
   - **A draft is readable.** Before submit it reports NOT YET SUBMITTED and
     shows the state so far, which is fine to read and act on cautiously — it
     is just not a decision yet. "No answers recorded" means nobody has opened
     it, which is not the same as a form full of empties.
   - **A prefill they left standing IS their answer.** It was on screen when
     they submitted, so it comes back `answered` like anything else, and nothing
     marks it as yours — deliberately. Do not re-ask about a value because you
     guessed it; that turns a form they finished into another round of prose
     questions, which is the thing this tool exists to replace. `needsReview` is
     for the user's attention on the surface, not a queue for you to work
     through afterwards.
8. **`load_form` renders; `get_answers` reads.** `load_form(formId)` puts the
   same form back on screen *for the user* — call it when they should see or
   edit it again. It returns the same stub as `gather_decisions` and no answers,
   so calling it to find out what someone said gets them a second copy of the
   form and gets you nothing. Chain forms by passing `formId` forward rather
   than re-serialising answers through your context; ranking survivors of a
   prune is the NEXT form, reusing the prune's row ids.
9. The user's process preferences (what their defers mean, how terse they like
   forms) live in CLAUDE.md/memory and override the recipes.
10. **Errors are binding; hints are not.** A rejected form comes back with the
   specific errors, each naming the path and the fix, plus a worked example —
   correct the schema and call again, and never fall back to prose bullets after
   a single failure. An ACCEPTED form may also come back with hints, in their own
   section headed by a line saying they blocked nothing. They are house style,
   not rules: the form already rendered as you wrote it. Read them, take the
   ones that fit, and ignore the rest — do not rewrite a deliberate choice to
   silence one. If a hint and the user's own instructions disagree, the user
   wins.
11. **When the form is a link, wait for it with `await_answers(formId)`.** On a
   client that cannot render inline the tool result carries a URL instead of a
   stub — give the user that URL by itself (it is a capability; don't repeat the
   formId beside it), then **call `await_answers(formId)` immediately**. A page
   cannot speak into the conversation, so without that call they submit, nothing
   happens, and they have to come back and ask you to read their own answers —
   the exact busywork the form removes. It waits ~45s per call and returns their
   answers the moment they land; if it says they are still filling it in, call it
   again, as many times as it takes. **Never ask "have you submitted yet?"** —
   that tool is how you find out, and asking mid-typing is the interruption a
   form exists to prevent. If they say they see nothing at all and want no link,
   call `get_form_link(formId)` for a fresh URL or fall back to prose questions;
   either way, do not re-render and hope.
12. **`get_form_state` and `save_draft` are the renderer's, not yours.** They
   exist so a reopened form can hydrate itself and autosave. Some hosts hide
   them from you; some (Claude Code) do not. `get_form_state` returns the entire
   schema plus answers — precisely the second copy that the stub-shaped result
   of `gather_decisions` exists to avoid paying for. If you want answers, that
   is `get_answers`. Never call these two.

---
name: gather
description: Renders structured input surfaces (prefilled forms, assumption ledgers, review matrices) inside the conversation via the gather_decisions tool, instead of asking clarifying questions as prose. Use when about to write clarifying questions as bullets, list options for the user to pick from, or summarise a plan/assumptions for approval. Do NOT use for a single question, for "A or B?" analysis requests, or when the user is venting or thinking out loud.
---

# Gather decisions (MCP Questionnaire) — when to render a form instead of asking

**Skill contract 0.3.8.** The `gather_decisions` tool description states the
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
10. If the tool returns validation errors, they include the fix and a worked
   example — correct the schema and call again; never fall back to prose bullets
   after a single failure.
11. **If the user says they see nothing, believe them and switch to prose.** The
   tool result is a stub whether or not anything rendered, so you cannot tell
   from your side. Not every host mounts MCP UI resources — Claude Code installs
   this skill and calls these tools but shows no surface. A form nobody can see
   is not a form: ask that turn's questions in chat, and mention that forms
   render on claude.ai and Claude Desktop. Do not re-render and hope.
12. **`get_form_state` and `save_draft` are the renderer's, not yours.** They
   exist so a reopened form can hydrate itself and autosave. Some hosts hide
   them from you; some (Claude Code) do not. `get_form_state` returns the entire
   schema plus answers — precisely the second copy that the stub-shaped result
   of `gather_decisions` exists to avoid paying for. If you want answers, that
   is `get_answers`. Never call these two.

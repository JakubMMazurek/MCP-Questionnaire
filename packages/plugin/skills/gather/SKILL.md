---
name: gather
description: Renders structured input surfaces (prefilled forms, assumption ledgers, review matrices) inside the conversation via the gather_decisions tool, instead of asking clarifying questions as prose. Use when about to write clarifying questions as bullets, list options for the user to pick from, or summarise a plan/assumptions for approval. Do NOT use for a single question, for "A or B?" analysis requests, or when the user is venting or thinking out loud.
---

# Gather decisions — when to render a form instead of asking

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
3. **Partial submit is normal.** Unanswered fields come back `empty`; decide or
   ask, don't scold. Defer options ("You decide", "TBD") are ordinary options
   you defined — you interpret your own values.
4. **Always leave the escape hatch** — the form's description ends with a
   variant of "…or just tell me".
5. **Chain forms via `formId`** (returned in the tool result) and `load_form`,
   not by re-serialising answers through your context. Ranking survivors of a
   prune is the NEXT form, reusing the prune's row ids.
6. The user's process preferences (what their defers mean, how terse they like
   forms) live in CLAUDE.md/memory and override the recipes.
7. If the tool returns validation errors, they include the fix and a worked
   example — correct the schema and call again; never fall back to prose bullets
   after a single failure.

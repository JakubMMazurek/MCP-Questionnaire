/**
 * Layer 1 of five (§6.1) — the tool description carries the TRIGGER.
 *
 * This text is always in context, so it costs tokens in every conversation the
 * connector is enabled for. It is written behaviourally and negatively, because
 * the trigger is a conversational moment and not a topic: the user asks for
 * clarification, a brainstorm, or plan confirmation, and never says
 * "questionnaire". So the description fires on something the model can notice
 * ITSELF doing, and spends more of its length on the don'ts than the dos —
 * false positives cost more than false negatives, and a needless 18-field form
 * reads as bureaucracy.
 *
 * The tool is named for the behaviour for the same reason: `gather_decisions`
 * gets selected at the right moments, `render_questionnaire` gets selected when
 * someone says "questionnaire", which never happens.
 */

/**
 * The skill contract version, and the one string that lets a stale install
 * announce itself (§6.1).
 *
 * The plugin's skill file ships by VERSION over git; this Worker's tool
 * descriptions ship by DEPLOY. The two drift, and the failure is silent and
 * expensive: an agent following 0.2.1's instructions against a 0.3.x server
 * does not know get_answers exists, so it reaches for load_form, renders a
 * second form, and reads nobody's answers. That is a real field session.
 *
 * Nothing in the protocol reports an installed plugin version. But the agent
 * can read its OWN loaded skill text, and this description is always in its
 * context beside it — so the server states the current contract and asks for a
 * one-line comparison. Bump this in lockstep with
 * packages/plugin/.claude-plugin/plugin.json; verify-contract.mjs fails the
 * build if they drift.
 */
export const SKILL_CONTRACT = "0.7.0";

export const GATHER_DECISIONS_DESCRIPTION = `Render a structured input surface (a form) in the conversation and collect the user's answers.

BEFORE ANYTHING ELSE — IS YOUR SKILL CURRENT?
The current skill contract is ${SKILL_CONTRACT}. If the mcp-questionnaire skill instructions in your context do not say "Skill contract ${SKILL_CONTRACT}" — an older number, or no such line at all — then the installed plugin is behind this server and its rules are wrong in ways that will cost the user real turns. Say so once, in one line, and give them the fix: \`/plugin update mcp-questionnaire\`. Then carry on using THIS description and get_form_guide as the source of truth, never the stale skill.

WHEN TO CALL THIS
If you are about to write clarifying questions as prose bullets, stop — those go in this tool instead. Same if you are about to list options for the user to pick from, or summarise a plan for approval.

WHEN NOT TO CALL THIS — these matter more:
- One question -> just ask it.
- "A or B?" -> they want analysis, not their options back as radio buttons.
- The user already gave detailed constraints -> don't second-guess them with an intake form.
- Venting, exploring, thinking out loud -> a form is a wall.

FIRST
If you have not called get_form_guide in this conversation, call it first. It returns the recipe and worked examples for the archetype you need (ledger, elicitation, convergence, plan_confirmation, matrix) — including the parts that are easy to get wrong: prefilled verdicts with provenance, computed counters, and where rules attach.

HOW
Pass the form envelope as \`form\`. Prefill everything you can infer and mark it as inferred with a rationale — a form of empty fields is worse than the prose it replaced. The result is a short stub plus a formId; the schema is never echoed back to you. Reopen the same form later with load_form(formId), and pass formIds forward when you chain forms rather than re-serialising answers.

READING THE ANSWERS
You do NOT see what the user typed by watching the form. When they submit, a one-line receipt arrives in the conversation naming the formId — call get_answers(formId) to read the answers. Do that before you act on them, and do not guess or ask the user to repeat themselves.

If the envelope is malformed you get the specific errors plus a worked example back, and can call again.`;

/**
 * Layer 1, continued — the `form` ARGUMENT description, and the fix for the
 * narrowest failure this tool has.
 *
 * The wire schema is `z.record(z.string(), z.unknown())`, loose on purpose
 * (§6.3), so the argument description is the only type-level signal that is
 * unconditionally in context. It used to name the envelope keys and no field
 * types at all, and the consequence was measurable: every type beyond
 * single_select and short_text lived behind `get_form_guide`, which is an
 * OPTIONAL round trip, and an agent that skipped it had nothing to generate
 * from but the prior every HTML form in its training data carries. So the forms
 * came back as a radio group and a comment box — not because the author chose
 * plainly, but because nothing had told them `allocation` or `matrix` existed.
 *
 * Hence a bare vocabulary here and the craft still in `get_form_guide`: the
 * list is what you cannot invent, the recipes are what you would get wrong.
 * `tools.test.ts` asserts every member of FIELD_TYPES appears below, so the
 * list cannot drift from the schema the validator enforces.
 */
export const FORM_ARGUMENT_DESCRIPTION = `The form envelope: { version, title, description?, display?, submitLabel?, sections: [...], rules?: [...], prefill?: {...} }. Do not include formId — the server mints it.

THE FIELD TYPES. Pick the one that matches the decision; most forms should not be a column of single_selects.
- Choose: single_select (render: cards | segmented | radio | list), multi_select (chips | checkboxes | list), boolean (toggle | segmented).
- Order and weigh: rank (drag to prioritise), allocation (split a total across "members" — a forced tradeoff beats asking "what matters?"), slider, number.
- Time: date, date_range.
- Grids and repetition: matrix (2D — roles x permissions, fields x profiles; cells take a cellType, and render cycle | paint), table (columns declared once, rows as data — this is how you ask forty things cheaply), repeatable ("add another stakeholder").
- Text, last resort: short_text, long_text. A form that is mostly long_text should have been a conversation.
- MEMBERS vs OPTIONS: rank "items", allocation "members" and matrix "rows"/"cols" take { id, label } — you ADDRESS them by path (tradeoff[breadth], grid[row][col]). Only option lists take { value, label }.
- No answer of their own: info (a markdown body — headings, lists, bold, italic, quotes and code all render), computed (a live counter over other answers: count_value, count_empty, count_answered, count_changed, count_needs_review, sum).

RULES make one answer reshape the form, and targets take SECTION ids as well as field ids: ops eq, neq, in, contains, not_contains, contains_all, contains_any, contains_none, gt, lt, empty, filled; actions show, hide, enable, disable, require, optional, filter_options, set_default, clear. Branching on a multi_select takes the contains ops, never "in".

PREFILL carries provenance per path: { value, source: user | inferred | default | existing, confidence?: high | low, rationale?, needsReview? }. It is what makes the form an audit rather than a blank.

Call get_form_guide(archetype) for how to combine these well — the list above is the vocabulary, not the craft.`;

export const GET_FORM_GUIDE_DESCRIPTION = `Return the generation recipe and worked examples for one form archetype. Call this before gather_decisions if you have not already in this conversation — it is where the craft lives, and it costs one round trip against a human filling in a form.

archetype:
- ledger — a dense list of inferences to confirm or correct (the highest-value one).
- elicitation — 4-8 fields you need before you can start.
- convergence — prune and rank options you just produced in prose.
- plan_confirmation — a fully prefilled plan or draft for approval, with per-part notes.
- matrix — a 2D grid (roles x permissions, fields x profiles).`;

export const GET_ANSWERS_DESCRIPTION = `Read back the answers the user gave on a form. Takes the formId from gather_decisions (the submit receipt in the conversation repeats it).

This is how the answers reach you. The form is a surface the user interacts with directly; nothing they select is visible to you until you read it here. Call this as soon as a submit receipt appears, and again after any turn in which the user may have changed something.

The result is one line per question — the label the user saw, the path, and the value — including the ones left empty, which are answers too. It says whether the form was submitted or is still a draft; a draft is safe to read, it is just not a decision yet.

A value you prefilled and the user left alone comes back like any other answer, and that is what it is: it was on screen when they submitted. Act on it. Re-asking because it was originally your guess spends the turn the form just saved.`;

export const GET_FORM_LINK_DESCRIPTION = `Mint a link that opens an already-stored form as a web page, for a user whose client cannot render the form inline. Takes the formId from gather_decisions.

Use it when the form did not appear. Some clients — Claude Code among them — run the tools but mount no UI, so the user sees your text and no form. If they say they cannot see it, or you are in a client where forms have not been appearing, call this and give them the link.

The page is the same renderer, so answers land in the same place: when they submit, read the answers with get_answers exactly as you would have. The link is good for 12 hours; call this again for a fresh one. Hand over the URL and nothing else — it is a capability, so do not repeat the formId beside it in the conversation.`;

export const AWAIT_ANSWERS_DESCRIPTION = `Wait for the user to submit a form, and return their answers the moment they do. Takes the formId from gather_decisions.

CALL THIS IMMEDIATELY AFTER YOU GIVE SOMEONE A FORM LINK. A link opens a page, and a page cannot speak into this conversation — without this tool the user submits, nothing happens, and they have to come back and ask you to read their own answers. That is the busywork the form existed to remove.

Pass \`waitMs: 600000\` — the plugin's own server config raises the client's timeout so a single call can cover the whole time someone spends on a form, and one quiet call beats fifteen noisy ones. If that call comes back as a timeout ERROR rather than a result, this client's timeout was not raised: fall back to the 45-second default and call again each time it says they are still filling it in.

If it returns without their answers it tells you what has been saved so far; call it again with the same formId, as many times as it takes. Do NOT ask the user whether they are finished — this tool is how you find that out, and asking while they are typing is the interruption a form is supposed to prevent.

When it returns their answers, act on them. There is no need to call get_answers afterwards: what comes back is the same report.`;

export const LOAD_FORM_DESCRIPTION = `Render an already-stored form again, for the USER to look at. Takes the formId returned by gather_decisions.

This does NOT return the answers to you. It returns the same stub gather_decisions returns; what it produces is a second copy of the form in the conversation. To read what the user answered, call get_answers(formId) — that is the only tool that reports answers, and it renders nothing.

Use load_form when the user should see and edit the form again: they asked for it back, or a later turn changed what you need from them. If you only want to know what they said, you want get_answers.`;

/* -------------------------------------------------------------------------- */
/* app-visible tools (§7.1 — visibility ["app"]); the model never sees these.  */
/* -------------------------------------------------------------------------- */

export const SAVE_DRAFT_DESCRIPTION = `Autosave the current answers for a form. Called by the renderer, not by the model. Debounce it: writes are capped in size and rate-limited per form.`;

export const GET_FORM_STATE_DESCRIPTION = `Return the stored schema and answers for a formId, so a re-opened form can hydrate itself. Called by the renderer, not by the model.`;

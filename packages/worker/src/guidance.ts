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

export const GATHER_DECISIONS_DESCRIPTION = `Render a structured input surface (a form) in the conversation and collect the user's answers.

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

export const GET_FORM_GUIDE_DESCRIPTION = `Return the generation recipe and worked examples for one form archetype. Call this before gather_decisions if you have not already in this conversation — it is where the craft lives, and it costs one round trip against a human filling in a form.

archetype:
- ledger — a dense list of inferences to confirm or correct (the highest-value one).
- elicitation — 4-8 fields you need before you can start.
- convergence — prune and rank options you just produced in prose.
- plan_confirmation — a fully prefilled plan or draft for approval, with per-part notes.
- matrix — a 2D grid (roles x permissions, fields x profiles).`;

export const GET_ANSWERS_DESCRIPTION = `Read back the answers the user gave on a form. Takes the formId from gather_decisions (the submit receipt in the conversation repeats it).

This is how the answers reach you. The form is a surface the user interacts with directly; nothing they select is visible to you until you read it here. Call this as soon as a submit receipt appears, and again after any turn in which the user may have changed something.

The result is one line per question — the label the user saw, the path, and the value — including the ones left empty, which are answers too. It says whether the form was submitted or is still a draft; a draft is safe to read, it is just not a decision yet.`;

export const LOAD_FORM_DESCRIPTION = `Re-open a form that was already rendered, with everything the user has answered so far. Forms are documents, not one-shot events — use this to bring one back after other turns, or to show the user their own state again. Takes the formId returned by gather_decisions.`;

/* -------------------------------------------------------------------------- */
/* app-visible tools (§7.1 — visibility ["app"]); the model never sees these.  */
/* -------------------------------------------------------------------------- */

export const SAVE_DRAFT_DESCRIPTION = `Autosave the current answers for a form. Called by the renderer, not by the model. Debounce it: writes are capped in size and rate-limited per form.`;

export const GET_FORM_STATE_DESCRIPTION = `Return the stored schema and answers for a formId, so a re-opened form can hydrate itself. Called by the renderer, not by the model.`;

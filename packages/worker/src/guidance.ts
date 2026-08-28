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
export const SKILL_CONTRACT = "0.3.8";

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

export const LOAD_FORM_DESCRIPTION = `Render an already-stored form again, for the USER to look at. Takes the formId returned by gather_decisions.

This does NOT return the answers to you. It returns the same stub gather_decisions returns; what it produces is a second copy of the form in the conversation. To read what the user answered, call get_answers(formId) — that is the only tool that reports answers, and it renders nothing.

Use load_form when the user should see and edit the form again: they asked for it back, or a later turn changed what you need from them. If you only want to know what they said, you want get_answers.`;

/* -------------------------------------------------------------------------- */
/* app-visible tools (§7.1 — visibility ["app"]); the model never sees these.  */
/* -------------------------------------------------------------------------- */

export const SAVE_DRAFT_DESCRIPTION = `Autosave the current answers for a form. Called by the renderer, not by the model. Debounce it: writes are capped in size and rate-limited per form.`;

export const GET_FORM_STATE_DESCRIPTION = `Return the stored schema and answers for a formId, so a re-opened form can hydrate itself. Called by the renderer, not by the model.`;

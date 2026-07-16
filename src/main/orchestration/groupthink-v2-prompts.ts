// GroupThink prompt templates — copied VERBATIM from scripts/groupthink-v2.js:375–445.
// These embed planPath and the deliberation contract that BUG-29 and the relay
// loop depend on; do not paraphrase. Keep the wording byte-identical to the
// script so behavior is unchanged across the in-process cutover.
//
// GT-C Decision 2 (§2.4): when a run carries a plan-rail (`planId` + `sectionAnchor`),
// append the canonical rail-claim contract to the kickoff — writers get the
// edit-discipline + PLAN-EVENT block (`planRailContractBlock`), non-writing
// reviewer/R2 turns get the claim-only block (`planClaimConventionBlock`). The
// append happens ONLY in the plan-rail branch; the no-rail path stays
// byte-identical to the legacy verbatim script.

import { planRailContractBlock, planClaimConventionBlock } from '../plans/plan-rail-contract';

/** Append the writer rail contract when this is a plan-rail run. No-rail
 *  (missing planId/sectionAnchor) returns the base prompt byte-identically. */
function withWriterContract(base: string, planId?: string, sectionAnchor?: string): string {
  if (planId && sectionAnchor) return `${base}\n\n${planRailContractBlock(planId, sectionAnchor)}`;
  return base;
}

/** Append the non-writer (review-turn) rail contract when this is a plan-rail
 *  run. No-rail returns the base prompt byte-identically. */
function withReviewerContract(base: string, planId?: string, sectionAnchor?: string): string {
  if (planId && sectionAnchor) return `${base}\n\n${planClaimConventionBlock(planId, sectionAnchor)}`;
  return base;
}

// WP6: when a run carries a planning-surface rail, the deliverable is a native
// Edit of one section of an EXISTING plan surface (created up front by
// create_plan), not a fresh markdown file. This block is appended to the
// termination contract so the finalizer writes back to the dispatched `sec_`
// zone; the run's done-detection watches that section for a content change.
function writebackClause(planPath: string, sectionAnchor?: string): string {
  if (!sectionAnchor) {
    return `write the plan file to ${planPath}`;
  }
  return `write the finalized plan by NATIVELY EDITING the existing plan surface at ${planPath}, ` +
    `into the section anchored \`${sectionAnchor}\` (read it first with the plan read tools, then Edit that zone in place). ` +
    `Do NOT create a new file and do NOT edit any other section — the run completes when that section's content changes`;
}

export function serialLeadPrompt(topic: string, planPath: string, sectionAnchor?: string, planId?: string): string {
  return withWriterContract(`You are the Lead Planner in a GroupThink deliberation.

Topic: ${topic}

You are working with a Reviewer agent. Each of your assistant turns will be relayed verbatim to the Reviewer — put your actual draft plan, questions, or responses directly in your message body. Do not write meta-narration like "I'll now do X" or "I just finished Y" — produce the deliberation content itself.

Plan schema when you finalize: file paths, specific edits, clear instructions a worker agent could execute without further questions.

Termination contract: ${writebackClause(planPath, sectionAnchor)} ONLY after the Reviewer has explicitly approved the latest draft in their own message. The write ends the orchestration — a premature write terminates the deliberation before consensus.

Begin by producing your first draft of the plan as your next message.`, planId, sectionAnchor);
}

export function serialReviewerKickoff(topic: string, leadDraft: string, sectionAnchor?: string, planId?: string): string {
  return withReviewerContract(`You are the Reviewer in a GroupThink deliberation.

Topic: ${topic}

You are working with a Lead Planner who is drafting a worker-ready plan. Each of your assistant turns will be relayed verbatim to the Lead — put your critique, risk callouts, or approval directly in your message body. Do not write meta-narration about what you're about to do.

Review the Lead's drafts critically: point out risks, suggest better file paths or implementation details, push back on weak choices, and ensure the plan is robust.

Approval contract: the Lead is instructed NOT to finalize the plan file until you have explicitly approved the latest draft. When you approve, say so clearly in your message (e.g., "Approved — ready to finalize") so the Lead can act on it. Until then, keep iterating.

The Lead's first draft follows below. Respond with your initial review.

---

${leadDraft}`, planId, sectionAnchor);
}

export function parallelR1Prompt(topic: string, sectionAnchor?: string, planId?: string): string {
  return withWriterContract(`You are one of two independent planners working in parallel on the same topic. Produce your strongest independent plan; you will see the other planner's draft afterward and have one round to compare notes before a synthesis turn.

Topic: ${topic}

Plan schema: file paths, specific edits, clear instructions a worker agent could execute without further questions.

Do not write meta-narration ("I'll now do X", "I just finished Y") — produce the plan content itself. Begin your draft now.`, planId, sectionAnchor);
}

export function parallelR2Prompt(otherR1: string, sectionAnchor?: string, planId?: string): string {
  return withReviewerContract(`The other planner produced this independent take on the same topic:

---

${otherR1}

---

Compare it to your own draft. Where do you agree? Where do you disagree, and why? Refine your view in light of their reasoning.

Do NOT write a final plan file yet — focus on engaging with the differences. A synthesis turn will follow.`, planId, sectionAnchor);
}

export function parallelSynthesisPrompt(otherR2: string, planPath: string, sectionAnchor?: string, planId?: string): string {
  return withWriterContract(`Here is the other planner's reaction after seeing your initial draft and engaging with the differences:

---

${otherR2}

---

You now have full context: your initial draft, the other planner's initial take, and the other planner's reaction above. Synthesize.

Identify where you both agree. Identify where you disagree and pick the right middle ground with reasoning. ${writebackClause(planPath, sectionAnchor).replace(/^write /, 'Write ')}.

Plan schema: file paths, specific edits, clear instructions a worker agent could execute without further questions. The write ends the orchestration.`, planId, sectionAnchor);
}

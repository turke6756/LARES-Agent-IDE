// GroupThink prompt templates — copied VERBATIM from scripts/groupthink-v2.js:375–445.
// These embed planPath and the deliberation contract that BUG-29 and the relay
// loop depend on; do not paraphrase. Keep the wording byte-identical to the
// script so behavior is unchanged across the in-process cutover.

export function serialLeadPrompt(topic: string, planPath: string): string {
  return `You are the Lead Planner in a GroupThink deliberation.

Topic: ${topic}

You are working with a Reviewer agent. Each of your assistant turns will be relayed verbatim to the Reviewer — put your actual draft plan, questions, or responses directly in your message body. Do not write meta-narration like "I'll now do X" or "I just finished Y" — produce the deliberation content itself.

Plan schema when you finalize: file paths, specific edits, clear instructions a worker agent could execute without further questions.

Termination contract: write the plan file to ${planPath} ONLY after the Reviewer has explicitly approved the latest draft in their own message. The file-write ends the orchestration — a premature write terminates the deliberation before consensus.

Begin by producing your first draft of the plan as your next message.`;
}

export function serialReviewerKickoff(topic: string, leadDraft: string): string {
  return `You are the Reviewer in a GroupThink deliberation.

Topic: ${topic}

You are working with a Lead Planner who is drafting a worker-ready plan. Each of your assistant turns will be relayed verbatim to the Lead — put your critique, risk callouts, or approval directly in your message body. Do not write meta-narration about what you're about to do.

Review the Lead's drafts critically: point out risks, suggest better file paths or implementation details, push back on weak choices, and ensure the plan is robust.

Approval contract: the Lead is instructed NOT to finalize the plan file until you have explicitly approved the latest draft. When you approve, say so clearly in your message (e.g., "Approved — ready to finalize") so the Lead can act on it. Until then, keep iterating.

The Lead's first draft follows below. Respond with your initial review.

---

${leadDraft}`;
}

export function parallelR1Prompt(topic: string): string {
  return `You are one of two independent planners working in parallel on the same topic. Produce your strongest independent plan; you will see the other planner's draft afterward and have one round to compare notes before a synthesis turn.

Topic: ${topic}

Plan schema: file paths, specific edits, clear instructions a worker agent could execute without further questions.

Do not write meta-narration ("I'll now do X", "I just finished Y") — produce the plan content itself. Begin your draft now.`;
}

export function parallelR2Prompt(otherR1: string): string {
  return `The other planner produced this independent take on the same topic:

---

${otherR1}

---

Compare it to your own draft. Where do you agree? Where do you disagree, and why? Refine your view in light of their reasoning.

Do NOT write a final plan file yet — focus on engaging with the differences. A synthesis turn will follow.`;
}

export function parallelSynthesisPrompt(otherR2: string, planPath: string): string {
  return `Here is the other planner's reaction after seeing your initial draft and engaging with the differences:

---

${otherR2}

---

You now have full context: your initial draft, the other planner's initial take, and the other planner's reaction above. Synthesize.

Identify where you both agree. Identify where you disagree and pick the right middle ground with reasoning. Write the final consensus plan to ${planPath}.

Plan schema: file paths, specific edits, clear instructions a worker agent could execute without further questions. The file-write ends the orchestration.`;
}

---
artifact_id: prop_cf97d7dc
title: Reframe the Lares README Around the Visibility-First Meta-Harness
author_role: worker
author: Codex README strategy worker
authored_at: 2026-08-06T10:23:20.9088922-07:00
---

# Reframe the Lares README Around the Visibility-First Meta-Harness

## Summary

Revise the repository README so it presents Lares through one coherent product argument:

> Lares is a visibility-first meta-harness for terminal AI agents. It begins with a visual terminal multiplexer, places that multiplexer inside a workspace for files and human review, and adds the coordination, context, planning, memory, and safety systems needed to make multi-agent work dependable.

The current README already contains most of the right facts and several strong formulations, especially “a harness for agent harnesses.” The proposed change is therefore a reframing and consolidation rather than a ground-up rewrite. It should make the product easier to understand in the first thirty seconds, reduce repeated explanations, and connect individual features to the larger design philosophy captured in `plans/GitHub_Strategy/meta-harness.md`.

## Motivation

The current README is technically rich, visually strong, and unusually honest about the alpha state. It already explains provider independence, visible terminal sessions, GroupThink, planning, context management, document work, setup, architecture, and security.

Its weakness is not missing information. Its weakness is that several competing descriptions appear before a reader has formed a single mental model of the product:

- An agent-native workspace.
- A harness for agent harnesses.
- A terminal multiplexer.
- A lightweight development and document environment.
- A multi-agent orchestration system.

All of these descriptions are true, but their relationship is not immediately apparent. The README should show that they are layers of the same product rather than separate claims.

The refined `meta-harness.md` provides that relationship. It describes Lares as three nested ideas:

1. A terminal multiplexer that makes full agent sessions visible and controllable.
2. A workspace in which humans and agents can inspect and collaborate on files and artifacts.
3. A meta-harness that coordinates those agents and manages the conditions required for reliable long-running work.

This progression should become the README’s organizing narrative.

## Proposed positioning

### Primary category

Describe Lares first as a **visibility-first meta-harness for terminal AI agents**.

“Meta-harness” is the most differentiated category, but it is unfamiliar language and must be defined immediately. “Visibility-first” captures the product principle that separates Lares from headless orchestration systems. “Terminal AI agents” is broader than “coding agents” while remaining concrete and faithful to the harnesses Lares launches today.

### Memorable shorthand

Retain:

> A harness for agent harnesses.

Use this as a memorable summary after the plain-language definition, not as the definition itself.

### Supporting analogy

Keep the comparison to a terminal multiplexer inside a lightweight, VS Code-style workspace, but move it below the initial product definition. This analogy helps readers picture the interface, but leading with it risks positioning Lares as an incomplete IDE rather than a new orchestration layer.

### Audience framing

Lead with terminal coding agents because Claude Code and Codex are the concrete, searchable, tested entry point. Then broaden the thesis:

> Coding agents are becoming general-purpose computer-work agents. They need an environment built around supervising their work across code, documents, notebooks, data, and the web—not merely another chat box inside a conventional IDE.

This preserves the product’s origin in research, writing, notebooks, and environmental analysis without making the opening so broad that readers cannot identify what Lares actually runs.

## Proposed opening

Replace the current stack of overlapping hero descriptions with a tighter sequence along these lines:

> **Watch, direct, and collaborate with teams of AI agents—in one workspace.**
>
> **Lares is a visibility-first meta-harness for terminal AI agents.** It runs full Claude Code, Codex, and other compatible terminal-agent sessions inside a shared visual workspace, where you can watch them work, inspect their tools and files, coordinate them across providers, and intervene at any time.
>
> Lares combines an agent terminal multiplexer, a lightweight development and document workspace, and an orchestration layer for planning, context management, memory, and repeatable multi-agent workflows.
>
> **A harness for agent harnesses.**

The exact copy should be polished during implementation, but it should preserve this order: human outcome, category, concrete mechanism, product layers, memorable shorthand.

## Proposed README narrative

### 1. Hero

Keep the lockup, primary screenshot, alpha badge, and concise human-facing promise. Reduce the introductory copy to one definition and one expansion.

### 2. Why Lares exists

Compress the current “What & why” section into the origin problem:

- Agents were scattered across terminal tabs and VS Code windows.
- Their status, identity, and completed work were difficult to recover at a glance.
- Independent Claude Code and Codex sessions could not communicate.
- Long-running work exceeded the context and attention of any single session.
- Agent-produced Markdown, plans, notebooks, and reports needed a better human review surface.

Retain some first-person maintainer voice. The origin story makes the project feel authored rather than generic, but it should remain concise.

### 3. How the system fits together

Introduce the three-layer model:

| Layer | Role |
|---|---|
| Agent multiplexer | Runs real terminal agents and makes their identity, status, context, chat, and terminal visible. |
| Agent-native workspace | Gives humans and agents a shared surface for files, Markdown, plans, notebooks, documents, browser sessions, and review. |
| Meta-harness | Coordinates roles and workflows while managing context, continuity, memory, safety, and improvement. |

A compact architecture diagram should accompany this explanation:

```text
Claude Code        Codex        Other compatible agents
     \                |                /
      \--- provider-supplied harnesses-/
                       |
                 Lares meta-harness
        visibility · coordination · context
          planning · memory · workflows
                       |
          human + files + docs + browser
```

This is a conceptual diagram, not a substitute for the technical architecture documentation.

### 4. What makes Lares different

Organize the differentiators around product principles instead of adding another flat feature list:

- **Full agents, not hidden model calls.** Every top-level participant is a real, interactive terminal-agent session with its own harness and tools.
- **Visible rather than headless.** Agents remain on the dashboard, can be inspected or interrupted, and do not disappear into an opaque background workflow.
- **Provider-independent by architecture.** Lares coordinates through terminal sessions, MCP, hooks, skills, and instruction files rather than a model-provider SDK.
- **Persistent orientation.** Agent identity, conversations, outputs, plans, and handoffs remain navigable across sessions.
- **Context as a managed resource.** Lares considers both prompt-window capacity and the durable decision context stored in plans, artifacts, evidence, and memory.
- **Planning before implementation.** Proposals, deliberation, plans, and bounded work packages make long-running projects resumable.
- **Human control throughout.** Users can inspect chats and tool calls, edit artifacts, leave comments, open terminals, and intervene at any point.

### 5. Capabilities

Retain the existing feature screenshots and most of their supporting copy. Regroup capabilities under four headings that reflect increasing meta-harness responsibility:

| Capability group | Examples |
|---|---|
| Observe | Agent cards, state, context use, chats, tool calls, files read and written, terminal attachment. |
| Coordinate | Supervisor/worker/researcher roles, agent messaging, scripted orchestration, cross-provider GroupThink. |
| Sustain | Plans, handoffs, context rotation, workspace memory, persistent agent sessions, reviewable artifacts. |
| Improve and protect | Usage intelligence, instruction and skill refinement, Git attribution and recovery, resource protection, browser controls. |

Only include capabilities in the present tense when they are demonstrably available in the repository today.

### 6. Cross-provider deliberation

Keep GroupThink as the flagship worked example of the meta-harness. It concretely proves the architecture and is more persuasive than an abstract provider-neutrality claim.

Shorten the section slightly by removing meta-harness explanations already established earlier. Focus this section on:

- Why independent providers catch different mistakes.
- Parallel versus serial deliberation.
- Why orchestration is scripted and repeatable.
- Where users can inspect the implementation and workflow documentation.

### 7. Quick start

Move Quick Start earlier than it appears today—after readers understand the product and see the core capabilities, but before the longer workflow, provider, architecture, and roadmap material.

Preserve the current alpha warnings and agent-assisted setup flow unless implementation review finds them outdated.

### 8. Today versus direction

Introduce an explicit capability-status distinction. The refined meta-harness vision contains mature responsibilities that may be only partially implemented. The README must not blur architectural direction into shipped behavior.

Use a small status vocabulary consistently:

- **Available today**
- **Experimental**
- **In development**
- **Long-term direction**

Audit claims concerning:

- Recovery of deleted agents.
- Automatic session rotation and identity preservation.
- Workspace memory and lesson creation.
- High-frequency Git checkpoints and commit consolidation.
- Host-memory pressure controls.
- Cost and performance feedback.
- Support for providers beyond Claude Code and Codex.

The nine tiers in `meta-harness.md` should guide the vision, but should not be reproduced as nine apparently completed product tiers in the README.

### 9. Architecture, security, roadmap, and contribution

Retain these sections with minimal structural change. They are already appropriately direct. Update internal wording only where necessary to align with the new definitions and audited capability status.

## Content to consolidate or move

The README currently explains “harness for harnesses” in the hero, “What & why,” GroupThink, and Providers sections. Consolidate the full explanation near the top.

After consolidation:

- The hero defines the product.
- “How it works” explains the three layers.
- GroupThink demonstrates the value of orchestration.
- Providers describes the compatibility contract: terminal session, MCP, and lifecycle hooks.
- `docs/vision.md` carries the longer philosophy and nine-tier meta-harness maturity model.

The personal history and detailed philosophy in `meta-harness.md` should be edited into `docs/vision.md` rather than copied wholesale into the README. The README should remain a strong front door, not become the entire house.

## Terminology rules

Use the following terms consistently:

- **Agent:** the model and its provider-supplied operational harness together.
- **Terminal agent:** the full interactive process launched by Lares.
- **Meta-harness:** the outer system that configures, observes, and coordinates terminal-agent harnesses.
- **Orchestration:** a defined interaction among agents, preferably implemented as a repeatable scripted primitive.
- **Workspace:** the human-and-agent surface containing files, artifacts, terminals, documents, plans, and browser sessions.
- **GroupThink:** Lares’s named cross-provider deliberation workflow.

Avoid using “provider-agnostic” as an unqualified compatibility promise. Prefer **provider-independent architecture** or **provider-neutral by design**, followed by the tested-support statement: Claude Code is the reference harness and Codex is the tested second provider today.

## Non-goals

This proposal does not call for:

- Replacing the existing screenshots or brand assets.
- Removing setup, security, architecture, roadmap, or contribution information.
- Claiming broad provider compatibility before it is tested.
- Presenting Lares as a sandbox or security boundary.
- Positioning Lares as a replacement for every feature of VS Code.
- Copying the full nine-tier vision into the README.
- Changing application behavior as part of the documentation revision.

## Implementation approach

1. Audit every present-tense capability claim in the README and `meta-harness.md` against current code and documentation.
2. Rewrite the hero and opening around the three-layer product definition.
3. Consolidate the existing “What & why” material into a shorter origin story and differentiator section.
4. Add the three-layer conceptual model and compact diagram.
5. Regroup existing feature copy without discarding useful screenshots or concrete implementation details.
6. Tighten GroupThink and Providers so they no longer repeat the core definition.
7. Add explicit status language for experimental and aspirational responsibilities.
8. Update `docs/vision.md` with the longer philosophy and maturity model where needed.
9. Check every relative link, image, setup command, provider statement, and security statement after restructuring.

## Acceptance criteria

The revision is successful when:

- A reader can accurately explain what Lares is after reading only the hero and first explanatory section.
- “Meta-harness” is defined in plain language before it is relied upon.
- The relationship among terminal multiplexer, workspace, and orchestration layer is explicit.
- The README clearly explains that Lares launches full interactive agent harnesses rather than decomposing agents into provider API calls.
- Visibility, human control, persistence, context management, and cross-provider collaboration read as related design principles.
- Coding remains the concrete entry point while documents, notebooks, research, data, and browser work are visibly first-class.
- Current, experimental, and aspirational capabilities cannot reasonably be confused.
- Claude Code and Codex are described as the tested surface without implying guaranteed support for every terminal agent.
- The alpha security warning remains prominent and accurate.
- Existing useful screenshots, setup instructions, architecture links, and examples remain easy to find.
- Repeated explanations are reduced and the resulting README is no longer than the current version without a deliberate reason.

## Open editorial decisions

Include that we support grok and antigravity working on pi

- Whether the primary noun should be “terminal AI agents” or “terminal coding agents.” The former better reflects the product vision; the latter may be more immediately recognizable and searchable.
- Whether “visibility-first” belongs in the permanent one-line description or only in the explanatory copy.
- Whether the four capability groups should appear as a table, short sections, or a compact visual.
- How much first-person origin story should remain in the README versus moving to `docs/vision.md`.
- Which parts of the nine-tier meta-harness model are sufficiently implemented to mention as current capabilities.

## Source material

- `README.md` — current public repository front door.
- `plans/GitHub_Strategy/meta-harness.md` — refined product thesis and meta-harness responsibility model.
- `plans/GitHub_Strategy/github_repo_readiness_playbook_lares.md` — original repository presentation strategy.
- `plans/GitHub_Strategy/archetecture_ed.md` — earlier design philosophy and origin narrative.
- `docs/vision.md` — appropriate durable home for the full product philosophy.


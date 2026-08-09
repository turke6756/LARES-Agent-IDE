---
artifact_id: prop_0ed67aa4232e423fa8147937ac05639c
title: User-owned behavior overlays for every Lares agent lane
author_role: worker
authored_at: 2026-08-03T22:32:27.1849863Z
---

# User-owned behavior overlays for every Lares agent lane

## Summary

Lares should give every dashboard-created agent lane a durable, user-owned behavior overlay and make the dashboard-managed instruction carrier explicitly explain that overlay.

The app must remain free to upgrade its managed `CLAUDE.md`, `AGENTS.md`, or other provider instruction files. Users and agents need a separate, obvious place for local behavioral choices that will not be replaced by scaffold migration. The managed carrier should tell the agent to read the overlay, explain that it is user-owned, and direct behavioral tuning there instead of into the managed file.

The first motivating use case is supervisor worker-provider policy: a user may want the supervisor to favor Claude, Codex, Gemini, Grok, or Antigravity workers, require cross-provider diversity for reviews, avoid a provider, or choose providers by task type. The mechanism should be general rather than provider-policy-specific so it can also hold communication style, verification preferences, delegation norms, and other workspace or persona behavior.

## Problem

Lares currently ships substantial managed behavior in scaffolded instruction files. For example, the structural supervisor contract is written to `.lares/supervisor/CLAUDE.md`, Claude workers receive `.lares/workers/claude/CLAUDE.md`, and Codex/Grok/Antigravity workers receive derived `AGENTS.md` identities. These files are versioned scaffold content. When their bundled version changes, a locally edited unknown body is backed up and replaced with the new managed body.

That migration behavior is correct for application-owned contracts, but it makes the managed files the wrong place for user preferences. An agent that is asked to "change how you behave" can reasonably edit the instruction file it sees, only to have that edit displaced on a later upgrade. The current product does not establish one universal, clearly named user-owned behavior surface across built-in supervisors, provider worker lanes, the researcher lane, and custom personas.

There is partial precedent:

- The researcher contract says to place workspace-specific tuning in sibling `CLAUDE.local.md`, which the dashboard never overwrites.
- The custom-persona guidance likewise describes sibling `CLAUDE.local.md` as the durable place for persona-specific tuning.
- Lares's context-overhead tooling already recognizes `CLAUDE.local.md` as a local override source.
- The structural supervisor and normal worker contracts do not currently offer the same explicit, universal contract.

The result is an inconsistent ownership story. Some lanes know about a local overlay, some do not, and non-Claude providers should not have to depend on Claude-specific implicit loading semantics.

## Proposal

### 1. Establish one provider-neutral overlay contract

Use a provider-neutral sibling file named `LARES.local.md` as the canonical user-owned behavior overlay for a Lares-created lane or persona.

The filename is deliberately not `CLAUDE.local.md` or `AGENTS.local.md`:

- the behavior belongs to the Lares agent role, not to one model vendor;
- every provider can follow the same explicit read contract;
- the user does not need to maintain equivalent preference text in multiple provider-specific files;
- future provider carriers can adopt the contract without inventing another filename.

Provider-native local files may still exist for provider-specific advanced configuration, but Lares should advertise `LARES.local.md` as its own stable user customization surface.

### 2. Make every managed carrier acknowledge and read it

Every dashboard-managed instruction carrier should contain a short, high-priority section with these semantics:

> Before beginning work, read `./LARES.local.md` if it exists. This is the user-owned behavior overlay for this Lares lane. Follow it unless it conflicts with higher-priority safety, application, or task instructions. Put durable user-requested preferences and behavioral tuning there; do not place them in this dashboard-managed file, because Lares may replace this file during an upgrade.

This must be an explicit instruction, not merely a comment that the file exists. That keeps the mechanism honest across Claude, Codex, Gemini, Grok, Antigravity, and later providers, regardless of whether a provider has a native "local instructions" convention.

At minimum, update the managed carriers for:

- the structural supervisor;
- Claude workers;
- Codex workers;
- Grok workers;
- Antigravity workers;
- Gemini workers once their persistent instruction carrier is defined;
- the researcher lane;
- dashboard-created custom personas.

The worker identities that are derived from the Claude worker body should continue to derive this shared section from one source rather than copying it into independent constants.

### 3. Seed the overlay once and never manage its contents

The application should create an initial `LARES.local.md` when it creates or first refreshes a lane/persona scaffold. Its lifecycle must be seed-once:

- create it only when absent;
- never add it to a version-migrated scaffold map;
- never compare it with a bundled hash;
- never overwrite, rename, delete, or `.bak` it during application upgrades;
- preserve an existing file byte-for-byte;
- do not silently re-seed a deliberately deleted file on every launch unless the product explicitly chooses "absence means recreate" and documents that behavior.

This should use the same ownership pattern as seed-once supervisor memory and seed-once provider identities, not the managed-file migration path.

The starter body should be useful but restrained:

```md
# Local Lares behavior

This file is owned by you, not by the Lares scaffold updater. Lares-managed
CLAUDE.md and AGENTS.md files may be replaced during upgrades; this file will not.

Add durable preferences for this agent lane here. Keep task-specific instructions
in the task prompt rather than turning them into permanent behavior.
```

The initial file should not impose opinionated provider preferences. The application's default behavior belongs in its managed contract; the overlay records the user's departures from or refinements to that default.

### 4. Be precise about the scope of an "agent" overlay

Several dashboard agents intentionally share a working directory. Therefore a sibling overlay is not necessarily private to one agent card:

- `.lares/supervisor/LARES.local.md` is the workspace's structural-supervisor overlay and is shared by supervisor sessions using that cwd;
- `.lares/workers/<provider>/LARES.local.md` is shared by workers in that provider lane;
- `.lares/researcher/LARES.local.md` is shared by researcher sessions;
- `.lares/agents/<persona>/LARES.local.md` belongs to that reusable custom persona.

The UI and documentation must call these lane/persona preferences, not per-session preferences. If Lares later needs per-agent-card behavior, that requires a different storage and launch-injection mechanism and should not be implied by this proposal.

### 5. Add a behavior-tuning skill

Ship a skill that helps users and agents safely tune the overlay. A working name is `tune-lares-behavior`.

The skill should:

- identify the current lane/persona and the corresponding `LARES.local.md`;
- explain the overlay's scope before editing it;
- distinguish durable preferences from one-task instructions;
- translate conversational preferences into concise behavioral rules;
- show the proposed edit before making a broad or potentially costly policy change;
- preserve unrelated user content;
- avoid duplicating application-owned invariants from managed carriers;
- help remove or revise stale preferences;
- support provider-selection policies without assuming provider availability;
- never edit the managed `CLAUDE.md` or `AGENTS.md` when the user's intent is local behavioral tuning.

Example provider-policy requests the skill should handle include:

- "Use a combination of Claude, Codex, Gemini, and Grok workers."
- "Prefer Codex for implementation and Claude for review."
- "For architecture or debugging with an uncertain cause, use at least two providers."
- "Do not launch Grok workers in this workspace."
- "Use one well-matched worker for routine tasks; diversify only parallel or judgment-heavy work."

The skill should produce policy based on capability, availability, cost, task fit, and requested diversity. It should not convert a preference for variety into an unconditional requirement to spend multiple agents on every small task.

### 6. Improve the supervisor's managed provider-awareness

The supervisor contract should separately document the application-owned fact that `launch_agent` accepts a provider choice and name the providers supported by the installed build or direct the supervisor to the tool schema as the authority. This is capability documentation, not a user preference, so it belongs in the managed carrier.

The managed default should be neutral and practical: select by task fit and availability, and seek provider diversity when independent perspectives materially help. The overlay can then express a user's stronger preferences, exclusions, or routing rules.

## Relationship to user-authored workflow support

Lares already contains the related `write-orchestration-script` skill at `.claude/skills/write-orchestration-script/`. It teaches agents to help users author external Python, Node.js, or Bash workflows that drive the local Lares HTTP API. Its supported shapes include dispatcher fan-out, schedulers, deliberation/relay, and staged pipelines. It deliberately distinguishes bespoke external workflows from built-in `run-orchestration` execution.

That skill is the closest existing example of the product direction described here: users can shape not only an agent's standing behavior but also their own multi-agent operating procedures on top of the dashboard API.

The current approved implementation plan for `write-orchestration-script` makes an important limitation explicit: the canonical package lives in this repository's root `.claude/skills/`, and distributing it into other Lares-created workspaces is a non-goal of that implementation. In other words, the skill exists in the Lares development workspace, but it is not yet a generally shipped capability in every user's workspace.

This proposal should align with that future rollout rather than create a competing workflow system:

- `LARES.local.md` stores standing behavioral policy: how an agent or lane should usually act.
- `tune-lares-behavior` helps users maintain that policy conversationally.
- `write-orchestration-script` helps users create executable, reusable multi-agent workflows against the dashboard API.
- `run-orchestration` starts and monitors application-bundled workflows.

The behavior-tuning skill may suggest that a request has outgrown a standing preference and should become a workflow. For example, "usually use diverse reviewers" fits the overlay; "launch three provider-specific reviewers, run two critique rounds, synthesize, verify an artifact, and resume after interruption" belongs in a user-authored orchestration.

When Lares productizes the orchestration-authoring skill for general workspaces, both skills should share terminology for providers, lanes, ownership, authorization, and the boundary between policy and execution. Neither should launch a live multi-agent workflow without explicit user authorization.

## UI direction

The first implementation does not require a rich preferences schema. A simple editor can open the appropriate `LARES.local.md`, show its ownership and scope, and offer an "Ask an agent to tune this" action that invokes the tuning skill.

Possible surfaces:

- Supervisor settings: "Behavior & worker-provider preferences."
- Worker provider settings: one overlay per provider lane.
- Researcher settings: sources, depth, and reporting preferences.
- Persona editor: behavior overlay next to the persona's managed identity.

The UI must visibly distinguish:

- **Managed by Lares:** application contract, upgraded with the app.
- **Owned by you:** durable local behavior, never overwritten by Lares.

Direct Markdown remains the source of truth initially. A later structured preferences UI may compile well-known controls into a marked block inside the overlay, but it must preserve free-form user text and avoid turning the entire file back into application-owned content.

## Migration and compatibility

Existing `CLAUDE.local.md` files need a deliberate compatibility rule. The safest initial behavior is:

- do not delete or rewrite them;
- continue allowing provider-native loading;
- mention their presence in the UI;
- avoid automatically merging ambiguous content;
- offer an explicit migration or copy into `LARES.local.md` if the user wants one provider-neutral overlay.

For the researcher and custom-persona documentation that currently names `CLAUDE.local.md`, update the managed text to make `LARES.local.md` the Lares-owned convention while explaining that a pre-existing provider-native local file remains valid.

Managed carrier changes require normal scaffold version bumps, frozen prior hashes, migration tests, and parity assertions. The new overlay itself must not receive a managed version entry.

## Acceptance criteria

1. A fresh workspace receives a user-owned behavior overlay for every dashboard-created built-in lane that has a persistent cwd, and a new custom persona receives its own overlay.
2. Every applicable managed `CLAUDE.md` or `AGENTS.md` explicitly instructs the agent to read the overlay and explains the ownership boundary.
3. Relaunching or upgrading Lares preserves an edited overlay byte-for-byte and creates no overlay backup caused by scaffold migration.
4. Managed carrier upgrades still occur normally; local behavioral edits no longer require modifying those carriers.
5. Claude, Codex, Gemini, Grok, and Antigravity launch tests prove the provider actually receives or follows the read instruction, rather than assuming filename support.
6. Shared-cwd scope is accurately described in the UI and documentation.
7. The behavior-tuning skill edits only the user-owned overlay, preserves unrelated content, and distinguishes standing policy from task prompts and executable workflows.
8. Supervisor guidance documents provider selection through `launch_agent`, while the overlay controls user-specific preferences.
9. Documentation connects behavior overlays, `tune-lares-behavior`, `write-orchestration-script`, and `run-orchestration` as four complementary layers rather than competing mechanisms.
10. Existing `CLAUDE.local.md` content is never silently destroyed or ambiguously merged.

## Risks and questions for hardening

- **Filename:** confirm `LARES.local.md` versus a more explicit name such as `BEHAVIOR.local.md`. The provider-neutral and product-owned name is preferred.
- **Seeding after deletion:** decide whether deleting the starter overlay means "recreate next launch" or "the user intentionally removed it." A small seed-state record may be needed to distinguish those cases.
- **Overlay precedence:** define how conflicts are explained. The overlay must remain below system, safety, application invariants, and the current user's task, while overriding managed defaults that are explicitly customizable.
- **Supervisor multiplicity:** multiple structural supervisors share the same directory today. Confirm that workspace-wide supervisor policy is intended.
- **Provider lanes without a mature carrier:** Gemini support must prove an enforceable instruction-loading path before claiming parity.
- **Context cost:** keep the starter file tiny and surface overlay size in context-overhead tooling. The tuning skill should warn before turning it into a long handbook.
- **Sensitive content:** preferences are ordinary workspace files and should not invite users to store API keys, credentials, or secrets.
- **Distribution of `write-orchestration-script`:** decide whether general-workspace shipping belongs in the same implementation plan or remains a linked follow-up. The behavior-overlay feature should not claim that user-authored workflow support is already distributed when it is currently repository-local.

## Suggested implementation sequence

1. Decide the canonical filename, precedence statement, and deletion/re-seeding semantics.
2. Inventory every persistent dashboard-created lane/persona and its provider instruction carrier.
3. Add seed-once overlay creation outside managed scaffold maps.
4. Bump managed carrier versions and add the explicit read/ownership section through the existing derivation chains.
5. Add preservation, migration, carrier-parity, and live-provider compliance tests.
6. Add the basic overlay editor and ownership labels.
7. Ship and evaluate `tune-lares-behavior`.
8. Link or separately productize the existing `write-orchestration-script` package for general user workspaces.


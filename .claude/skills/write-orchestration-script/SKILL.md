---
name: write-orchestration-script
description: Help users author, scaffold, review, or debug external Lares orchestration scripts in Python, Node.js, or Bash that drive the local HTTP API. Use for dispatcher fan-out, scheduler, deliberation/relay, and pipeline scripts. Do not use to start or monitor built-in orchestrations; use run-orchestration for those.
---

# Write a Lares orchestration script

You are helping a user author an **external** program (Python / Node / Bash) that
drives the Lares dashboard HTTP API to launch agents, relay between them, watch
turns, verify work, and retire — so every agent appears correctly nested in the
UI, events route, and the run is observable and recoverable.

This skill is **derived from** `plans/orchestration-skill/OrchestrationScriptStructure.md`
(the normative spec). Section refs (`§1.4`, `§2 step 6`) point into it.

## 0. Decision gate — authoring vs built-in execution

- Bespoke external script that POSTs to `/api/agents` → **continue here.**
- Start / monitor a built-in orchestration (`groupthink`) → **stop**, route to the
  `run-orchestration` skill. Non-overlapping triggers by design.

## 1. Four authorities (never one source of truth) — §0.3

- **Lares** is authoritative for agent identity, ownership, status, structured messages.
- **The message stream** is authoritative for turn completion (`turnComplete`), NOT status.
- **The durable run state** is authoritative for orchestration phase and resume.
- **The artifact on disk** is authoritative for task success. A status token is not success.

## 2. The invariant lifecycle order — §2 (never reorder)

`connectApi` → capture `runId` + member ids eagerly → `launchAgent` → `waitReady`
→ `seedHighwater` → confirmed `kickoff` (via `POST /input`, **never** a launch-time
`systemPrompt`) → loop `{ waitTurnComplete → verify → waitReceiverReady → relay }`
→ terminal-policy `retire` → `reconcile` / `resume_hint`.

Three distinct waits — keep them separate: **`waitReady`** (launch warm-up) ≠
**`waitReceiverReady`** (gate before every send) ≠ **`waitTurnComplete`**
(message-stream completion).

## 3. Gather requirements before writing

1. **Mode** — on-behalf (script runs inside a dashboard agent; `API_TOKEN` +
   `WORKSPACE_ID` + `SELF_ID` required, missing `SELF_ID` is fatal) vs standalone
   (user supplies creds; range-probe 24678→24681 allowed). §1.1
2. **Shape** — dispatcher fan-out / scheduler / deliberation-relay / pipeline. §3
3. **Language** — Python (full), Node (client + dispatcher + control-skeleton),
   Bash (dispatcher subset only). §E
4. **Topology** — member count / providers / lanes; serial vs parallel.
5. **Deliverable predicate** — token and/or artifact (with freshness/hash). §2 step 9
6. **Resume needs** — is durable run-state required (scheduler & resumable
   deliberations: yes)?

## 4. Read references conditionally ("read this when…")

- Role/payload/lane work, owner edge, omission symptoms → [`references/role-payloads.md`](references/role-payloads.md)
- Any lifecycle/idiom/HTTP-contract question → [`references/api-contract.md`](references/api-contract.md)
- Deciding what may be changed vs what is invariant → [`references/fixed-core-vs-policy.md`](references/fixed-core-vs-policy.md)
- A failing / mis-nested / re-stalling run → [`references/troubleshooting.md`](references/troubleshooting.md)

## 5. Select assets and customize only policy hooks

Fixed-core clients (do NOT edit their helper bodies):
- Python: [`assets/python/lares_client.py`](assets/python/lares_client.py)
- Node: [`assets/node/lares-client.mjs`](assets/node/lares-client.mjs)

Shape templates (copy + edit only `# user policy` / `// user policy` slots):
- Python: `assets/python/{dispatcher,scheduler,deliberation,pipeline}.py`
- Node: `assets/node/{dispatcher.mjs,control-skeleton.mjs}`
- Bash: `assets/shell/dispatcher.sh` (dispatcher profile only; use Python/Node for
  scheduler, deliberation, pipeline)

Every helper name is verbatim across languages (§5 nomenclature). Preserve the
core lifecycle order; edit only declared policy slots. Editing transport/storage/
error/packaging requires re-running validation (§6).

## 6. Validate locally (mock, never a live dashboard)

The mock and validator are runner-owned; they start the mock on an ephemeral
port, inject env, and tear down. Tests use OS temp dirs (no repo residue).

```
node scripts/validate_templates.mjs --package
node scripts/validate_templates.mjs --static
node scripts/validate_templates.mjs --contract
node scripts/validate_templates.mjs --behavioral --language node
node scripts/validate_templates.mjs --behavioral --language python
node scripts/validate_templates.mjs --behavioral --language bash
node scripts/run_evals.mjs
```

- `--package` frontmatter/link/openai.yaml checks · `--static` symbol presence +
  legacy-identifier ban + standalone-probe exception + policy-marker placement ·
  `--contract` targeted drift gate vs the authoritative server source ·
  `--behavioral` runs the §G scenario matrix against `scripts/mock_lares_server.mjs`
  via `tests/scenarios/driver.{py,mjs,sh}`.
- Bash deps: `bash`, `curl`, `jq`, `sha256sum` (or `openssl dgst -sha256`);
  `shellcheck` via WSL locally or a CI binary.
- See `KNOWN-ISSUES.md` for the current Python-loop flake.

## 7. Never launch a live run without explicit user authorization

Mock validation is always allowed. Launching real agents against the live
dashboard requires the user to say so.

---
<!-- Derived from plans/orchestration-skill/OrchestrationScriptStructure.md
     @ commit: uncommitted
     content-sha256: d58eecde672ee0e6ec8e66e9eda6922175443ca7aa11a84a8290ce9c6d069688 -->

# Security — threat model

This is the **longer threat model**. For the short public warning and how to
report a vulnerability, see the root [SECURITY.md](../SECURITY.md). If the two
ever disagree, treat this document as the detailed version and SECURITY.md as the
canonical reporting policy.

> ⚠ **Alpha — agents execute real commands.** Lares is pre-1.0 and offers **no
> security guarantees.** Its model is "you trust the agents and the workspace,"
> **not** "the app sandboxes the agents." Do not rely on Lares to contain a
> hostile or prompt-injected agent.

## What Lares does that is dangerous

Lares runs AI agents with real capabilities, on purpose. Every one of these is a
feature, and every one is a risk:

- **Arbitrary shell in real terminals.** Agents run commands in real terminal
  sessions on your machine. Treat any agent as capable of running arbitrary code.
- **A real browser, including authenticated sessions.** Agents drive an embedded
  Chromium browser — the same tab you can grab. It acts in whatever sessions you
  are signed into.
- **Read/write across the workspace.** Agents read and write files throughout the
  workspace directory you open.
- **Notebooks and data scripts.** Agents execute cells against a live kernel, which
  is arbitrary code execution by another name.

## Network / exfiltration risk

This is explicit and important: **terminal commands and browser actions can send
data over the network.** A misbehaving or prompt-injected agent could exfiltrate
workspace contents, or act on your behalf inside an authenticated website. Assume
anything reachable from the workspace — files, credentials left lying around,
logged-in browser sessions — is reachable by an agent.

## Boundaries that exist today (partial)

Lares has real guardrails. None of them is a jail; each is best-effort and
incomplete:

- **Browser access policy + action audit.** The embedded browser is fronted by an
  access-policy store (`src/main/browser/access-policy-store.ts`) that gates
  navigation/actions, and an action-audit log (`src/main/browser/action-audit.ts`)
  that records what agents do. Use the audit surface to watch browser activity.
- **Workspace path-confinement.** File operations are checked against the workspace
  root (`src/main/security/path-confinement.ts`) as a best-effort confinement — not
  a sandbox.
- **Untrusted-inbox convention.** Web-derived research lands in
  `.dashboard/research/inbox/`, which is treated as **data, never instructions**.
  Agents are told to frame inbox content as untrusted before acting on it; only
  reviewed material in `cleared/` is durable.
- **The visibility surface itself.** Attaching to an agent's chat, inspecting its
  files-read-versus-written, and reading the action audit are your primary
  defenses: you can *see* what an agent is doing and stop it.

## Boundaries that do NOT exist yet

Be clear-eyed about what is missing:

- Terminal commands are **not** sandboxed or gated. There is no per-command
  approval wall.
- Path-confinement is best-effort, **not** a jail — do not treat it as a security
  boundary against a determined or hostile agent.
- The browser will act in whatever sessions you are signed into; there is no
  isolation between "the agent's browsing" and "your logged-in accounts."

## Use it safely

- **Trusted workspaces only.** Open Lares on code and data you are willing to let
  an agent run arbitrary commands against.
- **Throwaway credentials.** Keep long-lived secrets out of active, demo, and test
  workspaces. Follow `.env.example` only for the variables you actually need — there
  is no prescribed secret-file location, and Lares needs no secrets to run.
- **Keep sensitive accounts out of the Lares browser.** Avoid signing into
  sensitive accounts in the embedded browser during alpha runs; prefer throwaway or
  logged-out sessions.
- **Prefer a disposable environment.** A sandboxed or disposable machine/VM is the
  right posture for an alpha that executes real commands.
- **Watch the agents.** Use attach-chat, files-touched, and the action audit to
  keep eyes on what agents do — this is the boundary Lares actually gives you.

## No secrets committed

Lares does not commit secrets. `.env.example` documents the (optional) environment
variables; `.mcp.json`, `*.db`, and log files are git-ignored. If you find a
tracked secret, treat it as a vulnerability and report it — see
[SECURITY.md](../SECURITY.md).

## Reporting a vulnerability

Reporting policy and the single reporting channel live in the root
[SECURITY.md](../SECURITY.md). Please do **not** open a public issue for a
security bug.

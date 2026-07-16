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
- **PDF viewer navigation + document policy.** The PDF viewer surface loads only
  the exact confined `media://file/<encoded>` URL Lares constructed; any other
  `media://` path and every `file:`/`javascript:`/`data:`/`blob:`/`chrome:`/
  `chrome-extension:`/`about:` navigation is denied, popups are denied, and an
  external `http(s)` link is routed through the existing browser navigation
  policy only after an explicit user gesture — never via unrestricted
  `shell.openExternal`. These decisions are pure and tested in
  `src/main/pdf/pdf-security.ts` (`pdf-security.test.ts`).

## PDF rendering — added native-parser attack surface

The fast PDF viewer renders pages with **PDFium** (compiled to WASM), pinned as
`@hyzyla/pdfium@2.1.13` (MIT wrapper over the BSD-3-Clause PDFium core; recorded
in `PDFIUM_ARTIFACT` in `src/main/pdf/pdf-security.ts`). A native document parser
processing untrusted PDF bytes is a **real, non-trivial attack surface** —
malformed files have historically triggered memory-safety bugs in PDF engines.

This is **mitigated, not eliminated**, by:

- running the parser in the **sandboxed renderer/worker** with **no Node access**;
- sourcing bytes only through the **confined `media://` transport** (realpath
  workspace confinement, `src/main/media-protocol.ts`);
- a **document-byte ceiling** (512 MiB) plus malformed-size rejection that bound
  denial-of-service pressure before bytes reach the parser
  (`isDocumentSizeAllowed` / `assertPdfDocumentSize`, and `pdf-bytes.ts`);
- **pinned-artifact supply-chain hygiene**: the dependency version, licenses,
  source, and a checksum field are recorded so the exact WASM bytes are
  auditable and upgrades are visible. The checksum is a placeholder until the
  artifact is vendored and pinned — the loader must verify real bytes against it.

Treat an opened PDF like any other untrusted input: the sandbox contains a parser
crash, but a determined exploit against PDFium itself is not fully prevented.

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

---
plan_artifact_id: plan_ce97b9ad
intent_id: int_c2a90f13
kind: research
id: provider-sandbox-capabilities-c2-2026-08-08
topic: provider-sandbox-capabilities-c2
created: 2026-08-08T00:00:00Z
source_urls:
  - https://openai.com/index/building-codex-windows-sandbox/
  - https://deepwiki.com/openai/codex/5.6-sandboxing-implementation
  - https://codex.danielvaughan.com/2026/05/14/codex-cli-windows-sandbox-engineering-restricted-tokens-acls-elevated-architecture/
  - https://codex.danielvaughan.com/2026/07/18/codex-cli-windows-sandbox-architecture-powershell-ast-safety-elevated-unelevated-appcontainer-restricted-tokens/
  - https://code.claude.com/docs/en/permissions
  - https://code.claude.com/docs/en/hooks
  - https://github.com/anthropics/claude-code/issues/11226
  - https://github.com/anthropics/claude-code/issues/29709
  - https://generalanalysis.com/guides/claude-code-settings-permissions-bash-tool-security
  - https://github.com/xai-org/grok-build
  - https://grok-wiki.com/public/docs/xai-org-grok-build-90205de50458
  - https://reptile.haus/journal/grok-build-xai-privacy-data-exfiltration-ai-coding-agents-2026/
  - https://antigravity.google/docs/permissions
  - https://github.com/google-antigravity/antigravity-cli/issues/614
  - https://github.com/google-antigravity/antigravity-cli/issues/36
  - https://discuss.ai.google.dev/t/request-for-official-clarification-on-windows-sandbox-support/145290
  - https://arxiv.org/pdf/2605.26298
  - https://arxiv.org/pdf/2606.17573
  - https://learn.microsoft.com/en-us/archive/blogs/voy/write-restricted-token
  - https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-
trust: untrusted
summary: >
  Per-provider capability matrix for native sandbox/containment features across
  Claude Code, OpenAI Codex CLI, xAI Grok Build, and Google Antigravity (agy)
  CLI, with Windows 11 caveats. Codex has the only production-level Windows
  sandbox (restricted tokens + synthetic SIDs + ACLs, experimental as of early
  2026). Claude Code's write guard is instruction/hook-level with known shell
  escape bypasses. Grok Build and agy both lack Windows-native sandbox
  enforcement today. OS-level fallbacks on Windows are technically feasible
  (restricted tokens, AppContainer, icacls deny-ACEs) but each carries
  significant operational friction or coverage gaps. Provider-neutral outbox
  enforcement requires an OS-level layer wrapping all providers, not provider
  hooks alone.
---

# Provider Sandbox Capabilities — Cluster C2 Research

**Plan:** plan_ce97b9ad · **Intent:** int_c2a90f13  
**Date:** 2026-08-08 · **Scope:** Windows 11 host, four CLI providers

---

## 1. Per-Provider Capability Matrix

### 1.1 OpenAI Codex CLI

**Enforcement layer:** OS-native (strongest of the four)

| Mechanism | macOS | Linux | Windows |
|---|---|---|---|
| Primary sandbox | Apple Seatbelt (`sandbox-exec`, SBPL profile) | Bubblewrap (`bwrap`) + Landlock + seccomp | Restricted token + synthetic SID + ACL |
| Write allowlist | SBPL `allow file-write-*` on workspace paths | `--bind` mount, Landlock allow-list | ACE stamped on workspace dir for `sandbox-write` SID |
| Network blocking | SBPL deny-outbound | seccomp-based socket block | Windows Firewall rules (requires elevation) |
| Bypass flag | `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) | same | same |
| Status | Production | Production | **Experimental** (as of March 2026) |

**Windows implementation details (verified via OpenAI blog + Codex knowledge base):**

1. **Setup binary (`codex-sandbox-setup.exe`)** crosses UAC once to provision dedicated local accounts (`CodexSandboxOffline`, `CodexSandboxOnline`), set firewall rules, and stamp ACLs.
2. **Long-lived elevated runner (`codex-command-runner.exe`)** accepts spawn requests via named pipe; validates against policy before calling `CreateProcessAsUserW()`.
3. **Synthetic SID (`sandbox-write`)** is a non-real SID placed in the token's `RestrictedSids` list. Windows write-restricted tokens (Vista+) add a second access check: BOTH the normal identity AND a SID in the restricted list must have write permission. Most paths lack the `sandbox-write` ACE, so writes are denied.
4. **Workspace grant:** `codex-sandbox-setup.exe` stamps write-allow ACEs for the synthetic SID onto the workspace directory tree and any `writable_roots` paths. `.git`, `.codex`, `.agents` get explicit deny-write ACEs even within the workspace.
5. **Audit pass:** at startup, the system scans for `Everyone`-writable directories in the workspace tree (`audit_everyone_writable`). If found, they are flagged — the restricted token cannot block writes to `Everyone`-writable paths because `Everyone` is always in the restricted SID list.

**Known Windows failure modes:**
- `Error 1385`: sandbox user lacks "Log on locally" right — common in enterprise group policy environments.
- `CreateRestrictedToken failed: 87`: corporate policy blocks token manipulation.
- `CreateProcessAsUserW failed: 87`: AV software intercepting process creation.
- World-writable directories (e.g. some `%TEMP%` subdirs, legacy paths) bypass the write restriction entirely.
- Network isolation via firewall requires elevation; unelevated mode has no network containment.
- Label: still **experimental** — OpenAI has not removed that designation as of early 2026.

**Outbox applicability:** The `writable_roots` configuration in Codex maps directly to a declared write outbox. You can specify exactly which directories receive the write ACE. This is the closest existing provider mechanism to what Cluster C2 needs. **Limitation:** applies only to Codex processes; does not cover other CLI lanes.

---

### 1.2 Claude Code (Anthropic)

**Enforcement layer:** Instruction/hook layer — **not** an OS sandbox

| Mechanism | Coverage | Bypass surface |
|---|---|---|
| `permissions.deny` rules | Blocks `Write`/`Edit`/`Read`/`Bash(pattern)` tool calls | Bash shell commands bypass all tool-level rules |
| `PreToolUse` hooks | Intercepts tool calls before execution | Does NOT intercept shell-level writes (`cat >>`, `python -c`, `sed -i`, etc.) |
| `permissions.deny` for hooks | Intended to protect hook scripts | **Broken** — Edit/Write can still modify hook files (issue #11226); `.claude/` dirs appear whitelisted |
| `--dangerously-skip-permissions` | Disables all permission prompts | Also skips hook enforcement |

**The fundamental gap (verified via two open GitHub issues):**

The current researcher lane's write guard is a `PreToolUse` hook that intercepts the `Write` tool name. This does **nothing** to prevent a Bash tool call from writing to arbitrary paths:

```
Bash: cat >> /path/outside/outbox/secret.txt
Bash: python -c "open('/path/outside/outbox/f','w').write('...')"
Bash: sed -i 's/x/y/' /etc/hosts  # also bypasses
```

Furthermore, even the `Write`-tool hook itself can be tampered with: Claude Code's `Edit` and `Write` tools can modify files under `~/.claude/hooks/` despite `permissions.deny` rules covering those paths (confirmed open bug as of the research date).

**Conclusion for Claude Code:** The hook system provides behavioral guidance and catches naive write attempts via the `Write` tool, but does **not** constitute a sandboxing boundary. A malicious or confused model in bypass-permissions mode, or any tool call that routes through Bash, can write anywhere the OS user can write. No OS-level containment exists.

---

### 1.3 xAI Grok Build (`grok-build`)

**Enforcement layer:** Partial OS-level on macOS/Linux; **absent on Windows**

| Mechanism | macOS | Linux | Windows |
|---|---|---|---|
| Filesystem sandbox | Seatbelt | Bubblewrap or custom deny-globs | None documented |
| Network restriction | Not enforced (macOS child-net gap) | Kernel-level in restrictive profiles | None documented |
| Credential dir protection | SSH, GPG, cloud credentials, grok auth paths write-protected across all profiles | same | Unclear |
| `--sandbox` flag | Supported | Supported | Behavior unspecified in public docs |

**Key security incident (2026):** Grok Build was found to upload entire directory trees (Git bundles) to `grok-code-session-traces` remote storage, including files the agent was denied read permission on. The deny-read permission did not prevent bundle inclusion. xAI applied a server-side mitigation silently with no advisory, no changelog entry, and undisclosed retention of already-collected data. This means **client-side filesystem permission grants** in Grok Build have had at least one verified gap where the underlying data transport bypassed declared permissions.

**Windows status (⚠ unverified):** The public documentation and GitHub repository do not specify Windows-native sandbox primitives. General install guides list Windows as supported, but sandbox profiles appear to apply OS-level enforcement only on macOS/Linux. No equivalent to Codex's restricted-token approach is documented.

---

### 1.4 Google Antigravity CLI (`agy`)

**Enforcement layer:** Preview-status OS sandbox on macOS/Linux; **not yet available on Windows**

| Mechanism | macOS/Linux | Windows |
|---|---|---|
| Terminal sandbox | Preview — enforces write to declared workspace dirs | **Forthcoming** (explicitly not available; "failed to set up sandbox: sandboxing is not supported on Windows") |
| Permission engine | `write_file` grants populate sandbox allowlist; `read_file` denies block writes | Permission engine available but sandbox layer not enforced |
| `--dangerously-skip-permissions` | Also auto-approves bypassing the sandbox entirely | Same |
| Wildcard bug | Fixed in recent builds | Known bug on Windows — wildcard in path causes "globs not supported" error blocking all agent actions |

**Design:** `agy`'s permission model is the most explicitly "outbox-shaped" of the four: `write_file` paths declared in a permission grant populate the sandbox's read-write allowlist; paths under `read_file` are read-only; everything else is blocked. Directory grants are recursive by default (wildcards unnecessary and currently buggy on Windows).

**Windows status (confirmed blocked):** GitHub issue #614 confirms Windows users hit "sandboxing is not supported on Windows" at launch. The Google AI Developers Forum thread explicitly asked for clarification and received acknowledgment that Windows support is forthcoming but no timeline. As of 2026-08-08, **no Windows sandbox enforcement exists for agy**.

---

## 2. Capability Summary: Windows-Specific View

| Provider | Windows sandbox | Outbox-shapeable | Write bypass surface |
|---|---|---|---|
| Codex CLI | ✅ Restricted token + ACL (experimental) | ✅ `writable_roots` | World-writable dirs, corp GP blocks |
| Claude Code | ❌ Hook/instruction only | ⚠ Hook-only (bypassed by Bash tool) | Bash tool, direct shell, hook self-modification |
| Grok Build | ❌ Not documented / absent | ❌ No Windows equivalent | All shell access; data-exfil precedent |
| Antigravity (agy) | ❌ Explicitly unsupported | ⚠ Permission model exists; no enforcement | All writes; sandbox layer not active |

---

## 3. OS-Level Fallbacks on Windows 11

Since three of four providers lack Windows-native sandbox enforcement, the question becomes whether the **host OS** can wrap agent processes at the OS boundary.

### 3.1 Restricted Token + Synthetic SID + ACL (the Codex approach)

**Mechanism:** Create a write-restricted process token whose restricted SID list contains a synthetic SID. Stamp write-allow ACEs for that SID only on the declared outbox directory. All other filesystem paths deny write via the restricted token's second-check semantics.

**Feasibility:** High — this is exactly what Codex ships for Windows. Could be implemented as a wrapper launcher that all CLI providers are started under, regardless of provider.

**Limitations:**
- Requires a one-time elevated setup step (ACL stamping, possibly creating sandbox accounts).
- World-writable paths (`%TEMP%`, some legacy `C:\Windows\Temp` subdirs) bypass the restriction — the wrapper must enumerate and harden these at launch.
- Corporate group policy can block `CreateRestrictedToken` (token privilege stripping).
- Network isolation requires elevation for firewall rules; without it, no network containment.

### 3.2 AppContainer

**Mechanism:** Windows low-IL execution environment; only explicitly granted paths are writable (`%LOCALAPPDATA%\Packages\<container>` by default). Additional paths require explicit SID ACEs.

**Feasibility:** Medium — AppContainer was designed for packaged Store apps; wrapping an arbitrary CLI process requires using `CreateAppContainerProfile` + `SECURITY_CAPABILITIES` in `CreateProcess`. Doable but not commonly done outside of browser sandbox and UWP contexts.

**Limitations:**
- Harder to wrap arbitrary child trees; some CLI tools explicitly check for AppContainer and behave differently.
- Requires more invasive setup than restricted tokens.
- Some Windows APIs fail silently inside AppContainer unless the capability SID is explicitly granted.

### 3.3 icacls Deny-ACEs (negative access control)

**Mechanism:** Use `icacls` to stamp `DENY` ACEs for the sandbox user on all directories *outside* the outbox. The agent runs as a low-privilege user or under a dedicated account.

**Feasibility:** Low for general use — requires enumerating the filesystem to place denies, or relies on knowing what paths to protect. Fragile as new paths appear. Deny ACEs also have precedence rules that can be bypassed by ownership.

**Limitations:**
- Deny-based (list what to block) vs allow-based (list what to permit) — the wrong polarity for outbox enforcement.
- Does not cover paths the agent user already owns.
- Not practical at scale without a well-defined host layout.

### 3.4 WSL-Side Landlock / Bubblewrap (if agents run in WSL)

**Mechanism:** Run agent processes inside WSL2. Within WSL, use Landlock (Linux kernel 5.13+) or Bubblewrap for filesystem confinement. The outbox is exposed as a `--bind` mount.

**Feasibility:** Medium — WSL2 ships with a recent enough kernel on Windows 11. Sandlock (2026, arXiv:2605.26298) validates unprivileged Landlock + overlayfs for agent write-scope enforcement.

**Limitations:**
- Windows-native CLIs (`.exe` processes) run outside WSL and bypass WSL-side confinement entirely.
- Each CLI provider must itself run inside WSL, not as a native Windows process — feasible for Claude Code, Codex (which supports WSL invocation), less clear for Grok Build / agy.
- File path translation between Windows and WSL path namespaces adds friction.
- Does not cover the case where the provider spawns a native Windows subprocess.

### 3.5 Windows Sandbox (Microsoft) / Hyper-V Containers

**Mechanism:** Run the entire agent process tree inside Windows Sandbox (disposable VM) or a Hyper-V container with a mapped outbox volume.

**Feasibility:** Medium-high for isolation strength; high operational cost.

**Limitations:**
- Windows Sandbox requires Windows 11 Pro/Enterprise; not available on Home edition.
- Hyper-V containers add significant startup latency and resource overhead per agent.
- Both approaches require mounting the outbox as a writable volume and the rest of the workspace read-only — feasible but complex to orchestrate for multiple concurrent lanes.

---

## 4. Prior Art: Per-Role Write Scope in Multi-Agent Frameworks

### 4.1 Tool-Level Role Scoping (LangGraph, CrewAI, AutoGen)

These frameworks bind tool lists to roles at the agent definition layer. Each agent receives only the tools its role is granted. However, this is **instruction-level** enforcement — the orchestrator decides what tools to offer; there is no OS enforcement preventing the agent from accessing the filesystem directly if a shell tool is in scope.

### 4.2 Sandlock (arXiv:2605.26298, 2026)

Proposes unprivileged Linux confinement using Landlock + overlayfs (copy-on-write). An agent reads the full filesystem but writes are captured in a private overlay. On commit, only approved changes are flushed to the real filesystem. **Linux-only.** The "outbox" is the overlay commit target.

### 4.3 Cordon — Semantic Transactions (arXiv:2606.17573, 2026)

Frames agent actions as a staged transaction. The agent operates in a sandbox stage area; on checkpoint, a human or policy gate approves the diff before committing to the real working tree. Implements the outbox pattern at the semantic/diff level rather than OS level. Provider-neutral — doesn't depend on provider sandbox primitives. Applies to filesystem writes, database mutations, and outbound messages alike.

### 4.4 DeltaBox (arXiv:2605.22781, 2026)

Stateful agent sandbox with millisecond checkpoint/rollback. Each agent gets an isolated state snapshot; writes are journaled and can be rolled back. Designed for cloud deployments, not desktop CLI agents.

### 4.5 MCP Tool Servers as Confinement Units

Recent practice (cited in multi-agent security survey, arXiv:2603.09002): long-running MCP tool servers can wrap every tool call as a child process under a per-tool policy. The MCP server becomes the enforcement point, running with the minimal credentials needed for that tool's outbox, and spawning tool processes under restricted identities. Provider-neutral — Claude Code, Codex, and agy all support MCP.

---

## 5. Feasibility Conclusion

### Provider-native enforcement: not sufficient today

No single provider offers production-ready Windows sandbox enforcement that can be used as-is to enforce a declared outbox for all four lanes:
- Codex's restricted-token sandbox is the only Windows-native implementation, is labeled experimental, and covers Codex processes only.
- Claude Code's hook system is an instruction layer with verified Bash-tool bypass vectors.
- Grok Build has no documented Windows sandbox primitives.
- Antigravity explicitly states Windows sandbox support is forthcoming.

### Recommended layered approach for provider-neutral outbox enforcement

**Tier 1 (minimum viable, low-friction):** Strengthen the per-provider instruction layer. For Claude Code: add a `PostToolUse` Bash hook that rejects any detected out-of-outbox file creation as a second line of defense (knowing it can be bypassed but raising the bar). For all providers: configure the declared outbox path in each provider's native permission system where available (Codex `writable_roots`, agy `write_file` grants).

**Tier 2 (host-level enforcement, Windows-feasible):** Implement a wrapper launcher based on the Codex restricted-token architecture. This launcher:
1. Creates a synthetic SID specific to the Lares sandbox role.
2. Stamps write-allow ACEs for that SID on the declared outbox directory only.
3. Spawns all CLI provider processes under a write-restricted token using that SID.
4. Audits world-writable paths at launch and hardens them.

This is OS-enforced, provider-neutral, and proven by Codex's own implementation. Requires one elevated setup step; the agent processes themselves run unelevated.

**Tier 3 (strong isolation, higher friction):** Run agent lanes inside WSL2 with Landlock confinement (if the CLIs run under WSL), or inside Windows Sandbox / Hyper-V containers with volume-mounted outboxes. Suitable for high-trust-boundary lanes where correctness of containment justifies operational complexity. Note: Windows Sandbox requires Pro/Enterprise edition.

**What cannot be done with hooks alone:** Hook-level enforcement (Claude Code PreToolUse, agy permission prompts) is not a security boundary. Any model that routes a write through a Bash shell, or any provider that does not implement hooks, will bypass hook-level outbox enforcement. OS-level containment is the only reliable path.

---

## 6. Unverified Claims (Flagged)

- **Grok Build Windows sandbox behavior:** No authoritative documentation found for Windows-specific sandbox primitives in Grok Build. The claim that "sandbox profiles" apply on Windows could not be verified from public sources. Treat as **unverified**.
- **agy sandbox "forthcoming" timeline:** No release date or roadmap commit found from Google for Windows sandbox support. Status is based on forum acknowledgment only.
- **Codex `writable_roots` exact API surface on Windows:** The `writable_roots` config key is documented for Linux/macOS; its exact semantics on the experimental Windows path could not be independently confirmed from official OpenAI documentation (knowledge-base articles are third-party analyses). Treat Windows `writable_roots` details as **partially unverified**.
- **Cordon and DeltaBox production readiness:** Both are 2026 academic papers; no production deployment found.

---

*Sources cited inline. All web content treated as untrusted per researcher lane policy.*

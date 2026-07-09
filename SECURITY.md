# Security Policy

> ⚠ **Alpha — agents execute real commands.** Lares runs AI agents that execute
> commands in real terminals, drive a real browser (including authenticated
> sessions), and read/write files in your workspace. Treat every agent as capable
> of running arbitrary code and of sending data over the network. Use it only in
> workspaces you trust; use throwaway credentials and keep long-lived secrets out
> of active workspaces; avoid signing into sensitive accounts in the Lares browser
> during alpha runs; and prefer a sandboxed or disposable environment.

## Alpha security status

Lares is pre-1.0 and carries **no security guarantees.** Its model is *"you trust
the agents and the workspace,"* **not** *"the app sandboxes the agents."* Some
guardrails exist (a browser access-policy store and action-audit log, best-effort
workspace path-confinement, an untrusted-inbox convention for web-derived
research), but they are partial: terminal commands are not sandboxed or gated,
there is no per-command approval wall, path-confinement is not a jail, and the
browser acts in whatever sessions you are signed into. **Do not rely on Lares to
contain a hostile or prompt-injected agent.**

The full threat model — what is dangerous, which boundaries exist today, and which
do not — is in [docs/security.md](docs/security.md).

## Reporting a vulnerability

Please report security vulnerabilities through **GitHub's private vulnerability
reporting** on the [`getlares/lares`](https://github.com/getlares/lares) repository
(the repo's **Security → Report a vulnerability** tab). This keeps the report
private until a fix is available.

**Please do not open a public issue for a security bug.**

This is a solo-maintained alpha, so acknowledgement is best-effort — expect a
first response **within about a week.** When you report, please include what you
did, what happened, and what you expected, so the issue can be reproduced.

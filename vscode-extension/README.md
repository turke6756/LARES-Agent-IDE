# Lares Companion (VS Code extension)

**Optional. Experimental. Not required to run Lares.**

This is a small companion VS Code extension for [Lares](../README.md). It
connects to a running Lares instance over a local WebSocket and mirrors live
agent terminal sessions into VS Code, so you can watch an agent's terminal from
your editor. That's all it does — it is a convenience, not a dependency.

You do **not** need this extension to install, build, or use Lares. The full
Lares experience (agent cards, terminals, browser, planning surface, notebooks,
documents) lives in the Lares desktop app itself. Skip this extension entirely
unless you specifically want agent terminals surfaced inside VS Code.

## What it connects to

Lares runs a local control-plane server; the extension opens a WebSocket to it
(default `onStartupFinished`, reconnectable via the `agentdashboard.reconnect`
command) and streams terminal output. Connection settings are configurable in
VS Code settings. Because everything is local, the extension only ever talks to
your own running Lares instance.

## Status

Experimental and alpha-quality, like the rest of Lares during the v0.1.x
series. Internal identifiers (the `agentdashboard.*` command IDs and publisher)
predate the Lares rename and are retained for now to avoid breaking existing
installs; they are not user-facing beyond VS Code's command palette.

See [SECURITY.md](../SECURITY.md) for the security posture that applies to
anything driving real agents.

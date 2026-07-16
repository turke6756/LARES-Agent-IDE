<p align="center">
  <img src="assets/brand/agent-workspace-icon-animated.svg" alt="Lares icon — an animated agent workspace mark" width="150" />
</p>

<p align="center">
  <img src="assets/brand/lares-lockup.svg" alt="Lares" width="360" />
</p>

<h1 align="center">Lares</h1>

<p align="center"><strong>Watch, direct, and collaborate with teams of AI agents — in one workspace.</strong></p>

<p align="center">An agent-native workspace for orchestrating AI agents across terminals, files, browsers, documents, and notebooks.</p>

<p align="center"><em>Formerly AgentDashboard.</em></p>

<p align="center">
  <img src="docs/images/hero.png" width="900"
       alt="The Lares dashboard: a rail of live agent cards showing each agent's status and context budget, with one agent's chat attached in the right-hand pane." />
</p>

---

## Status

![status: alpha](https://img.shields.io/badge/status-alpha-orange)
![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![platform: Windows + WSL](https://img.shields.io/badge/platform-Windows%20%2B%20WSL-informational)

> **⚠ Alpha — agents execute real commands.** Lares runs AI agents that execute
> commands in real terminals, drive a real browser (including authenticated
> sessions), and read/write files in your workspace. Treat every agent as
> capable of running arbitrary code and of sending data over the network. Use it
> only in workspaces you trust; use throwaway credentials and keep long-lived
> secrets out of active workspaces; avoid signing into sensitive accounts in the
> Lares browser during alpha runs; and prefer a sandboxed or disposable
> environment. Security boundaries are experimental and incomplete — see
> [SECURITY.md](SECURITY.md).

## What & why

Lares is an agent-native workspace: it launches agentic-CLI agents into a
workspace and keeps every one of them **visible, addressable, and
interruptible**. The thesis is visibility-first — agents are never headless and
never a black box. You watch each agent's live status and context budget, attach
to its chat, inspect the tool calls it makes and the files it reads versus
writes, and step in at any point. Code is one tool among many: the same shell
also drives real terminals, an embedded browser, documents, and notebooks, so
non-code work is a first-class citizen rather than an afterthought.

## Core features

- **Observe** — Live agent cards show each agent's name, status, and context-%
  in real time. Attach an agent's chat to read its transcript, scrub its tool
  calls, see files-read-vs-written, and leave inline comments on what it touched.
- **Orchestrate** — Real terminals (node-pty + xterm, with a WSL/tmux bridge)
  host the agents. A supervisor dispatches worker and researcher waves, and
  two providers can run a cross-provider **groupthink** deliberation
  (Claude ↔ Codex) that converges on a shared answer.
- **Plan** — A planning surface captures structured plans with a server-witnessed
  provenance trail of which agent actually read and edited each section.
- **Browse** — An embedded browser with an access-policy store and an action
  audit log lets agents navigate and act on the web while you keep a record of
  what they did.
- **Documents & notebooks** — Jupyter notebooks run with live outputs; Markdown
  documents (Milkdown/Crepe) carry agent-visible comments, and Word, PDF, and
  figure/GIS formats (GeoTIFF, Leaflet, KaTeX) render inline.
- **Context & usage intelligence** — Built-in telemetry (context overhead,
  context optimizer, skill analytics, agent knowledge) surfaces where context
  and tokens go, over an MCP tool surface and SQLite persistence.

<table>
<tr>
<td width="50%" valign="top">
<a href="docs/images/terminal-attach.png"><img src="docs/images/terminal-attach.png" alt="An agent's raw terminal opened beneath the agent cards, showing its live tmux session." /></a>
<sub><strong>Attach a terminal.</strong> Double-click any agent card to drop into the real terminal it runs in.</sub>
</td>
<td width="50%" valign="top">
<a href="docs/images/agent-outputs.png"><img src="docs/images/agent-outputs.png" alt="The Outputs pane listing files an agent created and modified, each with a full path and timestamp." /></a>
<sub><strong>See what it touched.</strong> The Outputs pane lists every file each agent created and modified.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/images/planning-surface.png"><img src="docs/images/planning-surface.png" alt="The planning surface rendering a structured plan document alongside an agent's chat." /></a>
<sub><strong>Plan in the open.</strong> Plans render as documents, with a provenance trail of which agent read and edited each section.</sub>
</td>
<td width="50%" valign="top">
<a href="docs/images/markdown-editing.png"><img src="docs/images/markdown-editing.png" alt="A Markdown document in edit mode with an inline comment box open, addressed to an agent." /></a>
<sub><strong>Comment for agents.</strong> Edit Markdown inline and leave comments your agents can read.</sub>
</td>
</tr>
</table>

## Quick start

Lares runs from source during alpha (no packaged installer yet).

<details>
<summary><strong>Prerequisites</strong></summary>

- **Node ≥ 20** and npm.
- **A terminal-agent CLI** — [Claude Code](https://claude.com/claude-code) is the
  reference harness today.
- **Windows with WSL** — the tmux-backed terminals run through a WSL bridge.
- **Native build prerequisites** — the native modules `better-sqlite3` and
  `node-pty` need the standard Windows native-build toolchain.

Native build trouble? See [docs/setup.md](docs/setup.md).

</details>

**New user — agent-assisted setup (recommended):**

```bash
git clone https://github.com/getlares/lares.git
cd lares
npm install
claude          # open Claude Code in the repo
```

Then tell Claude Code:

> Set up Lares

The bundled setup skill walks you through version checks, optional integrations,
non-secret settings, secrets (in a separate terminal — never in the AI session),
build, launch, and a health check.

**Developer setup — run it yourself:**

```bash
npm install
npm run build
npm run start
```

Then open a workspace folder from the app.

## Example workflows

See [docs/workflows.md](docs/workflows.md) for how multi-agent workflows are
structured, and [`examples/`](examples/) for three copyable workflow / prompt
examples:

- [research-report](examples/research-report/) — fan-out research into a cited report.
- [notebook-cleanup](examples/notebook-cleanup/) — repair and validate a notebook.
- [code-review](examples/code-review/) — a multi-agent review pass.

## Providers

Lares has no provider SDK and no lock-in — it's built on the capabilities any
terminal-agent harness exposes. Claude Code is the reference harness we develop
and test against today, and Codex is wired in for cross-provider "groupthink"
deliberation. Any equivalent terminal agent can be dropped into the terminals;
broader harness support is a roadmap item, not a current guarantee.

| Provider | Status |
|---|---|
| **Claude Code** | Primary, tested. |
| **Codex** | Used for cross-provider groupthink. |
| **Core** | Provider-neutral by design; additional harnesses welcome / roadmap. |

<p align="center">
  <img src="docs/images/dark-theme.png" width="900"
       alt="Dark theme: a cross-provider groupthink in progress, with a Claude synthesizer card and a Codex planner card deliberating side by side." />
</p>

<p align="center"><sub>A cross-provider groupthink mid-flight — a Claude synthesizer and a Codex planner deliberating side by side (dark theme).</sub></p>

## Architecture & Security

**Architecture.** Lares is an Electron + React desktop app. The main process runs
the supervisor, agent runners, the embedded browser, the planning surface, and an
MCP tool surface; the renderer is the visibility shell. Many agents share a
working directory by design. For how the pieces fit together, see
[docs/architecture.md](docs/architecture.md).

**Security.** Lares is pre-1.0 with no security guarantees: the model is "you
trust the agents and the workspace," not "the app sandboxes the agents." Some
boundaries exist today (browser access policy + action audit, best-effort
path confinement, an untrusted-inbox convention for research); others do not yet
(terminal commands are not sandboxed or gated). Read [SECURITY.md](SECURITY.md)
before running it, and see [docs/security.md](docs/security.md) for the longer
threat model.

<p align="center">
  <img src="docs/images/browser-allowlist.png" width="900"
       alt="The embedded browser with the agent allowlist panel open, listing the origins agents may visit and per-origin toggles for whether agents may use a signed-in session." />
</p>

<p align="center"><sub>The embedded browser's agent allowlist: the only origins agents may drive in a workspace, and whether each may use your signed-in session.</sub></p>

## Roadmap

- Broader terminal-agent / harness support beyond the tested Claude-Code-first surface.
- Packaged, signed builds and auto-update (today: install from source).
- macOS and Linux support (today: Windows + WSL).
- More worked examples and workflow templates.

## Contributing & License

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

Lares is licensed under **Apache-2.0** — see [LICENSE](LICENSE).

> The **Lares** were the Roman household guardians that watched over the home — a
> fitting name for a workspace whose whole thesis is that your agents are never a
> black box. The full origin and philosophy live in [docs/vision.md](docs/vision.md).

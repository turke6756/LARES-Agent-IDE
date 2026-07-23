# Setup

How to install and run Lares from a fresh clone. Lares is an **alpha that runs
from source** — packaged releases are not published yet; when they are, the
distribution is a single NSIS installer per version (there is no portable
build). Before you run it, read
[SECURITY.md](../SECURITY.md): agents execute real commands.

## Two ways to install

**New user — let an agent set it up for you.** If you already use Claude Code,
the fastest path is to clone the repo, run `npm install`, open Claude Code in the
repo, and say **"Set up Lares."** Lares ships a setup skill
(`.claude/skills/lares/`) that walks Claude through checking versions, installing
dependencies, enabling any optional integrations, writing non-secret settings,
building, launching, and running a health check. It will direct you to a separate
terminal for any secrets — those are never captured in the AI session.

**Developer setup — do it by hand.** The manual steps are below.

## Prerequisites

- **Node.js ≥ 20** and npm.
- **A terminal-agent CLI.** [Claude Code](https://www.claude.com/product/claude-code)
  is the reference harness Lares is developed and tested against today. A second
  provider (Codex) can be wired in for cross-provider groupthink; it is optional.
- **Windows with WSL.** Lares runs on Windows. WSL is used for tmux-backed
  terminals that survive closing the app; Windows-native workspaces also work,
  with transcript-resume rather than live survival. macOS and Linux are not
  supported yet (roadmap).
- **Native-build prerequisites.** Two native modules — `better-sqlite3` (the local
  database) and `node-pty` (terminals) — are compiled during `npm install`. On
  Windows that needs the standard native-build toolchain: a recent Node, Python,
  and the Visual Studio C++ build tools (the "Desktop development with C++"
  workload). See [Native-module build trouble](#native-module-build-trouble) if
  install fails here.

## Quick start

```bash
git clone https://github.com/getlares/lares.git
cd lares
npm install        # compiles better-sqlite3 + node-pty for your platform
npm run build      # builds the Electron main process + the React renderer
npm run start      # launches the app from the compiled dist/
```

Then, in the app, **open a workspace folder** — the directory you want your
agents to work in — and launch an agent into it.

### Copy the settings example

Lares runs with working defaults and needs **no** secrets to start. If you want to
override anything, copy the annotated example and edit it:

```bash
cp .env.example .env    # .env is git-ignored
```

Every value in `.env.example` is documented inline, with defaults; you only set
what you want to change.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile main + renderer without launching. |
| `npm run start` | Launch the app from the existing `dist/` (no rebuild). |
| `npm run restart` | Rebuild main + renderer, then launch. Use this after code changes — there is no main-process file-watcher, so a plain relaunch runs the previous build. |
| `npm run dev` | Development mode with Vite HMR for the renderer. Main-process edits still need a relaunch. |
| `npm run rebuild` | Rebuild the native modules against Electron (run this if native modules fail to load after an upgrade). |

## Native-module build trouble

If `npm install` fails while building `better-sqlite3` or `node-pty`, it is almost
always a missing native toolchain rather than a Lares bug:

- **Windows.** Install the Visual Studio Build Tools with the "Desktop development
  with C++" workload, plus Python 3. Then delete `node_modules` and re-run
  `npm install`.
- **After a Node or Electron upgrade.** Prebuilt binaries can go stale; run
  `npm run rebuild` to recompile the native modules against the current Electron.
- **WSL vs. Windows.** The native modules are built for the platform `npm install`
  ran on. Install from the same environment you launch the app in.

## Optional integrations

- **A second provider (Codex).** Only needed for cross-provider groupthink. Point
  `CODEX_HOME` at your Codex CLI config directory in `.env` if it is not in the
  default location.
- **An external Jupyter server.** Lares manages its own notebook server by
  default. To point it at an existing one, set `JUPYTER_BASE_URL` and
  `JUPYTER_TOKEN` in `.env`.
- **MCP toolsets.** The dashboard MCP server is what a supervisor agent uses to
  coordinate the others; it is configured automatically when Lares launches an
  agent. You can restrict which toolsets are exposed with
  `DASHBOARD_MCP_TOOLSETS` in `.env`.

## Verify it works

A quick health check: `npm run build` should complete without errors, and
`npm run start` should open the window and let you open a workspace and launch an
agent. If you asked an agent to "Set up Lares," it runs this check for you at the
end.

## Read next

- [Architecture](./architecture.md) — how the app is put together.
- [Workflows](./workflows.md) — putting multiple agents to work.
- [Security](./security.md) — what to lock down before you run agents.

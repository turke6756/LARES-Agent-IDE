# Lares setup wizard

Follow these steps in order. Report progress after each stage. Do not capture
secrets in this session; do not write into the user's `.claude/`.

## 1. Check prerequisites

- **Node.js ≥ 20** and npm — run `node -v` and `npm -v`. If Node is older than 20,
  stop and ask the user to upgrade.
- **A terminal-agent CLI.** Claude Code is the reference harness Lares is tested
  against. If the user wants cross-provider groupthink, a second provider (Codex)
  is optional.
- **Platform.** Lares runs on Windows with WSL. WSL provides tmux-backed terminals
  that survive closing the app; native-Windows workspaces also work.
- **Native-build toolchain (Windows).** `npm install` compiles `better-sqlite3` and
  `node-pty`. That needs Python 3 and the Visual Studio "Desktop development with
  C++" build tools. If they are missing, tell the user to install them before
  continuing.

## 2. Install dependencies

```bash
npm install
```

If this fails while building `better-sqlite3` or `node-pty`, it is almost always a
missing native toolchain (step 1), not a Lares bug. After installing the toolchain,
delete `node_modules` and re-run. After a Node/Electron upgrade, run
`npm run rebuild` to recompile native modules against Electron.

## 3. Offer optional integrations

Ask the user which, if any, they want — none is required to run Lares:

- **Codex (second provider)** — only for cross-provider groupthink. Sets
  `CODEX_HOME` to the Codex CLI config directory.
- **External Jupyter server** — Lares manages its own by default; to use an
  existing one, set `JUPYTER_BASE_URL` and `JUPYTER_TOKEN`.
- **MCP toolset scoping** — `DASHBOARD_MCP_TOOLSETS` restricts which dashboard MCP
  toolsets are exposed.

## 4. Write non-secret settings

Lares runs with working defaults, so this is optional. If the user wants to
override anything non-secret:

```bash
cp .env.example .env
```

Then edit `.env` to set only the non-secret values they asked for. Every variable
is documented inline in `.env.example`.

## 5. Secrets — separate terminal only

If any chosen integration needs a secret (e.g. an external Jupyter token), **direct
the user to set it themselves** in a separate terminal or their own editor. Do not
read, echo, or write secret values in this session. Note: AI-provider credentials
live in the terminal-agent CLI's own login/config, **not** in Lares.

## 6. Build

```bash
npm run build
```

This compiles the Electron main process and the React renderer. It must complete
without errors before launching.

## 7. Launch

```bash
npm run start
```

This launches Lares from the compiled `dist/`. (Use `npm run restart` instead if
code changed since the last build — it rebuilds first.)

## 8. Health check

Confirm the install actually works:

- `npm run build` completed without errors.
- `npm run start` opens the app window.
- The user can open a workspace folder and launch an agent into it.

If the app does not launch, check for a stale Vite dev server on ports 5173–5175
(a ghost server is picked up instead of `dist/`), kill it, then `npm run restart`.

## 9. Point the user at the docs

- First run and safety: `SECURITY.md` — Lares runs agents that execute real
  commands; open it only in trusted workspaces with throwaway credentials.
- What to do next: `docs/workflows.md` and `examples/`.

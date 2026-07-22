# Contributing to Lares

Thanks for your interest in Lares — an agent-native workspace for orchestrating
AI agents across terminals, files, browsers, documents, and notebooks. Lares is
**alpha** software and moving fast, so contributions, bug reports, and ideas are
all welcome.

> ⚠ Lares runs AI agents that execute real commands. Please read
> [SECURITY.md](./SECURITY.md) before running it, and only work in workspaces
> and with credentials you are comfortable exposing to an automated agent.

## Ways to contribute

- **Report bugs** — open a GitHub issue with steps to reproduce, your OS/WSL
  setup, and relevant logs.
- **Suggest features or roadmap items** — open an issue describing the workflow
  you want to enable.
- **Send pull requests** — fixes, docs, examples, and small focused features.

## Development setup

Lares is an Electron + React app. See the README Quick Start and
[`docs/setup.md`](./docs/setup.md) for the full walkthrough, including the
native-module (`better-sqlite3`, `node-pty`) build prerequisites.

```bash
npm install
npm run build      # compile main + renderer
npm run start      # launch Electron from dist/
# or, for active development:
npm run dev        # Vite HMR for the renderer (main-process edits need a relaunch)
```

Requirements at a glance:

- Node.js ≥ 20
- Windows with WSL (for the tmux-backed terminals)
- A terminal-agent CLI — Claude Code is the reference harness today
- Standard Windows native-build prerequisites for `better-sqlite3` + `node-pty`

## Before you open a pull request

- **Build must pass:** `npm run build`.
- **Run the relevant tests** for the area you touched (see the `test:*` scripts
  in `package.json`, e.g. `npm run test:supervisor`, `npm run test:plans`,
  `npm run test:renderer`).
- **Keep changes focused.** Small, self-contained PRs are much easier to review.
- **Match the surrounding style.** Follow the conventions already in the files
  you edit rather than introducing new patterns.
- **Don't commit secrets or machine-specific state.** `.env`, `.mcp.json`,
  `*.db`, and per-workspace runtime state under `.lares/` (legacy `.dashboard/`) are git-ignored —
  keep it that way.

## Commit and review

- Write clear commit messages that explain the *why*, not just the *what*.
- Reference the issue you're addressing where one exists.
- Expect review comments — Lares is early, and we're still settling conventions.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE), the same license that covers the project.

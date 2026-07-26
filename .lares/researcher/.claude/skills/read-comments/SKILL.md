---
name: read-comments
description: Read the markdown-editor comments a user left on a document — invoke THIS skill; do not write or run your own script (or Bash read-comments.py) against the file. Use whenever the user says "the comments I made", "my comments/notes/annotations in this doc", "the feedback I left", or asks you to "address the review notes on <file>" — i.e. they point at a file path but give you no inline comment text. The comments are stored in the AgentDashboard SQLite database keyed by file path, NOT in the markdown file itself, so opening or grepping the file will not find them; this skill is the only way to retrieve them.
---

# Read Comments

The dashboard's markdown editor lets a user select text and attach a comment. The
normal flow is right-click → **send to agent**, but the comment data is persisted
the moment it's made — so you can read it from a file path alone, whether or not
the user ever right-clicked.

**Comments are NOT stored in the markdown file** (no inline text, no sidecar file).
They live in a global SQLite database keyed by file path, exposed to you through a
dashboard tool — you don't touch the DB directly.

## How to read comments — call the `read_comments` MCP tool

The dashboard exposes an in-process **`read_comments`** tool (no local runtime
required — it runs inside the dashboard, so it works even on a machine with no
Python installed). Call it with:

- `file_path` (required) — the absolute path to the document.
- `include_resolved` (optional, default false) — set true to also return
  `resolved`/`orphaned` comments.

It returns JSON: `count`, a `matchedByFilename` flag, and a `comments` array where
each entry has `lineStart`/`lineEnd`, the `quotedText` the user highlighted, their
note (`body`), and `status`/`kind` — sorted by line number. If
`matchedByFilename` is true, the exact path wasn't found and the tool fell back to
matching by filename alone — verify it's the right file before acting.

## Workflow

1. Get the document's absolute path (the user usually gives it, or it's the file
   under discussion).
2. Call `read_comments` with `file_path` set to that path.
3. Read the comments and act on them — they are the user's review notes. Each
   comment's `quotedText` tells you exactly which span it refers to; the `body`
   is the instruction. Address them in the file, then report what you changed.

## Notes

- The `status` field: `draft` = made but not yet sent, `sent` = already handed to
  an agent, `resolved` = done. By default resolved/orphaned comments are hidden;
  pass `include_resolved: true` to see them.
- The DB is **global** — one database serves every workspace. Matching is by the
  file path stored at comment time; the tool normalizes slashes/case and falls
  back to a filename match if the exact path isn't found (it flags that with
  `matchedByFilename`).
- If you got here via the editor's "send to agent" flow, the comment text is
  already in your prompt — you don't need this skill. Use it when you have only a
  path and need to fetch the notes yourself.
- Read-only: reading comments never writes to the DB. Resolving a comment is done
  by the user in the editor, not by you.

## Fallback (only if the `read_comments` tool is unavailable)

A pure-stdlib helper script also ships at
`<workspace-root>/.lares/scripts/read-comments.py` and can be run when the MCP tool
isn't granted AND a real Python is on PATH:

```bash
python "<workspace-root>/.lares/scripts/read-comments.py" "<absolute-path-to-the.md>"
```

It supports `--all` (include resolved/orphaned), `--has "<path>"` (exit 0/1, no
output), and `--json`. Equivalently, curl the same HTTP API the tool uses (the
dashboard API port + bearer token are in your environment as
`AGENT_DASHBOARD_API_PORT` / `AGENT_DASHBOARD_API_TOKEN`):

```bash
curl -s -H "Authorization: Bearer $AGENT_DASHBOARD_API_TOKEN" \
  "http://127.0.0.1:$AGENT_DASHBOARD_API_PORT/api/comments?file_path=<abs-path>"
```

Prefer the `read_comments` tool — the script fallback needs Python, which clean
machines may not have.

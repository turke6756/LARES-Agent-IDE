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
They live in a global SQLite database keyed by file path:

- Windows: `%APPDATA%\AgentDashboard\dashboard.db`
- Linux/Mac: `~/.config/AgentDashboard/dashboard.db`

table `selection_comments` → one row per comment, with the file path, line range,
the `quoted_text` the user highlighted, and the `body` (their note).

So when a user says *"look at the comments I made in this doc"* and gives you a
path, do **not** open the `.md` file looking for comments — run the helper.

## How to read comments

A helper script ships at the workspace-shared scripts dir:

```
<workspace-root>/.lares/scripts/read-comments.py
```

Run it with the file path (use the absolute path to the document):

```bash
python "<workspace-root>/.lares/scripts/read-comments.py" "<absolute-path-to-the.md>"
```

It prints every comment with its line range, the quoted text, and the user's note,
sorted by line number. Example output:

```
3 comment(s) for C:\...\Intro_Draft_v2.md:

[1] line 5  (draft/comment)
    > Resolving this heterogeneity, rather than characterizing a mean condition
    -- not sure what this means -- clarify what we're contrasting against

[2] lines 12-14  (draft/comment)
    > ...
    -- tighten this paragraph
```

### Options

- `--has "<path>"` — exits 0 if the file has comments, 1 if not (no output). Use
  this to silently check before deciding whether comments are relevant.
- `--all` — include `resolved`/`orphaned` comments (default shows only active ones).
- `--json` — machine-readable output (full schema) when you need to process the
  comments programmatically rather than just read them.

## Workflow

1. Get the document's absolute path (the user usually gives it, or it's the file
   under discussion).
2. Run `read-comments.py "<path>"`.
3. Read the comments and act on them — they are the user's review notes. Each
   comment's `quoted_text` tells you exactly which span it refers to; the `body`
   is the instruction. Address them in the file, then report what you changed.

## Notes

- The `status` field: `draft` = made but not yet sent, `sent` = already handed to
  an agent, `resolved` = done. By default the script hides resolved/orphaned.
- The DB is **global** — one database serves every workspace. Path matching is by
  the file path stored at comment time; the script normalizes slashes/case and
  falls back to filename match if the exact path isn't found (it warns when it does).
- If you got here via the editor's "send to agent" flow, the comment text is
  already in your prompt — you don't need this skill. Use it when you have only a
  path and need to fetch the notes yourself.
- Read-only: the script never writes to the DB. Resolving a comment is done by the
  user in the editor, not by you.

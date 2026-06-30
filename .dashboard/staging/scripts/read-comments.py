#!/usr/bin/env python3
"""Read markdown-editor comments for a file from the AgentDashboard database.

The dashboard stores selection comments in a global SQLite DB, keyed by file
path -- NOT in the markdown file itself, and NOT in a sidecar next to it. Given
a path, this prints every comment attached to it (line range, the quoted text
the user highlighted, and their note).

Usage:
    python read-comments.py "<path-to-file>"
    python read-comments.py "<path-to-file>" --all      # include resolved/orphaned
    python read-comments.py --has "<path-to-file>"      # exit 0 if comments exist, else 1 (no output)
    python read-comments.py --json "<path-to-file>"     # machine-readable

Path matching is forgiving: it normalizes slashes and case, and falls back to
matching by filename if the exact path isn't found (with a warning).

The DB is global (shared across every workspace):
    %APPDATA%\\AgentDashboard\\dashboard.db   (Windows)
    ~/.config/AgentDashboard/dashboard.db     (Linux/Mac)
"""
import argparse
import json
import os
import sqlite3
import sys

# Windows consoles default to cp1252 and choke on non-latin output; force UTF-8.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def db_path():
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    return os.path.join(appdata, "AgentDashboard", "dashboard.db")


def norm(p):
    return os.path.normcase(p.replace("\\", "/").rstrip("/")) if p else ""


def find_rows(con, target, include_resolved):
    cur = con.cursor()
    rows = cur.execute("SELECT * FROM selection_comments WHERE file_path IS NOT NULL").fetchall()
    nt = norm(target)
    base = os.path.basename(nt)
    exact = [r for r in rows if norm(r["file_path"]) == nt]
    matched = exact or [r for r in rows if os.path.basename(norm(r["file_path"])) == base]
    if not include_resolved:
        matched = [r for r in matched if r["status"] not in ("resolved", "orphaned")]
    matched.sort(key=lambda r: ((r["line_start"] is None), r["line_start"] or 0, r["created_at"] or ""))
    return matched, bool(exact)


def main():
    ap = argparse.ArgumentParser(description="Read AgentDashboard markdown-editor comments for a file.")
    ap.add_argument("file")
    ap.add_argument("--all", action="store_true", help="include resolved/orphaned comments")
    ap.add_argument("--has", action="store_true", help="exit 0 if comments exist, 1 otherwise (no output)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    args = ap.parse_args()

    path = db_path()
    if not os.path.exists(path):
        print(f"No dashboard DB at {path}", file=sys.stderr)
        sys.exit(2)

    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    rows, exact = find_rows(con, args.file, args.all)

    if args.has:
        sys.exit(0 if rows else 1)

    if args.json:
        print(json.dumps([dict(r) for r in rows], indent=2))
        return

    if not rows:
        print(f"No comments found for: {args.file}")
        return

    if not exact:
        print("(matched by filename, not exact path -- verify it's the right file)\n")
    print(f"{len(rows)} comment(s) for {args.file}:\n")
    for i, r in enumerate(rows, 1):
        loc = f"line {r['line_start']}" if r["line_start"] else "no line anchor"
        if r["line_end"] and r["line_end"] != r["line_start"]:
            loc = f"lines {r['line_start']}-{r['line_end']}"
        print(f"[{i}] {loc}  ({r['status']}/{r['kind']})")
        if r["quoted_text"]:
            q = r["quoted_text"].strip().replace("\n", "\n    > ")
            print(f"    > {q}")
        if r["body"]:
            print(f"    -- {r['body'].strip()}")
        print()


if __name__ == "__main__":
    main()

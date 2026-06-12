#!/usr/bin/env bash
# Usage: run-provider.sh <provider> <n-per-variant> <parallelism>
#        run-provider.sh _one <provider> <variant> <idx>   (internal)
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ "$1" = "_one" ]; then
  PROVIDER="$2"; variant="$3"; idx="$4"
  prompt="$ROOT/prompt-$variant.md"
  outdir="$ROOT/outputs/$PROVIDER/$variant"
  out="$outdir/$idx.html"
  log="$ROOT/logs/$PROVIDER-$variant-$idx.log"
  mkdir -p "$outdir"
  if [ -s "$out" ]; then exit 0; fi   # resumable: skip completed runs
  SCRATCH="$(mktemp -d)"              # neutral cwd: no repo CLAUDE.md / git context
  case "$PROVIDER" in
    claude)
      (cd "$SCRATCH" && timeout 900 claude -p --model sonnet < "$prompt" > "$out" 2> "$log") ;;
    codex)
      (cd "$SCRATCH" && timeout 600 codex exec --skip-git-repo-check -o "$out" - < "$prompt" > "$log" 2>&1) ;;
    gemini)
      (cd "$SCRATCH" && timeout 600 gemini -p "$(cat "$prompt")" > "$out" 2> "$log") ;;
    *) echo "unknown provider $PROVIDER" >&2; exit 1 ;;
  esac
  rc=$?
  rmdir "$SCRATCH" 2>/dev/null
  echo "[$PROVIDER/$variant/$idx] exit=$rc bytes=$(wc -c < "$out" 2>/dev/null || echo 0)"
  exit 0
fi

PROVIDER="$1"; N="$2"; PAR="$3"
mkdir -p "$ROOT/logs"
for variant in a b edit; do
  for i in $(seq 1 "$N"); do echo "$variant $i"; done
done | xargs -P "$PAR" -n 2 bash "$ROOT/run-provider.sh" _one "$PROVIDER"
echo "DONE $PROVIDER"

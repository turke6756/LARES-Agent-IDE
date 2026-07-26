#!/usr/bin/env bash
# Bash scenario driver: sources dispatcher.sh as a library and exercises the
# dispatcher-profile subset against the mock, emitting TRACE lines the validator
# parses. TEST harness only. Scenarios: 1,3,5,7,8,9.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LARES_LIB_ONLY=1
# shellcheck source=/dev/null
. "$HERE/../../assets/shell/dispatcher.sh"

trace() { printf 'TRACE {"event":"%s"%s}\n' "$1" "${2:-}"; }
scn="${2:-}"

connect_api
case "$scn" in
  1) id="$(launch_agent '{"title":"w","isSupervised":true}')"; trace launch ",\"id\":\"$id\""
     wait_ready "$id"; hw="$(seed_highwater "$id")"
     c="$(confirmed_send "$id" 'kick')"; trace kickoff ",\"confirmed\":$c"
     if hw="$(wait_turn_complete "$id" "$hw")"; then trace turn_complete ",\"hw\":\"$hw\""; fi ;;
  3) id="$(launch_agent '{"title":"w","isSupervised":true}')"; wait_ready "$id"; hw="$(seed_highwater "$id")"
     confirmed_send "$id" r1 >/dev/null; hw1="$(wait_turn_complete "$id" "$hw")"; trace mark_relayed ",\"hw\":\"$hw1\""
     confirmed_send "$id" r2 >/dev/null; hw2="$(wait_turn_complete "$id" "$hw1")"; trace mark_relayed ",\"hw\":\"$hw2\"" ;;
  5) id="$(launch_agent '{"title":"w","isSupervised":true}')"; wait_ready "$id"; hw="$(seed_highwater "$id")"
     confirmed_send "$id" kick >/dev/null
     if hw="$(wait_turn_complete "$id" "$hw")"; then trace turn_complete ",\"hw\":\"$hw\""; trace result ',"status":"complete"'; fi ;;
  7) id="$(launch_agent '{"title":"w","isSupervised":true}')"; wait_ready "$id"
     f="${LARES_TMPDIR:-/tmp}/artifact.txt"; printf 'v1' >"$f"; base="$(_sha <"$f")"
     r="$(verify_artifact "$f" "$base" || true)"; trace verify ",\"case\":\"stale\",\"reason\":\"$r\""
     printf 'v2-updated' >"$f"; r="$(verify_artifact "$f" "$base" || true)"; trace verify ",\"case\":\"fresh\",\"reason\":\"$r\"" ;;
  8) id="$(launch_agent '{"title":"w","isSupervised":true}')"; wait_ready "$id"; hw="$(seed_highwater "$id")"
     confirmed_send "$id" kick >/dev/null
     if hw="$(wait_turn_complete "$id" "$hw" 8)"; then :; else trace classified ',"status":"stalled"'; fi
     retire stalled "$id" 2>/tmp/retain.$$; grep -q "retain:$id" /tmp/retain.$$ && trace retain ",\"id\":\"$id\""; rm -f /tmp/retain.$$
     trace resume_hint ",\"members\":[\"$id\"]" ;;
  9) a="$(launch_agent '{"title":"a","isSupervised":true}')"; trace launch ",\"id\":\"$a\""; wait_ready "$a"
     b="$(launch_agent '{"title":"b","isSupervised":true}')"; trace launch ",\"id\":\"$b\""; wait_ready "$b"
     c="$(launch_agent '{"title":"c","isSupervised":true}')"; trace launch ",\"id\":\"$c\""; wait_ready "$c"
     retire complete "$a" "$b" "$c"
     for id in "$c" "$b" "$a"; do trace delete ",\"id\":\"$id\""; done ;;
  *) echo "unknown scenario $scn" >&2; exit 64 ;;
esac

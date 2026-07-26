#!/usr/bin/env bash
# dispatcher.sh — DISPATCHER FAN-OUT shape (Bash), complete for the dispatcher
# profile only. For scheduler / deliberation / pipeline use the Python or Node
# templates (this file does NOT implement full reconcile/resume_hint/sentinel).
#
# Invoked core subset: connect_api, launch_agent, wait_ready, seed_highwater
#   (composite ts+hash), confirmed_send (409-handling), wait_turn_complete
#   (strict profile), verify_artifact, retire (terminal-state-specific,
#   incl. recoverable-stall retention: leave-alive, no delete).
#
# Deps: bash, curl, jq, and sha256sum (fallback: openssl dgst -sha256).
# Everything marked `# user policy` is a customization slot.
set -euo pipefail

: "${LARES_POLL_MS:=500}"
: "${LARES_MAX_409_RETRIES:=8}"
STANDALONE_PORT_RANGE="24678 24679 24680 24681"   # §1.1 standalone probe only

_sha() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-16; else openssl dgst -sha256 | awk '{print substr($NF,1,16)}'; fi; }
_sleep() { local ms="$1"; sleep "$(awk "BEGIN{print $ms/1000}")"; }
_curl() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }

# 1. connect_api — injected endpoint on-behalf; range-probe only standalone.
connect_api() {
  TOKEN="${AGENT_DASHBOARD_API_TOKEN:?token required}"
  local host="${AGENT_DASHBOARD_API_HOST:-127.0.0.1}"
  if [ -n "${AGENT_DASHBOARD_API_PORT:-}" ]; then
    : "${AGENT_DASHBOARD_WORKSPACE_ID:?workspace required}"
    : "${AGENT_DASHBOARD_SELF_ID:?self-id required (on-behalf fail-closed)}"
    BASE="http://$host:$AGENT_DASHBOARD_API_PORT"
  else
    for p in $STANDALONE_PORT_RANGE; do
      if curl -sS -H "Authorization: Bearer $TOKEN" "http://$host:$p/api/agents" >/dev/null 2>&1; then BASE="http://$host:$p"; break; fi
    done
    : "${BASE:?no Lares API on standalone port range}"
  fi
  _curl "$BASE/api/agents" | jq -e 'type=="array"' >/dev/null
}

# 3. launch_agent — no task prompt in the body; forward SELF_ID as owner edge.
launch_agent() { # $1 = json payload
  local body; body="$(jq -c --arg ws "${AGENT_DASHBOARD_WORKSPACE_ID:-}" --arg self "${AGENT_DASHBOARD_SELF_ID:-}" \
    '. + {workspaceId:(.workspaceId // $ws), owner_agent_id:(.owner_agent_id // $self)}' <<<"$1")"
  _curl -H 'Content-Type: application/json' -d "$body" "$BASE/api/agents" | jq -r '.id'
}

# 4. wait_ready
wait_ready() { local id="$1" s; for _ in $(seq 1 120); do
  s="$(_curl "$BASE/api/agents/$id" | jq -r '.status')"
  case "$s" in idle|waiting) return 0;; done|crashed) echo "terminal:$s" >&2; return 1;; esac
  _sleep "$LARES_POLL_MS"; done; return 1; }

# 5. seed_highwater — composite ts|hash of the newest assistant message.
seed_highwater() { local id="$1" m; m="$(_curl "$BASE/api/agents/$id/messages?limit=1&role=assistant")"
  local ts hash; ts="$(jq -r '.[0].timestamp // ""' <<<"$m")"; hash="$(jq -r '.[0].content // ""' <<<"$m" | _sha)"
  echo "$ts|$hash"; }

# 6. confirmed_send — 409 → wait_ready + bounded retry; confirm handshake.
confirmed_send() { local id="$1" text="$2" i=0 code; while :; do i=$((i+1))
  code="$(_curl -o /tmp/cs.$$ -w '%{http_code}' -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg t "$text" --arg s "${AGENT_DASHBOARD_SELF_ID:-}" '{text:$t,submit:true,confirm:true,sender_agent_id:$s}')" \
    "$BASE/api/agents/$id/input")"
  if [ "$code" = "409" ] && [ "$i" -le "$LARES_MAX_409_RETRIES" ]; then wait_ready "$id"; _sleep "$LARES_POLL_MS"; continue; fi
  jq -r '.confirmed // false' </tmp/cs.$$; rm -f /tmp/cs.$$; return 0; done; }

# 7. wait_turn_complete (strict profile) — new turnComplete beyond $2 (ts|hash).
wait_turn_complete() { local id="$1" hw="$2" soft="${3:-90}" m ts hash; local n=0
  while [ "$n" -lt "$soft" ]; do n=$((n+1))
    m="$(_curl "$BASE/api/agents/$id/messages?limit=1&role=assistant")"
    ts="$(jq -r '.[0].timestamp // ""' <<<"$m")"; hash="$(jq -r '.[0].content // ""' <<<"$m" | _sha)"
    if [ "$(jq -r '.[0].turnComplete // false' <<<"$m")" = "true" ] && [ "$ts|$hash" != "$hw" ]; then echo "$ts|$hash"; return 0; fi
    _sleep "$LARES_POLL_MS"; done; echo "STALLED"; return 2; }

# 9. verify_artifact — existence + freshness (hash change) vs baseline.
verify_artifact() { local path="$1" baseline="${2:-}"; [ -s "$path" ] || { echo "missing"; return 1; }
  local h; h="$(_sha <"$path")"; if [ -n "$baseline" ] && [ "$h" = "$baseline" ]; then echo "stale"; return 1; fi; echo "fresh"; }

# 10. retire — terminal-state-specific; recoverable STALL → leave alive (no delete).
retire() { local state="$1"; shift
  if [ "$state" = "stalled" ]; then for id in "$@"; do echo "retain:$id" >&2; done; return 0; fi  # leave-alive
  local ids=("$@"); for ((i=${#ids[@]}-1;i>=0;i--)); do _curl -X DELETE "$BASE/api/agents/${ids[$i]}" >/dev/null; done; }

# Dispatcher main (bounded serial for portability; parallelize per user policy).
dispatch() { connect_api; local rc=0
  for item in "$@"; do  # user policy — item selection
    local id; id="$(launch_agent "$(jq -nc --arg t "dispatch:$item" '{title:$t,provider:"claude",isSupervised:true}')")"  # user policy
    wait_ready "$id"; local hw; hw="$(seed_highwater "$id")"
    confirmed_send "$id" "Do task for $item; end with DONE" >/dev/null  # user policy — kickoff
    if hw="$(wait_turn_complete "$id" "$hw")"; then retire complete "$id"; else retire stalled "$id"; rc=2; fi
  done; return "$rc"; }

if [ "${LARES_LIB_ONLY:-0}" != "1" ] && [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  dispatch "${@:-item-1}"
fi

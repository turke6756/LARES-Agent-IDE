#!/usr/bin/env bash
# Get context window stats for a specific agent via the dashboard HTTP API.
# Usage: get-context-stats.sh <agent-id>

AGENT_ID="${1:?Usage: get-context-stats.sh <agent-id>}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=$(grep nameserver /etc/resolv.conf | head -1 | awk '{print $2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://${API_HOST}:${API_PORT}"

RESPONSE=$(curl -sf "${API_BASE}/api/agents/${AGENT_ID}/context-stats" 2>&1)
if [ $? -ne 0 ]; then
  echo "ERROR: Failed to get context stats. Is AgentDashboard running?"
  echo "Tried: ${API_BASE}"
  echo "$RESPONSE"
  exit 1
fi

echo "$RESPONSE"

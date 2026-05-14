#!/usr/bin/env bash
# List all agents managed by AgentDashboard via the HTTP API.
# Output: JSON array of agents with id, title, status, context info

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=$(grep nameserver /etc/resolv.conf | head -1 | awk '{print $2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://${API_HOST}:${API_PORT}"

RESPONSE=$(curl -sf "${API_BASE}/api/agents" 2>&1)
if [ $? -ne 0 ]; then
  echo "ERROR: Failed to list agents. Is AgentDashboard running?"
  echo "Tried: ${API_BASE}"
  echo "$RESPONSE"
  exit 1
fi

echo "$RESPONSE"

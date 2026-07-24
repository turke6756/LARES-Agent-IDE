#!/usr/bin/env bash
# Send a message to an agent via the dashboard HTTP API.
# Usage: send-message.sh <agent-id> "<message>"
#
# SAFETY: Only send to agents in idle/waiting status.
# The API will reject messages to working agents.

AGENT_ID="${1:?Usage: send-message.sh <agent-id> \"<message>\"}"
MESSAGE="${2:?Usage: send-message.sh <agent-id> \"<message>\"}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=$(grep nameserver /etc/resolv.conf | head -1 | awk '{print $2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://${API_HOST}:${API_PORT}"

RESPONSE=$(curl -sf -X POST "${API_BASE}/api/agents/${AGENT_ID}/input" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"${MESSAGE}\"}" 2>&1)

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to send message. Is AgentDashboard running?"
  echo "Tried: ${API_BASE}"
  echo "$RESPONSE"
  exit 1
fi

echo "Sent to $AGENT_ID: $MESSAGE"
echo "$RESPONSE"

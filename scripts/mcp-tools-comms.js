// Sender identity for transient one-turn subscriptions is launch-env only,
// never model-settable (mirrors mcp-team.js / mcp-browser-tools.js). When the
// dashboard launches an MCP proc it stamps process.env.AGENT_ID with the
// owning agent's id; we forward it as sender_agent_id so a submitted message
// auto-subscribes the sender to the target's next turn outcome.
const AGENT_ID = process.env.AGENT_ID || '';

function getCommsToolDefinitions() {
  return [
    {
      name: 'send_message_to_agent',
      description:
        'Send a message to an idle/waiting agent. Rejects if agent is working. ' +
        'HANDSHAKE: by default this call blocks until the worker\'s turn provably STARTED ' +
        '(UserPromptSubmit hook or a status flip to working) and the result says so explicitly. ' +
        'If it returns HANDSHAKE FAILED, the worker is NOT working and will never emit an idle ' +
        'event for this prompt — act on it in this turn (read_agent_log, send_keys_to_agent ' +
        '{key:"enter"}, or relaunch); do NOT end your turn assuming the handoff worked. ' +
        'For interactive widgets (AskUserQuestion pickers, slash-command menus, arrow keys, Ctrl-C), ' +
        'use `send_keys_to_agent` instead — this tool\'s bracketed-paste wrapping deposits bytes into ' +
        'the input box as text, not as key events. ' +
        'When the send is accepted and submitted, you are auto-subscribed to ONE turn of the target\'s ' +
        'outcome: you will get a [DASHBOARD EVENT] when it next goes idle/done/crashed (or a TTL expiry ' +
        'notice), then the subscription is gone. A rejected (busy/409) send does not subscribe.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          message: { type: 'string', description: 'Message to send as user input.' },
          confirm: {
            type: 'boolean',
            description: 'Default true: block until the worker turn is confirmed started. '
              + 'Pass false for legacy fire-and-forget delivery (no started-proof).',
          },
        },
        required: ['agent_id', 'message'],
      },
    },
  ];
}

async function handleCommsToolCall(name, args, apiRequest) {
  switch (name) {
    case 'send_message_to_agent': {
      // Handoff handshake (default): block until the worker's turn provably
      // started. Without this, "Message sent" only means bytes were typed —
      // a dropped Enter or dead agent left the supervisor believing a worker
      // was working when it never started, with no event to ever wake it.
      const confirm = args.confirm !== false;
      if (!confirm) {
        await apiRequest('POST', `/api/agents/${args.agent_id}/input`, {
          text: args.message,
          ...(AGENT_ID ? { sender_agent_id: AGENT_ID } : {}),
        });
        return {
          content: [{
            type: 'text',
            text: `Message sent to agent ${args.agent_id} (fire-and-forget — turn start NOT confirmed): "${args.message}"`,
          }],
        };
      }
      try {
        const r = await apiRequest('POST', `/api/agents/${args.agent_id}/input`, {
          text: args.message,
          confirm: true,
          ...(AGENT_ID ? { sender_agent_id: AGENT_ID } : {}),
        });
        if (r.confirmed) {
          const subscribed = r.transientSubscription && r.transientSubscription.registered === true;
          return {
            content: [{
              type: 'text',
              text: `HANDSHAKE OK — message delivered to agent ${args.agent_id} and the worker turn `
                + `is CONFIRMED started (proof: ${r.mode === 'hook' ? 'UserPromptSubmit hook' : 'status flipped to working'}). `
                + (subscribed
                  ? `You will get a [DASHBOARD EVENT] when it finishes this turn, then the one-turn subscription expires.`
                  : `You will get a [DASHBOARD EVENT] when it goes idle.`),
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: `HANDSHAKE UNCONFIRMED — message delivered to agent ${args.agent_id} but no turn-start `
              + `proof arrived in time (provider may lack an authoritative start signal, e.g. gemini). `
              + `The worker MAY be fine, but verify before relying on it: read_agent_log to see the PTY; `
              + `if the prompt sits unsubmitted, send_keys_to_agent {"agent_id":"${args.agent_id}","key":"enter"}.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `HANDSHAKE FAILED for agent ${args.agent_id}: ${err.message}\n`
              + `The prompt was typed but the worker turn NEVER STARTED — it will never emit an idle `
              + `event for this prompt, so do NOT end your turn assuming the handoff worked.\n`
              + `Recover now: 1) read_agent_log {"agent_id":"${args.agent_id}"} to inspect the PTY; `
              + `2) if the prompt sits unsubmitted, send_keys_to_agent {"agent_id":"${args.agent_id}","key":"enter"} `
              + `and re-check; 3) if the agent is dead or hook-broken, stop_agent + launch_agent a replacement.`,
          }],
        };
      }
    }

    default:
      return null;
  }
}

module.exports = { getCommsToolDefinitions, handleCommsToolCall };

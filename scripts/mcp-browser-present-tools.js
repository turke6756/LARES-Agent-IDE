/**
 * Minimal "present a page to the human" browser toolset for the SUPERVISOR and
 * WORKER lanes.
 *
 * UNLIKE the full `browser` toolset (researcher-only, mcp-browser-tools.js) this
 * exposes a SINGLE open-only tool. It always opens the URL as a VISIBLE tab in
 * the HUMAN's browser partition (forHuman: true) — i.e. a real user tab. There
 * is:
 *   - NO agent partition and NO page readback (the agent can't see the page),
 *   - NO read / click / type / scroll tools (none are defined here),
 *   - NO dependence on the browser-actions toggle (forHuman open stays available
 *     even while the toggle is off — see browser-policy.ts §5 #6).
 *
 * This lets a supervisor or worker "pull up" a webpage FOR the user without
 * granting any ability to read or drive it.
 *
 * SECURITY: the underlying POST /api/browser/open-url endpoint is scheme- and
 * SSRF-checked dashboard-side (http/https only; control ports + metadata IPs
 * refused) for forHuman opens too. This file is a dumb proxy — no
 * Runtime.evaluate, no readback. Do NOT add read/act tools here; the full
 * surface lives in mcp-browser-tools.js and is researcher-only by design.
 */

function getBrowserPresentToolDefinitions() {
  return [
    {
      name: 'browser_open_url',
      description:
        'Pull up a webpage FOR THE HUMAN. Opens the given http/https URL as a ' +
        'VISIBLE tab in the human\'s browser pane in the dashboard (the pane ' +
        'flashes for their attention). This is OPEN-ONLY: you get NO page ' +
        'readback and cannot read, click, scroll, or type — it is purely a way ' +
        'to surface a page for the human to look at themselves. The call returns ' +
        'once the page has loaded (the wait happens dashboard-side — no need to ' +
        'poll). URLs are scheme- and SSRF-checked (http/https only; control ports ' +
        'and metadata IPs are refused). After opening, tell the human in plain ' +
        'text what you pulled up and why.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http/https URL to pull up for the human.' },
        },
        required: ['url'],
      },
    },
  ];
}

/**
 * Dispatch the present-only browser tool against the dashboard API.
 * Returns an MCP result object, or null when `name` is not this tool (so the
 * caller's switch keeps handling everything else).
 * @param {string} name
 * @param {object} args
 * @param {(method: string, path: string, body?: object) => Promise<any>} apiRequest
 */
async function handleBrowserPresentToolCall(name, args, apiRequest) {
  if (name !== 'browser_open_url') return null;
  // Always forHuman: opens a persist:user tab the agent can never read or drive.
  await apiRequest('POST', '/api/browser/open-url', { url: args.url, forHuman: true });
  return {
    content: [{
      type: 'text',
      text:
        `Pulled up ${args.url} in the human's browser pane for them to look at. ` +
        `You get no page readback — let the human know what you opened and why.`,
    }],
  };
}

module.exports = { getBrowserPresentToolDefinitions, handleBrowserPresentToolCall };

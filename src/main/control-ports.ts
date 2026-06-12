// WP1-A task 1 (plans/embedded-browser-implementation-tasks.md) — the single
// source of truth for the dashboard's fixed control-plane ports.
//
// The M2 loopback filter (src/main/browser/browser-decisions.ts →
// decideLoopbackBlock) and the Phase-2 agent URL policy import these so the
// "ports browsed pages must never reach" list can't drift from the servers
// that actually bind them. Do NOT improvise port constants elsewhere.
//
// Note: the HTTP API port (default 24678) is deliberately absent — it can
// EADDRINUSE-increment at startup, so consumers must use the ACTUAL bound
// port resolved by ApiServer.start() (WP0.1), never a constant.

/** Dashboard WebSocket server (src/main/ws-server.ts, loopback-bound). */
export const WS_PORT = 4545;

/** First port the embedded Jupyter server tries (src/main/jupyter-server.ts). */
export const JUPYTER_BASE_PORT = 18888;

/** How many sequential ports Jupyter may walk past JUPYTER_BASE_PORT. */
export const JUPYTER_PORT_RETRIES = 50;

// T1-D / L-B: pure decision tree for the MCP launch_agent poll loop.
// Extracted so the post-restart behavior can be unit-tested without standing
// up the full MCP shim. Returns one of:
//   'ready'    — agent is idle/waiting; deliver the queued prompt
//   'continue' — keep polling (launching/working OR crashed-but-restarting)
//   'break'    — give up (done OR crashed with no restart remaining)
function decidePollAction(status, autoRestartEnabled, restartCount) {
  if (status === 'idle' || status === 'waiting') return 'ready';
  if (status === 'crashed') {
    if (autoRestartEnabled && (restartCount || 0) < 5) return 'continue';
    return 'break';
  }
  if (status === 'done') return 'break';
  return 'continue';
}

module.exports = { decidePollAction };

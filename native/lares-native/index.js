'use strict';

// lares-native — JS binding for the Windows Job Object + commit-telemetry addon.
//
// Windows: loads the compiled N-API addon and re-exports its surface, plus a
// `supported: true` flag and `jobName()` helper for the naming convention.
//
// Non-Windows (or if the binary is missing): returns a graceful no-op surface —
// `supported: false`, `platformSupported()` false, and every operation throws a
// clear, catchable error (never a hard require-time crash). D5 has separate
// non-Windows commit paths (/proc/meminfo, process.getSystemMemoryInfo), so this
// module deliberately does not try to serve them.

const path = require('path');

const UNSUPPORTED_MSG =
  'lares-native: Windows Job Object surface is unavailable on this platform/build';

/** Canonical named-job string: Local\Lares.agent.<agentId>.<instanceEpoch>. */
function jobName(agentId, instanceEpoch) {
  return `Local\\Lares.agent.${agentId}.${instanceEpoch}`;
}

function unsupportedSurface(reason) {
  const err = () => {
    throw new Error(`${UNSUPPORTED_MSG}${reason ? ` (${reason})` : ''}`);
  };
  return {
    supported: false,
    platformSupported: () => false,
    jobName,
    createNamedJob: err,
    openNamedJob: err,
    assignPid: err,
    listJobPids: err,
    terminateJob: err,
    pidCreationTime: err,
    getCommitStatus: err,
    loadError: reason || null,
  };
}

function loadNativeSurface() {
  // Candidate build outputs (Release first, then Debug).
  const candidates = [
    path.join(__dirname, 'build', 'Release', 'lares_native.node'),
    path.join(__dirname, 'build', 'Debug', 'lares_native.node'),
  ];
  let native = null;
  let lastErr = null;
  for (const p of candidates) {
    try {
      native = require(p);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!native) {
    return unsupportedSurface(
      `native addon not loaded: ${lastErr ? lastErr.message : 'not built'}`,
    );
  }
  return {
    supported: true,
    platformSupported: native.platformSupported,
    jobName,
    createNamedJob: native.createNamedJob,
    openNamedJob: native.openNamedJob,
    assignPid: native.assignPid,
    listJobPids: native.listJobPids,
    terminateJob: native.terminateJob,
    pidCreationTime: native.pidCreationTime,
    getCommitStatus: native.getCommitStatus,
    loadError: null,
  };
}

module.exports =
  process.platform === 'win32'
    ? loadNativeSurface()
    : unsupportedSurface(`platform ${process.platform} is not Windows`);

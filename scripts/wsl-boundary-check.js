// wsl-boundary-check.js — canonical regression harness for the Node→wsl.exe
// quote-stripping boundary bug (plans/wsl-workspace-parity.md §0).
//
// wsl.exe strips/mangles double quotes when it reconstructs the command line it
// hands to the Linux side. An inner `bash -lic "$(echo <B64> | base64 -d)"`
// therefore loses its $-expansion: the decoded command word-splits and only the
// first token runs. The fix (`wslBashEnvelope`) crosses the boundary with a
// quote-free `printf %s <B64> | base64 -d | bash` envelope.
//
// This script builds both shapes against the REAL wsl.exe with a probe command
// that proves whether an earlier env-style assignment survives to a later echo:
//   MARK=hello; echo RESULT=$MARK; echo SECOND
// Case A (current/broken) is expected to drop MARK (RESULT= empty); Case B (fix)
// must emit RESULT=hello. Exit non-zero iff Case B fails.
//
// On a host with no WSL (e.g. CI / a Windows box without a distro) this prints a
// skip line and exits 0 — that is an acceptable pass; the live verification is
// done by a human on a real WSL workspace.

const { execFileSync } = require('child_process');

const INNER_CMD = 'MARK=hello; echo RESULT=$MARK; echo SECOND';
const B64 = Buffer.from(INNER_CMD, 'utf8').toString('base64');

// Shape A — what the code produced before the §1 fix.
const CASE_A = `bash -lic "$(echo ${B64} | base64 -d)"`;
// Shape B — the quote-free wslBashEnvelope output.
const CASE_B = `printf %s ${B64} | base64 -d | bash`;

function runWsl(script) {
  // Mirror production: the whole script is the third argv element of
  // `wsl.exe bash -lc <script>`.
  return execFileSync('wsl.exe', ['bash', '-lc', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
}

function wslAvailable() {
  try {
    const out = runWsl('echo __wsl_ok__');
    return out.includes('__wsl_ok__');
  } catch {
    return false;
  }
}

(function main() {
  if (!wslAvailable()) {
    console.log('[wsl-boundary-check] SKIP — wsl.exe not available on this host; exiting 0');
    process.exit(0);
  }

  let aOut = '';
  let bOut = '';
  try {
    aOut = runWsl(CASE_A);
  } catch (e) {
    aOut = `<error: ${e && e.message ? e.message : e}>`;
  }
  try {
    bOut = runWsl(CASE_B);
  } catch (e) {
    bOut = `<error: ${e && e.message ? e.message : e}>`;
  }

  console.log('[wsl-boundary-check] inner cmd :', INNER_CMD);
  console.log('[wsl-boundary-check] Case A (broken `bash -lic "$(...)"`) stdout:');
  console.log(aOut);
  console.log('[wsl-boundary-check] Case B (fix `printf %s ... | base64 -d | bash`) stdout:');
  console.log(bOut);

  if (!bOut.includes('RESULT=hello')) {
    console.error('[wsl-boundary-check] FAIL — Case B stdout lacks RESULT=hello (quote-free envelope did not survive the boundary)');
    process.exit(1);
  }

  console.log('[wsl-boundary-check] PASS — Case B carries RESULT=hello across the wsl.exe boundary');
  process.exit(0);
})();

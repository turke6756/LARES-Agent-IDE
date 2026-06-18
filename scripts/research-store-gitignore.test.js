// WP-G §G6 — research-store .gitignore outcome test (Case A).
//
// Asserts the OUTCOME (inbox/ ignored, cleared/ + README trackable) rather than
// a specific literal block, plus that the sentinel-guarded block is present
// exactly once (idempotent append). Uses `git check-ignore` against the repo
// when available, with a content-based fallback for git-less environments.
//
// Run via: node scripts/research-store-gitignore.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name); console.error('       ', e && e.stack ? e.stack : e); failed++; }
}

function isGitRepo() {
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf-8' });
  return r.status === 0 && /true/.test(r.stdout || '');
}
function isIgnored(rel) {
  // git check-ignore exits 0 if the path is ignored, 1 if not.
  const r = spawnSync('git', ['-C', repoRoot, 'check-ignore', rel], { encoding: 'utf-8' });
  return r.status === 0;
}

test('research-store sentinel block present exactly once (idempotent)', () => {
  const opens = (gitignore.match(/# >>> agentdashboard-research-store >>>/g) || []).length;
  const closes = (gitignore.match(/# <<< agentdashboard-research-store <<</g) || []).length;
  assert.equal(opens, 1, `expected one opening sentinel; got ${opens}`);
  assert.equal(closes, 1, `expected one closing sentinel; got ${closes}`);
});

test('inbox/ ignored, cleared/ + README trackable', () => {
  if (isGitRepo()) {
    assert.ok(isIgnored('.dashboard/research/inbox/topic/2026-06-14T120000-x.md'),
      'inbox/ artifacts must be git-ignored');
    assert.ok(!isIgnored('.dashboard/research/cleared/topic/2026-06-14T120000-x.md'),
      'cleared/ artifacts must be trackable');
    assert.ok(!isIgnored('.dashboard/research/README.md'),
      'research README must be trackable');
  } else {
    // Fallback: the inbox rule exists and no rule ignores cleared/.
    assert.match(gitignore, /^\/\.dashboard\/research\/inbox\/$/m, 'inbox/ ignore rule present');
    assert.ok(!/\/\.dashboard\/research\/cleared\//.test(gitignore), 'no rule ignores cleared/');
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

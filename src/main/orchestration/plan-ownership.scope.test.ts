// WP-P8B — deletion guard for the retired legacy HTML one-writer lock.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const source = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

const removedModule = path.join(REPO, 'src', 'main', 'orchestration', 'plan-ownership.ts');
assert.equal(fs.existsSync(removedModule), false, 'the legacy ownership module stays deleted');

const dispatchCallSites = [
  path.join('src', 'main', 'api-server.ts'),
  path.join('src', 'main', 'ipc-handlers.ts'),
  path.join('src', 'main', 'orchestration', 'service.ts'),
];
for (const rel of dispatchCallSites) {
  const text = source(rel);
  assert.doesNotMatch(text, /plan-ownership/, `${rel} must not import the retired module`);
  assert.doesNotMatch(text, /assertPlanRailFree\s*\(/, `${rel} must not invoke the retired guard`);
}

const emittedPayloadSources = [
  ...dispatchCallSites.map(source),
  source(path.join('scripts', 'mcp-tools-orchestration.js')),
].join('\n');
for (const emitted of [
  /one writer per plan/i,
  /already has an active writer/i,
  /has a live plan-bound agent/i,
  /finalizing its execution trail/i,
]) {
  assert.doesNotMatch(emittedPayloadSources, emitted, `retired 409 payload remains: ${emitted}`);
}

console.log('WP-P8B ownership-lock deletion guard passed');

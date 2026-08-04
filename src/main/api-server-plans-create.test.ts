// WP-P8B — deletion guard for the retired legacy HTML plan-authoring path.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.join(__dirname, '..', '..', '..');
const main = path.join(REPO, 'src', 'main');
const apiSource = fs.readFileSync(path.join(main, 'api-server.ts'), 'utf8');
const plansToolSource = fs.readFileSync(path.join(REPO, 'scripts', 'mcp-tools-plans.js'), 'utf8');

assert.equal(fs.existsSync(path.join(main, 'plans', 'create-plan.ts')), false,
  'the legacy HTML authoring module stays deleted');
assert.equal(fs.existsSync(path.join(main, 'plans', 'templates', 'default-surface.ts')), false,
  'the legacy HTML template stays deleted');
assert.doesNotMatch(apiSource, /createPlanSurface\s*\(/,
  'POST /api/plans must not invoke the retired HTML writer');
assert.doesNotMatch(apiSource, /DEFAULT_SURFACE_TEMPLATE|renderDefaultSurface/,
  'the API must not retain the retired template capability');
assert.doesNotMatch(plansToolSource, /\bcreate_plan\b/,
  'the MCP plans toolset must not advertise or route the retired writer');

console.log('WP-P8B HTML-authoring deletion guard passed');

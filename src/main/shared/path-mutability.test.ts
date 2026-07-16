// path-mutability unit tests (base plan §3.1). Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/shared/path-mutability.test.js

import assert from 'node:assert/strict';
import { classifyPathMutability, type MutabilityClass } from './path-mutability';

interface Row { name: string; path: string; expect: MutabilityClass; }

const rows: Row[] = [
  // scaffold-managed: .dashboard/**/.claude/skills/
  { name: 'supervisor scaffolded skill', path: 'C:\\proj\\.dashboard\\supervisor\\.claude\\skills\\run-orchestration\\SKILL.md', expect: 'scaffold-managed' },
  { name: 'worker scaffolded skill (posix)', path: '/home/e/proj/.dashboard/workers/claude/.claude/skills/foo/SKILL.md', expect: 'scaffold-managed' },
  { name: 'scaffold skills dir itself (no trailing slash)', path: '/p/.dashboard/supervisor/.claude/skills', expect: 'scaffold-managed' },

  // generated-vendor: plugin / cache / vendored
  { name: 'user plugin skill beats user-owned ~/.claude', path: 'C:\\Users\\e\\.claude\\plugins\\pack\\skills\\x\\SKILL.md', expect: 'generated-vendor' },
  { name: 'node_modules', path: '/proj/node_modules/pkg/CLAUDE.md', expect: 'generated-vendor' },
  { name: 'cache dir', path: 'C:\\Users\\e\\.cache\\claude\\thing.md', expect: 'generated-vendor' },

  // user-owned: workspace CLAUDE.md, ~/.claude/**, default
  { name: 'workspace CLAUDE.md', path: 'C:\\proj\\CLAUDE.md', expect: 'user-owned' },
  { name: 'user global CLAUDE.md', path: 'C:\\Users\\e\\.claude\\CLAUDE.md', expect: 'user-owned' },
  { name: 'user rules', path: '/home/e/.claude/rules/style.md', expect: 'user-owned' },
  { name: 'plain workspace skill (not under .dashboard) is user-owned', path: '/proj/.claude/skills/mine/SKILL.md', expect: 'user-owned' },
  { name: 'arbitrary workspace file', path: '/proj/src/main/index.ts', expect: 'user-owned' },
];

let passed = 0; let failed = 0;
for (const r of rows) {
  try {
    const got = classifyPathMutability(r.path);
    assert.equal(got, r.expect, `${r.path} → ${got}, expected ${r.expect}`);
    console.log(`  ok  ${r.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${r.name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

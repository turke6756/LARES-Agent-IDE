import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MAIN_ROOT = path.resolve(process.cwd(), 'src/main');
const ALLOWED_WRITER = path.normalize(path.join(MAIN_ROOT, 'plans', 'package-ledger.ts'));

function productionSources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [absolute]
      : [];
  });
}

export function packageStateMutations(source: string): string[] {
  const normalized = source.replace(/\r\n?/g, '\n');
  const patterns: Array<[string, RegExp]> = [
    ['UPDATE plan_work_packages ... SET ... state',
      /UPDATE\s+plan_work_packages\s+SET[\s\S]{0,800}?\bstate\s*=/gi],
    ['plan_work_packages upsert conflict updates state',
      /INSERT\s+INTO\s+plan_work_packages[\s\S]{0,1600}?ON\s+CONFLICT[\s\S]{0,800}?\bstate\s*=/gi],
    ['plan-work-package updater receives a state field',
      /(?:upsert|update|set)PlanWorkPackage\w*\s*\([\s\S]{0,600}?\bstate\s*:/g],
  ];
  return patterns.flatMap(([label, pattern]) => [...normalized.matchAll(pattern)].map(() => label));
}

// Prove the guard itself recognizes both the historical SQL writer and the
// object-upsert equivalent that previously hid the finalization done flip.
assert.deepEqual(packageStateMutations(
  "db.prepare('UPDATE plan_work_packages SET state = ? WHERE id = ?')",
), ['UPDATE plan_work_packages ... SET ... state']);
assert.deepEqual(packageStateMutations(
  "upsertPlanWorkPackage({ ...pkg, state: 'done' })",
), ['plan-work-package updater receives a state field']);

const violations = productionSources(MAIN_ROOT)
  .filter((file) => path.normalize(file) !== ALLOWED_WRITER)
  .flatMap((file) => packageStateMutations(fs.readFileSync(file, 'utf8'))
    .map((kind) => `${path.relative(MAIN_ROOT, file)}: ${kind}`));

assert.deepEqual(violations, [],
  'plan_work_packages.state may be mutated only by plans/package-ledger.ts');
console.log('  ok  package-ledger is the sole production package-state writer');

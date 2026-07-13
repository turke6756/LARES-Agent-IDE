// Unit tests — process-memory CSV parse + snapshot lookup (full-D5, Wave 4). Run:
//   npm run build:main
//   node dist/main/main/watchdog/process-memory.test.js

import assert from 'node:assert/strict';
import { parseProcessMemCsv, makeSnapshot } from './process-memory';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const CSV =
  '"ProcessId","ParentProcessId","WorkingSetSize","PrivatePageCount"\r\n' +
  '"100","4","1048576","524288"\r\n' +
  '"101","100","2097152","1048576"\r\n';

test('parses pid/parent/working-set/commit columns', () => {
  const rows = parseProcessMemCsv(CSV);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 100, parentPid: 4, workingSetBytes: 1048576, commitBytes: 524288 });
  assert.equal(rows[1].parentPid, 100);
});

test('empty / header-only input → []', () => {
  assert.deepEqual(parseProcessMemCsv(''), []);
  assert.deepEqual(parseProcessMemCsv('"ProcessId","ParentProcessId","WorkingSetSize","PrivatePageCount"'), []);
});

test('non-numeric memory cells become null, row still kept', () => {
  const rows = parseProcessMemCsv('"h1","h2","h3","h4"\r\n"100","4","","x"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workingSetBytes, null);
  assert.equal(rows[0].commitBytes, null);
});

test('rows with a non-numeric pid are dropped', () => {
  const rows = parseProcessMemCsv('"h1","h2","h3","h4"\r\n"","4","1","1"\r\n"200","5","2","2"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 200);
});

test('snapshot lookups resolve bytes and null for unknown pids', () => {
  const snap = makeSnapshot(parseProcessMemCsv(CSV));
  assert.equal(snap.workingSetBytes(100), 1048576);
  assert.equal(snap.commitBytes(101), 1048576);
  assert.equal(snap.workingSetBytes(999), null);
  assert.equal(snap.processes.length, 2);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

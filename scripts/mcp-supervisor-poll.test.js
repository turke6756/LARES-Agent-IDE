// T1-D / L-B: poll-loop decision unit tests.
// Run via: node scripts/mcp-supervisor-poll.test.js

const assert = require('node:assert/strict');
const { decidePollAction } = require('./mcp-supervisor-poll');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${err && err.stack ? err.stack : err}`);
  }
}

test('idle => ready', () => {
  assert.equal(decidePollAction('idle', true, 0), 'ready');
});

test('waiting => ready', () => {
  assert.equal(decidePollAction('waiting', false, 0), 'ready');
});

test('launching/working => continue (poll on)', () => {
  assert.equal(decidePollAction('launching', false, 0), 'continue');
  assert.equal(decidePollAction('working', true, 1), 'continue');
});

test('done => break (terminal, no restart)', () => {
  assert.equal(decidePollAction('done', true, 0), 'break');
});

test('crashed + autoRestart pending => continue (do NOT break)', () => {
  // T1-D core fix: this used to be a `break` which forever lost the queued
  // prompt. Now we keep polling so the relaunched agent gets the prompt.
  assert.equal(decidePollAction('crashed', true, 0), 'continue');
  assert.equal(decidePollAction('crashed', true, 4), 'continue');
});

test('crashed + restart budget exhausted => break', () => {
  assert.equal(decidePollAction('crashed', true, 5), 'break');
  assert.equal(decidePollAction('crashed', true, 12), 'break');
});

test('crashed + autoRestart disabled => break', () => {
  assert.equal(decidePollAction('crashed', false, 0), 'break');
});

test('crashed + restartCount undefined treated as 0 (auto-restart still pending)', () => {
  assert.equal(decidePollAction('crashed', true, undefined), 'continue');
});

test('integration: sequence crashed -> crashed -> idle delivers prompt post-restart', () => {
  const sequence = [
    { status: 'crashed', autoRestartEnabled: true, restartCount: 0 },
    { status: 'crashed', autoRestartEnabled: true, restartCount: 1 },
    { status: 'idle', autoRestartEnabled: true, restartCount: 1 },
  ];
  const actions = [];
  let promptDelivered = false;
  for (const s of sequence) {
    const action = decidePollAction(s.status, s.autoRestartEnabled, s.restartCount);
    actions.push(action);
    if (action === 'ready') { promptDelivered = true; break; }
    if (action === 'break') break;
  }
  assert.deepEqual(actions, ['continue', 'continue', 'ready']);
  assert.equal(promptDelivered, true, 'queued prompt must fire after auto-restart reaches idle');
});

if (failed > 0) {
  console.error(`FAILED ${failed} test(s)`);
  process.exit(1);
} else {
  console.log('all mcp-supervisor poll tests passed');
}

// Context-Overhead Analyzer — token-estimator unit tests (plan §6).
// Pure (no Electron, no DB, no spawn) — runs under the system-Node runner:
//   npm run build:main
//   node dist/main/main/context-overhead/token-estimator.test.js

import assert from 'node:assert/strict';
import { TokenEstimator, sumEstimates, zeroEstimate } from './token-estimator';
import type { AnthropicToolDef, TokenClient } from './token-estimator';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

test('no encoder → chars-heuristic with ceil(chars/3.5)', () => {
  const est = new TokenEstimator();
  assert.equal(est.method, 'chars-heuristic');
  const r = est.estimate('1234567'); // 7 chars → ceil(7/3.5)=2
  assert.equal(r.tokens, 2);
  assert.equal(r.chars, 7);
  assert.equal(r.method, 'chars-heuristic');
  assert.equal(r.approximate, true);
});

test('stub encoder → deterministic tiktoken-approx, always approximate', () => {
  const est = new TokenEstimator({ encoder: (t) => t.split(' ').length });
  assert.equal(est.method, 'tiktoken-approx');
  const r = est.estimate('a b c d');
  assert.equal(r.tokens, 4);
  assert.equal(r.method, 'tiktoken-approx');
  assert.equal(r.approximate, true);
});

test('memoization — identical text estimated once (encoder called once)', () => {
  let calls = 0;
  const est = new TokenEstimator({ encoder: (t) => { calls++; return t.length; } });
  est.estimate('hello world');
  est.estimate('hello world');
  est.estimate('hello world');
  assert.equal(calls, 1, 'encoder must only run once for repeated identical input');
  // distinct text triggers a fresh call
  est.estimate('different');
  assert.equal(calls, 2);
});

test('encoder that throws falls back to chars-heuristic for THAT input', () => {
  const est = new TokenEstimator({
    encoder: (t) => { if (t.includes('boom')) throw new Error('bad'); return t.length; },
  });
  const ok = est.estimate('fine');
  assert.equal(ok.method, 'tiktoken-approx');
  const fell = est.estimate('boom'); // 4 chars → ceil(4/3.5)=2
  assert.equal(fell.method, 'chars-heuristic');
  assert.equal(fell.tokens, 2);
});

test('Phase-3: estimateToolExact uses client.countTools, NOT countText', async () => {
  const calls: string[] = [];
  const client: TokenClient = {
    countText: async () => { calls.push('text'); return 999; },
    countTools: async () => { calls.push('tools'); return 42; },
  };
  const est = new TokenEstimator({ client });
  const tool: AnthropicToolDef = { name: 't', description: 'd', input_schema: { type: 'object' } };
  const r = await est.estimateToolExact(tool);
  assert.deepEqual(calls, ['tools']);
  assert.equal(r.tokens, 42);
  assert.equal(r.method, 'anthropic-count-tokens');
  assert.equal(r.approximate, false);
});

test('estimateToolExact without client falls back to sync estimate (approximate)', async () => {
  const est = new TokenEstimator({ encoder: (t) => t.length });
  const r = await est.estimateToolExact({ name: 't', description: 'd', input_schema: {} });
  assert.equal(r.method, 'tiktoken-approx');
  assert.equal(r.approximate, true);
});

test('sumEstimates: all-approximate stays approximate; all-exact becomes exact', () => {
  const approx = sumEstimates(
    [
      { tokens: 1, bytes: 1, chars: 1, method: 'tiktoken-approx', approximate: true },
      { tokens: 2, bytes: 2, chars: 2, method: 'chars-heuristic', approximate: true },
    ],
    'tiktoken-approx',
  );
  assert.equal(approx.tokens, 3);
  assert.equal(approx.approximate, true);

  const exact = sumEstimates(
    [
      { tokens: 5, bytes: 5, chars: 5, method: 'anthropic-count-tokens', approximate: false },
      { tokens: 5, bytes: 5, chars: 5, method: 'anthropic-count-tokens', approximate: false },
    ],
    'tiktoken-approx',
  );
  assert.equal(exact.tokens, 10);
  assert.equal(exact.method, 'anthropic-count-tokens');
  assert.equal(exact.approximate, false);
});

test('zeroEstimate stamps the active method with zeros', () => {
  const z = zeroEstimate('tiktoken-approx');
  assert.equal(z.tokens, 0);
  assert.equal(z.bytes, 0);
  assert.equal(z.approximate, true);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyGrokFreeLimit } from './provider-quota-classifier';

const fixtures = path.resolve(process.cwd(), 'src/main/supervisor/__fixtures__');
const exhausted = fs.readFileSync(path.join(fixtures, 'grok-free-limit-exhausted.txt'), 'utf8');
const startupPromo = fs.readFileSync(path.join(fixtures, 'grok-startup-promo.txt'), 'utf8');

assert.deepEqual(classifyGrokFreeLimit(exhausted), {
  reason: 'free-usage-limit',
  detail: 'You hit your free usage limit.',
});
assert.equal(classifyGrokFreeLimit(startupPromo), null);

const forbiddenProse = [
  'The log says "You hit your free usage limit." but there is no picker on this screen.',
  'Document the Upgrade to SuperGrok and Upgrade to SuperGrok Heavy options.',
  'A test fixture might contain: You hit your free usage limit.',
  'You hit your free usage limit. Upgrade for more usage.',
  'You hit your free usage limit. Upgrade to SuperGrok Heavy.',
];
for (const prose of forbiddenProse) {
  assert.equal(classifyGrokFreeLimit(prose), null, `ordinary prose must not classify: ${prose}`);
}

assert.equal(classifyGrokFreeLimit(''), null);
assert.equal(classifyGrokFreeLimit(null), null);

console.log('provider-quota-classifier tests passed');

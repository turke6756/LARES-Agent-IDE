import assert from 'node:assert/strict';
import { addProviderAutoApproveFlag } from './provider-auto-approve';

assert.deepEqual(addProviderAutoApproveFlag('grok', []), ['--always-approve']);
assert.deepEqual(addProviderAutoApproveFlag('agy', []), ['--dangerously-skip-permissions']);
assert.deepEqual(addProviderAutoApproveFlag('claude', ['--model', 'opus']), ['--model', 'opus']);

const existing = ['--always-approve'];
assert.equal(addProviderAutoApproveFlag('grok', existing), existing);
assert.deepEqual(existing, ['--always-approve']);

console.log('provider-auto-approve tests passed');

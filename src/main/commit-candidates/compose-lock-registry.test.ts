import assert from 'node:assert/strict';

import { ComposeLockRegistry } from './compose-lock-registry';

const locks = new ComposeLockRegistry();
const first = locks.tryAcquire('repo-a');
assert.ok(first, 'first repository acquisition succeeds synchronously');
assert.equal(locks.isHeld('repo-a'), true);
assert.equal(locks.tryAcquire('repo-a'), null, 'same repository is exclusive');

const other = locks.tryAcquire('repo-b');
assert.ok(other, 'different repositories do not block each other');

first.release();
first.release();
assert.equal(locks.isHeld('repo-a'), false, 'release is idempotent');
assert.ok(locks.tryAcquire('repo-a'), 'released repository can be reacquired');

other.release();
console.log('compose-lock-registry: 4 assertions passed');

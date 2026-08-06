import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStrictJson, StrictJsonError } from './strict-json';

test('parseStrictJson accepts ordinary JSON', () => {
  assert.deepEqual(parseStrictJson('{"a":1,"nested":{"b":[true,null]}}'), {
    a: 1,
    nested: { b: [true, null] },
  });
});

test('parseStrictJson rejects duplicate keys at every object depth', () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), StrictJsonError);
  assert.throws(() => parseStrictJson('{"outer":{"a":1,"a":2}}'), StrictJsonError);
});

test('parseStrictJson rejects comments and trailing commas', () => {
  assert.throws(() => parseStrictJson('{/* comment */"a":1}'), StrictJsonError);
  assert.throws(() => parseStrictJson('{"a":1,}'), StrictJsonError);
});

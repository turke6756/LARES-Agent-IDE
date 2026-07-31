// RFC 8785 JSON Canonicalization Scheme encoder tests.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/jcs.test.js

import assert from 'node:assert/strict';

import { canonicalize } from './jcs';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

function doubleFromBits(hex: string): number {
  const bytes = Buffer.from(hex, 'hex');
  assert.equal(bytes.length, 8);
  return bytes.readDoubleBE(0);
}

test('RFC 8785 section 3.2.2/3.2.3 full canonical example', () => {
  const input = JSON.parse(String.raw`{
    "numbers": [333333333.33333329, 1E30, 4.50,
                2e-3, 0.000000000000000000000000001],
    "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
    "literals": [null, true, false]
  }`);
  const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
  assert.equal(canonicalize(input), expected);
});

test('RFC 8785 Appendix B number serialization samples', () => {
  const samples: Array<[string, string]> = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];

  for (const [bits, expected] of samples) {
    assert.equal(canonicalize(doubleFromBits(bits)), expected, bits);
  }
  assert.equal(canonicalize(1e+30), '1e+30');
  assert.equal(canonicalize(9007199254740996), '9007199254740996');
});

test('RFC 8785 UTF-16 property ordering vector', () => {
  const input = {
    '\u20ac': 'Euro Sign',
    '\r': 'Carriage Return',
    '\ufb33': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '\ud83d\ude00': 'Emoji: Grinning Face',
    '\u0080': 'Control',
    '\u00f6': 'Latin Small Letter O With Diaeresis',
  };
  const expected = String.raw`{"\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}`;
  assert.equal(canonicalize(input), expected);
});

test('strings use minimal RFC escapes and preserve Unicode without normalization', () => {
  const input = '\b\t\n\f\r\u0000\u001f"\\/é/e\u0301';
  const expected = String.raw`"\b\t\n\f\r\u0000\u001f\"\\/é/é"`;
  assert.equal(canonicalize(input), expected);
});

test('nested objects are stable while array order is preserved', () => {
  const first = {
    z: [{ b: 2, a: 1 }, 3],
    a: { d: { y: 2, x: 1 }, c: true },
  };
  const second = {
    a: { c: true, d: { x: 1, y: 2 } },
    z: [{ a: 1, b: 2 }, 3],
  };
  const expected = '{"a":{"c":true,"d":{"x":1,"y":2}},"z":[{"a":1,"b":2},3]}';
  assert.equal(canonicalize(first), expected);
  assert.equal(canonicalize(second), expected);
});

test('rejects non-JSON primitive values at every depth', () => {
  const invalid: unknown[] = [
    undefined,
    () => undefined,
    Symbol('value'),
    1n,
    { value: undefined },
    [undefined],
    { value: () => undefined },
    { value: Symbol('value') },
  ];
  for (const value of invalid) {
    assert.throws(() => canonicalize(value), TypeError);
  }
});

test('rejects non-finite numbers', () => {
  for (const value of [NaN, Infinity, -Infinity, { value: NaN }, [Infinity]]) {
    assert.throws(() => canonicalize(value), /NaN or Infinity/);
  }
});

test('rejects lone surrogates in values and property names', () => {
  for (const value of ['\ud800', '\udc00', { ['bad\ud800']: true }]) {
    assert.throws(() => canonicalize(value), /lone Unicode surrogate/);
  }
});

test('rejects structures that JSON.stringify would silently alter or omit', () => {
  const sparse = new Array(1);
  const withSymbolKey = { ok: true, [Symbol('hidden')]: false };
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;

  assert.throws(() => canonicalize(sparse), /sparse arrays/);
  assert.throws(() => canonicalize(withSymbolKey), /symbol properties/);
  assert.throws(() => canonicalize(new Date(0)), /plain JSON objects/);
  assert.throws(() => canonicalize(cyclic), /cyclic data/);
});

let passed = 0;
let failed = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error('       ', error instanceof Error ? error.stack || error.message : error);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

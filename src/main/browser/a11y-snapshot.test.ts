// WP2-A acceptance tests — a11y ref-staleness (pure ref-map logic) and
// snapshot formatting. NO Electron objects (testing ground rule).
//
//   npm run build:main
//   node dist/main/main/browser/a11y-snapshot.test.js

import assert from 'node:assert/strict';
import {
  buildA11ySnapshot,
  MAX_SNAPSHOT_CHARS,
  RefRegistry,
  StaleRefError,
  UnknownRefError,
  type RawAXNode,
} from './a11y-snapshot';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

function page(nodes: Array<Partial<RawAXNode> & { nodeId: string }>): RawAXNode[] {
  return nodes as RawAXNode[];
}

const SIMPLE_PAGE = page([
  {
    nodeId: '1',
    role: { value: 'RootWebArea' },
    name: { value: 'Example Page' },
    childIds: ['2', '3', '4', '5'],
  },
  { nodeId: '2', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 101 },
  { nodeId: '3', role: { value: 'link' }, name: { value: 'Help' }, backendDOMNodeId: 102 },
  { nodeId: '4', role: { value: 'StaticText' }, name: { value: 'Welcome back' } },
  // Nameless generic container with a nested textbox: container flattened,
  // child promoted.
  { nodeId: '5', role: { value: 'generic' }, childIds: ['6', '7'] },
  {
    nodeId: '6',
    role: { value: 'textbox' },
    name: { value: 'Email' },
    value: { value: 'a@b.c' },
    backendDOMNodeId: 103,
  },
  { nodeId: '7', ignored: true, role: { value: 'generic' } },
]);

// ── snapshot formatting ─────────────────────────────────────────────────────

test('buildA11ySnapshot: interactable nodes get [n] refs; text and roles rendered', () => {
  const reg = new RefRegistry();
  const text = buildA11ySnapshot(SIMPLE_PAGE, reg);
  assert.match(text, /\[1\] button "Sign in"/);
  assert.match(text, /\[2\] link "Help"/);
  assert.match(text, /\[3\] textbox "Email" value="a@b\.c"/);
  assert.match(text, /statictext "Welcome back"/);
  // Static text and the root get NO refs.
  assert.ok(!/\[\d+\] statictext/.test(text));
  // The nameless generic container and the ignored node are flattened away.
  assert.ok(!/generic/.test(text));
});

test('buildA11ySnapshot: refs resolve to the CDP backend DOM node ids', () => {
  const reg = new RefRegistry();
  buildA11ySnapshot(SIMPLE_PAGE, reg);
  assert.equal(reg.resolve(1), 101); // Sign in
  assert.equal(reg.resolve(2), 102); // Help
  assert.equal(reg.resolve(3), 103); // Email
});

test('buildA11ySnapshot: output capped with a truncation marker', () => {
  const big: RawAXNode[] = [
    {
      nodeId: 'root',
      role: { value: 'RootWebArea' },
      childIds: Array.from({ length: 5000 }, (_, i) => `c${i}`),
    },
    ...Array.from({ length: 5000 }, (_, i) => ({
      nodeId: `c${i}`,
      role: { value: 'button' },
      name: { value: `button number ${i} with a long descriptive label` },
      backendDOMNodeId: 1000 + i,
    })),
  ];
  const reg = new RefRegistry();
  const text = buildA11ySnapshot(big, reg);
  assert.ok(text.length <= MAX_SNAPSHOT_CHARS + 100, 'capped near MAX_SNAPSHOT_CHARS');
  assert.match(text, /snapshot truncated/);
});

// ── ref staleness (the acceptance case) ─────────────────────────────────────

test('RefRegistry: a ref from a previous snapshot generation throws StaleRefError', () => {
  const reg = new RefRegistry();
  buildA11ySnapshot(SIMPLE_PAGE, reg);
  assert.equal(reg.resolve(1), 101); // fresh: resolves

  // The page is re-read (new generation) — e.g. after a click.
  buildA11ySnapshot(SIMPLE_PAGE, reg);

  assert.throws(
    () => reg.resolve(1),
    (err: unknown) => {
      assert.ok(err instanceof StaleRefError, 'typed StaleRefError');
      assert.equal((err as StaleRefError).code, 'stale-ref');
      assert.match((err as Error).message, /readPage again/i, 'tells the agent to re-read');
      return true;
    },
  );
});

test('RefRegistry: refs are monotonic across generations — old numbers never alias new elements', () => {
  const reg = new RefRegistry();
  buildA11ySnapshot(SIMPLE_PAGE, reg); // gen 1: refs 1..3
  const gen2Text = buildA11ySnapshot(SIMPLE_PAGE, reg); // gen 2: refs 4..6
  assert.match(gen2Text, /\[4\] button "Sign in"/);
  assert.equal(reg.resolve(4), 101);
  // Every gen-1 ref is stale, not remapped.
  for (const old of [1, 2, 3]) {
    assert.throws(() => reg.resolve(old), StaleRefError, `ref ${old} must be stale`);
  }
});

test('RefRegistry: a never-issued ref throws UnknownRefError (distinct from stale)', () => {
  const reg = new RefRegistry();
  buildA11ySnapshot(SIMPLE_PAGE, reg);
  assert.throws(() => reg.resolve(999), UnknownRefError);
  assert.throws(() => reg.resolve(0), UnknownRefError);
  assert.throws(() => reg.resolve(-1), UnknownRefError);
  assert.throws(() => reg.resolve(1.5), UnknownRefError);
});

test('RefRegistry: resolve before any snapshot throws UnknownRefError', () => {
  const reg = new RefRegistry();
  assert.throws(() => reg.resolve(1), UnknownRefError);
});

test('buildA11ySnapshot: cyclic childIds do not hang (defensive)', () => {
  const cyclic = page([
    { nodeId: 'a', role: { value: 'button' }, name: { value: 'A' }, backendDOMNodeId: 1, childIds: ['b'] },
    { nodeId: 'b', role: { value: 'button' }, name: { value: 'B' }, backendDOMNodeId: 2, childIds: ['a'] },
  ]);
  const reg = new RefRegistry();
  const text = buildA11ySnapshot(cyclic, reg);
  assert.match(text, /"A"/);
});

// ── Run ─────────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err instanceof Error ? err.stack : String(err));
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} a11y-snapshot tests passed`);

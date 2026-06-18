// WP6-KEYS acceptance tests — pure `mapChord` helper only, NO Electron runtime
// (the before-input-event wiring + routeShortcut glue is verified at the human
// gate). Mirrors the context-menu.test.ts / browser-decisions.test.ts plain-node
// harness.
//
//   npm run build:main
//   node dist/main/main/browser/manager-shortcuts.test.js

import assert from 'node:assert/strict';
import { mapChord, type ChordInput } from './browser-manager';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** Ctrl-modified key-down chord (Windows/Linux primary modifier). */
function ctrl(key: string, over: Partial<ChordInput> = {}): ChordInput {
  return { type: 'keyDown', key, control: true, ...over };
}
/** Cmd/meta-modified key-down chord (macOS primary modifier). */
function meta(key: string, over: Partial<ChordInput> = {}): ChordInput {
  return { type: 'keyDown', key, meta: true, ...over };
}

// ── Structural chords ────────────────────────────────────────────────────────

test('Ctrl+T → new-tab; Ctrl+Shift+T → reopen-closed', () => {
  assert.equal(mapChord(ctrl('t')), 'new-tab');
  assert.equal(mapChord(ctrl('t', { shift: true })), 'reopen-closed');
});

test('Ctrl+W → close-tab; Ctrl+Shift+W is NOT claimed', () => {
  assert.equal(mapChord(ctrl('w')), 'close-tab');
  assert.equal(mapChord(ctrl('w', { shift: true })), null);
});

test('Ctrl+R and bare F5 → reload', () => {
  assert.equal(mapChord(ctrl('r')), 'reload');
  assert.equal(mapChord({ type: 'keyDown', key: 'F5' }), 'reload');
});

test('Ctrl+Tab → cycle-next; Ctrl+Shift+Tab → cycle-prev', () => {
  assert.equal(mapChord(ctrl('Tab')), 'cycle-next');
  assert.equal(mapChord(ctrl('Tab', { shift: true })), 'cycle-prev');
});

test('zoom chords: +/=/-/_/0', () => {
  assert.equal(mapChord(ctrl('+')), 'zoom-in');
  assert.equal(mapChord(ctrl('=')), 'zoom-in');
  assert.equal(mapChord(ctrl('-')), 'zoom-out');
  assert.equal(mapChord(ctrl('_')), 'zoom-out');
  assert.equal(mapChord(ctrl('0')), 'zoom-reset');
});

// ── UI-reaction chords ───────────────────────────────────────────────────────

test('Ctrl+L/F/H/D → focus-address/find/history/bookmark', () => {
  assert.equal(mapChord(ctrl('l')), 'focus-address');
  assert.equal(mapChord(ctrl('f')), 'find');
  assert.equal(mapChord(ctrl('h')), 'history');
  assert.equal(mapChord(ctrl('d')), 'bookmark');
});

// ── Modifier discipline ──────────────────────────────────────────────────────

test('Cmd/meta works as the primary modifier (macOS)', () => {
  assert.equal(mapChord(meta('t')), 'new-tab');
  assert.equal(mapChord(meta('f')), 'find');
});

test('no modifier → null (bare keys are never chords, except F5)', () => {
  assert.equal(mapChord({ type: 'keyDown', key: 't' }), null);
  assert.equal(mapChord({ type: 'keyDown', key: 'f' }), null);
});

test('Alt-bearing combos are never claimed', () => {
  assert.equal(mapChord(ctrl('t', { alt: true })), null);
  assert.equal(mapChord(meta('f', { alt: true })), null);
});

test('only key-down fires (key-up ignored)', () => {
  assert.equal(mapChord(ctrl('t', { type: 'keyUp' })), null);
});

test('unknown keys → null', () => {
  assert.equal(mapChord(ctrl('q')), null);
  assert.equal(mapChord(ctrl('a')), null);
});

test('F5 carrying a modifier is not the bare-reload path (still maps via Ctrl+R rules only)', () => {
  // F5 + Ctrl is not a recognized chord (we only claim bare F5).
  assert.equal(mapChord({ type: 'keyDown', key: 'F5', control: true }), null);
});

// ── Runner ───────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${t.name}`);
    console.error(err);
  }
}
console.log(`\nmanager-shortcuts.test: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);

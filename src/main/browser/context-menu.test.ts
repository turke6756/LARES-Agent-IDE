// WP6-CTX-MAIN acceptance tests — pure template builder only, NO Electron
// runtime objects (the Menu.buildFromTemplate/popup glue is verified at the
// human gate). Mirrors the browser-decisions.test.ts plain-node harness.
//
//   npm run build:main
//   node dist/main/main/browser/context-menu.test.js

import assert from 'node:assert/strict';
import { buildContextMenuTemplate } from './context-menu';
import type { BrowserContextMenuParams } from '../../shared/browser';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** Build params with sensible defaults; override per case. */
function params(over: Partial<BrowserContextMenuParams> = {}): BrowserContextMenuParams {
  return {
    tabId: 't1',
    x: 0,
    y: 0,
    linkURL: '',
    srcURL: '',
    selectionText: '',
    isEditable: false,
    canGoBack: false,
    canGoForward: false,
    mediaType: 'none',
    ...over,
  };
}

const ids = (tmpl: Electron.MenuItemConstructorOptions[]): string[] =>
  tmpl.map((t) => t.id).filter((id): id is string => typeof id === 'string');

// ── Partition gating ────────────────────────────────────────────────────────

test('agent partition: NO bookmark-page item', () => {
  const tmpl = buildContextMenuTemplate(params(), { partition: 'agent' });
  assert.ok(!ids(tmpl).includes('bookmark-page'), 'agent template must not offer Bookmark this page');
});

test('agent partition: NO devtools/inspect item (M9)', () => {
  const tmpl = buildContextMenuTemplate(params(), { partition: 'agent' });
  assert.ok(!ids(tmpl).includes('inspect'), 'agent template must not offer Inspect');
  // belt-and-braces: no label mentions DevTools/Inspect either
  const labels = tmpl.map((t) => (typeof t.label === 'string' ? t.label.toLowerCase() : ''));
  assert.ok(!labels.some((l) => l.includes('inspect') || l.includes('devtools')));
});

test('user partition: INCLUDES bookmark-page item', () => {
  const tmpl = buildContextMenuTemplate(params(), { partition: 'user' });
  assert.ok(ids(tmpl).includes('bookmark-page'), 'user template must offer Bookmark this page');
});

test('user partition: includes inspect item', () => {
  const tmpl = buildContextMenuTemplate(params(), { partition: 'user' });
  assert.ok(ids(tmpl).includes('inspect'));
});

// ── Link items conditional on linkURL ───────────────────────────────────────

test('no linkURL: NO open-link-new-tab / copy-link items', () => {
  const tmpl = buildContextMenuTemplate(params({ linkURL: '' }), { partition: 'user' });
  const got = ids(tmpl);
  assert.ok(!got.includes('open-link-new-tab'));
  assert.ok(!got.includes('copy-link'));
});

test('with linkURL: open-link-new-tab + copy-link present', () => {
  const tmpl = buildContextMenuTemplate(
    params({ linkURL: 'https://example.com/page' }),
    { partition: 'user' },
  );
  const got = ids(tmpl);
  assert.ok(got.includes('open-link-new-tab'));
  assert.ok(got.includes('copy-link'));
});

// ── Selection items conditional on selectionText ────────────────────────────

test('no selectionText: NO copy / search-selection items', () => {
  const tmpl = buildContextMenuTemplate(params({ selectionText: '' }), { partition: 'user' });
  const got = ids(tmpl);
  assert.ok(!got.includes('copy'));
  assert.ok(!got.includes('search-selection'));
});

test('with selectionText: copy + search-selection present', () => {
  const tmpl = buildContextMenuTemplate(
    params({ selectionText: 'hello world' }),
    { partition: 'user' },
  );
  const got = ids(tmpl);
  assert.ok(got.includes('copy'));
  assert.ok(got.includes('search-selection'));
});

// ── Always-present navigation ────────────────────────────────────────────────

test('navigation items always present; back/forward reflect capability flags', () => {
  const tmpl = buildContextMenuTemplate(
    params({ canGoBack: true, canGoForward: false }),
    { partition: 'user' },
  );
  const byId = new Map(tmpl.filter((t) => t.id).map((t) => [t.id, t]));
  assert.equal(byId.get('nav-back')?.enabled, true);
  assert.equal(byId.get('nav-forward')?.enabled, false);
  assert.ok(byId.has('reload'));
});

// ── Slice 13: Save link/image as… — USER partition only ──────────────────────

test('user partition: save-link-as present when a linkURL exists', () => {
  const tmpl = buildContextMenuTemplate(
    params({ linkURL: 'https://x.test/a.zip' }),
    { partition: 'user' },
  );
  assert.ok(ids(tmpl).includes('save-link-as'), 'user template offers Save Link As…');
});

test('user partition: save-image-as present for an image srcURL', () => {
  const tmpl = buildContextMenuTemplate(
    params({ srcURL: 'https://x.test/img.png', mediaType: 'image' }),
    { partition: 'user' },
  );
  assert.ok(ids(tmpl).includes('save-image-as'), 'user template offers Save Image As…');
});

test('user partition: NO save-image-as for a non-image srcURL', () => {
  const tmpl = buildContextMenuTemplate(
    params({ srcURL: 'https://x.test/clip.mp4', mediaType: 'video' }),
    { partition: 'user' },
  );
  assert.ok(!ids(tmpl).includes('save-image-as'), 'only images get Save Image As…');
});

test('agent partition: NO save link/image item (downloads are allowlist-gated, never human-confirmed)', () => {
  const tmpl = buildContextMenuTemplate(
    params({ linkURL: 'https://x.test/a.zip', srcURL: 'https://x.test/img.png', mediaType: 'image' }),
    { partition: 'agent' },
  );
  const got = ids(tmpl);
  assert.ok(!got.includes('save-link-as'), 'agent template must not offer Save Link As…');
  assert.ok(!got.includes('save-image-as'), 'agent template must not offer Save Image As…');
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
console.log(`\ncontext-menu.test: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);

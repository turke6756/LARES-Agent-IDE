// Slice-6 acceptance tests (plans/premium-browser-experience.md §"Slice 6").
// Pure functions only — the suggester reads injected fixtures, NO Electron / DB.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/browser/omnibox-suggest.test.js

import assert from 'node:assert/strict';
import type { Bookmark, HistoryEntry } from '../../shared/browser';
import { resolveBrowserInput } from '../../shared/browser-input';
import {
  configureOmniboxSources,
  suggest,
  type OmniboxOpenTab,
  type OmniboxSources,
} from './omnibox-suggest';

interface TestCase {
  name: string;
  run(): void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── fixtures ────────────────────────────────────────────────────────────────
function bm(partial: Partial<Bookmark>): Bookmark {
  return {
    id: partial.id ?? 'b1',
    title: partial.title ?? '',
    url: partial.url ?? 'https://example.com/',
    createdAt: partial.createdAt ?? 0,
    sortOrder: partial.sortOrder ?? 0,
  };
}
function hist(partial: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: partial.id ?? 'h1',
    url: partial.url ?? 'https://example.com/',
    title: partial.title ?? '',
    visitedAt: partial.visitedAt ?? 0,
    visitCount: partial.visitCount ?? 1,
  };
}
function tab(partial: Partial<OmniboxOpenTab>): OmniboxOpenTab {
  return {
    tabId: partial.tabId ?? 't1',
    url: partial.url ?? 'https://example.com/',
    title: partial.title ?? '',
    partition: partial.partition ?? 'user',
    workspaceId: partial.workspaceId ?? null,
  };
}
function withSources(sources: Partial<OmniboxSources>, fn: () => void): void {
  configureOmniboxSources(() => ({
    openTabs: sources.openTabs ?? [],
    bookmarks: sources.bookmarks ?? [],
    history: sources.history ?? [],
  }));
  try {
    fn();
  } finally {
    configureOmniboxSources(() => ({ openTabs: [], bookmarks: [], history: [] }));
  }
}

// ── REQUIRED: shared resolver ─────────────────────────────────────────────────

test('REQUIRED: "open ai docs" resolves to a Google search, not https://open ai docs', () => {
  const r = resolveBrowserInput('open ai docs');
  assert.equal(r.kind, 'search');
  assert.ok(r.url.startsWith('https://www.google.com/search?q='), r.url);
  assert.ok(!r.url.includes('open ai docs'), 'spaces are encoded, never a bare host');
  assert.ok(r.url.includes(encodeURIComponent('open ai docs')));
});

test('REQUIRED: URL-like input still defaults to https://', () => {
  assert.deepEqual(resolveBrowserInput('github.com'), {
    kind: 'url',
    url: 'https://github.com',
    display: 'github.com',
  });
  // an explicit scheme passes through untouched
  assert.equal(resolveBrowserInput('http://example.com').url, 'http://example.com');
  // bare localhost is a URL, not a search
  assert.equal(resolveBrowserInput('localhost:3000').kind, 'url');
});

// ── REQUIRED: user-partition only ─────────────────────────────────────────────

test('REQUIRED: suggestions are user-partition only — agent tab URLs never surface', () => {
  withSources(
    {
      openTabs: [
        tab({ tabId: 'u', url: 'https://github.com/explore', title: 'Explore', partition: 'user' }),
        tab({
          tabId: 'a',
          url: 'https://secret-agent-site.example/admin',
          title: 'Agent Admin',
          partition: 'agent',
        }),
      ],
    },
    () => {
      const out = suggest('example', null, 8);
      const urls = out.map((s) => s.url).join(' ');
      assert.ok(!urls.includes('secret-agent-site'), 'agent URL must never appear');
      // the agent tab matched the query but was dropped; the user tab survives
      const tabRows = out.filter((s) => s.kind === 'tab');
      assert.equal(tabRows.length, 0, 'no user tab matched "example"');
    },
  );

  // and a matching USER tab does surface as switch-to-tab
  withSources(
    {
      openTabs: [
        tab({ tabId: 'u', url: 'https://github.com/explore', title: 'Explore', partition: 'user' }),
        tab({ tabId: 'a', url: 'https://github.com/agent', title: 'Agent', partition: 'agent' }),
      ],
    },
    () => {
      const out = suggest('github', null, 8);
      const tabRows = out.filter((s) => s.kind === 'tab');
      assert.equal(tabRows.length, 1, 'only the user tab is a switch-to-tab row');
      assert.equal(tabRows[0].url, 'https://github.com/explore');
    },
  );
});

// ── workspace scoping ─────────────────────────────────────────────────────────

test('open tabs are scoped to the requested workspace', () => {
  withSources(
    {
      openTabs: [
        tab({ url: 'https://github.com/ws-a', title: 'A', partition: 'user', workspaceId: 'A' }),
        tab({ url: 'https://github.com/ws-b', title: 'B', partition: 'user', workspaceId: 'B' }),
      ],
    },
    () => {
      const out = suggest('github', 'A', 8).filter((s) => s.kind === 'tab');
      assert.equal(out.length, 1);
      assert.equal(out[0].url, 'https://github.com/ws-a');
    },
  );
});

// ── ranking + dedup ───────────────────────────────────────────────────────────

test('empty query returns nothing', () => {
  withSources({ bookmarks: [bm({ url: 'https://x.com', title: 'X' })] }, () => {
    assert.deepEqual(suggest('', null), []);
    assert.deepEqual(suggest('   ', null), []);
  });
});

test('always offers a trailing search fallback', () => {
  withSources({}, () => {
    const out = suggest('hello world', null);
    const search = out.find((s) => s.kind === 'search');
    assert.ok(search, 'a search row is always present');
    assert.ok(search!.url.includes(encodeURIComponent('hello world')));
  });
});

test('adds a direct-URL row only when input parses as a host', () => {
  withSources({}, () => {
    const urlRow = suggest('github.com', null).find((s) => s.kind === 'url');
    assert.ok(urlRow, 'host-like input gets a direct-URL row');
    assert.equal(urlRow!.url, 'https://github.com');

    const noUrlRow = suggest('just words', null).find((s) => s.kind === 'url');
    assert.equal(noUrlRow, undefined, 'free text gets no direct-URL row');
  });
});

test('ranking: open tab outranks bookmark outranks history outranks search', () => {
  withSources(
    {
      openTabs: [tab({ url: 'https://acme.test/tab', title: 'acme tab', partition: 'user' })],
      bookmarks: [bm({ url: 'https://acme.test/bm', title: 'acme bm' })],
      history: [hist({ url: 'https://acme.test/h', title: 'acme h', visitCount: 9 })],
    },
    () => {
      const out = suggest('acme', null, 8);
      const kinds = out.map((s) => s.kind);
      assert.equal(kinds[0], 'tab', `tab first, got ${kinds.join(',')}`);
      assert.ok(kinds.indexOf('bookmark') < kinds.indexOf('history'), 'bookmark before history');
      assert.equal(kinds[kinds.length - 1], 'search', 'search is the last resort');
    },
  );
});

test('dedup: same URL across sources collapses to the highest-scored row', () => {
  withSources(
    {
      bookmarks: [bm({ url: 'https://dup.test/', title: 'Dup BM' })],
      history: [hist({ url: 'https://dup.test', title: 'Dup History', visitCount: 50 })],
    },
    () => {
      const out = suggest('dup', null, 8);
      const dupRows = out.filter((s) => s.url.includes('dup.test'));
      assert.equal(dupRows.length, 1, 'collapsed to one row');
      assert.equal(dupRows[0].kind, 'bookmark', 'bookmark (higher base) wins over history');
    },
  );
});

test('history frequency ordering is preserved among history rows', () => {
  withSources(
    {
      // provider gives them already ranked (freq desc); suggest must not reorder
      history: [
        hist({ url: 'https://news.test/a', title: 'news a', visitCount: 100 }),
        hist({ url: 'https://news.test/b', title: 'news b', visitCount: 2 }),
      ],
    },
    () => {
      const hRows = suggest('news', null, 8).filter((s) => s.kind === 'history');
      assert.equal(hRows[0].url, 'https://news.test/a');
      assert.equal(hRows[1].url, 'https://news.test/b');
    },
  );
});

test('respects the limit', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    bm({ id: `b${i}`, url: `https://site${i}.test/`, title: `site ${i}` }),
  );
  withSources({ bookmarks: many }, () => {
    assert.equal(suggest('site', null, 5).length, 5);
  });
});

// ── Run ───────────────────────────────────────────────────────────────────────
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
console.log(`\nAll ${tests.length} omnibox-suggest tests passed`);

// Slice 14 — Reading mode (MAIN side) tests. Two load-bearing claims:
//
//   1. SANITIZE: the extracted article HTML is untrusted content, so
//      extractReaderArticle() + enterReadingMode() must strip ALL scripts,
//      inline event handlers (on*), and javascript: URLs — nothing scriptable
//      survives into the renderer reader overlay.
//   2. AGENT ISOLATION: extraction is a trusted, user-tab-only path. It is NOT a
//      member of the BrowserToolProvider facade and is NOT a policy READ_VERB,
//      and enterReadingMode() rejects a non-user / non-http(s) tab — so agent
//      tabs can never reach extraction through the tool policy.
//
// The pure extract+sanitize tests need no Chromium; the manager-path tests reuse
// the same sql.js + electron require.cache injection as browser-manager.test.ts
// (no real WebContentsView — tabs are fabricated and injected, and the live-HTML
// read is faked on the tab's webContents.executeJavaScript seam).
//
//   npm run build:main
//   node dist/main/main/browser/reader-mode.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors browser-manager.test) ──────

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

// ── minimal `electron` stand-in ──────────────────────────────────────────────

function fakeSession(): unknown {
  return {
    setUserAgent() {},
    on() {},
    webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    cookies: { get: async () => [], remove: async () => {} },
    clearStorageData: async () => {},
    downloadURL() {},
  };
}

const electronMock = {
  app: { getPath: () => os.tmpdir() },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  session: { fromPartition: (_partition?: string) => fakeSession() },
  WebContentsView: class {},
};

// ── modules under test (loaded after the cache injections) ───────────────────

type BMModule = typeof import('./browser-manager');
type PolicyModule = typeof import('./browser-policy');
type ExtractModule = typeof import('./reader-extract');
let BM: BMModule;
let policy: PolicyModule;
let extractReaderArticle: ExtractModule['extractReaderArticle'];

// ── fakes for the tab graph (trimmed to the seams enterReadingMode touches) ───

interface FakeWC {
  getURL(): string; getTitle(): string; isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  setURL(url: string): void;
  on(): FakeWC; once(): FakeWC; removeListener(): FakeWC;
  setWindowOpenHandler(): void; setUserAgent(): void; setBackgroundThrottling(): void;
}
function fakeWC(url: string, html: string, title = 'T'): FakeWC {
  let currentUrl = url;
  const wc: FakeWC = {
    getURL: () => currentUrl,
    getTitle: () => title,
    isDestroyed: () => false,
    executeJavaScript: async () => html,
    setURL(next) { currentUrl = next; },
    on() { return wc; },
    once() { return wc; },
    removeListener() { return wc; },
    setWindowOpenHandler() {},
    setUserAgent() {},
    setBackgroundThrottling() {},
  };
  return wc;
}

interface FakeTab {
  id: string; partition: 'agent' | 'user'; partitionFull: string;
  openedByAgent: boolean; workspaceId?: string | null;
  view: { webContents: FakeWC };
}

let tabSeq = 0;
function injectTab(
  mgr: InstanceType<BMModule['BrowserManager']>,
  opts: { partition: 'agent' | 'user'; url: string; html?: string; title?: string },
): FakeTab {
  const id = `tab-${++tabSeq}`;
  const tab: FakeTab = {
    id,
    partition: opts.partition,
    partitionFull: opts.partition === 'agent' ? 'persist:agent' : 'persist:user',
    openedByAgent: false,
    workspaceId: null,
    view: { webContents: fakeWC(opts.url, opts.html ?? '<html><body></body></html>', opts.title) },
  };
  const internals = mgr as unknown as { tabs: Map<string, unknown>; tabOrder: string[] };
  internals.tabs.set(id, tab);
  internals.tabOrder.push(id);
  return tab;
}

function makeManager(): InstanceType<BMModule['BrowserManager']> {
  const win = {
    webContents: { isDestroyed: () => false, send: () => {} },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  const mgr = new BM.BrowserManager(() => win as never, 0);
  (mgr as unknown as { auditWriter: { record(): void } }).auditWriter = { record() {} };
  return mgr;
}

// A hostile article: a <script>, an inline on* handler, and a javascript: URL.
// All three MUST be gone after sanitization.
const HOSTILE_HTML = `<!doctype html><html><head>
  <title>Hostile Title</title>
  <meta name="author" content="Eve Hacker">
  <meta property="og:title" content="Hostile Title">
</head><body>
  <article>
    <h1>Hostile Title</h1>
    <p>Safe paragraph one with several words of body text to measure.</p>
    <script>window.__pwned = 1; alert('xss');</script>
    <p onclick="steal()">Para with an inline handler.</p>
    <a href="javascript:exfiltrate()">click me</a>
    <img src="x" onerror="fetch('//evil')">
    <p>Safe paragraph two, also with a reasonable amount of readable text.</p>
  </article>
</body></html>`;

// ── 1. SANITIZE — pure extractReaderArticle ──────────────────────────────────

test('extractReaderArticle strips <script> tags entirely', () => {
  const art = extractReaderArticle(HOSTILE_HTML, 'https://news.example/post');
  assert.ok(!/<script/i.test(art.html), 'no <script> tag survives');
  assert.ok(!/__pwned/.test(art.html), 'no inline script body survives');
  assert.ok(!/alert\(/.test(art.html), 'no alert() payload survives');
});

test('extractReaderArticle strips inline event handlers (on* attributes)', () => {
  const art = extractReaderArticle(HOSTILE_HTML, 'https://news.example/post');
  assert.ok(!/onclick/i.test(art.html), 'onclick handler removed');
  assert.ok(!/onerror/i.test(art.html), 'onerror handler removed');
  assert.ok(!/\son\w+=/i.test(art.html), 'NO on* attribute of any kind survives');
});

test('extractReaderArticle strips javascript: URLs', () => {
  const art = extractReaderArticle(HOSTILE_HTML, 'https://news.example/post');
  assert.ok(!/javascript:/i.test(art.html), 'no javascript: URL survives');
});

test('extractReaderArticle keeps benign article text + derives title/byline/length', () => {
  const art = extractReaderArticle(HOSTILE_HTML, 'https://news.example/post');
  assert.ok(/Safe paragraph one/.test(art.html), 'benign body text is preserved');
  assert.equal(art.title, 'Hostile Title', 'title extracted (og:title)');
  assert.equal(art.byline, 'Eve Hacker', 'byline extracted (meta author)');
  assert.ok(art.textLength > 0, 'textLength reflects surviving visible text');
});

test('extractReaderArticle tolerates empty / garbage HTML without throwing', () => {
  const empty = extractReaderArticle('', undefined);
  assert.equal(typeof empty.html, 'string');
  assert.equal(empty.textLength, 0);
  const garbage = extractReaderArticle('<<not really html>>', 'not-a-url');
  assert.equal(typeof garbage.html, 'string');
});

// ── 2. AGENT ISOLATION — extraction is unreachable from the tool policy ───────

test('extraction is NOT a member of the BrowserToolProvider (agent tool) facade', () => {
  const mgr = makeManager();
  const toolKeys = Object.keys(mgr.tools as unknown as Record<string, unknown>);
  // No verb on the agent-facing facade reaches reading-mode / extraction.
  for (const key of toolKeys) {
    assert.ok(
      !/read.?mode|reading|extract|article/i.test(key),
      `agent tool facade must not expose extraction (offending key: ${key})`,
    );
  }
  assert.equal(
    (mgr.tools as unknown as Record<string, unknown>).enterReadingMode,
    undefined,
    'enterReadingMode is not callable through the agent tool facade',
  );
});

test('reading mode is NOT a policy READ_VERB (the agent gate has no path to it)', () => {
  const readVerbs = (policy as unknown as { READ_VERBS: readonly string[] }).READ_VERBS;
  assert.ok(!readVerbs.includes('enterReadingMode'), 'no enterReadingMode read-verb');
  assert.ok(
    !readVerbs.some((v) => /read.?mode|reading|extract|article/i.test(v)),
    'no extraction-shaped verb exists in the agent read policy',
  );
});

test('enterReadingMode REJECTS an agent-partition tab (trusted user-tab-only path)', async () => {
  const mgr = makeManager();
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://anything.example/', html: HOSTILE_HTML });
  await assert.rejects(
    () => mgr.enterReadingMode(tab.id),
    /only for user tabs/i,
    'an agent tab can never reach extraction',
  );
});

test('enterReadingMode REJECTS a non-http(s) user tab (self-gate like ZoomControl/user-only features)', async () => {
  const mgr = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'about:blank', html: HOSTILE_HTML });
  await assert.rejects(
    () => mgr.enterReadingMode(tab.id),
    /http\(s\)/i,
    'a non-http(s) user tab is rejected',
  );
});

// ── 2b. The trusted path itself sanitizes (manager → live-HTML read → sanitize)

test('enterReadingMode on an http(s) USER tab returns a SANITIZED article', async () => {
  const mgr = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://news.example/post', html: HOSTILE_HTML });
  const art = await mgr.enterReadingMode(tab.id);
  assert.ok(!/<script/i.test(art.html), 'no script tag in the trusted-path result');
  assert.ok(!/\son\w+=/i.test(art.html), 'no on* handler in the trusted-path result');
  assert.ok(!/javascript:/i.test(art.html), 'no javascript: URL in the trusted-path result');
  assert.ok(/Safe paragraph/.test(art.html), 'benign article text survives');
  assert.equal(art.title, 'Hostile Title');
  assert.equal(art.byline, 'Eve Hacker');
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-mode-'));
  process.env.APPDATA = tmpAppData;
  if (!process.versions.chrome) {
    Object.defineProperty(process.versions, 'chrome', { value: '120.0.0.0', configurable: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const sqliteResolved = require.resolve('better-sqlite3');
  require.cache[sqliteResolved] = {
    id: sqliteResolved, filename: sqliteResolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  const electronResolved = require.resolve('electron');
  require.cache[electronResolved] = {
    id: electronResolved, filename: electronResolved, loaded: true, exports: electronMock,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbm = require('../database') as { initDatabase(): void };
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BM = require('./browser-manager') as BMModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  policy = require('./browser-policy') as PolicyModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  extractReaderArticle = (require('./reader-extract') as ExtractModule).extractReaderArticle;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

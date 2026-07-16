// Phase 5 (BrowserSigninSharing plan §E line 284) — FLAGSHIP INTEGRATION TRACE.
//
// ONE test file that traces the FULL cross-workspace chain end to end, the way
// a real MCP `browser_open_url` call flows in production:
//
//   MCP shim stamps body.agentId from AGENT_ID (env, unforgeable)
//     → POST /api/browser/open-url reads body.agentId
//     → getAgent(agentId).workspaceId              (agent-registry resolution)
//     → openUrl(url, { workspaceId, agentId, agentTitle })
//     → agentPartitionForWorkspace(workspaceId)    (the concrete
//        `persist:agent:<key>` string the manager hands to session.fromPartition)
//
// It proves agent-A's call lands in ws-A's partition and agent-B's in ws-B's
// (the cookie-isolation boundary), that an unresolved / absent agent collapses
// to `persist:agent:default` with NO forged identity stamped, and that a signin
// envelope round-trips whole (200, ok:false), never a 403 or a wrapped snapshot.
//
// The partition deriver asserted here (agentPartitionForWorkspace) is the SAME
// one the manager hands to session.fromPartition — proven directly by
// browser-manager.test.ts Slice-4(a). This file closes the seam between the HTTP
// route's workspace resolution and that deriver.
//
// Harness = HYBRID of api-browser-routes.test.ts (HTTP + fake provider) and the
// migration test's require.cache injection (real ../database + ./browser-manager,
// so getAgent() resolves a real seeded agent row and the partition string is the
// production one).
//
//   npm run build:main
//   node dist/main/main/browser/browser-signin-integration.test.js
//   (expected: all pass — exit 0; a green gate in the supervisor chain.)

import assert from 'node:assert/strict';
import http from 'http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserToolProvider } from '../api-server';
import type { AgentSupervisor } from '../supervisor';
import type { SigninPendingResult } from '../../shared/browser';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors the migration test) ────────

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
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
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
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    };
  }
}

// ── minimal `electron` stand-in (browser-manager needs it at require time) ────

function fakeSession(): unknown {
  return {
    setUserAgent() {},
    on() {},
    webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
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

// ── modules under test (loaded after the cache injections) ────────────────────

type BMModule = typeof import('./browser-manager');
type DbModule = typeof import('../database');
type ApiModule = typeof import('../api-server');
type AuthModule = typeof import('../security/api-auth');
let BM: BMModule;
let DB: DbModule;
let ApiServerCtor: ApiModule['ApiServer'];

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
} as unknown as AgentSupervisor;

// ── Fake provider (copied from api-browser-routes.test.ts) — records every call
//    so the exact {workspaceId, agentId, agentTitle} the route stamps is asserted.

function makeFakeTools(overrides: Partial<BrowserToolProvider> = {}): BrowserToolProvider & { calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    openUrl: async (url: string, opts: { forHuman?: boolean }) => {
      calls.push(['openUrl', url, opts]);
      return { tabId: 'tab-1', url, title: 'Fake Page', partition: opts.forHuman ? 'user' : 'agent' };
    },
    listTabs: () => {
      calls.push(['listTabs']);
      return [{ tabId: 'tab-1', url: 'https://example.com', partition: 'agent' }];
    },
    getPageText: async (tabId: string) => { calls.push(['getPageText', tabId]); return '<<untrusted>>t<</untrusted>>'; },
    readPage: async (tabId: string) => { calls.push(['readPage', tabId]); return '<<untrusted>>p<</untrusted>>'; },
    screenshot: async (tabId: string) => { calls.push(['screenshot', tabId]); return { base64Png: 'aGk=' }; },
    click: async (tabId: string, ref: number) => { calls.push(['click', tabId, ref]); return '<<untrusted>>c<</untrusted>>'; },
    type: async (tabId: string, ref: number, text: string) => { calls.push(['type', tabId, ref, text]); return '<<untrusted>>t<</untrusted>>'; },
    pressKey: async (tabId: string, key: string) => { calls.push(['pressKey', tabId, key]); return '<<untrusted>>k<</untrusted>>'; },
    selectOption: async (tabId: string, ref: number, value: string) => { calls.push(['selectOption', tabId, ref, value]); return '<<untrusted>>s<</untrusted>>'; },
    scroll: async (tabId: string, opts: { ref?: number; dy?: number }) => { calls.push(['scroll', tabId, opts]); return '<<untrusted>>s<</untrusted>>'; },
    goBack: async (tabId: string) => { calls.push(['goBack', tabId]); return '<<untrusted>>b<</untrusted>>'; },
    goForward: async (tabId: string) => { calls.push(['goForward', tabId]); return '<<untrusted>>f<</untrusted>>'; },
    reload: async (tabId: string) => { calls.push(['reload', tabId]); return '<<untrusted>>r<</untrusted>>'; },
    waitFor: async (tabId: string, input: { text: string; timeoutMs?: number }) => { calls.push(['waitFor', tabId, input]); return { found: true, elapsedMs: 1, snapshot: '<<untrusted>>w<</untrusted>>' }; },
    closeTab: async (tabId: string) => { calls.push(['closeTab', tabId]); return { closed: true, tabs: [] }; },
    requestSiteAccess: (input) => { calls.push(['requestSiteAccess', input]); return { requestId: 'req-1', status: 'pending' }; },
    listMyAccessRequests: (agentId: string) => { calls.push(['listMyAccessRequests', agentId]); return []; },
    listSigninPending: (workspaceId: string | null) => { calls.push(['listSigninPending', workspaceId]); return []; },
    ...overrides,
  };
}

// A pending-signin envelope, byte-shape frozen across Phase 2-4 (news.example.com).
const PENDING_ENVELOPE: SigninPendingResult = {
  ok: false,
  status: 'pending_signin',
  origin: 'https://news.example.com',
  requestId: 'ws-1|https://news.example.com',
  message: 'Human sign-in required and in progress; poll browser_list_my_access_requests and retry.',
};

// ── HTTP helpers (copied from api-browser-routes.test.ts) ─────────────────────

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; }

function request(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let TOKEN: string;
let AUTH: Record<string, string>;

async function withServer(
  tools: BrowserToolProvider | undefined,
  fn: (port: number, server: InstanceType<ApiModule['ApiServer']>) => Promise<void>,
): Promise<void> {
  const server = new ApiServerCtor(stubSupervisor, 0, undefined, '127.0.0.1', tools);
  const port = await server.start();
  try {
    await fn(port, server);
  } finally {
    server.stop();
  }
}

// ── Registry seed helpers (REAL resolution path via ../database) ──────────────

let wsCounter = 0;
function seedWorkspace(title: string): { id: string } {
  wsCounter += 1;
  return DB.createWorkspace({ title, path: `/tmp/ws-${wsCounter}`, pathType: 'windows', description: '' });
}
function seedAgent(workspaceId: string, title: string): { id: string; workspaceId: string; title: string } {
  return DB.createAgent({
    workspaceId, title, roleDescription: 'researcher', workingDirectory: '/tmp',
    command: 'echo', tmuxSessionName: null, autoRestartEnabled: true, logPath: '',
  });
}

// ── Cases ─────────────────────────────────────────────────────────────────────

test('agent-A resolves to ws-A: the route stamps ws-A workspace + identity, and that maps to ws-A\'s partition', async () => {
  const wsA = seedWorkspace('WS A');
  const agentA = seedAgent(wsA.id, 'Researcher A');
  const tools = makeFakeTools();
  await withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://x.com', agentId: agentA.id });
    assert.equal(res.status, 200);
    assert.deepEqual(
      tools.calls[0],
      ['openUrl', 'https://x.com', { forHuman: false, workspaceId: wsA.id, agentId: agentA.id, agentTitle: agentA.title }],
      'the route resolves agentId→workspaceId and stamps agentId+agentTitle (never forged from body args)',
    );
    // …and that workspaceId maps to ws-A\'s concrete agent-session partition.
    assert.equal(
      BM.agentPartitionForWorkspace(wsA.id),
      'persist:agent:' + encodeURIComponent(wsA.id),
      'the resolved workspaceId is exactly the partition the manager hands to session.fromPartition',
    );
  });
});

test('agent-B resolves to ws-B: a DIFFERENT partition from ws-A (the cookie-isolation boundary)', async () => {
  const wsA = seedWorkspace('WS A2');
  const wsB = seedWorkspace('WS B2');
  const agentB = seedAgent(wsB.id, 'Researcher B');
  const tools = makeFakeTools();
  await withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://y.com', agentId: agentB.id });
    assert.equal(res.status, 200);
    assert.equal((tools.calls[0][2] as { workspaceId: unknown }).workspaceId, wsB.id, 'B\'s call carries ws-B\'s workspace');
    assert.notEqual(
      BM.agentPartitionForWorkspace(wsA.id),
      BM.agentPartitionForWorkspace(wsB.id),
      'ws-A and ws-B never share a partition — their cookie jars are isolated',
    );
  });
});

test('no agentId → null workspace → persist:agent:default, and NO identity stamped', async () => {
  const tools = makeFakeTools();
  await withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://z.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(
      tools.calls[0],
      ['openUrl', 'https://z.com', { forHuman: false, workspaceId: null }],
      'no agent → workspaceId null, and the route emits NO agentId/agentTitle keys (never undefined-valued)',
    );
    assert.equal(BM.agentPartitionForWorkspace(null), 'persist:agent:default', 'null workspace collapses to the default partition');
  });
});

test('unknown agentId → getAgent returns null → treated as no agent (no identity, default partition)', async () => {
  const tools = makeFakeTools();
  await withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://q.com', agentId: 'no-such-agent' });
    assert.equal(res.status, 200);
    assert.deepEqual(
      tools.calls[0][2],
      { forHuman: false, workspaceId: null },
      'an unresolvable agentId stamps no identity — the route never forges agentId/agentTitle from the body',
    );
  });
});

test('a signin envelope round-trips whole through the route (200, ok:false, not a 403, not a wrapped snapshot)', async () => {
  const wsA = seedWorkspace('WS Signin');
  const agentA = seedAgent(wsA.id, 'Researcher Signin');
  await withServer(makeFakeTools({ openUrl: async () => PENDING_ENVELOPE }), async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://news.example.com', agentId: agentA.id });
    assert.equal(res.status, 200, 'a pending-signin envelope is a normal structured result, never a 403');
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'pending_signin');
    assert.equal(body.origin, 'https://news.example.com');
    assert.equal(body.snapshot, undefined, 'the envelope is forwarded whole — NOT wrapped as { ok:true, snapshot }');
  });
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-signin-integration-'));
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
  DB = require('../database') as DbModule;
  DB.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BM = require('./browser-manager') as BMModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ApiServerCtor = (require('../api-server') as ApiModule).ApiServer;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  TOKEN = (require('../security/api-auth') as AuthModule).getApiToken();
  AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

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

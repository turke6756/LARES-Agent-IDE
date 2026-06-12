// WP2-B (plans/embedded-browser-implementation-tasks.md) — /api/browser/*
// route tests against a FAKE BrowserToolProvider (the frozen WP2 contract;
// never the real browser manager — compiled-node tests can't construct
// Electron objects). Covers: 401 without token (M1 admission applies to the
// browser routes), 503 when no provider is wired, PolicyError → 403 with the
// policy message, happy-path serialization for all six routes, and the
// setBrowserTools late-injection seam used by production wiring.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-browser-routes.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer, BrowserToolProvider } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
} as unknown as AgentSupervisor;

// ── Fake provider implementing the frozen contract ──────────────────────────

/** Mirrors WP2-A's typed policy error: detection in api-server.ts is by
 *  `name === 'PolicyError'`, deliberately not by class identity, so the two
 *  halves stay decoupled. */
class FakePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

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
    getPageText: async (tabId: string) => {
      calls.push(['getPageText', tabId]);
      return '<<untrusted>>hello text<</untrusted>>';
    },
    readPage: async (tabId: string) => {
      calls.push(['readPage', tabId]);
      return '<<untrusted>>[1] button "OK"<</untrusted>>';
    },
    screenshot: async (tabId: string) => {
      calls.push(['screenshot', tabId]);
      return { base64Png: 'aGVsbG8=' };
    },
    click: async (tabId: string, ref: number) => {
      calls.push(['click', tabId, ref]);
      return '<<untrusted>>[1] button "OK" (clicked)<</untrusted>>';
    },
    ...overrides,
  };
}

// ── HTTP helpers (api-auth.test.ts pattern + request bodies) ────────────────

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; }

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Res> {
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

async function withServer(
  tools: BrowserToolProvider | undefined,
  fn: (port: number, server: ApiServer) => Promise<void>,
): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1', tools);
  const port = await server.start();
  try {
    await fn(port, server);
  } finally {
    server.stop();
  }
}

const TOKEN = getApiToken();
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// ── M1 admission applies to browser routes ──────────────────────────────────

test('no Authorization on /api/browser/tabs → 401 (admission gate covers browser routes)', () =>
  withServer(makeFakeTools(), async (port) => {
    const res = await request(port, 'GET', '/api/browser/tabs', {});
    assert.equal(res.status, 401);
  }));

test('no Authorization on POST /api/browser/open-url → 401, provider never called', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', {}, { url: 'https://example.com' });
    assert.equal(res.status, 401);
    assert.equal(tools.calls.length, 0);
  });
});

// ── 503 when no provider is wired ───────────────────────────────────────────

test('absent provider → 503 with a clear message, on every browser route', () =>
  withServer(undefined, async (port) => {
    const routes: Array<[string, string, unknown?]> = [
      ['POST', '/api/browser/open-url', { url: 'https://example.com' }],
      ['GET', '/api/browser/tabs'],
      ['GET', '/api/browser/tab-1/text'],
      ['GET', '/api/browser/tab-1/page'],
      ['POST', '/api/browser/tab-1/screenshot'],
      ['POST', '/api/browser/tab-1/click', { ref: 1 }],
    ];
    for (const [method, path, body] of routes) {
      const res = await request(port, method, path, AUTH, body);
      assert.equal(res.status, 503, `${method} ${path} expected 503, got ${res.status}`);
      assert.match(JSON.parse(res.body).error, /Browser tools unavailable/);
    }
  }));

test('setBrowserTools late injection: 503 before, 200 after (production wiring seam)', () =>
  withServer(undefined, async (port, server) => {
    assert.equal((await request(port, 'GET', '/api/browser/tabs', AUTH)).status, 503);
    server.setBrowserTools(makeFakeTools());
    const res = await request(port, 'GET', '/api/browser/tabs', AUTH);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).tabs[0].tabId, 'tab-1');
  }));

// ── PolicyError → 403 ───────────────────────────────────────────────────────

test('provider PolicyError on click → 403, policy message + code intact', () =>
  withServer(
    makeFakeTools({
      click: async () => { throw new FakePolicyError('Browser actions are disabled — the human must enable them in the dashboard.'); },
    }),
    async (port) => {
      const res = await request(port, 'POST', '/api/browser/tab-1/click', AUTH, { ref: 3 });
      assert.equal(res.status, 403);
      const body = JSON.parse(res.body);
      assert.match(body.error, /human must enable/);
      assert.equal(body.code, 'browser-policy-denied');
    },
  ));

test('provider PolicyError on agent open-url (actions toggle off) → 403', () =>
  withServer(
    makeFakeTools({
      openUrl: async () => { throw new FakePolicyError('Agent navigation denied: browser actions toggle is off.'); },
    }),
    async (port) => {
      const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://example.com' });
      assert.equal(res.status, 403);
      assert.match(JSON.parse(res.body).error, /toggle is off/);
    },
  ));

test('non-policy provider error → 500, errno-style codes NOT leaked', () =>
  withServer(
    makeFakeTools({
      getPageText: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); },
    }),
    async (port) => {
      const res = await request(port, 'GET', '/api/browser/tab-1/text', AUTH);
      assert.equal(res.status, 500);
      assert.equal(JSON.parse(res.body).code, undefined);
    },
  ));

// ── Happy paths ─────────────────────────────────────────────────────────────

test('POST open-url: forHuman flag forwarded, snapshot serialized', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, {
      url: 'https://accounts.google.com/consent', forHuman: true,
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.forHuman, true);
    assert.equal(body.snapshot.partition, 'user');
    assert.deepEqual(tools.calls[0], ['openUrl', 'https://accounts.google.com/consent', { forHuman: true }]);
  });
});

test('POST open-url without forHuman → forHuman: false reaches the provider', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://example.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(tools.calls[0], ['openUrl', 'https://example.com', { forHuman: false }]);
  });
});

test('GET text / GET page route to getPageText / readPage with the tabId', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const text = await request(port, 'GET', '/api/browser/tab-9/text', AUTH);
    assert.equal(text.status, 200);
    assert.equal(JSON.parse(text.body).tabId, 'tab-9');
    assert.match(JSON.parse(text.body).text, /hello text/);

    const page = await request(port, 'GET', '/api/browser/tab-9/page', AUTH);
    assert.equal(page.status, 200);
    assert.match(JSON.parse(page.body).page, /button "OK"/);

    assert.deepEqual(tools.calls, [['getPageText', 'tab-9'], ['readPage', 'tab-9']]);
  });
});

test('POST screenshot → { tabId, base64Png }', () =>
  withServer(makeFakeTools(), async (port) => {
    const res = await request(port, 'POST', '/api/browser/tab-1/screenshot', AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { tabId: 'tab-1', base64Png: 'aGVsbG8=' });
  }));

test('POST click → fresh snapshot; ref forwarded as a number', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/tab-1/click', AUTH, { ref: 7 });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.body).snapshot, /clicked/);
    assert.deepEqual(tools.calls[0], ['click', 'tab-1', 7]);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

test('open-url without url → 400; click with non-integer ref → 400', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    assert.equal((await request(port, 'POST', '/api/browser/open-url', AUTH, {})).status, 400);
    assert.equal((await request(port, 'POST', '/api/browser/tab-1/click', AUTH, { ref: 'one' })).status, 400);
    assert.equal((await request(port, 'POST', '/api/browser/tab-1/click', AUTH, { ref: 1.5 })).status, 400);
    assert.equal(tools.calls.length, 0); // validation rejects before the provider
  });
});

// ── Run ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
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
  console.log(`\nAll ${tests.length} api-browser-routes tests passed`);
})();

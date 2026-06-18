// WP2-B (plans/embedded-browser-implementation-tasks.md) — /api/browser/*
// route tests against a FAKE BrowserToolProvider (the frozen WP2 contract;
// never the real browser manager — compiled-node tests can't construct
// Electron objects). Covers: 401 without token (M1 admission applies to the
// browser routes), 503 when no provider is wired, PolicyError → 403 with the
// policy message, happy-path serialization for every route (including the WP-C
// parity verbs), and the setBrowserTools late-injection seam used by
// production wiring.
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
    type: async (tabId: string, ref: number, text: string) => {
      calls.push(['type', tabId, ref, text]);
      return '<<untrusted>>[1] textbox value="typed"<</untrusted>>';
    },
    pressKey: async (tabId: string, key: string) => {
      calls.push(['pressKey', tabId, key]);
      return '<<untrusted>>[1] form (submitted)<</untrusted>>';
    },
    selectOption: async (tabId: string, ref: number, value: string) => {
      calls.push(['selectOption', tabId, ref, value]);
      return '<<untrusted>>[1] combobox value="chosen"<</untrusted>>';
    },
    scroll: async (tabId: string, opts: { ref?: number; dy?: number }) => {
      calls.push(['scroll', tabId, opts]);
      return '<<untrusted>>[1] heading "Lower"<</untrusted>>';
    },
    goBack: async (tabId: string) => {
      calls.push(['goBack', tabId]);
      return '<<untrusted>>[1] heading "Prev page"<</untrusted>>';
    },
    goForward: async (tabId: string) => {
      calls.push(['goForward', tabId]);
      return '<<untrusted>>[1] heading "Next page"<</untrusted>>';
    },
    reload: async (tabId: string) => {
      calls.push(['reload', tabId]);
      return '<<untrusted>>[1] heading "Reloaded"<</untrusted>>';
    },
    waitFor: async (tabId: string, input: { text: string; timeoutMs?: number }) => {
      calls.push(['waitFor', tabId, input]);
      return { found: true, elapsedMs: 12, snapshot: '<<untrusted>>[1] heading "Ready"<</untrusted>>' };
    },
    closeTab: async (tabId: string) => {
      calls.push(['closeTab', tabId]);
      return { closed: true, tabs: [{ tabId: 'tab-2', url: 'https://example.com', partition: 'agent' }] };
    },
    requestSiteAccess: (input) => {
      calls.push(['requestSiteAccess', input]);
      return { requestId: 'req-1', status: 'pending' };
    },
    listMyAccessRequests: (agentId: string) => {
      calls.push(['listMyAccessRequests', agentId]);
      return [{ id: 'req-1', hostname: input_host_for(agentId), status: 'pending', requestedBy: agentId }];
    },
    ...overrides,
  };
}

/** Tiny helper so the fake's my-requests payload varies by agent id (keeps the
 *  route test honest that the id is threaded through). */
function input_host_for(agentId: string): string {
  return `${agentId}.example.com`;
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
    assert.deepEqual(tools.calls[0], ['openUrl', 'https://accounts.google.com/consent', { forHuman: true, workspaceId: null }]);
  });
});

test('POST open-url without forHuman → forHuman: false reaches the provider', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/open-url', AUTH, { url: 'https://example.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(tools.calls[0], ['openUrl', 'https://example.com', { forHuman: false, workspaceId: null }]);
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

// ── WP-C parity routes: happy paths ─────────────────────────────────────────

test('POST type: ref + text forwarded, snapshot returned', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/tab-1/type', AUTH, { ref: 2, text: 'hello' });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.body).snapshot, /typed/);
    assert.deepEqual(tools.calls[0], ['type', 'tab-1', 2, 'hello']);
  });
});

test('POST press-key: key forwarded, snapshot returned', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/tab-1/press-key', AUTH, { key: 'Enter' });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.body).snapshot, /submitted/);
    assert.deepEqual(tools.calls[0], ['pressKey', 'tab-1', 'Enter']);
  });
});

test('POST select-option: ref + value forwarded, snapshot returned', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/tab-1/select-option', AUTH, { ref: 5, value: 'CA' });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.body).snapshot, /chosen/);
    assert.deepEqual(tools.calls[0], ['selectOption', 'tab-1', 5, 'CA']);
  });
});

test('POST scroll: ref-only and dy-only each forward exactly one, snapshot returned', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const byRef = await request(port, 'POST', '/api/browser/tab-1/scroll', AUTH, { ref: 3 });
    assert.equal(byRef.status, 200);
    assert.match(JSON.parse(byRef.body).snapshot, /Lower/);
    assert.deepEqual(tools.calls[0], ['scroll', 'tab-1', { ref: 3 }]);

    const byDy = await request(port, 'POST', '/api/browser/tab-1/scroll', AUTH, { dy: 600 });
    assert.equal(byDy.status, 200);
    assert.deepEqual(tools.calls[1], ['scroll', 'tab-1', { dy: 600 }]);
  });
});

test('POST go-back / go-forward / reload return a fresh snapshot', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const back = await request(port, 'POST', '/api/browser/tab-1/go-back', AUTH);
    assert.equal(back.status, 200);
    assert.match(JSON.parse(back.body).snapshot, /Prev page/);

    const fwd = await request(port, 'POST', '/api/browser/tab-1/go-forward', AUTH);
    assert.equal(fwd.status, 200);
    assert.match(JSON.parse(fwd.body).snapshot, /Next page/);

    const rel = await request(port, 'POST', '/api/browser/tab-1/reload', AUTH);
    assert.equal(rel.status, 200);
    assert.match(JSON.parse(rel.body).snapshot, /Reloaded/);

    assert.deepEqual(tools.calls, [['goBack', 'tab-1'], ['goForward', 'tab-1'], ['reload', 'tab-1']]);
  });
});

test('POST wait-for: text + timeoutMs forwarded; result spread into the body', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/tab-1/wait-for', AUTH, { text: 'Ready', timeoutMs: 8000 });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.tabId, 'tab-1');
    assert.equal(body.found, true);
    assert.equal(body.elapsedMs, 12);
    assert.match(body.snapshot, /Ready/);
    assert.deepEqual(tools.calls[0], ['waitFor', 'tab-1', { text: 'Ready', timeoutMs: 8000 }]);
  });
});

test('POST close: returns the updated agent tab list (no snapshot)', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/tab-1/close', AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.tabId, 'tab-1');
    assert.equal(body.closed, true);
    assert.equal(body.tabs[0].tabId, 'tab-2');
    assert.deepEqual(tools.calls[0], ['closeTab', 'tab-1']);
  });
});

// ── WP-C parity routes: validation + a PolicyError → 403 ─────────────────────

test('WP-C validation: malformed bodies → 400 before the provider is called', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    // type without text
    assert.equal((await request(port, 'POST', '/api/browser/t/type', AUTH, { ref: 1 })).status, 400);
    // type with non-integer ref
    assert.equal((await request(port, 'POST', '/api/browser/t/type', AUTH, { ref: 1.5, text: 'x' })).status, 400);
    // press-key without key
    assert.equal((await request(port, 'POST', '/api/browser/t/press-key', AUTH, {})).status, 400);
    // select-option without value
    assert.equal((await request(port, 'POST', '/api/browser/t/select-option', AUTH, { ref: 1 })).status, 400);
    // scroll with neither ref nor dy
    assert.equal((await request(port, 'POST', '/api/browser/t/scroll', AUTH, {})).status, 400);
    // scroll with BOTH ref and dy
    assert.equal((await request(port, 'POST', '/api/browser/t/scroll', AUTH, { ref: 1, dy: 5 })).status, 400);
    // wait-for without text
    assert.equal((await request(port, 'POST', '/api/browser/t/wait-for', AUTH, {})).status, 400);
    assert.equal(tools.calls.length, 0);
  });
});

test('WP-C: provider PolicyError on type (actions off) → 403 with the message', () =>
  withServer(
    makeFakeTools({
      type: async () => { throw new FakePolicyError('browser actions are disabled (M12 default).'); },
    }),
    async (port) => {
      const res = await request(port, 'POST', '/api/browser/tab-1/type', AUTH, { ref: 1, text: 'x' });
      assert.equal(res.status, 403);
      const body = JSON.parse(res.body);
      assert.match(body.error, /actions are disabled/);
      assert.equal(body.code, 'browser-policy-denied');
    },
  ));

// ── §18 agent-initiated access-request routes ───────────────────────────────

test('POST access/request: forwards fields + stamped agent id, returns { requestId, status }', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    const res = await request(port, 'POST', '/api/browser/access/request', AUTH, {
      hostname: 'docs.example.com',
      reason: 'read the API docs',
      scheme: 'https',
      wantSignedIn: true,
      requestedBy: 'agent-7',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.requestId, 'req-1');
    assert.equal(body.status, 'pending');
    const [verb, input] = tools.calls[0] as [string, Record<string, unknown>];
    assert.equal(verb, 'requestSiteAccess');
    assert.equal(input.hostname, 'docs.example.com');
    assert.equal(input.requestedBy, 'agent-7');
    assert.equal(input.wantSignedIn, true);
  });
});

test('POST access/request: missing hostname or requestedBy → 400, provider never called', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    assert.equal(
      (await request(port, 'POST', '/api/browser/access/request', AUTH, { requestedBy: 'a' })).status,
      400,
    );
    assert.equal(
      (await request(port, 'POST', '/api/browser/access/request', AUTH, { hostname: 'x.com', reason: 'y' })).status,
      400,
    );
    assert.equal(tools.calls.length, 0);
  });
});

test('POST access/request: a store rejection (bad hostname / cap) surfaces as 400', () =>
  withServer(
    makeFakeTools({
      requestSiteAccess: () => { throw new Error('hostname contains a wildcard'); },
    }),
    async (port) => {
      const res = await request(port, 'POST', '/api/browser/access/request', AUTH, {
        hostname: '*.evil.com', reason: 'nope', requestedBy: 'a',
      });
      assert.equal(res.status, 400);
      assert.match(JSON.parse(res.body).error, /wildcard/);
    },
  ));

test('GET access/my-requests: requires agentId, threads it to the provider', () => {
  const tools = makeFakeTools();
  return withServer(tools, async (port) => {
    assert.equal((await request(port, 'GET', '/api/browser/access/my-requests', AUTH)).status, 400);

    const res = await request(port, 'GET', '/api/browser/access/my-requests?agentId=agent-7', AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.requests[0].requestedBy, 'agent-7');
    assert.deepEqual(tools.calls[0], ['listMyAccessRequests', 'agent-7']);
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

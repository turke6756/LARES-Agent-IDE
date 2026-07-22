// api-server-overhead-route.test — analytics-export plan §6 test 8.
//
// Real HTTP against an ApiServer with `./database` and the overhead scan stubbed.
// Pins the GET-only, read-only contract of /api/context-overhead: 405 on any
// mutating verb, 401 unauthenticated, 403 on a scope mismatch (never masked),
// an INVALID_ARGUMENT envelope (never a raw 500) on a failed scan, and no
// absolute path in any error message. Also pins the two structural constraints
// the work item is built around: no non-GET route under /api/context-overhead or
// /api/context-optimizer/, and no route or CLI action for mark-applied /
// sign-derivation (those stay IPC-only and human-gated).
//
//   npm run build:main
//   node dist/main/main/api-server-overhead-route.test.js

import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import nodePath from 'path';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';
import type { OverheadModel, TokenEstimate } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

/* eslint-disable @typescript-eslint/no-var-requires */
const db = require('./database') as Record<string, any>;
const ipcDeps = require('./context-overhead/ipc-deps') as Record<string, any>;
/* eslint-enable @typescript-eslint/no-var-requires */

const USER = 'zqfixtureuser';
const WS_ROOT = `C:\\Users\\${USER}\\Projects\\Demo`;

function est(tokens: number): TokenEstimate {
  return { tokens, bytes: tokens * 4, chars: tokens * 4, method: 'tiktoken-approx', approximate: true };
}

function fixtureModel(workspaceId: string): OverheadModel {
  return {
    workspaceId,
    workspaceRoot: WS_ROOT,
    pathType: 'windows',
    generatedAt: '2026-07-19T18:44:55.123Z',
    estimatorMethod: 'tiktoken-approx',
    agents: [{
      id: 'a1', name: 'worker', kind: 'builtin-worker', lane: 'worker',
      workingDir: `${WS_ROOT}\\.dashboard\\workers\\claude`,
      pathType: 'windows',
      inheritanceChain: [{
        dir: WS_ROOT, scope: 'workspace-ancestor', distanceFromAgentCwd: 3, included: true,
        sources: [],
      }],
      mcpServers: [],
      flatSources: [{
        id: 'ws-claude', kind: 'inherited-claude', label: 'CLAUDE.md',
        resolvedPath: `${WS_ROOT}\\CLAUDE.md`, dedupeKey: `${WS_ROOT}\\CLAUDE.md`,
        sourceScope: 'workspace-ancestor', openable: true, exists: true, inherited: true,
        estimate: est(100), origin: 'walk-up', mutable: 'user-owned',
      }],
      total: est(1000), totalHeaderView: est(800),
      exactness: 'estimated', warnings: [],
    }],
    globalWarnings: [],
  };
}

let scanImpl: (workspaceId: string) => OverheadModel = fixtureModel;

function installStubs(): void {
  scanImpl = fixtureModel;
  db.getWorkspace = (id: string) =>
    (id === 'ws-1' ? { id: 'ws-1', title: 'WS', path: WS_ROOT, pathType: 'windows' } : null);
  db.getAgent = () => null;
  // An asserted X-Workspace-Id makes resolveIdentity look for the workspace's
  // supervisor; without this stub it would reach the real DB handle.
  db.getSupervisorAgent = () => null;
  ipcDeps.runOverheadScan = (workspaceId: string) => {
    const ws = db.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    return scanImpl(workspaceId);
  };
}

const stubSupervisor = {
  getContextStats: () => null, isInputInFlight: () => false, emit: () => false,
} as unknown as AgentSupervisor;

interface Res { status: number; body: string; }
function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  installStubs();
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try { await fn(port); } finally { server.stop(); }
}

const AUTH = { Authorization: `Bearer ${getApiToken()}` };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
const PATH = '/api/context-overhead';

// ── the happy path ────────────────────────────────────────────────────────────

test('authorized GET → 200, ok:true, redacted body', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${PATH}?workspaceId=ws-1`, AUTH);
    assert.equal(res.status, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.workspaceRootDisplay, '$WORKSPACE');
    assert.equal(parsed.data.agents.length, 1);
    assert.ok(parsed.data.systemBaselineNote.includes('floor, not a total'));
    // The route is a redaction boundary, not just a transport.
    assert.equal(/[A-Za-z]:[\\/]/.test(res.body), false, 'a drive prefix crossed the route');
    assert.equal(res.body.includes(USER), false, 'a username crossed the route');
  }));

// ── method + auth guards ──────────────────────────────────────────────────────

for (const method of ['POST', 'PUT', 'PATCH']) {
  test(`${method} ${PATH} → 405 method-not-allowed`, () =>
    withServer(async (port) => {
      const res = await request(port, method, PATH, JSON_AUTH, '{}');
      assert.equal(res.status, 405, res.body);
      assert.equal(JSON.parse(res.body).code, 'method-not-allowed');
    }));
}

test('DELETE is refused too (never reaches a handler)', () =>
  withServer(async (port) => {
    const res = await request(port, 'DELETE', PATH, JSON_AUTH);
    assert.ok(res.status >= 400 && res.status < 500, `DELETE must be refused, got ${res.status}`);
    assert.notEqual(res.status, 200);
  }));

test('missing Authorization → 401', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${PATH}?workspaceId=ws-1`, {});
    assert.equal(res.status, 401, res.body);
  }));

// ── scope + error envelopes ───────────────────────────────────────────────────

test('X-Workspace-Id vs ?workspaceId= mismatch → 403, not masked', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${PATH}?workspaceId=ws-2`,
      { ...AUTH, 'X-Workspace-Id': 'ws-1' });
    assert.equal(res.status, 403, res.body);
    assert.equal(JSON.parse(res.body).code, 'workspace-scope-mismatch');
  }));

test('unknown workspace → INVALID_ARGUMENT envelope, never a raw 500', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${PATH}?workspaceId=nope`, AUTH);
    assert.equal(res.status, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'INVALID_ARGUMENT');
  }));

test('no resolvable workspace scope → 400 invalid-argument', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', PATH, AUTH);
    assert.equal(res.status, 400, res.body);
    assert.equal(JSON.parse(res.body).code, 'invalid-argument');
  }));

test('a path-bearing scan failure is sanitized — no absolute path in the error', () =>
  withServer(async (port) => {
    scanImpl = () => {
      throw new Error(`EACCES: permission denied, open '${WS_ROOT}\\CLAUDE.md'`);
    };
    const res = await request(port, 'GET', `${PATH}?workspaceId=ws-1`, AUTH);
    assert.equal(res.status, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'INVALID_ARGUMENT');
    assert.equal(/[A-Za-z]:[\\/]/.test(res.body), false, 'the route leaked an absolute path');
    assert.equal(res.body.includes(USER), false, 'the route leaked a username');
    assert.ok(parsed.error.message.includes('<path>'), 'the path should be replaced, not the whole message dropped');
    assert.ok(parsed.error.message.includes('EACCES'), 'the non-path part of the message should survive');
  }));

// ── structural constraints (work item hard constraints 1-3) ───────────────────

const REPO_ROOT = nodePath.resolve(__dirname, '..', '..', '..');
const apiServerSrc = fs.readFileSync(nodePath.join(REPO_ROOT, 'src', 'main', 'api-server.ts'), 'utf-8');

test('the route table exposes no non-GET path under context-overhead / context-optimizer', () => {
  // Every occurrence of a matching path literal must sit in a block that 405s any
  // non-GET verb; the guard string is the one the read-only blocks share.
  const guards = apiServerSrc.match(/This is a read-only GET surface/g) ?? [];
  assert.ok(guards.length >= 3, `expected the read-only guard on every such block, found ${guards.length}`);
  // No handler may be keyed on a mutating method for these paths.
  const bad = apiServerSrc.match(
    /method\s*===\s*'(POST|PUT|PATCH|DELETE)'[^\n]*\/api\/context-(overhead|optimizer)/g,
  );
  assert.equal(bad, null, `a mutating handler is bound to a read-only path: ${bad}`);
});

test('no route or CLI action corresponds to mark-applied or sign-derivation', () => {
  for (const forbidden of ['mark-applied', 'sign-derivation']) {
    assert.equal(apiServerSrc.includes(`/api/context-optimizer/${forbidden}`), false,
      `api-server exposes ${forbidden} — it must stay IPC-only and human-gated`);
  }
  const cliPath = nodePath.join(REPO_ROOT, 'src', 'main', 'analytics-export', 'analytics-snapshot-cli.ts');
  if (fs.existsSync(cliPath)) {
    // Strip comments first: the CLI documents that these actions are deliberately
    // absent, and that sentence is the point — what must not exist is executable
    // code (a command name, a branch, a handler) corresponding to either.
    const cli = fs.readFileSync(cliPath, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['mark-applied', 'markApplied', 'sign-derivation', 'signDerivation']) {
      assert.equal(cli.includes(forbidden), false, `the exporter CLI names ${forbidden} in executable code`);
    }
  }
});

test('backfillMode is never read from an HTTP query parameter', () => {
  assert.equal(/searchParams\.get\(\s*['"]backfillMode['"]/.test(apiServerSrc), false,
    'backfillMode became remotely settable — it is exporter-only');
});

// ── runner ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (e) { failed += 1; console.error(`  FAIL  ${t.name}\n`, e); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();

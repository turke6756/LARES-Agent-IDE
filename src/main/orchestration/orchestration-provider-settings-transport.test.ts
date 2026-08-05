import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApiServer } from '../api-server';
import { getApiToken } from '../security/api-auth';
import type { AgentSupervisor } from '../supervisor';
import {
  __resetOrchestrationProviderSettingsForTest,
  OrchestrationProviderSettingsValidationError,
  orchestrationProviderSettingsPath,
} from './orchestration-provider-settings';
import {
  ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS,
  ORCHESTRATION_PROVIDER_SETTINGS_HTTP_PATH,
  onOrchestrationProviderSettingsChanged,
  registerOrchestrationProviderSettingsIpc,
} from './orchestration-provider-settings-transport';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

const FIRST = {
  groupthink: { defaultLeadProvider: 'codex', defaultReviewerProvider: 'grok' },
} as const;
const SECOND = {
  groupthink: { defaultLeadProvider: 'agy', defaultReviewerProvider: 'claude' },
} as const;

interface FakeIpc {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function makeIpc(): FakeIpc {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel, listener) { handlers.set(channel, listener); },
    async invoke(channel, ...args) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No IPC handler for ${channel}`);
      return listener({}, ...args);
    },
  };
}

function withRoots(): { root1: string; root2: string; cleanup(): void } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-provider-transport-'));
  const root1 = path.join(parent, 'one');
  const root2 = path.join(parent, 'two');
  fs.mkdirSync(root1);
  fs.mkdirSync(root2);
  __resetOrchestrationProviderSettingsForTest();
  return {
    root1,
    root2,
    cleanup: () => {
      __resetOrchestrationProviderSettingsForTest();
      fs.rmSync(parent, { recursive: true, force: true });
    },
  };
}

test('IPC get/update round-trips and emits a workspace-tagged changed event', async () => {
  const roots = withRoots();
  const ipc = makeIpc();
  const events: unknown[] = [];
  const off = onOrchestrationProviderSettingsChanged((event) => events.push(event));
  try {
    registerOrchestrationProviderSettingsIpc(
      ipc,
      (workspaceId) => workspaceId === 'ws-1' ? roots.root1 : null,
    );
    assert.deepEqual(
      await ipc.invoke(ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.update, 'ws-1', FIRST),
      FIRST,
    );
    assert.deepEqual(
      await ipc.invoke(ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.get, 'ws-1'),
      FIRST,
    );
    assert.deepEqual(events, [{ workspaceId: 'ws-1', settings: FIRST }]);
  } finally {
    off();
    roots.cleanup();
  }
});

test('invalid IPC update is a typed reject and preserves prior on-disk settings', async () => {
  const roots = withRoots();
  const ipc = makeIpc();
  try {
    registerOrchestrationProviderSettingsIpc(ipc, () => roots.root1);
    await ipc.invoke(ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.update, 'ws-1', FIRST);
    const settingsPath = orchestrationProviderSettingsPath(roots.root1);
    const before = fs.readFileSync(settingsPath, 'utf8');
    await assert.rejects(
      ipc.invoke(ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.update, 'ws-1', {
        groupthink: { defaultLeadProvider: 'gemini', defaultReviewerProvider: 'claude' },
      }),
      (error: unknown) => error instanceof OrchestrationProviderSettingsValidationError
        && error.code === 'INVALID_ORCHESTRATION_PROVIDER_SETTINGS',
    );
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);
    assert.deepEqual(
      await ipc.invoke(ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.get, 'ws-1'),
      FIRST,
    );
  } finally {
    roots.cleanup();
  }
});

interface HttpResult { status: number; body: any; }
function request(
  port: number,
  method: string,
  requestPath: string,
  workspaceId: string,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: requestPath, method, agent: false,
      headers: {
        Authorization: `Bearer ${getApiToken()}`,
        'X-Workspace-Id': workspaceId,
        ...(encoded === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded),
        }),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (encoded !== undefined) req.write(encoded);
    req.end();
  });
}

async function withHttpServer(
  roots: { root1: string; root2: string },
  run: (port: number) => Promise<void>,
): Promise<void> {
  // CommonJS live property reads let the route use isolated fixture workspaces.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, any>;
  const original = { getWorkspace: db.getWorkspace, getSupervisorAgent: db.getSupervisorAgent };
  db.getWorkspace = (id: string) => id === 'ws-1'
    ? { id, title: 'One', path: roots.root1, pathType: 'windows' }
    : id === 'ws-2'
      ? { id, title: 'Two', path: roots.root2, pathType: 'windows' }
      : null;
  db.getSupervisorAgent = () => null;
  const supervisor = {
    getContextStats: () => null,
    isInputInFlight: () => false,
    emit: () => false,
  } as unknown as AgentSupervisor;
  const api = new ApiServer(supervisor, 0, undefined, '127.0.0.1');
  const port = await api.start();
  try {
    await run(port);
  } finally {
    api.stop();
    db.getWorkspace = original.getWorkspace;
    db.getSupervisorAgent = original.getSupervisorAgent;
  }
}

test('HTTP GET/PUT use only X-Workspace-Id and ignore query/body workspace ids', async () => {
  const roots = withRoots();
  try {
    await withHttpServer(roots, async (port) => {
      const put = await request(
        port,
        'PUT',
        `${ORCHESTRATION_PROVIDER_SETTINGS_HTTP_PATH}?workspaceId=ws-2`,
        'ws-1',
        { ...FIRST, workspaceId: 'ws-2' },
      );
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.deepEqual(put.body, FIRST);
      assert.equal(fs.existsSync(orchestrationProviderSettingsPath(roots.root2)), false);

      const get = await request(
        port,
        'GET',
        `${ORCHESTRATION_PROVIDER_SETTINGS_HTTP_PATH}?workspaceId=ws-2`,
        'ws-1',
        { workspaceId: 'ws-2' },
      );
      assert.equal(get.status, 200, JSON.stringify(get.body));
      assert.deepEqual(get.body, FIRST);
    });
  } finally {
    roots.cleanup();
  }
});

test('invalid HTTP update returns 422 and preserves prior settings byte-for-byte', async () => {
  const roots = withRoots();
  try {
    await withHttpServer(roots, async (port) => {
      assert.equal((await request(
        port, 'PUT', ORCHESTRATION_PROVIDER_SETTINGS_HTTP_PATH, 'ws-1', SECOND,
      )).status, 200);
      const settingsPath = orchestrationProviderSettingsPath(roots.root1);
      const before = fs.readFileSync(settingsPath, 'utf8');
      const invalid = await request(
        port,
        'PUT',
        ORCHESTRATION_PROVIDER_SETTINGS_HTTP_PATH,
        'ws-1',
        { groupthink: { defaultLeadProvider: '', defaultReviewerProvider: 'claude' } },
      );
      assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);
      assert.deepEqual(
        (await request(port, 'GET', ORCHESTRATION_PROVIDER_SETTINGS_HTTP_PATH, 'ws-1')).body,
        SECOND,
      );
    });
  } finally {
    roots.cleanup();
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (error) { failed += 1; console.error(`  FAIL  ${t.name}\n`, error); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();

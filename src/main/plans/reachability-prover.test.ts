import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PlanWpReachabilityEvidence, PlanWpReachabilityObligation } from '../database';
import { proveReachability } from './reachability-prover';
import type { ReachabilityTargetRegistry } from './reachability-targets';

type Entry = {
  path: string;
  symbol: string;
  test: string;
  mutation: string;
  target: string;
  marker: string;
};

type Construct = {
  producerPath: string;
  symbol: string;
  consumerPath: string;
  test: string;
  mutation: string;
  target: string;
  marker: string;
};

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root: string, relative: string, body: string): void {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

function packageDocument(
  artifactId: string,
  paths: string[],
  entries: Entry[],
  constructs: Construct[] = [],
): string {
  const pkg = {
    id: 'WP-PROOF', order: 10, title: 'Proof fixture', initial_state: 'ready',
    acceptance_conditions: ['The proof fixture behaves.'],
    paths: [...new Set(paths)].map((entry) => ({ path: entry, intent_kind: 'create' })),
    depends_on: [],
    reachability: {
      kind: 'behavior',
      entry_seam_links: entries.map((entry) => ({
        seam_kind: 'ipc', path: entry.path, symbol: entry.symbol,
        entering_test: entry.test, mutation: entry.mutation,
        verification: { target: entry.target, expect_failure: entry.marker },
      })),
      production_constructs: constructs.map((item) => ({
        name: 'fixture token', producer_path: item.producerPath,
        producer_symbol: item.symbol, consumer_path: item.consumerPath,
        entering_test: item.test, mutation: item.mutation,
        verification: { target: item.target, expect_failure: item.marker },
      })),
    },
  };
  const machine = JSON.stringify({ schema_version: 2, plan_artifact_id: artifactId,
    packages: [pkg] }, null, 2);
  return `---\nplan_artifact_id: ${artifactId}\nkind: work-packages\n---\n\n`
    + `<!--PLAN-WORK-PACKAGES:v2\n${machine}\n-->\n\n## WP-PROOF - Proof fixture\n\n**Accept**\n- fixture\n`;
}

function registry(entries: Array<{ name: string; file: string; testName: string;
  protectedPaths?: string[] }>): ReachabilityTargetRegistry {
  return {
    version: 'fixture-registry-v7',
    targets: Object.fromEntries(entries.map((entry) => [entry.name, {
      runner: 'node-test' as const,
      file: entry.file,
      test_name: entry.testName,
      protected_test_paths: entry.protectedPaths ?? [entry.file],
    }])),
  };
}

function obligationRows(entries: number, constructs = 0): PlanWpReachabilityObligation[] {
  return [
    ...Array.from({ length: entries }, (_, ordinal) => ({
      id: `ob-entry-${ordinal}`, packageId: 'unused', packageContentHash: 'unused',
      schemaVersion: 2, obligationKind: 'entry-link' as const, ordinal,
      declaredJson: '{}', mutationPath: 'unused', verificationTarget: 'unused',
      expectFailureId: 'unused',
    })),
    ...Array.from({ length: constructs }, (_, ordinal) => ({
      id: `ob-construct-${ordinal}`, packageId: 'unused', packageContentHash: 'unused',
      schemaVersion: 2, obligationKind: 'construct' as const, ordinal,
      declaredJson: '{}', mutationPath: 'unused', verificationTarget: 'unused',
      expectFailureId: 'unused',
    })),
  ];
}

function fixture(input: {
  production: string;
  tests: Record<string, string>;
  patches: Record<string, string>;
  entries: Entry[];
  constructs?: Construct[];
}): { root: string; planFolder: string; baseOid: string; paths: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reachability-prover-fixture-'));
  git(root, 'init', '--quiet');
  write(root, 'package.json', '{"name":"reachability-fixture","private":true}\n');
  git(root, 'add', 'package.json');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'base');
  const baseOid = git(root, 'rev-parse', 'HEAD');
  write(root, 'fixture/production.js', input.production);
  for (const [name, body] of Object.entries(input.tests)) write(root, `fixture/${name}`, body);
  for (const [name, body] of Object.entries(input.patches)) write(root, `reachability-mutations/${name}`, body);
  const planFolder = path.join(root, '.lares', 'plans', 'fixture');
  fs.mkdirSync(path.join(planFolder, 'supplements'), { recursive: true });
  write(root, '.lares/plans/fixture/plan.json', JSON.stringify({
    schema_version: 1, plan_artifact_id: 'plan_fixture', plan_sku: 'fixture',
  }));
  const paths = [
    'fixture/production.js',
    ...Object.keys(input.tests).map((name) => `fixture/${name}`),
    ...Object.keys(input.patches).map((name) => `reachability-mutations/${name}`),
  ];
  write(root, '.lares/plans/fixture/supplements/work-packages.md',
    packageDocument('plan_fixture', paths, input.entries, input.constructs));
  return { root, planFolder, baseOid, paths };
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

const realProduction = [
  "function registerLive(registry) { registry.set('live', () => 'ok'); }",
  'function register(registry) { registerLive(registry); }',
  "function mintToken() { return 'token'; }",
  'function productionChain() { return mintToken(); }',
  'module.exports = { register, productionChain };',
  '',
].join('\n');

const registrationTest = [
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { register } = require('./production');",
  "test('real registration', () => {",
  '  const handlers = new Map(); register(handlers);',
  "  assert.ok(handlers.get('live'), 'REACHABILITY:real-registration');",
  '});',
  '',
].join('\n');

const constructTest = [
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { productionChain } = require('./production');",
  "test('production constructs token', () => {",
  "  assert.equal(productionChain(), 'token', 'REACHABILITY:production-token');",
  '});',
  '',
].join('\n');

const registrationPatch = [
  'diff --git a/fixture/production.js b/fixture/production.js',
  '--- a/fixture/production.js',
  '+++ b/fixture/production.js',
  '@@ -1,5 +1,5 @@',
  " function registerLive(registry) { registry.set('live', () => 'ok'); }",
  '-function register(registry) { registerLive(registry); }',
  '+function register(registry) { /* registerLive removed */ }',
  " function mintToken() { return 'token'; }",
  ' function productionChain() { return mintToken(); }',
  ' module.exports = { register, productionChain };',
  '',
].join('\n');

const constructPatch = [
  'diff --git a/fixture/production.js b/fixture/production.js',
  '--- a/fixture/production.js',
  '+++ b/fixture/production.js',
  '@@ -1,5 +1,5 @@',
  " function registerLive(registry) { registry.set('live', () => 'ok'); }",
  ' function register(registry) { registerLive(registry); }',
  "-function mintToken() { return 'token'; }",
  '+function mintToken() { return null; }',
  ' function productionChain() { return mintToken(); }',
  ' module.exports = { register, productionChain };',
  '',
].join('\n');

test('real registration and production construction refute independently and bind evidence', async () => {
  const entry: Entry = { path: 'fixture/production.js', symbol: 'registerLive',
    test: 'fixture/registration.test.js', mutation: 'reachability-mutations/registration.patch',
    target: 'real-registration', marker: 'REACHABILITY:real-registration' };
  const construct: Construct = { producerPath: 'fixture/production.js', symbol: 'mintToken',
    consumerPath: 'fixture/production.js', test: 'fixture/construct.test.js',
    mutation: 'reachability-mutations/construct.patch', target: 'production-token',
    marker: 'REACHABILITY:production-token' };
  const ctx = fixture({ production: realProduction,
    tests: { 'registration.test.js': registrationTest, 'construct.test.js': constructTest },
    patches: { 'registration.patch': registrationPatch, 'construct.patch': constructPatch },
    entries: [entry], constructs: [construct] });
  const evidence: PlanWpReachabilityEvidence[] = [];
  try {
    const result = await proveReachability({ repositoryRoot: ctx.root, planFolder: ctx.planFolder,
      packageId: 'WP-PROOF', baseOid: ctx.baseOid,
      foreignEditPaths: ['fixture/production.js'] }, {
      registry: registry([
        { name: 'real-registration', file: entry.test, testName: 'real registration' },
        { name: 'production-token', file: construct.test, testName: 'production constructs token' },
      ]),
      listObligations: () => obligationRows(1, 1),
      persistEvidence: (rows) => evidence.push(...rows),
      now: () => 1234,
    });
    assert.equal(result.verdict, 'pass');
    assert.deepEqual(result.obligations.map((row) => [row.kind, row.verdict]),
      [['entry-link', 'pass'], ['construct', 'pass']]);
    assert.equal(result.specimen.packageExact, false);
    assert.deepEqual(result.specimen.admittedForeignPaths, ['fixture/production.js']);
    assert.ok(result.specimen.dirtyDeclaredPathStatus.length > 0);
    assert.equal(evidence.length, 2);
    for (const row of evidence) {
      assert.equal(row.specimenTreeOid, result.specimen.treeOid);
      assert.match(row.mutationBlobOid, /^[0-9a-f]{40}$/);
      assert.equal(row.verificationTargetVersion, 'fixture-registry-v7');
      assert.equal(row.verdict, 'pass');
    }
    assert.notEqual(evidence[0].obligationId, evidence[1].obligationId);
  } finally { removeFixture(ctx.root); }
});

test('constructor-only entering test fails refutation because it stays green', async () => {
  const constructorOnly = [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('constructor only', () => {",
    "  const service = new (class Service { run() { return 'ok'; } })();",
    "  assert.equal(service.run(), 'ok', 'REACHABILITY:real-registration');",
    '});', '',
  ].join('\n');
  const entry: Entry = { path: 'fixture/production.js', symbol: 'registerLive',
    test: 'fixture/constructor.test.js', mutation: 'reachability-mutations/registration.patch',
    target: 'constructor-only', marker: 'REACHABILITY:real-registration' };
  const ctx = fixture({ production: realProduction, tests: { 'constructor.test.js': constructorOnly },
    patches: { 'registration.patch': registrationPatch }, entries: [entry] });
  try {
    const result = await proveReachability({ repositoryRoot: ctx.root, planFolder: ctx.planFolder,
      packageId: 'WP-PROOF', baseOid: ctx.baseOid, foreignEditPaths: [] }, {
      registry: registry([{ name: entry.target, file: entry.test, testName: 'constructor only' }]),
      listObligations: () => obligationRows(1), persistEvidence: () => undefined,
    });
    assert.equal(result.verdict, 'fail');
    assert.equal(result.obligations[0].classification, 'still-passes-after-revert');
  } finally { removeFixture(ctx.root); }
});

async function classifySingle(patch: string, protectedPaths?: string[]): Promise<string> {
  const entry: Entry = { path: 'fixture/production.js', symbol: 'registerLive',
    test: 'fixture/registration.test.js', mutation: 'reachability-mutations/mutation.patch',
    target: 'classification', marker: 'REACHABILITY:real-registration' };
  const ctx = fixture({ production: realProduction, tests: { 'registration.test.js': registrationTest },
    patches: { 'mutation.patch': patch }, entries: [entry] });
  try {
    const result = await proveReachability({ repositoryRoot: ctx.root, planFolder: ctx.planFolder,
      packageId: 'WP-PROOF', baseOid: ctx.baseOid, foreignEditPaths: [] }, {
      registry: registry([{ name: entry.target, file: entry.test,
        testName: 'real registration', protectedPaths }]),
      listObligations: () => obligationRows(1), persistEvidence: () => undefined,
    });
    assert.equal(result.verdict, 'indeterminate');
    return result.obligations[0].classification;
  } finally { removeFixture(ctx.root); }
}

test('stale-context patch is INDETERMINATE', async () => {
  const stale = registrationPatch.replace("function register(registry) { registerLive(registry); }",
    'function register(registry) { registerLive(registry, staleContext); }');
  assert.equal(await classifySingle(stale), 'stale-context-patch');
});

test('protected-test-path patch is INDETERMINATE before application', async () => {
  const protectedPatch = registrationPatch + [
    'diff --git a/fixture/registration.test.js b/fixture/registration.test.js',
    '--- a/fixture/registration.test.js',
    '+++ b/fixture/registration.test.js',
    '@@ -1,3 +1,3 @@',
    " const test = require('node:test');",
    "-const assert = require('node:assert/strict');",
    "+const assert = require('node:assert');",
    " const { register } = require('./production');",
    '',
  ].join('\n');
  assert.equal(await classifySingle(protectedPatch, ['fixture/registration.test.js']),
    'protected-test-path-touched');
});

test('compile or collection failure under mutation is INDETERMINATE', async () => {
  const compilePatch = [
    'diff --git a/fixture/production.js b/fixture/production.js',
    '--- a/fixture/production.js',
    '+++ b/fixture/production.js',
    '@@ -1,5 +1,5 @@',
    "-function registerLive(registry) { registry.set('live', () => 'ok'); }",
    '+function registerLive(registry {',
    ' function register(registry) { registerLive(registry); }',
    " function mintToken() { return 'token'; }",
    ' function productionChain() { return mintToken(); }',
    ' module.exports = { register, productionChain };',
    '',
  ].join('\n');
  assert.equal(await classifySingle(compilePatch),
    'compile-collection-fixture-failure-under-mutation');
});

test('registerIpcHandlers registers the prove_reachability production channel', () => {
  type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
  const handlers = new Map<string, RegisteredHandler>();
  const ipcMain = {
    handle(channel: string, handler: RegisteredHandler) { handlers.set(channel, handler); },
    on() { /* registration-only fake */ },
  };
  const noop = () => undefined;
  const electronPath = require.resolve('electron');
  const priorElectron = require.cache[electronPath];
  const ipcHandlersPath = require.resolve('../ipc-handlers');
  const priorIpcHandlers = require.cache[ipcHandlersPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain,
      app: { getPath: () => process.cwd(), isPackaged: false, on: noop },
      dialog: { showOpenDialog: noop, showMessageBox: noop },
      shell: { openExternal: noop, trashItem: noop },
      BrowserWindow: class {},
      nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
    },
    children: [], paths: [],
  } as unknown as NodeModule;
  delete require.cache[ipcHandlersPath];
  try {
    const bridge = require('../ipc-handlers') as typeof import('../ipc-handlers');
    const supervisor = new Proxy({}, { get: () => noop });
    const mainWindow = new Proxy({
      isDestroyed: () => false,
      webContents: new Proxy({ send: noop }, { get: () => noop }),
    }, { get: (target, property) => property in target
      ? target[property as keyof typeof target] : noop });
    bridge.registerIpcHandlers(
      supervisor as Parameters<typeof bridge.registerIpcHandlers>[0],
      mainWindow as unknown as Parameters<typeof bridge.registerIpcHandlers>[1],
      {} as Parameters<typeof bridge.registerIpcHandlers>[2],
    );
    assert.ok(handlers.get('prove_reachability'),
      'REACHABILITY:registerIpcHandlers:prove_reachability');
  } finally {
    if (priorElectron) require.cache[electronPath] = priorElectron;
    else delete require.cache[electronPath];
    if (priorIpcHandlers) require.cache[ipcHandlersPath] = priorIpcHandlers;
    else delete require.cache[ipcHandlersPath];
  }
});

// Workspace-scoped orchestration provider settings.
//
//   npm run build:main
//   node dist/main/main/orchestration/orchestration-provider-settings.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS } from '../../shared/constants';
import type { OrchestrationProviderSettings } from '../../shared/types';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';
import {
  __resetOrchestrationProviderSettingsForTest,
  getOrchestrationProviderSettingsCached,
  loadOrchestrationProviderSettings,
  OrchestrationProviderSettingsValidationError,
  orchestrationProviderSettingsPath,
  updateOrchestrationProviderSettings,
} from './orchestration-provider-settings';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

const roots: string[] = [];
function workspaceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-provider-settings-'));
  roots.push(root);
  return root;
}

function settings(
  defaultLeadProvider: OrchestrationProviderSettings['groupthink']['defaultLeadProvider'],
  defaultReviewerProvider: OrchestrationProviderSettings['groupthink']['defaultReviewerProvider'],
): OrchestrationProviderSettings {
  return { groupthink: { defaultLeadProvider, defaultReviewerProvider } };
}

function resetCaches(): void {
  __resetOrchestrationProviderSettingsForTest();
  resetWorkspaceStateDirCacheForTests();
}

test('malformed JSON and malformed shapes recover to defaults without throwing', () => {
  const root = workspaceRoot();
  const target = orchestrationProviderSettingsPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const malformed of ['', 'not json', '[]', '42', '{"groupthink": "bad"}']) {
    fs.writeFileSync(target, malformed, 'utf8');
    assert.doesNotThrow(() => loadOrchestrationProviderSettings(root));
    assert.deepEqual(loadOrchestrationProviderSettings(root), DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS);
  }
});

test('read recovery defaults each corrupted field independently', () => {
  const root = workspaceRoot();
  const target = orchestrationProviderSettingsPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  fs.writeFileSync(target, JSON.stringify({
    groupthink: { defaultLeadProvider: 'gemini', defaultReviewerProvider: 'agy' },
  }), 'utf8');
  assert.deepEqual(loadOrchestrationProviderSettings(root), settings('claude', 'agy'));

  fs.writeFileSync(target, JSON.stringify({
    groupthink: { defaultLeadProvider: 'grok', defaultReviewerProvider: '' },
  }), 'utf8');
  assert.deepEqual(loadOrchestrationProviderSettings(root), settings('grok', 'codex'));
});

test('invalid explicit updates reject with a typed error and preserve disk exactly', () => {
  const invalidValues = ['gemini', 'unknown-provider', ''];
  for (const invalid of invalidValues) {
    const root = workspaceRoot();
    const prior = settings('grok', 'agy');
    updateOrchestrationProviderSettings(prior, root);
    const target = orchestrationProviderSettingsPath(root);
    const before = fs.readFileSync(target);

    assert.throws(
      () => updateOrchestrationProviderSettings(
        { groupthink: { defaultLeadProvider: invalid, defaultReviewerProvider: 'codex' } },
        root,
      ),
      (error: unknown) => error instanceof OrchestrationProviderSettingsValidationError
        && error.code === 'INVALID_ORCHESTRATION_PROVIDER_SETTINGS'
        && error.field === 'groupthink.defaultLeadProvider',
      `invalid provider ${JSON.stringify(invalid)}`,
    );
    assert.deepEqual(fs.readFileSync(target), before, 'rejected update leaves saved bytes unchanged');
    assert.deepEqual(getOrchestrationProviderSettingsCached(root), prior, 'rejected update leaves cache unchanged');
  }

  const root = workspaceRoot();
  const prior = settings('claude', 'grok');
  updateOrchestrationProviderSettings(prior, root);
  const target = orchestrationProviderSettingsPath(root);
  const before = fs.readFileSync(target);
  assert.throws(
    () => updateOrchestrationProviderSettings(
      { groupthink: { defaultLeadProvider: 'agy', defaultReviewerProvider: 'gemini' } },
      root,
    ),
    (error: unknown) => error instanceof OrchestrationProviderSettingsValidationError
      && error.field === 'groupthink.defaultReviewerProvider',
  );
  assert.deepEqual(fs.readFileSync(target), before);
});

test('valid update round-trips atomically and refreshes the cache', () => {
  const root = workspaceRoot();
  const next = settings('codex', 'claude');
  assert.deepEqual(updateOrchestrationProviderSettings(next, root), next);
  assert.deepEqual(getOrchestrationProviderSettingsCached(root), next);

  resetCaches();
  assert.deepEqual(loadOrchestrationProviderSettings(root), next);
  const stateDirEntries = fs.readdirSync(path.dirname(orchestrationProviderSettingsPath(root)));
  assert.deepEqual(stateDirEntries, ['orchestration-provider-settings.json']);
});

test('two workspace roots keep independent disk and cache values', () => {
  const firstRoot = workspaceRoot();
  const secondRoot = workspaceRoot();
  const first = settings('grok', 'agy');
  const second = settings('codex', 'claude');

  updateOrchestrationProviderSettings(first, firstRoot);
  updateOrchestrationProviderSettings(second, secondRoot);
  assert.deepEqual(getOrchestrationProviderSettingsCached(firstRoot), first);
  assert.deepEqual(getOrchestrationProviderSettingsCached(secondRoot), second);

  fs.writeFileSync(orchestrationProviderSettingsPath(firstRoot), JSON.stringify(settings('agy', 'grok')), 'utf8');
  assert.deepEqual(getOrchestrationProviderSettingsCached(firstRoot), first, 'first root reads its own cached value');
  assert.deepEqual(getOrchestrationProviderSettingsCached(secondRoot), second, 'first-root disk change cannot leak');

  resetCaches();
  assert.deepEqual(getOrchestrationProviderSettingsCached(firstRoot), settings('agy', 'grok'));
  assert.deepEqual(getOrchestrationProviderSettingsCached(secondRoot), second);
});

(async () => {
  let passed = 0;
  let failed = 0;
  try {
    for (const t of tests) {
      resetCaches();
      try {
        await t.run();
        console.log(`  ok  ${t.name}`);
        passed++;
      } catch (error) {
        console.error(`  FAIL ${t.name}`);
        console.error('       ', error instanceof Error ? error.stack || error.message : error);
        failed++;
      }
    }
  } finally {
    resetCaches();
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

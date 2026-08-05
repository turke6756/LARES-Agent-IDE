import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS } from '../main/orchestration/orchestration-provider-settings-transport';

const preload = fs.readFileSync(path.join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8');
const sharedTypes = fs.readFileSync(path.join(process.cwd(), 'src', 'shared', 'types.ts'), 'utf8');

for (const channel of [
  ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.get,
  ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.update,
  ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.changed,
]) {
  assert.ok(preload.includes(`'${channel}'`), `preload is missing channel ${channel}`);
}

assert.ok(preload.includes('orchestrationProviderSettings: {'));
assert.ok(sharedTypes.includes('orchestrationProviderSettings: {'));
assert.ok(sharedTypes.includes('Promise<OrchestrationProviderSettings>'));
assert.ok(sharedTypes.includes('workspaceId: string;'));

console.log('  ok  orchestration provider settings preload and typed API channels match');

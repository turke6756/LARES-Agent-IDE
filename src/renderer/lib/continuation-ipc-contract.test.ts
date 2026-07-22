import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcApi } from '../../shared/types';

// §2.7 — contract coverage for a brand-new IPC channel.
//
// Two distinct failure modes, both of which pass EVERY pure unit test in this
// change and both of which produce exactly one symptom in the app: silence.
//
//   1. SHAPE drift — preload stops satisfying `IpcApi`. Caught at typecheck by
//      the assertion below (`src/preload/index.ts` declares `const api: IpcApi`,
//      so this is a second, explicit witness that the two new members are part
//      of the contract and not optional extras).
//   2. CHANNEL-NAME drift — preload invokes 'agent:list-continuation-phase'
//      while main registers 'agent:list-continuation-phases'. TypeScript cannot
//      see this: both sides are string literals in different files. So the
//      channel strings are compared across the two sources directly.
//
// A full Electron E2E suite is an explicit non-goal (§6); this is the cheap
// coverage that makes the non-goal safe.

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** Typecheck-only: a value of this type must be assignable to the two new
 *  members of `IpcApi['agents']`. If either signature drifts, `npm run build`
 *  fails here rather than at runtime with an undefined method. */
type ContinuationPhaseApi = Pick<
  IpcApi['agents'],
  'listContinuationPhases' | 'onContinuationPhaseChanged'
>;

const CONTRACT_WITNESS: ContinuationPhaseApi = {
  listContinuationPhases: async () => [],
  onContinuationPhaseChanged: (_cb) => () => {},
};

describe('continuation phase IPC contract', () => {
  it('the phase API members are part of IpcApi with the expected shapes', () => {
    // The compile-time assertion is the point; this keeps the witness live.
    expect(typeof CONTRACT_WITNESS.listContinuationPhases).toBe('function');
    expect(typeof CONTRACT_WITNESS.onContinuationPhaseChanged).toBe('function');
    const unsub = CONTRACT_WITNESS.onContinuationPhaseChanged(() => {});
    expect(typeof unsub).toBe('function');
  });

  it('preload declares itself as IpcApi, so a missing member cannot compile', () => {
    expect(read('src/preload/index.ts')).toMatch(/const api:\s*IpcApi\s*=/);
  });

  it('the invoke channel preload calls is the channel main registers', () => {
    const channel = 'agent:list-continuation-phases';
    expect(read('src/preload/index.ts')).toContain(`ipcRenderer.invoke('${channel}')`);
    expect(read('src/main/ipc-handlers.ts')).toContain(`ipcMain.handle('${channel}'`);
  });

  it('the push channel preload listens on is the channel main emits', () => {
    const channel = 'continuation:phase';
    expect(read('src/preload/index.ts')).toContain(`ipcRenderer.on('${channel}'`);
    expect(read('src/preload/index.ts')).toContain(`ipcRenderer.removeListener('${channel}'`);
    expect(read('src/main/ipc-handlers.ts')).toContain(`emit('${channel}'`);
  });

  it('the phase broadcast rides `emit` (detached windows), not a mainWindow-only send', () => {
    // A torn-off Dashboard renders the same cards. Sending phases only to the
    // shell would leave that window with the original defect.
    const handlers = read('src/main/ipc-handlers.ts');
    const line = handlers
      .split('\n')
      .find((l) => l.includes("'continuation:phase'"));
    expect(line).toBeTruthy();
    expect(line).toContain('emit(');
    expect(line).not.toContain('mainWindow.webContents.send');
  });
});

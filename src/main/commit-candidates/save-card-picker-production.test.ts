import assert from 'node:assert/strict';

import { SAVECARD_ATTRIBUTION_RESOLUTION_CHANNEL } from '../../shared/types';

(async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const noop = () => undefined;
  const electronPath = require.resolve('electron');
  const ipcHandlersPath = require.resolve('../ipc-handlers');
  const priorElectron = require.cache[electronPath];
  const priorHandlers = require.cache[ipcHandlersPath];
  const ipcMain = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) };
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain, app: { getPath: () => process.cwd(), isPackaged: false, on: noop },
      dialog: { showOpenDialog: noop, showMessageBox: noop },
      shell: { openExternal: noop, trashItem: noop }, BrowserWindow: class {},
      nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
    }, children: [], paths: [],
  } as unknown as NodeModule;
  delete require.cache[ipcHandlersPath];
  const previousFlag = process.env.LARES_INTENT_PACKAGING;
  process.env.LARES_INTENT_PACKAGING = '1';
  try {
    const bridge = require('../ipc-handlers') as typeof import('../ipc-handlers');
    let persisted = false;
    bridge.setSaveCardMintRoutes({
      mintCandidate: async () => { throw new Error('mint not used'); },
      persistAttributionResolution: async (request) => {
        persisted = true;
        return { resolutionId: 'resolution-1', evidenceDigest: request.atom.evidenceDigest,
          resolution: request.resolution };
      },
    });
    const proxy = new Proxy({}, { get: () => noop });
    bridge.registerIpcHandlers(proxy as any, proxy as any, {} as any);
    const handler = handlers.get(SAVECARD_ATTRIBUTION_RESOLUTION_CHANNEL);
    assert.ok(handler, 'production registerIpcHandlers must register picker persistence');
    const result = await handler({}, {
      workspaceId: 'ws-1', resolution: 'commit-together',
      atom: {
        kind: 'cross-intent', atomId: 'atom-1', digest: 'digest-1', reasonVersion: 1,
        pathBytesBase64: 'c2hhcmVkLnRz', displayPath: 'shared.ts', earlierIntentId: 'a',
        laterIntentId: 'b', evidenceDigest: 'evidence-1', resolution: null,
      },
    });
    assert.equal(persisted, true);
    assert.equal(result.resolutionId, 'resolution-1');
    console.log('save-card picker production registration: passed');
  } finally {
    if (previousFlag === undefined) delete process.env.LARES_INTENT_PACKAGING;
    else process.env.LARES_INTENT_PACKAGING = previousFlag;
    if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
    if (priorHandlers) require.cache[ipcHandlersPath] = priorHandlers; else delete require.cache[ipcHandlersPath];
  }
})().catch((error) => { console.error(error); process.exit(1); });

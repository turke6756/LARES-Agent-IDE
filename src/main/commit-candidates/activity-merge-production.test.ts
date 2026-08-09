import assert from 'node:assert/strict';
import { SAVECARD_ACTIVITY_MERGE_RESOLVE_CHANNEL } from '../../shared/types';

(async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const noop = () => undefined;
  const electronPath = require.resolve('electron');
  const ipcHandlersPath = require.resolve('../ipc-handlers');
  const preloadPath = require.resolve('../../preload/index');
  const priorElectron = require.cache[electronPath];
  const priorHandlers = require.cache[ipcHandlersPath];
  const priorPreload = require.cache[preloadPath];
  let exposedApi: any = null;
  const invoked: Array<{ channel: string; request: unknown }> = [];
  const ipcMain = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) };
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain, app: { getPath: () => process.cwd(), isPackaged: false, on: noop },
      contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposedApi = api; } },
      ipcRenderer: { invoke: (channel: string, request: unknown) => { invoked.push({ channel, request }); }, on: noop, removeListener: noop },
      webUtils: { getPathForFile: () => '' },
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
    let entered = false;
    bridge.setActivityMergeService({
      resolveAndPromote: async () => { entered = true; return { status: 'promoted', attemptId: 'attempt-1', primaryHeadOid: 'a'.repeat(40) }; },
    } as any);
    const proxy = new Proxy({}, { get: () => noop });
    bridge.registerIpcHandlers(proxy as any, proxy as any, {} as any);
    const handler = handlers.get(SAVECARD_ACTIVITY_MERGE_RESOLVE_CHANNEL);
    assert.ok(handler, 'REACHABILITY:registerIpcHandlers:savecard:resolveActivityMerge');
    const result = await handler({}, { attemptId: 'attempt-1', resolutions: [] });
    assert.equal(entered, true, 'the registered production handler must enter the injected live service');
    assert.equal(result.status, 'promoted');
    delete require.cache[preloadPath];
    require('../../preload/index');
    assert.ok(exposedApi?.saveCard?.resolveActivityMerge,
      'REACHABILITY:preload:saveCard.resolveActivityMerge');
    exposedApi.saveCard.resolveActivityMerge({ attemptId: 'attempt-preload', resolutions: [] });
    assert.deepEqual(invoked.at(-1), {
      channel: SAVECARD_ACTIVITY_MERGE_RESOLVE_CHANNEL,
      request: { attemptId: 'attempt-preload', resolutions: [] },
    });
    console.log('activity merge production registration: passed');
  } finally {
    if (previousFlag === undefined) delete process.env.LARES_INTENT_PACKAGING;
    else process.env.LARES_INTENT_PACKAGING = previousFlag;
    if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
    if (priorHandlers) require.cache[ipcHandlersPath] = priorHandlers; else delete require.cache[ipcHandlersPath];
    if (priorPreload) require.cache[preloadPath] = priorPreload; else delete require.cache[preloadPath];
  }
})().catch((error) => { console.error(error); process.exit(1); });

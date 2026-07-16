// Native shell spellcheck context-menu acceptance tests. This is deliberately a
// plain node:assert script: never invoke a registered context-menu callback here,
// because Electron's Menu/MenuItem value imports are undefined under plain Node.
//
//   npm run build:main
//   node dist/main/main/spellcheck-context-menu.test.js

import assert from 'node:assert/strict';
import {
  buildSpellcheckMenuItems,
  installShellSpellcheckContextMenu,
} from './spellcheck-context-menu';
import {
  __resetDetachedRegistryForTest,
  createDetachedWindow,
  type DetachedWindowDeps,
} from './detached-windows';
import type { DetachRequest } from '../shared/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

type SpellcheckParams = Parameters<typeof buildSpellcheckMenuItems>[0];

function params(overrides: Partial<SpellcheckParams> = {}): SpellcheckParams {
  return {
    isEditable: true,
    misspelledWord: '',
    dictionarySuggestions: [],
    selectionText: '',
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: false,
      canSelectAll: true,
      canEditRichly: true,
    },
    ...overrides,
  };
}

test('not editable returns no items', () => {
  assert.deepEqual(buildSpellcheckMenuItems(params({ isEditable: false })), []);
});

test('selected text is ceded to the renderer selection surface', () => {
  assert.deepEqual(buildSpellcheckMenuItems(params({ selectionText: 'selected' })), []);
});

test('Chromium misspelling selection includes suggestions and add-to-dictionary', () => {
  const items = buildSpellcheckMenuItems(params({
    misspelledWord: 'teh',
    selectionText: 'teh',
    dictionarySuggestions: ['the', 'tech', 'ten'],
  }));
  assert.deepEqual(items.filter((item) => item.id === 'suggestion').map((item) => item.word),
    ['the', 'tech', 'ten']);
  assert.deepEqual(items.find((item) => item.id === 'add-to-dictionary'), {
    id: 'add-to-dictionary',
    label: 'Add to Dictionary',
    word: 'teh',
  });
});

test('misspelling includes at most five suggestions and add-to-dictionary', () => {
  const items = buildSpellcheckMenuItems(params({
    misspelledWord: 'recieve',
    dictionarySuggestions: ['receive', 'receiver', 'received', 'relieve', 'recipe', 'deceive'],
  }));
  assert.deepEqual(items.slice(0, 5).map((item) => item.word),
    ['receive', 'receiver', 'received', 'relieve', 'recipe']);
  assert.equal(items.filter((item) => item.id === 'suggestion').length, 5);
  assert.deepEqual(items.find((item) => item.id === 'add-to-dictionary'), {
    id: 'add-to-dictionary',
    label: 'Add to Dictionary',
    word: 'recieve',
  });
});

test('editable text without a misspelling has edit roles only', () => {
  const items = buildSpellcheckMenuItems(params({
    editFlags: { ...params().editFlags, canCut: false, canPaste: false },
  }));
  assert.deepEqual(items, [
    { id: 'cut', role: 'cut', enabled: false },
    { id: 'copy', role: 'copy', enabled: true },
    { id: 'paste', role: 'paste', enabled: false },
    { id: 'select-all', role: 'selectAll' },
  ]);
});

test('double install registers exactly one context-menu listener', () => {
  const registrations: string[] = [];
  const webContents = {
    on(event: string): void { registrations.push(event); },
  } as unknown as Electron.WebContents;
  const win = { webContents } as Electron.BrowserWindow;

  installShellSpellcheckContextMenu(win);
  installShellSpellcheckContextMenu(win);

  assert.equal(registrations.filter((event) => event === 'context-menu').length, 1);
});

test('detached factory invokes injected installer after trust and before load', () => {
  __resetDetachedRegistryForTest();
  const order: string[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const webContents = {
    id: 7101,
    setWindowOpenHandler(): void {},
    on(event: string, callback: (...args: any[]) => void): void { listeners.set(event, callback); },
    send(): void {},
    isDestroyed(): boolean { return false; },
  } as unknown as Electron.WebContents;
  const win = {
    id: 7100,
    webContents,
    focus(): void {},
    loadURL(): void { order.push('load'); },
    loadFile(): void { order.push('load'); },
    isDestroyed(): boolean { return false; },
    on(): void {},
    close(): void {},
  } as unknown as Electron.BrowserWindow;
  const trustedContents = new Set<Electron.WebContents>();
  const deps: DetachedWindowDeps = {
    devServerUrl: 'http://localhost:5173',
    builtIndexHtml: 'index.html',
    theme: 'dark',
    trustedContents,
    setConstructingDetached: () => {},
    getMainWindow: () => null,
    createWindow: () => win,
    installSpellcheckContextMenu: (target) => {
      assert.equal(target, win);
      assert.equal(trustedContents.has(webContents), true, 'webContents trusted before install');
      order.push('spellcheck');
    },
  };
  const req: DetachRequest = {
    filePath: 'C:\\workspace\\spellcheck.md',
    rootDirectory: 'C:\\workspace',
    pathType: 'windows',
    workspaceId: 'ws-spellcheck',
    label: 'spellcheck.md',
    x: 100,
    y: 100,
  };

  createDetachedWindow(req, deps);

  assert.deepEqual(order, ['spellcheck', 'load']);
  __resetDetachedRegistryForTest();
});

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${t.name}`);
    console.error(err);
  }
}
console.log(`\nspellcheck-context-menu.test: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);

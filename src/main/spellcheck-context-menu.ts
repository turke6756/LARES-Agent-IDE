import { BrowserWindow, Menu, MenuItem, type WebContents } from 'electron';

export interface SpellcheckMenuItemSpec {
  id: string;
  label?: string;
  role?: Electron.MenuItem['role'];
  type?: 'separator';
  enabled?: boolean;
  word?: string;
}

/**
 * Decide which spellcheck/edit items belong in the shell context menu.
 * Pure: this function only reads the supplied params and makes no Electron
 * runtime calls, so it remains safe to exercise under plain Node.
 */
export function buildSpellcheckMenuItems(
  params: Pick<
    Electron.ContextMenuParams,
    'isEditable' | 'misspelledWord' | 'dictionarySuggestions' | 'selectionText' | 'editFlags'
  >,
): SpellcheckMenuItemSpec[] {
  if (!params.isEditable) return [];
  if (params.selectionText && !params.misspelledWord) return [];

  const items: SpellcheckMenuItemSpec[] = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ id: 'suggestion', label: suggestion, word: suggestion });
    }
    if (params.dictionarySuggestions.length > 0) {
      items.push({ id: 'sep', type: 'separator' });
    }
    items.push({
      id: 'add-to-dictionary',
      label: 'Add to Dictionary',
      word: params.misspelledWord,
    });
    items.push({ id: 'sep', type: 'separator' });
  }

  items.push({ id: 'cut', role: 'cut', enabled: params.editFlags.canCut });
  items.push({ id: 'copy', role: 'copy', enabled: params.editFlags.canCopy });
  items.push({ id: 'paste', role: 'paste', enabled: params.editFlags.canPaste });
  items.push({ id: 'select-all', role: 'selectAll' });
  return items;
}

const installed = new WeakSet<WebContents>();

/**
 * Attach the native spellcheck menu to one shell-owned BrowserWindow.
 * Idempotent per WebContents. Never install this on browser-pane views.
 */
export function installShellSpellcheckContextMenu(win: BrowserWindow): void {
  const wc = win.webContents;
  if (installed.has(wc)) return;
  installed.add(wc);

  wc.on('context-menu', (_event, params) => {
    const spec = buildSpellcheckMenuItems(params);
    if (spec.length === 0) return;

    const menu = new Menu();
    for (const item of spec) {
      if (item.type === 'separator') {
        menu.append(new MenuItem({ type: 'separator' }));
        continue;
      }
      if (item.role) {
        menu.append(new MenuItem({ role: item.role, enabled: item.enabled }));
        continue;
      }
      if (item.id === 'suggestion' && item.word) {
        menu.append(new MenuItem({
          label: item.label,
          click: () => wc.replaceMisspelling(item.word!),
        }));
      } else if (item.id === 'add-to-dictionary' && item.word) {
        menu.append(new MenuItem({
          label: item.label,
          click: () => wc.session.addWordToSpellCheckerDictionary(item.word!),
        }));
      }
    }
    menu.popup({ window: win });
  });
}

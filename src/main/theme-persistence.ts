import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * UI theme persisted by the renderer toggle (system:set-theme IPC). Read at
 * window creation so the native chrome (title bar, menu bar) and the
 * pre-paint background match the app theme instead of following OS dark mode.
 */

export type UiTheme = 'dark' | 'light';

const themeFile = () => path.join(app.getPath('userData'), 'ui-theme.json');

export function loadPersistedTheme(): UiTheme {
  try {
    const raw = JSON.parse(fs.readFileSync(themeFile(), 'utf8'));
    if (raw?.theme === 'light' || raw?.theme === 'dark') return raw.theme;
  } catch { /* first run or unreadable — default dark */ }
  return 'dark';
}

export function persistTheme(theme: UiTheme): void {
  try {
    fs.writeFileSync(themeFile(), JSON.stringify({ theme }), 'utf8');
  } catch (err) {
    console.error('Failed to persist UI theme:', err);
  }
}

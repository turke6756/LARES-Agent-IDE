// Idle-agent lifecycle §B7 — persisted lifecycle settings.
//
// Follows the `theme-persistence.ts` model (a small JSON file under userData),
// with two differences that matter because this file decides whether agents get
// KILLED automatically:
//
//   1. the write is ATOMIC — temp file + renameSync — so a crash mid-write can
//      never leave a truncated file that reads back as some other threshold;
//   2. the read VALIDATES the enum and falls back to DEFAULT_LIFECYCLE_SETTINGS
//      on anything malformed, rather than trusting whatever is on disk.
//
// The sweep re-reads this on every run, so a settings change takes effect
// without a restart and without any cached copy to invalidate.

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  DEFAULT_LIFECYCLE_SETTINGS,
  type AutoStopThreshold,
  type LifecycleSettings,
} from '../../shared/types';

export const AUTO_STOP_THRESHOLDS: readonly AutoStopThreshold[] = [
  'never', '6h', '12h', '24h', '3d', '7d',
] as const;

const THRESHOLD_SET: ReadonlySet<string> = new Set<string>(AUTO_STOP_THRESHOLDS);

export function isAutoStopThreshold(v: unknown): v is AutoStopThreshold {
  return typeof v === 'string' && THRESHOLD_SET.has(v);
}

/** Injectable for tests; production resolves under Electron's userData. */
export function lifecycleSettingsPath(dir?: string): string {
  return path.join(dir ?? app.getPath('userData'), 'lifecycle-settings.json');
}

/**
 * Read the persisted settings. ANY problem — missing file, unreadable file,
 * invalid JSON, wrong shape, an unknown threshold — yields the default. A
 * corrupt file must never be able to widen or disable the auto-stop policy by
 * accident.
 */
export function loadLifecycleSettings(dir?: string): LifecycleSettings {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(lifecycleSettingsPath(dir), 'utf8'));
    if (raw && typeof raw === 'object') {
      const t = (raw as { autoStopIdleThreshold?: unknown }).autoStopIdleThreshold;
      if (isAutoStopThreshold(t)) return { autoStopIdleThreshold: t };
    }
  } catch { /* first run or unreadable — fall through to the default */ }
  return { ...DEFAULT_LIFECYCLE_SETTINGS };
}

/**
 * Persist settings atomically. Returns the settings actually written — an
 * invalid threshold is rejected in favour of the default rather than stored.
 */
export function saveLifecycleSettings(settings: LifecycleSettings, dir?: string): LifecycleSettings {
  const safe: LifecycleSettings = isAutoStopThreshold(settings?.autoStopIdleThreshold)
    ? { autoStopIdleThreshold: settings.autoStopIdleThreshold }
    : { ...DEFAULT_LIFECYCLE_SETTINGS };
  const target = lifecycleSettingsPath(dir);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(safe), 'utf8');
    // rename is atomic on the same volume: a reader sees either the whole old
    // file or the whole new one, never a half-written threshold.
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[lifecycle] failed to persist lifecycle settings:', err);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
  return safe;
}

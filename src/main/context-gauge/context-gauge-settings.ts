// Context Window Warning — persisted per-role gauge-cap settings.
//
// Follows the lifecycle-settings.ts model (B7): a small JSON file under
// userData, ATOMIC write (temp + renameSync), and a read that VALIDATES every
// field and falls back to DEFAULT_CONTEXT_GAUGE_SETTINGS on anything
// malformed. Numbers are clamped into [CONTEXT_GAUGE_CAP_MIN_TOKENS,
// CONTEXT_GAUGE_CAP_MAX_TOKENS] so a corrupt file can never zero a gauge
// denominator or promise a window no model has.
//
// A module-level cache keeps the hot path (one lookup per usage event in the
// log readers) off the filesystem; save updates the cache in the same call, so
// a slider move is visible to the very next reader poll without any push.

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { DEFAULT_CONTEXT_GAUGE_SETTINGS } from '../../shared/constants';
import type { ContextGaugeSettings, ContextWindowCaps } from '../../shared/types';
import { clampGaugeCap } from './context-gauge-cap';

/** Injectable for tests; production resolves under Electron's userData. */
export function contextGaugeSettingsPath(dir?: string): string {
  return path.join(dir ?? app.getPath('userData'), 'context-gauge-settings.json');
}

/** Persona names follow the persona-scanner VALID_NAME rule; anything else in
 *  the file (or a hostile IPC payload) is dropped rather than stored. */
const VALID_PERSONA_NAME = /^[a-z0-9_-]+$/;

/** Normalize an unknown value into a fully-valid settings object. Every
 *  missing/invalid field independently falls back to its default, so a partial
 *  file keeps the fields it did carry. */
export function sanitizeContextGaugeSettings(raw: unknown): ContextGaugeSettings {
  const defaults = DEFAULT_CONTEXT_GAUGE_SETTINGS.contextWindowCaps;
  const caps: ContextWindowCaps = {
    worker: defaults.worker,
    supervisor: defaults.supervisor,
    researcher: defaults.researcher,
    personas: {},
  };
  if (raw && typeof raw === 'object') {
    const rawCaps = (raw as { contextWindowCaps?: unknown }).contextWindowCaps;
    if (rawCaps && typeof rawCaps === 'object') {
      const c = rawCaps as Record<string, unknown>;
      for (const role of ['worker', 'supervisor', 'researcher'] as const) {
        if (typeof c[role] === 'number' && Number.isFinite(c[role] as number)) {
          caps[role] = clampGaugeCap(c[role]);
        }
      }
      const personas = c.personas;
      if (personas && typeof personas === 'object' && !Array.isArray(personas)) {
        for (const [name, value] of Object.entries(personas as Record<string, unknown>)) {
          if (!VALID_PERSONA_NAME.test(name)) continue;
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          caps.personas[name] = clampGaugeCap(value);
        }
      }
    }
  }
  return { contextWindowCaps: caps };
}

/** Read the persisted settings. ANY problem — missing file, invalid JSON,
 *  wrong shape — yields (per-field) defaults. */
export function loadContextGaugeSettings(dir?: string): ContextGaugeSettings {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(contextGaugeSettingsPath(dir), 'utf8'));
    return sanitizeContextGaugeSettings(raw);
  } catch {
    /* first run or unreadable — fall through to the default */
  }
  return sanitizeContextGaugeSettings(undefined);
}

/** Persist settings atomically. Returns the settings actually written (i.e.
 *  post-sanitize, post-clamp). */
export function saveContextGaugeSettings(settings: unknown, dir?: string): ContextGaugeSettings {
  const safe = sanitizeContextGaugeSettings(settings);
  const target = contextGaugeSettingsPath(dir);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(safe), 'utf8');
    // rename is atomic on the same volume: a reader sees either the whole old
    // file or the whole new one, never a half-written cap.
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[context-gauge] failed to persist settings:', err);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
  return safe;
}

// ── Cached accessor (production hot path) ────────────────────────────────────

let cached: ContextGaugeSettings | null = null;

/** Current settings, loaded from disk once and kept in sync by
 *  updateContextGaugeSettings (all writers in this process go through it). */
export function getContextGaugeSettingsCached(): ContextGaugeSettings {
  if (!cached) cached = loadContextGaugeSettings();
  return cached;
}

/** Save + refresh the cache in one step. The single write path for IPC and
 *  HTTP setters. */
export function updateContextGaugeSettings(next: unknown): ContextGaugeSettings {
  cached = saveContextGaugeSettings(next);
  return cached;
}

/** Test hook: drop the cache so the next read hits the (test-scoped) disk. */
export function __resetContextGaugeSettingsCacheForTest(): void {
  cached = null;
}

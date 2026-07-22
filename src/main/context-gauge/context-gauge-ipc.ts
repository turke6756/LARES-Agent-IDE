// Context Window Warning — the IPC surface for per-role gauge-cap settings.
//
// Mirrors lifecycle-ipc.ts: the renderer's payload is never trusted (it goes
// through sanitizeContextGaugeSettings main-side), the saved result is
// broadcast to EVERY window, and an onChanged hook lets the supervisor
// recompute live gauge readings so a slider move takes effect without waiting
// for each agent's next usage event.

import type { ContextGaugeSettings } from '../../shared/types';

export const CONTEXT_GAUGE_CHANNELS = {
  getSettings: 'context-gauge:get-settings',
  setSettings: 'context-gauge:set-settings',
  settingsChanged: 'context-gauge:settings-changed',
} as const;

export interface ContextGaugeIpcDeps {
  loadSettings(): ContextGaugeSettings;
  /** Sanitizes + persists; returns what was actually written. */
  saveSettings(raw: unknown): ContextGaugeSettings;
  /** Push the new settings to EVERY window, not just the sender's. */
  broadcastSettings(settings: ContextGaugeSettings): void;
  /** Post-save hook: recompute live context readings under the new caps. */
  onChanged?(settings: ContextGaugeSettings): void;
}

export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** Shared by the IPC setter and the HTTP PUT route so both write paths behave
 *  identically (sanitize → persist → broadcast → recompute). */
export function applyContextGaugeSettings(raw: unknown, deps: ContextGaugeIpcDeps): ContextGaugeSettings {
  const saved = deps.saveSettings(raw);
  deps.broadcastSettings(saved);
  deps.onChanged?.(saved);
  return saved;
}

export function registerContextGaugeIpc(ipc: IpcLike, deps: ContextGaugeIpcDeps): void {
  ipc.handle(CONTEXT_GAUGE_CHANNELS.getSettings, () => deps.loadSettings());
  ipc.handle(CONTEXT_GAUGE_CHANNELS.setSettings, (_e, raw: unknown) =>
    applyContextGaugeSettings(raw, deps));
}

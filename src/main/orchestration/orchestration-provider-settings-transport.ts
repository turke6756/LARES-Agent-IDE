import type { OrchestrationProviderSettings } from '../../shared/types';
import {
  getOrchestrationProviderSettingsCached,
  updateOrchestrationProviderSettings,
  validateOrchestrationProviderSettingsUpdate,
} from './orchestration-provider-settings';

export const ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS = {
  get: 'get_orchestration_provider_settings',
  update: 'update_orchestration_provider_settings',
  changed: 'orchestration_provider_settings_changed',
} as const;

export const ORCHESTRATION_PROVIDER_SETTINGS_HTTP_PATH =
  '/api/settings/orchestration-providers';

export interface OrchestrationProviderSettingsChangedEvent {
  workspaceId: string;
  settings: OrchestrationProviderSettings;
}

export class OrchestrationProviderSettingsWorkspaceError extends Error {
  readonly code = 'ORCHESTRATION_PROVIDER_SETTINGS_WORKSPACE_NOT_FOUND';

  constructor(readonly workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
    this.name = 'OrchestrationProviderSettingsWorkspaceError';
  }
}

export interface WorkspaceRootResolver {
  (workspaceId: string): string | null;
}

export interface IpcLike {
  // Electron's IpcMain.handle listener arguments are intentionally dynamic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

type ChangedListener = (event: OrchestrationProviderSettingsChangedEvent) => void;
const changedListeners = new Set<ChangedListener>();

export function onOrchestrationProviderSettingsChanged(listener: ChangedListener): () => void {
  changedListeners.add(listener);
  return () => changedListeners.delete(listener);
}

function workspaceRoot(workspaceId: string, resolveWorkspaceRoot: WorkspaceRootResolver): string {
  const root = resolveWorkspaceRoot(workspaceId);
  if (!root) throw new OrchestrationProviderSettingsWorkspaceError(workspaceId);
  return root;
}

export function getOrchestrationProviderSettingsForWorkspace(
  workspaceId: string,
  resolveWorkspaceRoot: WorkspaceRootResolver,
): OrchestrationProviderSettings {
  return getOrchestrationProviderSettingsCached(workspaceRoot(workspaceId, resolveWorkspaceRoot));
}

export function updateOrchestrationProviderSettingsForWorkspace(
  workspaceId: string,
  raw: unknown,
  resolveWorkspaceRoot: WorkspaceRootResolver,
): OrchestrationProviderSettings {
  // The transport boundary validates intent before path resolution or mutation.
  // updateOrchestrationProviderSettings validates again as its own invariant.
  const validated = validateOrchestrationProviderSettingsUpdate(raw);
  const saved = updateOrchestrationProviderSettings(
    validated,
    workspaceRoot(workspaceId, resolveWorkspaceRoot),
  );
  const event = { workspaceId, settings: saved };
  for (const listener of changedListeners) {
    try {
      listener(event);
    } catch (error) {
      // Persistence already succeeded; a closing renderer must not turn the
      // committed update into an apparent transport failure.
      console.warn('[orchestration-provider-settings] changed listener failed', error);
    }
  }
  return saved;
}

export function registerOrchestrationProviderSettingsIpc(
  ipc: IpcLike,
  resolveWorkspaceRoot: WorkspaceRootResolver,
): void {
  ipc.handle(ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.get, (_event, workspaceId: string) =>
    getOrchestrationProviderSettingsForWorkspace(workspaceId, resolveWorkspaceRoot));
  ipc.handle(
    ORCHESTRATION_PROVIDER_SETTINGS_CHANNELS.update,
    (_event, workspaceId: string, raw: unknown) =>
      updateOrchestrationProviderSettingsForWorkspace(workspaceId, raw, resolveWorkspaceRoot),
  );
}

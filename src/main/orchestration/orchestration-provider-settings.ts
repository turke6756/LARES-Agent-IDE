// Workspace-scoped provider preferences for orchestration features.
//
// Disk reads are recovery-oriented: malformed state is sanitized per field and
// can never prevent a launch. Explicit writes are intent-bearing and therefore
// take the separate strict validation path before any filesystem operation.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS } from '../../shared/constants';
import {
  isLaunchableAgentProvider,
  type OrchestrationProviderSettings,
} from '../../shared/types';
import { workspaceStateDir } from '../workspace-state-dir';

const SETTINGS_FILE_NAME = 'orchestration-provider-settings.json';
const cachedByWorkspaceRoot = new Map<string, OrchestrationProviderSettings>();

type ProviderSettingsField =
  | 'groupthink.defaultLeadProvider'
  | 'groupthink.defaultReviewerProvider';

export class OrchestrationProviderSettingsValidationError extends Error {
  readonly code = 'INVALID_ORCHESTRATION_PROVIDER_SETTINGS';

  constructor(readonly field: ProviderSettingsField, readonly value: unknown) {
    super(`Invalid orchestration provider setting ${field}`);
    this.name = 'OrchestrationProviderSettingsValidationError';
  }
}

function defaults(): OrchestrationProviderSettings {
  return {
    groupthink: {
      defaultLeadProvider:
        DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS.groupthink.defaultLeadProvider,
      defaultReviewerProvider:
        DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS.groupthink.defaultReviewerProvider,
    },
  };
}

/**
 * READ RECOVERY only. Each malformed field independently falls back to its
 * built-in default. This function is deliberately total and never throws.
 */
export function sanitizeOrchestrationProviderSettings(raw: unknown): OrchestrationProviderSettings {
  const fallback = defaults();
  try {
    if (!raw || typeof raw !== 'object') return fallback;
    const groupthink = (raw as { groupthink?: unknown }).groupthink;
    if (!groupthink || typeof groupthink !== 'object') return fallback;
    const candidate = groupthink as Record<string, unknown>;
    return {
      groupthink: {
        defaultLeadProvider: isLaunchableAgentProvider(candidate.defaultLeadProvider)
          ? candidate.defaultLeadProvider
          : fallback.groupthink.defaultLeadProvider,
        defaultReviewerProvider: isLaunchableAgentProvider(candidate.defaultReviewerProvider)
          ? candidate.defaultReviewerProvider
          : fallback.groupthink.defaultReviewerProvider,
      },
    };
  } catch {
    return fallback;
  }
}

/**
 * WRITE VALIDATION only. Explicit updates are rejected without coercion when
 * either field is absent or outside the launchable-provider set.
 */
export function validateOrchestrationProviderSettingsUpdate(
  raw: unknown,
): OrchestrationProviderSettings {
  const groupthink = raw && typeof raw === 'object'
    ? (raw as { groupthink?: unknown }).groupthink
    : undefined;
  const candidate = groupthink && typeof groupthink === 'object'
    ? groupthink as Record<string, unknown>
    : {};

  const lead = candidate.defaultLeadProvider;
  if (!isLaunchableAgentProvider(lead)) {
    throw new OrchestrationProviderSettingsValidationError(
      'groupthink.defaultLeadProvider',
      lead,
    );
  }

  const reviewer = candidate.defaultReviewerProvider;
  if (!isLaunchableAgentProvider(reviewer)) {
    throw new OrchestrationProviderSettingsValidationError(
      'groupthink.defaultReviewerProvider',
      reviewer,
    );
  }

  return {
    groupthink: {
      defaultLeadProvider: lead,
      defaultReviewerProvider: reviewer,
    },
  };
}

export function orchestrationProviderSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceStateDir(workspaceRoot), SETTINGS_FILE_NAME);
}

/** Load is the sole production caller of the lenient sanitizer. */
export function loadOrchestrationProviderSettings(
  workspaceRoot: string,
): OrchestrationProviderSettings {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(orchestrationProviderSettingsPath(workspaceRoot), 'utf8'),
    );
    return sanitizeOrchestrationProviderSettings(raw);
  } catch {
    return defaults();
  }
}

/** Persist an already-validated settings value using a same-directory rename. */
export function saveOrchestrationProviderSettings(
  validated: OrchestrationProviderSettings,
  workspaceRoot: string,
): OrchestrationProviderSettings {
  const target = orchestrationProviderSettingsPath(workspaceRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(validated, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return validated;
}

export function getOrchestrationProviderSettingsCached(
  workspaceRoot: string,
): OrchestrationProviderSettings {
  let cached = cachedByWorkspaceRoot.get(workspaceRoot);
  if (!cached) {
    cached = loadOrchestrationProviderSettings(workspaceRoot);
    cachedByWorkspaceRoot.set(workspaceRoot, cached);
  }
  return cached;
}

/** Strictly validate before resolving a path or touching the filesystem. */
export function updateOrchestrationProviderSettings(
  next: unknown,
  workspaceRoot: string,
): OrchestrationProviderSettings {
  const validated = validateOrchestrationProviderSettingsUpdate(next);
  const saved = saveOrchestrationProviderSettings(validated, workspaceRoot);
  cachedByWorkspaceRoot.set(workspaceRoot, saved);
  return saved;
}

export function __resetOrchestrationProviderSettingsForTest(): void {
  cachedByWorkspaceRoot.clear();
}

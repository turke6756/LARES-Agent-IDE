// @vitest-environment jsdom
//
// WP-G3.4 — the GitInitConsent affordance. Load-bearing rules:
//   1. It renders the honest-disabled → consent state (an explicit "Enable
//      checkpoints" action) only when git is usable AND a workspace is selected.
//   2. It NEVER auto-runs — `git init` fires only on the explicit click.
//   3. It reports the main-process outcome honestly: success hides the action and
//      shows the success line; a refusal/failure keeps the action and shows why.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GitInitConsent from './GitInitConsent';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { GitInitResult } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function gitCheck(status: 'available' | 'missing') {
  return { id: 'git', label: 'Git', status, tier: 'optional', impact: '', remediation: '' };
}
function seedStore(over: { gitStatus?: 'available' | 'missing'; selected?: string | null } = {}) {
  useDashboardStore.setState({
    prerequisites: { optional: [gitCheck(over.gitStatus ?? 'available')] } as any,
    workspaces: [{ id: 'ws1', name: 'demo-project' }] as any,
    selectedWorkspaceId: over.selected === undefined ? 'ws1' : over.selected,
    loadPrerequisites: vi.fn(async () => null),
    checkHealth: vi.fn(async () => {}),
  } as any);
}

function mkApi(gitInit: (id: string) => Promise<GitInitResult>) {
  return { checkpoints: { gitInit: vi.fn(gitInit) } };
}

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<GitInitConsent />);
  });
}

const enableBtn = () => container.querySelector('[data-testid="git-init-enable"]') as HTMLButtonElement | null;
const resultEl = () => container.querySelector('[data-testid="git-init-result"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('GitInitConsent — WP-G3.4', () => {
  it('renders the consent action when git is usable and a workspace is selected', async () => {
    seedStore();
    (window as any).api = mkApi(async () => ({ ok: true, status: 'initialized', message: 'done' }));
    await render();
    const btn = enableBtn();
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toMatch(/git init/i);
    // Says plainly what will happen, before anything runs.
    expect(container.textContent).toMatch(/create a Git repository at the workspace root/i);
    expect(container.textContent).toMatch(/demo-project/);
    // No auto-run.
    expect((window as any).api.checkpoints.gitInit).not.toHaveBeenCalled();
  });

  it('runs git init ONLY on the explicit click, then shows success and hides the action', async () => {
    seedStore();
    (window as any).api = mkApi(async () => ({
      ok: true, status: 'initialized', message: 'Created a Git repository at the workspace root.',
    }));
    await render();
    await act(async () => { enableBtn()!.click(); });

    expect((window as any).api.checkpoints.gitInit).toHaveBeenCalledWith('ws1');
    expect(resultEl()?.textContent).toMatch(/Created a Git repository/i);
    // Success is terminal — the action is gone.
    expect(enableBtn()).toBeNull();
    // The UI re-probed so the status surface reflects the new repo.
    expect(useDashboardStore.getState().loadPrerequisites).toHaveBeenCalledWith(true);
  });

  it('surfaces an already-repo refusal honestly and keeps the action', async () => {
    seedStore();
    (window as any).api = mkApi(async () => ({
      ok: false, status: 'already-repo', message: 'This workspace is already a Git repository.',
    }));
    await render();
    await act(async () => { enableBtn()!.click(); });

    expect(resultEl()?.textContent).toMatch(/already a Git repository/i);
    // A refusal is not success — the action remains available.
    expect(enableBtn()).not.toBeNull();
  });

  it('renders nothing when git is not usable', async () => {
    seedStore({ gitStatus: 'missing' });
    (window as any).api = mkApi(async () => ({ ok: true, status: 'initialized', message: 'done' }));
    await render();
    expect(container.textContent).toBe('');
  });

  it('renders nothing when no workspace is selected', async () => {
    seedStore({ selected: null });
    (window as any).api = mkApi(async () => ({ ok: true, status: 'initialized', message: 'done' }));
    await render();
    expect(container.textContent).toBe('');
  });
});

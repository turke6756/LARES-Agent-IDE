// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Workspace } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import PromoteToPlanPanel from './PromoteToPlanPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = { id: 'ws-1', path: 'C:\\work', pathType: 'windows', title: 'Work' } as Workspace;
const agent = (id: string, title: string, status: Agent['status'], isSupervisor = true): Agent => ({
  id, title, status, isSupervisor, workspaceId: 'ws-1',
} as Agent);

let host: HTMLDivElement;
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('PromoteToPlanPanel supervisor picker', () => {
  it('lists live and terminal structural supervisors plus the new path, excluding workers', () => {
    useDashboardStore.setState({ agents: [
      agent('live', 'Live owner', 'idle'),
      agent('done', 'Done owner', 'done'),
      agent('worker', 'Ordinary worker', 'idle', false),
      { ...agent('foreign', 'Foreign owner', 'idle'), workspaceId: 'ws-2' },
    ] });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(
      <PromoteToPlanPanel workspace={workspace} proposalFilePath="C:\work\.lares\proposals\idea.md" proposalTitle="Idea" onClose={() => {}} />,
    ));

    const text = host.textContent ?? '';
    expect(text).toContain('Live owner');
    expect(text).toContain('Done owner');
    expect(text).toContain('done · revive');
    expect(text).toContain('New supervisor');
    expect(text).not.toContain('Ordinary worker');
    expect(text).not.toContain('Foreign owner');
  });
});

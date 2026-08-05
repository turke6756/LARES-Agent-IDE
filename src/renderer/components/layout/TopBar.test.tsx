// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import TopBar from './TopBar';

let container: HTMLDivElement;
let root: Root;
let openToolTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  openToolTab = vi.fn();
  useDashboardStore.setState({ workspaces: [], selectedWorkspaceId: null, openToolTab } as any);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe('TopBar Tools menu', () => {
  it('opens the GroupThink Providers tool tab', () => {
    act(() => {
      root = createRoot(container);
      root.render(<TopBar />);
    });
    const tools = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Tools')!;
    act(() => tools.click());
    const item = [...container.querySelectorAll('button')].find((button) => button.textContent === 'GroupThink Providers')!;
    act(() => item.click());
    expect(openToolTab).toHaveBeenCalledWith('groupthink-providers', 'GroupThink Providers');
  });
});

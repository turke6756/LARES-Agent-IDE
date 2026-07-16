// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../stores/dashboard-store';
import { useTreeHoverStore } from '../stores/tree-hover-store';
import {
  bindDoubleSpaceSidePanelCollapse,
  DOUBLE_SPACE_WINDOW_MS,
} from './useDoubleSpaceSidePanelCollapse';

function pressSpace(target: EventTarget = window, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('double-Space side-panel shortcut', () => {
  beforeEach(() => {
    useTreeHoverStore.setState({ hovered: null, spaceHold: false });
    document.body.innerHTML = '';
  });

  it('collapses on two Space presses inside the gesture window', () => {
    const collapse = vi.fn();
    let time = 1_000;
    const unbind = bindDoubleSpaceSidePanelCollapse(window, collapse, () => time);

    pressSpace();
    time += DOUBLE_SPACE_WINDOW_MS;
    const second = pressSpace();

    expect(collapse).toHaveBeenCalledOnce();
    expect(second.defaultPrevented).toBe(true);
    unbind();
  });

  it('toggles both side panels closed and back open', () => {
    useDashboardStore.setState((state) => ({
      panelLayout: {
        ...state.panelLayout,
        sidebarCollapsed: false,
        detailPanelCollapsed: false,
      },
    }));

    useDashboardStore.getState().toggleSidePanels();
    expect(useDashboardStore.getState().panelLayout).toMatchObject({
      sidebarCollapsed: true,
      detailPanelCollapsed: true,
    });

    useDashboardStore.getState().toggleSidePanels();
    expect(useDashboardStore.getState().panelLayout).toMatchObject({
      sidebarCollapsed: false,
      detailPanelCollapsed: false,
    });
  });

  it('does not collapse for slow presses, editable targets, repeats, or a hovered tree', () => {
    const collapse = vi.fn();
    let time = 1_000;
    const unbind = bindDoubleSpaceSidePanelCollapse(window, collapse, () => time);

    pressSpace();
    time += DOUBLE_SPACE_WINDOW_MS + 1;
    pressSpace();

    const input = document.body.appendChild(document.createElement('input'));
    time += 10;
    pressSpace(input);
    time += 10;
    pressSpace(input);

    pressSpace(window, { repeat: true });

    useTreeHoverStore.setState({
      hovered: {
        rootPath: 'C:\\workspace',
        path: 'C:\\workspace\\src',
        isDirectory: true,
        toggleRef: { current: () => undefined },
      },
    });
    time += 10;
    pressSpace();
    time += 10;
    pressSpace();

    expect(collapse).not.toHaveBeenCalled();
    unbind();
  });
});

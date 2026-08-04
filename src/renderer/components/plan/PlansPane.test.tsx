// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlansPane from './PlansPane';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('PlansPane shell', () => {
  it('reserves proposal and promoted-plan regions without surfacing history', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<PlansPane />));

    expect(container.querySelector('[data-testid="plans-proposals-region"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plans-promoted-region"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/historic|history|legacy/i);
  });
});

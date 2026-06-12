// @vitest-environment jsdom
/**
 * WP0.3 acceptance: mount/unmount the Crepe editor twice, StrictMode-style,
 * without throwing or leaking a live Crepe instance.
 */
import { describe, it, expect } from 'vitest';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import MilkdownEditor, { getActiveCrepeInstanceCount } from './MilkdownEditor';
import { polyfillJsdomForProseMirror } from './prosemirrorJsdomPolyfills';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

polyfillJsdomForProseMirror();

const flushCrepe = async () => {
  // crepe.create() resolves over several microtask/macrotask hops
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
};

describe('MilkdownEditor lifecycle', () => {
  it('mounts/unmounts twice (StrictMode) without throwing or leaking', async () => {
    expect(getActiveCrepeInstanceCount()).toBe(0);

    for (let cycle = 0; cycle < 2; cycle++) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);

      await act(async () => {
        root.render(
          <StrictMode>
            <MilkdownEditor content={'# Spike\n\nA paragraph.\n\n- a\n- b\n'} />
          </StrictMode>,
        );
      });
      await flushCrepe();

      // StrictMode double-invokes the effect: the throwaway instance must be
      // gone, exactly one live instance may remain while mounted.
      expect(getActiveCrepeInstanceCount()).toBe(1);
      expect(host.querySelector('.milkdown')).toBeTruthy();

      await act(async () => {
        root.unmount();
      });
      await flushCrepe();

      expect(getActiveCrepeInstanceCount()).toBe(0);
      host.remove();
    }
  });
});

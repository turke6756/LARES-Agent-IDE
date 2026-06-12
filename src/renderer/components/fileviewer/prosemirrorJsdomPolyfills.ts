/**
 * Test-only helper: the DOM APIs ProseMirror/Crepe touch during mount that
 * jsdom doesn't implement. Imported by jsdom unit tests; never by app code.
 */
export function polyfillJsdomForProseMirror(): void {
  const rect = {
    x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
    toJSON: () => ({}),
  } as DOMRect;
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (typeof proto.getClientRects !== 'function') {
    proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
    proto.getBoundingClientRect = () => rect;
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null;
  }
  const g = globalThis as Record<string, unknown>;
  if (typeof g.ResizeObserver !== 'function') {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof g.IntersectionObserver !== 'function') {
    g.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
}

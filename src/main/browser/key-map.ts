// WP-C C0 (plans/groupthink/browser-parity-and-research-store.md) — pure
// chord→CDP key payload map for press_key and type()'s select-all clear.
// No Electron imports — compiled-node unit-test surface (key-map.test.ts).
//
// M10: this map only describes physical key events for a fixed, named set of
// keys. There is NO eval here, no agent-supplied code path — press_key
// dispatches Input.dispatchKeyEvent with one of these fixed payloads, never a
// script. resolveKey returns null for anything off the list so the caller can
// throw a readable error instead of dispatching an arbitrary key.

export interface CdpKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Present iff the key emits a character (Enter→'\r', Tab→'\t'). `pressKey`
   *  mirrors this into `unmodifiedText` on the keydown (Puppeteer parity) so the
   *  keydown produces the DOM keypress that fires a form's implicit submit; no
   *  separate char event is emitted. */
  text?: string;
  /** CDP modifier bitmask: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift. */
  modifiers?: number;
  /** Named Chromium editor commands run ON the keydown edge (e.g.
   *  ['selectAll']). Chromium only executes editing commands when the keydown
   *  explicitly carries this array — it does NOT infer them from VK+modifiers.
   *  These are built-in editor commands, NOT JS eval (M10-safe). */
  commands?: string[];
}

export const NAMED_KEYS: Record<string, CdpKey> = {
  Enter:      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13, text: '\r' },
  Tab:        { key: 'Tab',        code: 'Tab',        windowsVirtualKeyCode: 9,  text: '\t' },
  Escape:     { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  Backspace:  { key: 'Backspace',  code: 'Backspace',  windowsVirtualKeyCode: 8  },
  Delete:     { key: 'Delete',     code: 'Delete',     windowsVirtualKeyCode: 46 },
  ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
  ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
  ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home:       { key: 'Home',       code: 'Home',       windowsVirtualKeyCode: 36 },
  End:        { key: 'End',        code: 'End',        windowsVirtualKeyCode: 35 },
  PageUp:     { key: 'PageUp',     code: 'PageUp',     windowsVirtualKeyCode: 33 },
  PageDown:   { key: 'PageDown',   code: 'PageDown',   windowsVirtualKeyCode: 34 },
};

/** Ctrl+A select-all for type()'s replace clear. The `commands:['selectAll']`
 *  array is what actually runs the selection — Chromium executes the named
 *  editor command regardless of input type (search inputs, DDG, Wikipedia),
 *  whereas a bare Ctrl+A or synthetic Shift+Ctrl+Home keydown is ignored on
 *  many inputs and forms no selection. modifiers:2 = Ctrl (for fidelity). */
export const SELECT_ALL: CdpKey = {
  key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'],
};

export const SUPPORTED_BROWSER_KEYS = Object.keys(NAMED_KEYS);

/** Resolve a case-insensitive key name to its CDP payload, or null (caller
 *  throws a readable "unsupported key; supported: …" error — never a raw
 *  dispatch). */
export function resolveKey(name: string): CdpKey | null {
  if (typeof name !== 'string') return null;
  const hit = SUPPORTED_BROWSER_KEYS.find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? NAMED_KEYS[hit] : null;
}

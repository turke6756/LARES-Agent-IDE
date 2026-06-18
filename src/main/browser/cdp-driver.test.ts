// Browser automation defect-fix tests (acceptance follow-up) — assert the
// EXACT CDP payloads CdpDriver emits for the repaired verbs:
//   • type(replace)  → descend to the inner editable (DOM.querySelector under
//     the ref's pushed node) → focus it → assertPageFocused
//     (Emulation.setFocusEmulationEnabled) → selectAll-command keydown →
//     Input.insertText. The agent's ref often lands on a combobox/search WRAPPER
//     (type=search / DDG / Wikipedia); descending targets the real <input>. The
//     clear is a FOCUS-CORRECT selectAll editor command + insertText (which
//     REPLACES the selection) — NO Backspace key-events. Agent tabs are HIDDEN
//     WebContentsViews, never "focused & active", so dispatchKeyEvent EDITING
//     default-actions (selectAll, Backspace deletion) silently NO-OP unless
//     Emulation.setFocusEmulationEnabled holds the page focused+active; the old
//     Backspace×N clear deleted nothing while insertText appended → replace
//     became append (A2 / round-6). A second type now REPLACES rather than
//     appends (Defect 1).
//   • pressKey(Enter)→ assertPageFocused first (so the hidden view's implicit
//     submit default-action fires), then a 2-event sequence keyDown(text:'\r'
//     AND unmodifiedText:'\r') + keyUp(NO text), NO separate char (matches
//     Puppeteer's CDP path). Blink builds the DOM keypress that fires a form's
//     IMPLICIT submit from unmodifiedText, not text — the missing unmodifiedText
//     (every prior round) was the A3 defect. The keydown still reads as
//     key:'Enter' so ARIA-combobox commit (A7) is unchanged. Char-less keys
//     stay rawKeyDown + keyUp and emit NO char. Mouse click carries
//     button:'left', buttons:1, clickCount:1 so a submit <button> submits
//     (Defect 2).
//   • refuseNativeSelect → DOM.describeNode; nodeName 'SELECT' throws the
//     keyboard guidance and NEVER reaches the click/geometry path; hasGeometry
//     reports empty content-quads so select_option can refuse select2-style /
//     aria-activedescendant comboboxes with the SAME guidance (Defect 3 + the
//     mis-error round-2 fix)
//
// CdpDriver has no Electron runtime import (only `import type`), so it runs
// under plain node against a fake debugger that records sendCommand calls.
//
//   npm run build:main
//   node dist/main/main/browser/cdp-driver.test.js

import assert from 'node:assert/strict';
import { CdpDriver, KEYBOARD_DROPDOWN_GUIDANCE } from './cdp-driver';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

interface Call { method: string; params: Record<string, unknown>; }

/** Fake webContents.debugger that records every sendCommand and answers from a
 *  handler map (value, or a fn of params). Unknown methods return {}. */
function makeDriver(handlers: Record<string, unknown> = {}): { driver: CdpDriver; calls: Call[] } {
  const calls: Call[] = [];
  const dbg = {
    on(): void {},
    off(): void {},
    async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params: params ?? {} });
      const h = handlers[method];
      return typeof h === 'function' ? (h as (p?: Record<string, unknown>) => unknown)(params) : (h ?? {});
    },
  };
  // wc is only touched by navigateAndWait/getText, none of which we exercise.
  const driver = new CdpDriver({} as never, () => dbg as never);
  return { driver, calls };
}

const keyEvents = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
const mouseEvents = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
const focusEmulation = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'Emulation.setFocusEmulationEnabled');

// ── Defect 1 / A2: type(replace) descends to the inner editable + clears ────

// The ref (backend id 7) is a search/combobox WRAPPER; its inner <input> is
// backend id 77. resolveEditable pushes 7 to a frontend nodeId (100),
// querySelectors its subtree → inner nodeId 200, and describeNode(200) → backend
// id 77. The clear then targets 77 with a selectAll editor command + insertText.
const editableResolution = {
  'DOM.pushNodesByBackendIdsToFrontend': { nodeIds: [100] },
  'DOM.querySelector': { nodeId: 200 },
  'DOM.describeNode': (p?: Record<string, unknown>) =>
    p?.nodeId === 200 ? { node: { backendNodeId: 77 } } : { node: {} },
};

test('type(replace) descends to inner editable → assertPageFocused → selectAll → insertText (NO Backspace, NO DOMSnapshot)', async () => {
  const { driver, calls } = makeDriver({
    ...editableResolution,
    // An AX tree IS available but must NOT be consulted — the clear is value-agnostic now.
    'Accessibility.getFullAXTree': { nodes: [{ nodeId: '1', backendDOMNodeId: 77, value: { value: 'WRONG' } }] },
  });
  await driver.typeText(7, 'anthropic', { replace: true });

  // Descended 7 → inner editable 77 and focused THAT node, not the wrapper.
  const focus = calls.filter((c) => c.method === 'DOM.focus');
  assert.ok(focus.some((c) => c.params.backendNodeId === 77), 'focus targets the inner editable (77)');
  assert.ok(!focus.some((c) => c.params.backendNodeId === 7), 'wrapper ref (7) is not focused');

  // Page held focused+active so the selectAll editor command's default-action fires
  // on the hidden agent view (the crux of the A2 fix).
  const emu = focusEmulation(calls);
  assert.equal(emu.length, 1, 'assertPageFocused fired exactly once for the replace clear');
  assert.deepEqual(emu[0].params, { enabled: true });

  // The clear reads NO field value — no DOMSnapshot, no AX tree, no Backspace count.
  assert.ok(!calls.some((c) => c.method === 'DOMSnapshot.captureSnapshot'), 'no value read (DOMSnapshot)');
  assert.ok(!calls.some((c) => c.method === 'Accessibility.getFullAXTree'), 'does NOT read getFullAXTree');

  const keys = keyEvents(calls);
  // Exactly the selectAll keydown + keyUp — no Delete, no End, no Backspace.
  assert.equal(keys.length, 2, 'only the selectAll keydown/keyUp — no deletion keys');
  assert.equal(keys[0].params.type, 'rawKeyDown');
  assert.equal(keys[0].params.windowsVirtualKeyCode, 65, 'KeyA');
  assert.equal(keys[0].params.modifiers, 2, 'Ctrl');
  assert.deepEqual(keys[0].params.commands, ['selectAll'], 'named editor command on the keydown');
  assert.equal(keys[1].params.type, 'keyUp');
  assert.equal(keys[1].params.commands, undefined, 'commands never on keyUp');
  assert.ok(
    !keys.some((k) => [8, 46, 35].includes(k.params.windowsVirtualKeyCode as number)),
    'NO Backspace(8)/Delete(46)/End(35) — insertText replaces the selection',
  );

  // insertText runs exactly once, AFTER the selectAll selection, with the new text.
  const inserts = calls.filter((c) => c.method === 'Input.insertText');
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].params, { text: 'anthropic' });
  const lastKeyIdx = calls.lastIndexOf(keys[keys.length - 1]);
  assert.ok(calls.indexOf(inserts[0]) > lastKeyIdx, 'insertText comes after the selectAll selection');

  // Ordering: focus → focus-emulation → selectAll → insertText.
  assert.ok(calls.indexOf(emu[0]) < calls.indexOf(keys[0]), 'focus emulation asserted before the selectAll keydown');
});

test('type(replace) is a no-op descent when the ref is already the editable (querySelector finds no inner input)', async () => {
  const { driver, calls } = makeDriver({
    'DOM.pushNodesByBackendIdsToFrontend': { nodeIds: [100] },
    'DOM.querySelector': { nodeId: 0 }, // no descendant input → keep the ref itself
  });
  await driver.typeText(7, 'z', { replace: true });

  const focus = calls.filter((c) => c.method === 'DOM.focus');
  assert.ok(focus.some((c) => c.params.backendNodeId === 7), 'focuses the original input ref (7)');
  // describeNode is NOT called to remap when querySelector found nothing.
  assert.ok(!calls.some((c) => c.method === 'DOM.describeNode'), 'no remap when ref is already the input');
  // Still a focus-correct selectAll + insertText.
  assert.equal(focusEmulation(calls).length, 1, 'assertPageFocused still fires');
  const keys = keyEvents(calls);
  assert.equal(keys.length, 2, 'selectAll keydown/keyUp only');
  assert.deepEqual(keys[0].params.commands, ['selectAll']);
  const inserts = calls.filter((c) => c.method === 'Input.insertText');
  assert.deepEqual(inserts[0].params, { text: 'z' });
});

test('type without replace does NOT clear, descend, or assert focus — just insertText', async () => {
  const { driver, calls } = makeDriver();
  await driver.typeText(7, 'hi', { replace: false });
  assert.equal(keyEvents(calls).length, 0, 'no clearing keys when replace=false');
  assert.equal(focusEmulation(calls).length, 0, 'no focus-emulation on the non-replace path');
  // No editable descent and no value read when not replacing.
  assert.ok(!calls.some((c) => c.method === 'DOM.pushNodesByBackendIdsToFrontend'), 'no editable descent');
  assert.ok(!calls.some((c) => c.method === 'DOMSnapshot.captureSnapshot'), 'no value read');
  const inserts = calls.filter((c) => c.method === 'Input.insertText');
  assert.deepEqual(inserts[0].params, { text: 'hi' });
});

// ── Defect 2a / A3: Enter — assertPageFocused, then keyDown+keyUp, NO char ───

test('pressKey(Enter) asserts page focus, then keyDown(text+unmodifiedText:\\r, vk/native 13) + keyUp(no text), NO char', async () => {
  const { driver, calls } = makeDriver();
  // Enter's payload (matches key-map.ts NAMED_KEYS.Enter).
  await driver.pressKey({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });

  // A3 fix: the implicit-submit default-action is gated on the page being
  // focused+active, which a hidden agent view is not — assert it BEFORE the keys.
  const emu = focusEmulation(calls);
  assert.equal(emu.length, 1, 'assertPageFocused fired before the Enter dispatch');
  assert.deepEqual(emu[0].params, { enabled: true });

  const keys = keyEvents(calls);
  assert.equal(keys.length, 2, 'keyDown + keyUp (no separate char event)');
  assert.ok(calls.indexOf(emu[0]) < calls.indexOf(keys[0]), 'focus emulation precedes the keydown');

  // keyDown carries BOTH text and unmodifiedText. Blink synthesizes the DOM
  // keypress — whose default action runs implicit form submit — from
  // unmodifiedText, not text; its prior absence was the A3 defect. This mirrors
  // Puppeteer's path: keyDown{text, unmodifiedText} → keyUp, no char.
  assert.equal(keys[0].params.type, 'keyDown');
  assert.equal(keys[0].params.text, '\r', 'text on the keydown edge');
  assert.equal(keys[0].params.unmodifiedText, '\r', 'unmodifiedText drives the keypress/submit');
  assert.equal(keys[0].params.windowsVirtualKeyCode, 13);
  assert.equal(keys[0].params.nativeVirtualKeyCode, 13, 'native VK sent alongside windows VK');
  assert.equal(keys[0].params.key, 'Enter', 'A7: keydown still reads as key:Enter — combobox commit unchanged');
  assert.equal(keys[0].params.code, 'Enter');

  // No explicit char event — it would insert a stray '\r' in a textarea and can
  // double the keypress; the keyDown alone fires the submitting keypress.
  assert.ok(!keys.some((k) => k.params.type === 'char'), 'no separate char event');

  // keyUp carries the VK but NOT the char or unmodifiedText.
  assert.equal(keys[1].params.type, 'keyUp');
  assert.equal(keys[1].params.text, undefined, 'no text on keyUp');
  assert.equal(keys[1].params.unmodifiedText, undefined, 'no unmodifiedText on keyUp');
  assert.equal(keys[1].params.nativeVirtualKeyCode, 13);
});

test('pressKey for a character-less key emits rawKeyDown + keyUp (no char)', async () => {
  const { driver, calls } = makeDriver();
  await driver.pressKey({ key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  const keys = keyEvents(calls);
  assert.equal(keys.length, 2, 'no char event for a char-less key');
  assert.equal(keys[0].params.type, 'rawKeyDown');
  assert.equal(keys[0].params.text, undefined);
  assert.ok(!keys.some((k) => k.params.type === 'char'), 'no char event');
  assert.equal(keys[1].params.type, 'keyUp');
});

test('pressKey carries a named editor command on the keydown edge only', async () => {
  const { driver, calls } = makeDriver();
  await driver.pressKey({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
  const keys = keyEvents(calls);
  assert.equal(keys[0].params.type, 'rawKeyDown');
  assert.deepEqual(keys[0].params.commands, ['selectAll']);
  assert.equal(keys[1].params.type, 'keyUp');
  assert.equal(keys[1].params.commands, undefined, 'commands never on keyUp');
});

// ── Defect 2b: a real left click (buttons:1) so submit buttons submit ───────

test('click emits move→press→release with button:left, buttons:1, clickCount:1', async () => {
  const { driver, calls } = makeDriver({
    'DOM.getContentQuads': { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] },
  });
  await driver.click(3);

  const mice = mouseEvents(calls);
  assert.equal(mice.length, 3);
  assert.equal(mice[0].params.type, 'mouseMoved');
  assert.equal(mice[0].params.buttons, 0);

  assert.equal(mice[1].params.type, 'mousePressed');
  assert.equal(mice[1].params.button, 'left');
  assert.equal(mice[1].params.buttons, 1);
  assert.equal(mice[1].params.clickCount, 1);

  assert.equal(mice[2].params.type, 'mouseReleased');
  assert.equal(mice[2].params.button, 'left');
  assert.equal(mice[2].params.buttons, 1);
  assert.equal(mice[2].params.clickCount, 1);
});

test('click on a node with no geometry throws the fresh-ref guidance', async () => {
  const { driver } = makeDriver({ 'DOM.getContentQuads': { quads: [] } });
  await assert.rejects(() => driver.click(9), /no visible geometry|fresh ref/);
});

// ── Defect 3: native <select> is refused before any click ───────────────────

// The shared guidance names every keyboard-only widget class + the press_key
// recovery, so all three select_option refusal sites give one consistent message.
test('KEYBOARD_DROPDOWN_GUIDANCE names the widget classes and the press_key recovery', () => {
  assert.match(KEYBOARD_DROPDOWN_GUIDANCE, /Native <select>/);
  assert.match(KEYBOARD_DROPDOWN_GUIDANCE, /select2-style/);
  assert.match(KEYBOARD_DROPDOWN_GUIDANCE, /aria-activedescendant/);
  assert.match(KEYBOARD_DROPDOWN_GUIDANCE, /press_key ArrowDown\/ArrowUp/);
  assert.match(KEYBOARD_DROPDOWN_GUIDANCE, /press_key Enter/);
  // Must NOT regress into the misleading geometry/fresh-ref wording.
  assert.ok(!/no visible geometry/.test(KEYBOARD_DROPDOWN_GUIDANCE));
  assert.ok(!/fresh ref/.test(KEYBOARD_DROPDOWN_GUIDANCE));
});

test('refuseNativeSelect throws the shared guidance for nodeName SELECT — no click', async () => {
  const { driver, calls } = makeDriver({ 'DOM.describeNode': { node: { nodeName: 'SELECT' } } });
  await assert.rejects(
    () => driver.refuseNativeSelect(5),
    (err: Error) => {
      assert.equal(err.message, KEYBOARD_DROPDOWN_GUIDANCE);
      return true;
    },
  );
  // It must describe the node but NEVER reach the geometry/click path.
  assert.ok(calls.some((c) => c.method === 'DOM.describeNode'), 'describeNode was called');
  assert.ok(!calls.some((c) => c.method === 'DOM.getContentQuads'), 'never reaches getContentQuads');
  assert.ok(!calls.some((c) => c.method === 'Input.dispatchMouseEvent'), 'never clicks');
});

test('refuseNativeSelect is a no-op for an ARIA combobox (nodeName DIV)', async () => {
  const { driver } = makeDriver({ 'DOM.describeNode': { node: { nodeName: 'DIV' } } });
  await driver.refuseNativeSelect(5); // resolves without throwing
});

test('refuseNativeSelect matches case-insensitively (describeNode returns lower-case)', async () => {
  const { driver } = makeDriver({ 'DOM.describeNode': { node: { nodeName: 'select' } } });
  await assert.rejects(() => driver.refuseNativeSelect(5), (err: Error) => {
    assert.equal(err.message, KEYBOARD_DROPDOWN_GUIDANCE);
    return true;
  });
});

// hasGeometry: select_option's pre-click probe for select2-style / off-layout
// comboboxes that resolve to a 0×0 node (the round-2 mis-error fix).
test('hasGeometry is false for empty content-quads (hidden 0×0 / select2 wrapper)', async () => {
  const { driver } = makeDriver({ 'DOM.getContentQuads': { quads: [] } });
  assert.equal(await driver.hasGeometry(5), false);
});

test('hasGeometry is false when getContentQuads returns a degenerate quad', async () => {
  const { driver } = makeDriver({ 'DOM.getContentQuads': { quads: [[0, 0, 0, 0]] } });
  assert.equal(await driver.hasGeometry(5), false);
});

test('hasGeometry is true for a laid-out node (full 8-point quad)', async () => {
  const { driver } = makeDriver({ 'DOM.getContentQuads': { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] } });
  assert.equal(await driver.hasGeometry(5), true);
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} cdp-driver tests passed`);
})();

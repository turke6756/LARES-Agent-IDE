// Tiny pure helpers split out of `_doSendInput` so the per-provider Enter
// encoding can be unit-tested without dragging in the rest of AgentSupervisor.
// See BUG-01 / send-input-encoder.test.ts.

// Win32 Input Mode CSI sequence for a VK_RETURN keypress (down + up).
// Codex/gemini on Windows enable mode ?9001h and expect submit as a real
// key event, not the auto-converted single KEY_DOWN ConPTY emits for raw '\r'.
// Format: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
const WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_';
const WIN32_KEY_ENTER_UP = '\x1b[13;28;13;0;0;1_';

/**
 * Per-provider Windows submit byte sequence (the keys that get written after
 * the body when `submit:true`). Used by AgentSupervisor._doSendInput and
 * exercised directly by send-input-encoder.test.ts.
 */
export function getWindowsSubmitSequence(provider: string): string {
  if (provider === 'claude') return '\r';
  if (provider === 'codex' || provider === 'gemini') {
    return WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP;
  }
  return '\r';
}

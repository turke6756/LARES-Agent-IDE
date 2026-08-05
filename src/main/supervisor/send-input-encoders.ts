// Tiny pure helpers split out of `_doSendInput` so the per-provider Enter
// encoding can be unit-tested without dragging in the rest of AgentSupervisor.
// See BUG-01 / send-input-encoder.test.ts.

// Win32 Input Mode CSI sequence for a VK_RETURN keypress (down + up).
// Codex on Windows enables mode ?9001h and expects submit as a real
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
  // Grok submits on a bare crossterm KeyCode::Enter/NONE and never enables
  // Win32 Input Mode, so over ConPTY a plain CR is the submit byte — same as
  // the Claude-on-Windows lane, NOT the codex Win32 VK_RETURN records.
  // Source-verified: xai-grok-pager prompt_widget/mod.rs:2142 (submit on
  // Enter/NONE) + app/mod.rs:1174-1202 (kitty push) + render terminal/mod.rs:
  // 344-388 (kitty gated OFF for ConPTY). See plans/grok-phase0-probe-results.md
  // §0.1. Listed explicitly (not left to the CR fall-through) so the contract is
  // a verified decision, not an implicit accident.
  if (provider === 'grok') return '\r';
  // Empirically proven over the dashboard's real node-pty/ConPTY transport:
  // bare CR submits agy, while LF inserts a newline without submitting. agy
  // also accepts kitty CSI-u Enter, but CR is the canonical legacy-robust form.
  // See C:/Users/turke/Projects/plans/agy-phase0-probe-results.md §0.1.
  if (provider === 'agy') return '\r';
  if (provider === 'codex') {
    return WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP;
  }
  return '\r';
}

/**
 * Normalize an agy prompt body without introducing submit bytes. Probe §0.1
 * proves that every embedded CR would submit immediately, whereas LF is agy's
 * transport-friendly newline chord. The caller writes the final submit CR as a
 * separate event via getWindowsSubmitSequence('agy').
 */
export function encodeAgyWindowsBody(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

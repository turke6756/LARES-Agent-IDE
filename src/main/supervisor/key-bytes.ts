// Provider-aware named-key → PTY byte sequence mapping for BUG-02.
//
// Background: `send_keys_to_agent` originally took only a raw `keys` string.
// The MCP tool description promised that JS-style escapes like `\r` and
// `\x1b` would be interpreted by the JSON parser before the bytes hit the
// PTY, but in practice MCP clients often pass the two-character escape
// through literally (one backslash + one 'r'), so every Enter submission
// became a coin flip. Worse, even when the JSON decoding worked, the *right*
// Enter byte sequence depends on the agent's provider and host:
//
//   - claude (windows or wsl):     plain CR (`\r`)
//   - codex/gemini on Windows:     Win32 Input Mode VK_RETURN down+up pair
//   - codex/gemini on WSL (kitty): CSI-u `\x1b[13u`
//
// This module exposes a small enum-based API that callers can use to ask
// for a named key (`enter`, `esc`, `tab`, an arrow, Ctrl-C, etc.) and get
// back the correct bytes for the target agent. Callers that genuinely need
// raw bytes can still pass them via the legacy `keys` field on the HTTP
// endpoint.
//
// Provider tables live in arrays-of-tuples form rather than nested objects
// so the supported (key, provider, pathType) combinations are easy to scan
// in code review and trivially exhaustive-testable.

import type { AgentProvider, PathType } from '../../shared/types';

// Win32 Input Mode CSI sequences (ConPTY-aware). Codex/gemini enable Win32
// Input Mode (ESC[?9001h) on launch and expect every keypress as a CSI
// `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _` event with both down (Kd=1) and up
// (Kd=0). Plain `\r` is auto-translated by ConPTY into a single KEY_DOWN
// which renders typed chars but does NOT trigger submit.
const WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_';
const WIN32_KEY_ENTER_UP = '\x1b[13;28;13;0;0;1_';
const WIN32_KEY_SHIFT_ENTER_DOWN = '\x1b[13;28;13;1;16;1_';
const WIN32_KEY_SHIFT_ENTER_UP = '\x1b[13;28;13;0;16;1_';
const WIN32_KEY_ENTER = WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP;
const WIN32_KEY_SHIFT_ENTER = WIN32_KEY_SHIFT_ENTER_DOWN + WIN32_KEY_SHIFT_ENTER_UP;

// CSI-u (kitty keyboard protocol). All three providers enable this on Linux
// at startup; tmux's `send-keys Enter` (a bare `\r`) is dropped under
// disambiguate-escape, so submit must be the CSI form.
const KITTY_ENTER = '\x1b[13u';
const KITTY_SHIFT_ENTER = '\x1b[13;2u';

// Standard CSI key sequences that work across all providers and hosts.
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_RIGHT = '\x1b[C';
const ARROW_LEFT = '\x1b[D';

/** Named keys that `send_keys_to_agent` understands via the `key` parameter. */
export const SUPPORTED_KEY_NAMES = [
  'enter',
  'shift-enter',
  'esc',
  'tab',
  'up',
  'down',
  'left',
  'right',
  'backspace',
  'ctrl-c',
  'ctrl-d',
  'space',
] as const;

export type KeyName = (typeof SUPPORTED_KEY_NAMES)[number];

export function isKeyName(value: unknown): value is KeyName {
  return typeof value === 'string' && (SUPPORTED_KEY_NAMES as readonly string[]).includes(value);
}

/**
 * Map a named key to the byte sequence the agent's PTY expects. The mapping
 * varies by (provider, pathType) for `enter` and `shift-enter`; all other
 * keys are provider-agnostic.
 *
 * Returns the byte string ready to be written verbatim to the agent's PTY
 * via `Supervisor.writeToAgent`. Throws on unknown keys so callers get a
 * loud failure instead of silently sending no bytes.
 */
export function mapKeyToBytes(
  key: KeyName,
  provider: AgentProvider,
  pathType: PathType,
): string {
  switch (key) {
    case 'enter': {
      // claude (any host) accepts plain CR. codex/gemini need the
      // provider+host-specific submit event — otherwise bytes render as
      // typed text without firing submit.
      if (provider === 'claude') return '\r';
      if (provider === 'codex' || provider === 'gemini') {
        return pathType === 'wsl' ? KITTY_ENTER : WIN32_KEY_ENTER;
      }
      return '\r';
    }
    case 'shift-enter': {
      // Inserts a newline in multi-line input *without* submitting.
      // Claude on either host treats CR as submit, so for claude we map
      // shift-enter to bracketed-paste-friendly LF — callers can use it
      // for newline-without-submit when the input is single-shot.
      if (provider === 'claude') return '\n';
      if (provider === 'codex' || provider === 'gemini') {
        return pathType === 'wsl' ? KITTY_SHIFT_ENTER : WIN32_KEY_SHIFT_ENTER;
      }
      return '\n';
    }
    case 'esc':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'up':
      return ARROW_UP;
    case 'down':
      return ARROW_DOWN;
    case 'left':
      return ARROW_LEFT;
    case 'right':
      return ARROW_RIGHT;
    case 'backspace':
      // DEL (0x7f) is what terminal libraries (readline, blessed, ink) treat
      // as backspace; BS (0x08) often gets interpreted as ^H instead.
      return '\x7f';
    case 'ctrl-c':
      return '\x03';
    case 'ctrl-d':
      return '\x04';
    case 'space':
      return ' ';
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unknown key name: ${String(_exhaustive)}`);
    }
  }
}

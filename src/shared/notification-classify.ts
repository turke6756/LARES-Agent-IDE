/** Claude Code Notification `notification_type` values that are INFORMATIONAL —
 *  they never gate on a human and must not flip an agent's card to 'waiting'.
 *  Blocking types (permission_prompt, elicitation_dialog) and any UNKNOWN/missing
 *  type fall through to 'waiting' (conservative: a possibly-blocked agent must be
 *  surfaced). The array is the canonical list (drift tests iterate it); the Set is
 *  the lookup. Keep in sync with the inlined mirror in buildDashboardStatusScript
 *  (src/shared/constants.ts). See plans/idle-vs-waiting-notification-fix.md. */
export const NON_BLOCKING_NOTIFICATION_TYPES = [
  'idle_prompt',
  'auth_success',
  'elicitation_complete',
  'elicitation_response',
] as const;

const NON_BLOCKING_NOTIFICATION_TYPE_SET = new Set<string>(NON_BLOCKING_NOTIFICATION_TYPES);

/** True when a Notification event must NOT drive the 'waiting' latch. */
export function isNonBlockingNotificationType(value?: string): boolean {
  return NON_BLOCKING_NOTIFICATION_TYPE_SET.has((value ?? '').trim().toLowerCase());
}

/** Notification `message` texts that announce turn/response COMPLETION rather
 *  than gating on a human. The grok lane fires a Notification hook on turn
 *  completion carrying the message "Turn complete" and NO `notification_type`,
 *  so the type-based `isNonBlockingNotificationType` discriminator can't catch
 *  it — mapping it to 'waiting' strands an idle worker (~60s after a clean
 *  Stop→idle). Genuine input-needed / permission notifications ("waiting for
 *  your input", trust/permission prompts) do NOT match, so they still latch
 *  'waiting'. Matched on the message because the type is absent. */
const TURN_COMPLETE_NOTIFICATION_MESSAGE_RE = /\bturn complete\b/i;

/** True when a Notification's message is a turn-completion notice (informational)
 *  and so must NOT drive the 'waiting' latch, regardless of transport/type. */
export function isTurnCompleteNotificationMessage(message?: string): boolean {
  return TURN_COMPLETE_NOTIFICATION_MESSAGE_RE.test((message ?? '').trim());
}

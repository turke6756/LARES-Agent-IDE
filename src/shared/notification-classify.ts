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

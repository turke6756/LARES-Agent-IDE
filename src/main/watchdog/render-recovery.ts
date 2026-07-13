// D1 shell renderer-crash recovery policy (incident-2026-07-11 §5 D1).
//
// Pure decision logic, extracted from the Electron `render-process-gone` handler
// so the bounded-retry + pressure-gate behavior is unit-testable without a live
// window. The handler in index.ts owns the side effects (log, reload, dialog);
// this owns the "reload vs dialog" decision and the attempt bookkeeping.

export type RecoveryAction = 'reload' | 'dialog';

export interface RecoveryDecision {
  action: RecoveryAction;
  /** Why this action was chosen (for the crash log line + the dialog copy). */
  reason: 'reload' | 'critical-pressure' | 'retries-exhausted';
}

export interface RenderRecoveryConfig {
  /** Max automatic reloads within the rolling window. */
  maxAttempts: number;
  /** Rolling window for the attempt budget (ms). */
  windowMs: number;
}

export const DEFAULT_RENDER_RECOVERY_CONFIG: RenderRecoveryConfig = {
  maxAttempts: 3,
  windowMs: 5 * 60_000,
};

export class RenderRecoveryPolicy {
  private readonly cfg: RenderRecoveryConfig;
  private attempts: number[] = [];

  constructor(config?: Partial<RenderRecoveryConfig>) {
    this.cfg = { ...DEFAULT_RENDER_RECOVERY_CONFIG, ...(config ?? {}) };
  }

  /**
   * Decide how to recover from a shell renderer crash and record the attempt.
   *
   * - Critical commit pressure → dialog (auto-reload suppressed; reloading into a
   *   machine at the ceiling invites a crash loop — plan §5 note).
   * - Below Critical and within the attempt budget → reload (attempt recorded).
   * - Budget exhausted → dialog.
   *
   * `criticalPressure` is the D5 sampler's `isCriticalPressure()` — already
   * fail-open (false when the commit sampler is down).
   */
  registerCrashAndDecide(now: number, criticalPressure: boolean): RecoveryDecision {
    this.prune(now);
    if (criticalPressure) {
      return { action: 'dialog', reason: 'critical-pressure' };
    }
    if (this.attempts.length >= this.cfg.maxAttempts) {
      return { action: 'dialog', reason: 'retries-exhausted' };
    }
    this.attempts.push(now);
    return { action: 'reload', reason: 'reload' };
  }

  /** Reset the attempt budget — call once the shell reload commits successfully,
   *  so a later, unrelated crash gets a fresh budget. */
  onRecovered(): void {
    this.attempts = [];
  }

  /** Reloads recorded within the current window (diagnostics/tests). */
  attemptsInWindow(now: number): number {
    this.prune(now);
    return this.attempts.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    this.attempts = this.attempts.filter((t) => t > cutoff);
  }
}

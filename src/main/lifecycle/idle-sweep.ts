// Idle-agent lifecycle §B9 — the automatic stale-idle sweep.
//
// The only main-process caller of `automatic-stale-idle`. It is deliberately
// conservative:
//
//   - it starts 5 minutes AFTER boot, so a startup reconcile storm never gets
//     mistaken for a fleet of long-idle agents;
//   - it is SINGLE-FLIGHT: a run that outlives its interval is never joined by
//     a second one;
//   - it reads settings FRESH every run, so `never` takes effect immediately
//     and no cached threshold can outlive a user's change;
//   - on resume from sleep it re-arms a FRESH startup delay rather than firing
//     a catch-up burst for the missed interval(s) — the machine was asleep, the
//     agents were not idle in any meaningful sense, and the human has just sat
//     back down;
//   - `stop()` clears the timers, unregisters the power hooks and waits for an
//     in-flight run to finish, so shutdown never races a kill.

import type { BulkStopDeps } from './lifecycle-ipc';
import { runStaleIdleStop, thresholdMsFor } from './lifecycle-ipc';

export const STARTUP_DELAY_MS = 5 * 60 * 1000;
export const INTERVAL_MS = 15 * 60 * 1000;

export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}

export interface IdleSweepDeps extends BulkStopDeps {
  powerMonitor?: PowerMonitorLike | null;
  log?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  setIntervalTimer?: (fn: () => void, ms: number) => unknown;
  clearIntervalTimer?: (h: unknown) => void;
}

export class IdleSweep {
  private startupTimer: unknown = null;
  private intervalTimer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private suspended = false;
  private readonly onSuspend = (): void => { this.suspended = true; this.disarm(); };
  private readonly onResume = (): void => {
    this.suspended = false;
    if (this.stopped) return;
    // A FRESH delay, not a catch-up: nothing is stopped the instant the lid
    // opens, and the missed intervals do not queue up.
    this.armStartupDelay();
  };

  constructor(private readonly deps: IdleSweepDeps) {}

  private get setTimer(): (fn: () => void, ms: number) => unknown {
    return this.deps.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; });
  }
  private get clearTimer(): (h: unknown) => void {
    return this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }
  private get setIntervalTimer(): (fn: () => void, ms: number) => unknown {
    return this.deps.setIntervalTimer ?? ((fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; });
  }
  private get clearIntervalTimer(): (h: unknown) => void {
    return this.deps.clearIntervalTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }
  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(msg);
  }

  /**
   * Arm the sweep. MUST be called after `app.whenReady()` — Electron's
   * `powerMonitor` throws if it is touched before the app is ready, and a
   * throw here would take the whole boot down for a background chore.
   */
  start(): void {
    if (this.stopped) return;
    this.armStartupDelay();
    this.deps.powerMonitor?.on('suspend', this.onSuspend);
    this.deps.powerMonitor?.on('resume', this.onResume);
  }

  private armStartupDelay(): void {
    this.disarm();
    this.startupTimer = this.setTimer(() => {
      this.startupTimer = null;
      void this.runOnce();
      this.intervalTimer = this.setIntervalTimer(() => { void this.runOnce(); }, INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  }

  private disarm(): void {
    if (this.startupTimer !== null) { this.clearTimer(this.startupTimer); this.startupTimer = null; }
    if (this.intervalTimer !== null) { this.clearIntervalTimer(this.intervalTimer); this.intervalTimer = null; }
  }

  /** Exposed for tests and for a future manual "run now". Single-flight. */
  runOnce(): Promise<void> {
    if (this.stopped || this.suspended) return Promise.resolve();
    if (this.inFlight) return this.inFlight; // a slow run is never joined by a second
    // The cleanup MUST be a .finally() continuation rather than a `finally`
    // block inside the body: a run that returns without ever awaiting (the
    // `never` early exit) would otherwise clear `inFlight` synchronously —
    // before the assignment below — and leave a settled promise latched in
    // forever, so no later tick could ever run again.
    const run = this.doRun().finally(() => { if (this.inFlight === run) this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private doRun(): Promise<void> {
    return (async () => {
      try {
        // FRESH read every run: a user switching to 'never' takes effect on the
        // very next tick, with no cached threshold to invalidate.
        const settings = this.deps.loadSettings();
        if (thresholdMsFor(settings.autoStopIdleThreshold) === null) return;
        const result = await runStaleIdleStop('automatic-stale-idle', this.deps);
        const stopped = result.items.filter((i) => i.result === 'stopped').length;
        const failed = result.items.filter((i) => i.result === 'failed').length;
        const skipped = result.items.filter((i) => i.result === 'skipped').length;
        if (result.items.length > 0) {
          this.log(`[lifecycle] stale-idle sweep (${settings.autoStopIdleThreshold}): ${stopped} stopped, ${skipped} skipped, ${failed} failed`);
        }
      } catch (e) {
        this.log(`[lifecycle] stale-idle sweep failed: ${String(e)}`);
      }
    })();
  }

  /** Shutdown: disarm, unhook power events, and await any in-flight run so a
   *  kill is never abandoned half-way. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.disarm();
    this.deps.powerMonitor?.removeListener('suspend', this.onSuspend);
    this.deps.powerMonitor?.removeListener('resume', this.onResume);
    const pending = this.inFlight;
    if (pending) await pending.catch(() => {});
  }
}

// WP-3c rehydrate unit tests — exact-once replay across every reopen source.
//
//   npm run test:renderer  (vitest, node env — pure, no jsdom/xterm)
//
// Each test models xterm as a STREAMING UTF-8 decoder sink (byte writes join
// across the range→straddle seam exactly as xterm's parser does) and asserts
// the reconstructed text is byte-exact AND each numbered line appears exactly
// once — the plan's "not merely no gap" bar.

import { describe, it, expect, vi } from 'vitest';
import {
  reconcileChunk,
  rehydrateTerminalHistory,
  type BufferedChunk,
  type RehydrateDeps,
  type RehydrateState,
} from './rehydrate-terminal';

const enc = (s: string) => new TextEncoder().encode(s);
const BUDGET = 8_000_000;

/** Models xterm.write: strings append decoded text; Uint8Arrays feed a single
 *  streaming decoder so a rune split across two byte writes is reconstructed. */
class XtermSink {
  private decoder = new TextDecoder('utf-8');
  out = '';
  write = (data: string | Uint8Array): Promise<void> => {
    if (typeof data === 'string') this.out += data;
    else this.out += this.decoder.decode(data, { stream: true });
    return Promise.resolve();
  };
}

function freshState(): RehydrateState {
  return { appliedOffset: 0, logOffsetsReliable: true, epoch: '' };
}

/** Byte-range pager over an in-memory `.log` buffer (mirrors readFileRange:
 *  exact bytes, no alignment). `cap` caps bytes per call to model a short read,
 *  forcing the catch-up while-loop to iterate. */
function pagerFor(log: Uint8Array, cap = Infinity) {
  return (start: number, end: number) => {
    const from = Math.max(0, start);
    const to = Math.min(Math.max(from, Math.min(end, log.length)), from + cap);
    return Promise.resolve({
      bytes: log.subarray(from, to),
      startOffset: from,
      endOffset: to,
      fileSize: log.length,
    });
  };
}

/** Base deps: every source stubbed to a benign default; tests override. */
function baseDeps(over: Partial<RehydrateDeps>, sink: XtermSink): RehydrateDeps {
  return {
    attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: 0, degraded: false, terminalEpoch: 'e1' }),
    loadCheckpoint: () => Promise.resolve(null),
    readLogRange: () => Promise.resolve({ bytes: new Uint8Array(0), startOffset: 0, endOffset: 0, fileSize: 0 }),
    readLogTail: () => Promise.resolve({ bytes: new Uint8Array(0), startOffset: 0, endOffset: 0, truncated: false }),
    getRingSnapshot: () => Promise.resolve(null),
    readDeadAgentSnapshot: () => Promise.resolve({ text: '', truncated: false, retainedBytes: 0, missing: false }),
    write: sink.write,
    showTruncationBanner: vi.fn(),
    showHistoryWarning: vi.fn(),
    showReclaimedBanner: vi.fn(),
    showHistoryUnavailable: vi.fn(),
    maxReplayBytes: BUDGET,
    ...over,
  };
}

/** Run the orchestrator, then drain buffered live chunks exactly as the
 *  component does: reconcile each against the FIXED post-history cursor, then
 *  continue steady-state against the advancing cursor. */
async function reopen(
  deps: RehydrateDeps,
  state: RehydrateState,
  buffered: BufferedChunk[],
  sink: XtermSink,
) {
  const res = await rehydrateTerminalHistory(state, deps);
  if (res.live) {
    // Reconcile each buffered chunk against the FIXED post-history cursor, but
    // advance the applied cursor on each write exactly as the component's
    // queueWrite(endOffset) does — so final-state assertions hold.
    const cursor = state.appliedOffset;
    for (const chunk of buffered) {
      const action = reconcileChunk(chunk, cursor, enc);
      if (action.kind === 'write') {
        await sink.write(action.data);
        state.appliedOffset = chunk.endOffset;
      }
    }
  }
  return res;
}

/** Build a contiguous live chunk from a running byte offset. */
function chunkAt(start: number, text: string): BufferedChunk {
  return { data: text, startOffset: start, endOffset: start + enc(text).length };
}

describe('reconcileChunk (exact-once primitive)', () => {
  it('drops a chunk fully behind the cursor', () => {
    expect(reconcileChunk({ data: 'x', startOffset: 0, endOffset: 5 }, 10, enc)).toEqual({ kind: 'drop' });
    // boundary: endOffset === applied is still a full duplicate
    expect(reconcileChunk({ data: 'x', startOffset: 5, endOffset: 10 }, 10, enc)).toEqual({ kind: 'drop' });
  });

  it('writes a chunk fully ahead of the cursor whole', () => {
    const a = reconcileChunk({ data: 'new', startOffset: 10, endOffset: 13 }, 10, enc);
    expect(a).toEqual({ kind: 'write', data: 'new', endOffset: 13 });
  });

  it('trims a straddling chunk to the not-yet-applied byte suffix', () => {
    // "abcdef" spans [4,10); cursor at 7 → applied "abc" (4,5,6), suffix "def"
    const a = reconcileChunk({ data: 'abcdef', startOffset: 4, endOffset: 10 }, 7, enc);
    expect(a.kind).toBe('write');
    if (a.kind === 'write') {
      expect(new TextDecoder().decode(a.data as Uint8Array)).toBe('def');
      expect(a.endOffset).toBe(10);
    }
  });
});

describe('healthy live rehydrate', () => {
  it('cold tail (no checkpoint) + buffered chunks replay exactly once, in order', async () => {
    const history = 'line1\nline2\nline3\n';
    const cutoff = enc(history).length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        readLogTail: () => Promise.resolve({ bytes: enc(history), startOffset: 0, endOffset: cutoff, truncated: false }),
      },
      sink,
    );

    const buffered: BufferedChunk[] = [
      // a duplicate of history's tail that arrived during attach → must drop
      { data: 'line3\n', startOffset: cutoff - enc('line3\n').length, endOffset: cutoff },
      chunkAt(cutoff, 'line4\n'),
      chunkAt(cutoff + enc('line4\n').length, 'line5\n'),
    ];

    await reopen(deps, state, buffered, sink);

    expect(sink.out).toBe('line1\nline2\nline3\nline4\nline5\n');
    // each line exactly once
    for (const n of [1, 2, 3, 4, 5]) {
      expect(sink.out.split(`line${n}\n`).length - 1).toBe(1);
    }
    expect(state.appliedOffset).toBe(cutoff + enc('line4\nline5\n').length);
    expect(deps.showTruncationBanner).not.toHaveBeenCalled();
  });

  it('reconstructs a multibyte char split exactly at the cutoff across the range→straddle seam', async () => {
    // "hello€" — € is E2 82 AC at bytes [5,8). Cut the checkpoint replay at 6
    // (after E2); the straddling live chunk carries the whole €.
    const full = 'hello€';
    const log = enc(full); // 8 bytes
    const cutoff = 6;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: '', appliedOffset: 0 }),
        readLogRange: pagerFor(log),
      },
      sink,
    );
    // live chunk spanning [5,8): the € (its first byte 5 is inside the applied range)
    const buffered = [{ data: '€', startOffset: 5, endOffset: 8 }];

    await reopen(deps, state, buffered, sink);

    expect(sink.out).toBe('hello€');
    expect(state.appliedOffset).toBe(8);
  });

  it('checkpointed open (fully caught up) shows the buffer with no banner', async () => {
    const cutoff = 4242;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: 'FULL-SERIALIZED-BUFFER', appliedOffset: cutoff }),
        readLogRange: vi.fn(() => Promise.resolve({ bytes: new Uint8Array(0), startOffset: cutoff, endOffset: cutoff, fileSize: cutoff })),
      },
      sink,
    );

    await reopen(deps, state, [], sink);

    expect(sink.out).toBe('FULL-SERIALIZED-BUFFER');
    expect(state.appliedOffset).toBe(cutoff);
    expect(deps.readLogRange).not.toHaveBeenCalled(); // nothing to page
    expect(deps.showTruncationBanner).not.toHaveBeenCalled();
  });

  it('checkpoint + range catch-up pages exactly to the cutoff', async () => {
    const head = 'CKPT-HEAD;'; // serialized (applied through offset 10)
    const tailText = 'catchup-bytes-to-cutoff';
    const log = enc('##########' + tailText); // first 10 bytes stand in for pre-checkpoint history
    const cutoff = log.length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: head, appliedOffset: 10 }),
        // Short-read pager (8 bytes/call) forces the catch-up while-loop to
        // iterate; budget stays large so the checkpoint is ACCEPTED.
        readLogRange: pagerFor(log, 8),
      },
      sink,
    );

    await reopen(deps, state, [], sink);

    expect(sink.out).toBe(head + tailText);
    expect(state.appliedOffset).toBe(cutoff);
  });

  it('checkpoint backlog over budget → checkpoint rejected, cold tail + truncation banner', async () => {
    const cutoff = 1000;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: 'STALE-CKPT', appliedOffset: 0 }), // 1000-0 > budget
        readLogTail: () => Promise.resolve({ bytes: enc('TAILONLY'), startOffset: 900, endOffset: cutoff, truncated: true }),
        maxReplayBytes: 100,
      },
      sink,
    );

    await reopen(deps, state, [], sink);

    expect(sink.out).toBe('TAILONLY'); // serialized checkpoint NOT applied
    expect(deps.showTruncationBanner).toHaveBeenCalledWith({ retainedBytes: 100, snapshotTotal: 1000 });
    expect(state.appliedOffset).toBe(cutoff);
  });

  it('no-checkpoint live open caps at budget + banner', async () => {
    const cutoff = 5000;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        readLogTail: () => Promise.resolve({ bytes: enc('BUDGET-TAIL'), startOffset: 4000, endOffset: cutoff, truncated: true }),
        maxReplayBytes: 1000,
      },
      sink,
    );

    await reopen(deps, state, [], sink);
    expect(deps.showTruncationBanner).toHaveBeenCalledWith({ retainedBytes: 1000, snapshotTotal: 5000 });
  });
});

describe('dead reopen', () => {
  it('uses a valid checkpoint (same process) when present', async () => {
    const cutoff = 300;
    const sink = new XtermSink();
    const state = freshState();
    const deadSnap = vi.fn(() => Promise.resolve({ text: 'SHOULD-NOT-USE', truncated: false, retainedBytes: 0 }));
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: false, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: 'DEAD-CKPT', appliedOffset: cutoff }),
        readDeadAgentSnapshot: deadSnap,
      },
      sink,
    );

    const res = await reopen(deps, state, [], sink);
    expect(sink.out).toBe('DEAD-CKPT');
    expect(res.live).toBe(false);
    expect(deadSnap).not.toHaveBeenCalled();
    expect(deps.showTruncationBanner).not.toHaveBeenCalled();
  });

  it('falls back to the dead snapshot and banners a truncated one', async () => {
    const cutoff = 500;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: false, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        readDeadAgentSnapshot: () => Promise.resolve({ text: 'DEADHIST', truncated: true, retainedBytes: 400 }),
      },
      sink,
    );

    const res = await reopen(deps, state, [], sink);
    expect(sink.out).toBe('DEADHIST');
    expect(res.live).toBe(false);
    expect(deps.showTruncationBanner).toHaveBeenCalledWith({ retainedBytes: 400, snapshotTotal: 500 });
  });
});

describe('degraded recovery', () => {
  it('replays the ring snapshot + logical cursor, dedups live, writes no checkpoint, warns', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const loadCheckpoint = vi.fn(() => Promise.resolve(null));
    const ringText = 'ring-chunk-A\nring-chunk-B\n';
    const logicalCutoff = 80;
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: 50, degraded: true, terminalEpoch: 'e1' }),
        getRingSnapshot: () => Promise.resolve({ text: ringText, logicalCutoff }),
        loadCheckpoint,
      },
      sink,
    );

    // buffered live: one already inside the ring (endOffset <= logicalCutoff → drop),
    // one strictly after (write).
    const buffered: BufferedChunk[] = [
      { data: 'dup\n', startOffset: 70, endOffset: 74 }, // 74 <= 80 → drop
      chunkAt(80, 'fresh-after\n'),
    ];

    const res = await reopen(deps, state, buffered, sink);

    expect(res.live).toBe(true);
    expect(sink.out).toBe(ringText + 'fresh-after\n');
    // orchestrator set the dedup boundary to the ring's LOGICAL cutoff; the
    // drained fresh chunk (endOffset 92) then advanced it, and the dup (74) was
    // dropped — a surviving dup would leave a different offset/output.
    expect(state.appliedOffset).toBe(logicalCutoff + enc('fresh-after\n').length);
    expect(state.logOffsetsReliable).toBe(false);
    expect(deps.showHistoryWarning).toHaveBeenCalledTimes(1);
    expect(deps.showTruncationBanner).not.toHaveBeenCalled();
    expect(loadCheckpoint).not.toHaveBeenCalled(); // degraded epoch never touches checkpoints
  });
});

// ── WP-3e acceptance — the five attach-race scenarios, each exact-once ──
//
// The five moments at which live PTY output can race the async reopen (WP-3c):
// before attach resolves, during range paging, during chunked writes, between
// serialize and detach, and across a same-id rebound/restart. Each asserts the
// reconstructed stream is byte-exact AND every numbered line appears EXACTLY
// once (the plan's "not merely no gap" bar).

/** Assert each `lineN` marker in `[from,to]` appears exactly once in `out`. */
function eachLineOnce(out: string, from: number, to: number): void {
  for (let n = from; n <= to; n++) {
    expect(out.split(`line${n}\n`).length - 1).toBe(1);
  }
}

describe('WP-3e attach-race (exact-once at every phase)', () => {
  it('race 1 — output arriving BEFORE attach resolves replays once (dup dropped, fresh kept)', async () => {
    const history = 'line1\nline2\nline3\n';
    const cutoff = enc(history).length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        readLogTail: () => Promise.resolve({ bytes: enc(history), startOffset: 0, endOffset: cutoff, truncated: false }),
      },
      sink,
    );
    // Buffered while attach was in flight: a duplicate of the tail (must drop) +
    // two fresh lines (must append, in order).
    const buffered: BufferedChunk[] = [
      { data: 'line3\n', startOffset: cutoff - enc('line3\n').length, endOffset: cutoff },
      chunkAt(cutoff, 'line4\n'),
      chunkAt(cutoff + enc('line4\n').length, 'line5\n'),
    ];
    await reopen(deps, state, buffered, sink);
    expect(sink.out).toBe('line1\nline2\nline3\nline4\nline5\n');
    eachLineOnce(sink.out, 1, 5);
  });

  it('race 2 — output straddling the cutoff DURING range paging is trimmed to its fresh suffix', async () => {
    // Checkpoint at offset 10; range pages the rest to the cutoff in short reads.
    const preCkpt = 'line1\nline2\n'; // stands in for the serialized head (12 bytes)
    const paged = 'line3\nline4\n';
    const log = enc('############' + paged); // 12 filler bytes (pre-checkpoint) + paged
    const cutoff = log.length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: preCkpt, appliedOffset: 12 }),
        readLogRange: pagerFor(log, 5), // 5 bytes/call → the while-loop iterates mid-replay
      },
      sink,
    );
    // A live chunk straddling the cutoff arrives during paging: bytes [cutoff-6,
    // cutoff) are already in the log pages (dup), [cutoff, +) are fresh.
    const straddle = { data: 'line4\nline5\n', startOffset: cutoff - enc('line4\n').length, endOffset: cutoff + enc('line5\n').length };
    await reopen(deps, state, [straddle], sink);
    expect(sink.out).toBe(preCkpt + paged + 'line5\n');
    eachLineOnce(sink.out, 1, 5);
    expect(state.appliedOffset).toBe(cutoff + enc('line5\n').length);
  });

  it('race 3 — a burst of contiguous chunks DURING chunked writes lands once, in order', async () => {
    const history = 'line1\n';
    const cutoff = enc(history).length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        readLogTail: () => Promise.resolve({ bytes: enc(history), startOffset: 0, endOffset: cutoff, truncated: false }),
      },
      sink,
    );
    // Five contiguous live chunks buffered back-to-back (the chunked-write burst).
    let off = cutoff;
    const buffered: BufferedChunk[] = [];
    for (let n = 2; n <= 6; n++) {
      const c = chunkAt(off, `line${n}\n`);
      buffered.push(c);
      off = c.endOffset;
    }
    await reopen(deps, state, buffered, sink);
    expect(sink.out).toBe('line1\nline2\nline3\nline4\nline5\nline6\n');
    eachLineOnce(sink.out, 1, 6);
  });

  it('race 4 — output BETWEEN serialize and detach: bytes already in the checkpoint drop, later ones keep', async () => {
    // Fully-caught-up checkpoint (appliedOffset == cutoff): the serialized buffer
    // already reflects everything through the cutoff. A chunk whose bytes predate
    // the serialize (endOffset <= cutoff) is a duplicate; one after is fresh.
    const cutoff = 30;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: 'line1\nline2\n', appliedOffset: cutoff }),
      },
      sink,
    );
    const buffered: BufferedChunk[] = [
      { data: 'already-serialized', startOffset: cutoff - 18, endOffset: cutoff }, // in the buffer → drop
      chunkAt(cutoff, 'line3\n'),
    ];
    await reopen(deps, state, buffered, sink);
    expect(sink.out).toBe('line1\nline2\nline3\n');
    eachLineOnce(sink.out, 1, 3);
    expect(state.appliedOffset).toBe(cutoff + enc('line3\n').length);
  });

  it('race 5 — across a same-id rebound/restart: new epoch rejects the old checkpoint, cold tail replays once', async () => {
    // Rebound mints a fresh epoch; the main-side load guard rejects the retired
    // checkpoint (modelled as loadCheckpoint → null under the new epoch), so the
    // reopen cold-tails and drains post-rebound chunks exactly once.
    const history = 'line1\nline2\n';
    const cutoff = enc(history).length;
    const sink = new XtermSink();
    const state = { appliedOffset: 999, logOffsetsReliable: true, epoch: 'epoch-old' };
    const loadCheckpoint = vi.fn(() => Promise.resolve(null)); // stale checkpoint rejected
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'epoch-new' }),
        loadCheckpoint,
        readLogTail: () => Promise.resolve({ bytes: enc(history), startOffset: 0, endOffset: cutoff, truncated: false }),
      },
      sink,
    );
    const buffered: BufferedChunk[] = [chunkAt(cutoff, 'line3\n')];
    await reopen(deps, state, buffered, sink);
    expect(state.epoch).toBe('epoch-new'); // rehydrate adopted the fresh epoch
    expect(sink.out).toBe('line1\nline2\nline3\n');
    eachLineOnce(sink.out, 1, 3);
  });
});

// ── WP-3e acceptance — banner behavior across the three reopen outcomes ──
describe('WP-3e banner acceptance', () => {
  it('no-checkpoint reopen shows the truncation banner', async () => {
    const cutoff = 5000;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        readLogTail: () => Promise.resolve({ bytes: enc('TAIL'), startOffset: 4000, endOffset: cutoff, truncated: true }),
        maxReplayBytes: 1000,
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(deps.showTruncationBanner).toHaveBeenCalledWith({ retainedBytes: 1000, snapshotTotal: 5000 });
    expect(deps.showHistoryWarning).not.toHaveBeenCalled();
  });

  it('checkpointed reopen shows NO banner', async () => {
    const cutoff = 1234;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: 'FULL', appliedOffset: cutoff }),
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(deps.showTruncationBanner).not.toHaveBeenCalled();
    expect(deps.showHistoryWarning).not.toHaveBeenCalled();
  });

  it('a degraded epoch shows the history-warning banner and NEVER replays .log', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const readLogRange = vi.fn(() => Promise.resolve({ bytes: new Uint8Array(0), startOffset: 0, endOffset: 0, fileSize: 0 }));
    const readLogTail = vi.fn(() => Promise.resolve({ bytes: new Uint8Array(0), startOffset: 0, endOffset: 0, truncated: false }));
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: 40, degraded: true, terminalEpoch: 'e1' }),
        getRingSnapshot: () => Promise.resolve({ text: 'RING-RECOVERED', logicalCutoff: 40 }),
        readLogRange,
        readLogTail,
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(sink.out).toBe('RING-RECOVERED');
    expect(deps.showHistoryWarning).toHaveBeenCalledTimes(1);
    expect(deps.showTruncationBanner).not.toHaveBeenCalled();
    expect(readLogRange).not.toHaveBeenCalled(); // no `.log` range replay in a degraded epoch
    expect(readLogTail).not.toHaveBeenCalled(); // and no `.log` cold tail either
    expect(state.logOffsetsReliable).toBe(false);
  });
});

// ── WP-7 — reclaimed-history disclosure surfacing ──
//
// The retention marker is DISCLOSURE, never a gate. The overlay must appear the
// instant attach resolves (before any later read can throw), a revived agent
// must replay its real bytes AND show the overlay, and NO banner text ever
// reaches the xterm write sink.
describe('WP-7 reclaimed-history disclosure', () => {
  const RECLAIMED = { kind: 'retention-reclaimed' as const, reclaimedAt: '2026-07-27T12:00:00Z' };

  it('surfaces the attach notice IMMEDIATELY — even when a later read THROWS', async () => {
    // The #1 mutation to kill: surfacing the notice only after replay. Here the
    // tail read rejects; the banner must ALREADY have been surfaced from attach.
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: 100, degraded: false, terminalEpoch: 'e1', historyNotice: RECLAIMED }),
        readLogTail: () => Promise.reject(new Error('read boom')),
      },
      sink,
    );
    await expect(rehydrateTerminalHistory(state, deps)).rejects.toThrow('read boom');
    expect(deps.showReclaimedBanner).toHaveBeenCalledWith({ reclaimedAt: RECLAIMED.reclaimedAt });
    // And it went to the OVERLAY, not the xterm stream.
    expect(sink.out).not.toContain(RECLAIMED.reclaimedAt);
  });

  it('surfaces the attach notice before the DEGRADED ring read (which could throw)', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: 10, degraded: true, terminalEpoch: 'e1', historyNotice: RECLAIMED }),
        getRingSnapshot: () => Promise.reject(new Error('ring boom')),
      },
      sink,
    );
    await expect(rehydrateTerminalHistory(state, deps)).rejects.toThrow('ring boom');
    expect(deps.showReclaimedBanner).toHaveBeenCalledWith({ reclaimedAt: RECLAIMED.reclaimedAt });
  });

  it('a revived agent REPLAYS its post-reclamation bytes AND shows the overlay (marker is not a gate)', async () => {
    const history = 'post-revive-line\n';
    const cutoff = enc(history).length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e2', historyNotice: RECLAIMED }),
        readLogTail: () => Promise.resolve({ bytes: enc(history), startOffset: 0, endOffset: cutoff, truncated: false }),
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(sink.out).toBe(history); // the real bytes were NOT skipped
    expect(deps.showReclaimedBanner).toHaveBeenCalledWith({ reclaimedAt: RECLAIMED.reclaimedAt });
    // Banner glyph/text never entered the xterm stream.
    expect(sink.out).not.toContain('🗑');
    expect(sink.out).not.toContain('reclaimed');
  });

  it('surfaces a notice returned by a RANGE PAGE during checkpoint catch-up (not only attach)', async () => {
    const head = 'CK;';
    const tailText = 'catchup';
    const log = enc('###' + tailText); // 3 filler (pre-checkpoint) + paged tail
    const cutoff = log.length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        // NO notice on attach — it must come from the range read.
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1' }),
        loadCheckpoint: () => Promise.resolve({ serialized: head, appliedOffset: 3 }),
        readLogRange: (start: number, end: number) => Promise.resolve({
          bytes: log.subarray(start, end), startOffset: start, endOffset: end, fileSize: log.length, historyNotice: RECLAIMED,
        }),
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(sink.out).toBe(head + tailText);
    expect(deps.showReclaimedBanner).toHaveBeenCalledWith({ reclaimedAt: RECLAIMED.reclaimedAt });
  });

  it('surfaces a notice returned by the DEAD snapshot', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: false, snapshotCutoff: 8, degraded: false, terminalEpoch: 'e1' }),
        readDeadAgentSnapshot: () => Promise.resolve({ text: 'DEADHIST', truncated: false, retainedBytes: 8, missing: false, historyNotice: RECLAIMED }),
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(sink.out).toBe('DEADHIST');
    expect(deps.showReclaimedBanner).toHaveBeenCalledWith({ reclaimedAt: RECLAIMED.reclaimedAt });
  });

  it('DEDUPES a notice repeated across attach + a later read (surfaced at most once)', async () => {
    const history = 'x\n';
    const cutoff = enc(history).length;
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: cutoff, degraded: false, terminalEpoch: 'e1', historyNotice: RECLAIMED }),
        readLogTail: () => Promise.resolve({ bytes: enc(history), startOffset: 0, endOffset: cutoff, truncated: false, historyNotice: RECLAIMED }),
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(deps.showReclaimedBanner).toHaveBeenCalledTimes(1);
  });

  it('IGNORES a malformed (empty-string) reclaimedAt', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: false, snapshotCutoff: 0, degraded: false, terminalEpoch: 'e1', historyNotice: { kind: 'retention-reclaimed', reclaimedAt: '' } }),
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(deps.showReclaimedBanner).not.toHaveBeenCalled();
  });

  it('a normal reopen (no marker) shows NO reclaimed banner', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      { attach: () => Promise.resolve({ ok: true, live: true, snapshotCutoff: 0, degraded: false, terminalEpoch: 'e1' }) },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(deps.showReclaimedBanner).not.toHaveBeenCalled();
    expect(deps.showHistoryUnavailable).not.toHaveBeenCalled();
  });

  it('a dead agent with BOTH fallback files absent → history-unavailable (and no bytes written)', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: false, snapshotCutoff: 0, degraded: false, terminalEpoch: 'e1' }),
        readDeadAgentSnapshot: () => Promise.resolve({ text: '', truncated: false, retainedBytes: 0, missing: true }),
      },
      sink,
    );
    const res = await reopen(deps, state, [], sink);
    expect(res.live).toBe(false);
    expect(deps.showHistoryUnavailable).toHaveBeenCalledTimes(1);
    expect(sink.out).toBe(''); // overlay only — nothing injected into the stream
    expect(deps.showReclaimedBanner).not.toHaveBeenCalled();
  });

  it('an empty-but-present dead log is NOT history-unavailable', async () => {
    const sink = new XtermSink();
    const state = freshState();
    const deps = baseDeps(
      {
        attach: () => Promise.resolve({ ok: true, live: false, snapshotCutoff: 0, degraded: false, terminalEpoch: 'e1' }),
        readDeadAgentSnapshot: () => Promise.resolve({ text: '', truncated: false, retainedBytes: 0, missing: false }),
      },
      sink,
    );
    await reopen(deps, state, [], sink);
    expect(deps.showHistoryUnavailable).not.toHaveBeenCalled();
  });
});

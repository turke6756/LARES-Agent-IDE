import { describe, it, expect } from 'vitest';
import type { FileActivity } from '../../../shared/types';
import { groupByFile } from './FileActivityList';

// Context-brick Phase 4 — the Context/Outputs tabs retain prior-session activity
// and must (a) keep a prior read and a current read of the SAME file as distinct
// rows and (b) mark prior-session rows so the shared out-of-context styling
// applies. groupByFile owns both, so pin it directly.

function act(over: Partial<FileActivity>): FileActivity {
  return {
    id: 1,
    agentId: 'a',
    filePath: 'C:\\repo\\x.ts',
    operation: 'read',
    timestamp: '2026-07-03 12:00:00',
    generation: 0,
    sessionId: null,
    ...over,
  };
}

describe('groupByFile', () => {
  it('keeps a prior read and a current read of the same file as distinct rows', () => {
    const rows = [
      act({ id: 2, sessionId: 'live', generation: 1 }),   // current
      act({ id: 1, sessionId: 'old', generation: 0 }),    // prior
    ];
    const grouped = groupByFile(rows, 'live');
    expect(grouped).toHaveLength(2);
    // Current band first, prior band after.
    expect(grouped[0].prior).toBe(false);
    expect(grouped[0].activity.sessionId).toBe('live');
    expect(grouped[1].prior).toBe(true);
    expect(grouped[1].activity.sessionId).toBe('old');
  });

  it('collapses duplicate (file, op, session, generation) into one counted row', () => {
    const rows = [
      act({ id: 3, sessionId: 'live', generation: 1 }),
      act({ id: 2, sessionId: 'live', generation: 1 }),
    ];
    const grouped = groupByFile(rows, 'live');
    expect(grouped).toHaveLength(1);
    expect(grouped[0].count).toBe(2);
    expect(grouped[0].prior).toBe(false);
  });

  it('distinguishes two same-generation /clear siblings by session id', () => {
    const rows = [
      act({ id: 2, sessionId: 'sib-B', generation: 0 }),
      act({ id: 1, sessionId: 'sib-A', generation: 0 }),
    ];
    const grouped = groupByFile(rows, 'sib-B');
    expect(grouped).toHaveLength(2);
    expect(grouped.find((g) => g.activity.sessionId === 'sib-A')!.prior).toBe(true);
    expect(grouped.find((g) => g.activity.sessionId === 'sib-B')!.prior).toBe(false);
  });

  it('treats legacy NULL-session rows as current so a migration does not dim everything', () => {
    const grouped = groupByFile([act({ id: 1, sessionId: null })], 'live');
    expect(grouped[0].prior).toBe(false);
  });
});

// attribution-stats.test.ts — Git-Native WP-G3.2 pure derivations.
//
// The load-bearing invariants (plan shape §2.3/§6/§7):
//   • a witnessed-empty turn is UNATTRIBUTED and never counted/filtered as attributed
//     (a shell-mediated write must not be misattributed);
//   • contention lists EVERY contending open turn/agent for a shared path;
//   • filters narrow by path/glob, agent, status, attribution;
//   • statistics match fixture data exactly.
import { describe, it, expect } from 'vitest';
import type { CheckpointTurnSummary } from '../../../shared/types';
import {
  isAttributed,
  filterTurns,
  pathMatches,
  deriveWorkspaceContention,
  contendedPathSet,
  computeAttributionStats,
  distinctAgents,
  distinctStatuses,
  EMPTY_FILTERS,
} from './attribution-stats';

function turn(over: Partial<CheckpointTurnSummary> = {}): CheckpointTurnSummary {
  return {
    turnId: 't',
    turnSeq: 1,
    agentId: 'a1',
    agentTitle: 'Alpha',
    taskLabel: 'task',
    status: 'completed',
    startedAt: 1000,
    endedAt: 2000,
    beforeReady: true,
    afterReady: true,
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    witnessedPaths: ['src/a.ts'],
    failureReason: null,
    ...over,
  };
}

/** A shell-mediated write: the turn ran a script that wrote a file, but Lares
 *  witnessed no write/create — so the turn has ZERO witnessed paths. Its changes,
 *  if any, live only in the raw window. This must never be attributed. */
const shellMediated = turn({
  turnId: 'shell',
  agentId: 'a2',
  agentTitle: 'Beta',
  taskLabel: 'run build script',
  witnessedPaths: [],
});

describe('isAttributed — witnessed-only partition', () => {
  it('a witnessed-empty (shell-mediated) turn is UNATTRIBUTED', () => {
    expect(isAttributed(shellMediated)).toBe(false);
    expect(isAttributed(turn({ witnessedPaths: ['x'] }))).toBe(true);
  });
});

describe('filterTurns', () => {
  const turns = [
    turn({ turnId: 't1', agentId: 'a1', status: 'completed', witnessedPaths: ['src/app.ts'] }),
    turn({ turnId: 't2', agentId: 'a2', status: 'open', endedAt: null, witnessedPaths: ['docs/readme.md'] }),
    shellMediated,
  ];

  it('attribution=attributed excludes the shell-mediated (unattributed) turn', () => {
    const out = filterTurns(turns, { ...EMPTY_FILTERS, attribution: 'attributed' });
    expect(out.map((t) => t.turnId).sort()).toEqual(['t1', 't2']);
    expect(out.find((t) => t.turnId === 'shell')).toBeUndefined();
  });

  it('attribution=unattributed yields ONLY the shell-mediated turn', () => {
    const out = filterTurns(turns, { ...EMPTY_FILTERS, attribution: 'unattributed' });
    expect(out.map((t) => t.turnId)).toEqual(['shell']);
  });

  it('narrows by agent', () => {
    const out = filterTurns(turns, { ...EMPTY_FILTERS, agentId: 'a2' });
    expect(out.map((t) => t.turnId).sort()).toEqual(['shell', 't2']);
  });

  it('narrows by status', () => {
    const out = filterTurns(turns, { ...EMPTY_FILTERS, status: 'open' });
    expect(out.map((t) => t.turnId)).toEqual(['t2']);
  });

  it('narrows by path substring', () => {
    const out = filterTurns(turns, { ...EMPTY_FILTERS, pathGlob: 'src/' });
    expect(out.map((t) => t.turnId)).toEqual(['t1']);
  });

  it('narrows by glob (anchored, basename-aware)', () => {
    const out = filterTurns(turns, { ...EMPTY_FILTERS, pathGlob: '**/*.md' });
    expect(out.map((t) => t.turnId)).toEqual(['t2']);
  });

  it('a path filter never matches an unattributed turn (no witnessed paths)', () => {
    const out = filterTurns([shellMediated], { ...EMPTY_FILTERS, pathGlob: '*' });
    expect(out).toEqual([]);
  });
});

describe('pathMatches', () => {
  it('substring for plain queries', () => {
    expect(pathMatches('src/a/b.ts', 'a/b')).toBe(true);
    expect(pathMatches('src/a/b.ts', 'zzz')).toBe(false);
  });
  it('glob: * does not cross a slash, ** does', () => {
    expect(pathMatches('src/a.ts', 'src/*.ts')).toBe(true);
    expect(pathMatches('src/deep/a.ts', 'src/*.ts')).toBe(false);
    expect(pathMatches('src/deep/a.ts', 'src/**/*.ts')).toBe(true);
  });
  it('glob matches the basename too', () => {
    expect(pathMatches('src/deep/config.ts', 'config.ts')).toBe(true); // substring
    expect(pathMatches('src/deep/config.ts', '*.ts')).toBe(true); // basename glob
  });
  it('normalizes backslashes', () => {
    expect(pathMatches('src\\a\\b.ts', 'src/a/b.ts')).toBe(true);
  });
});

describe('deriveWorkspaceContention — cross-agent', () => {
  it('lists EVERY contending open turn/agent for a shared path', () => {
    const t1 = turn({ turnId: 'o1', agentId: 'a1', agentTitle: 'Alpha', endedAt: null, status: 'open', witnessedPaths: ['src/shared.ts'] });
    const t2 = turn({ turnId: 'o2', agentId: 'a2', agentTitle: 'Beta', endedAt: null, status: 'open', witnessedPaths: ['src/shared.ts'] });
    const t3 = turn({ turnId: 'o3', agentId: 'a3', agentTitle: 'Gamma', endedAt: null, status: 'open', witnessedPaths: ['src/shared.ts', 'src/only-gamma.ts'] });
    const closed = turn({ turnId: 'c', agentId: 'a4', endedAt: 5000, status: 'completed', witnessedPaths: ['src/shared.ts'] });

    const contention = deriveWorkspaceContention([t1, t2, t3, closed]);
    const shared = contention.find((c) => c.path === 'src/shared.ts');
    expect(shared).toBeTruthy();
    // All THREE open turns contend; the closed turn does NOT (its set is frozen).
    expect(shared!.contenders.map((c) => c.turnId).sort()).toEqual(['o1', 'o2', 'o3']);
    expect(shared!.contenders.map((c) => c.agentId).sort()).toEqual(['a1', 'a2', 'a3']);
    // A path only one open turn witnesses is not contended.
    expect(contention.find((c) => c.path === 'src/only-gamma.ts')).toBeUndefined();
  });

  it('a single open turn on a path is not contention', () => {
    const t1 = turn({ turnId: 'o1', endedAt: null, status: 'open', witnessedPaths: ['solo.ts'] });
    expect(deriveWorkspaceContention([t1])).toEqual([]);
    expect(contendedPathSet([t1]).size).toBe(0);
  });
});

describe('computeAttributionStats — matches fixture', () => {
  // Fixture: 3 agents.
  //  a1: t1 (2 witnessed: shared.ts, a1only.ts) open, t2 (1 witnessed: a1only.ts) closed
  //  a2: t3 (1 witnessed: shared.ts) open
  //  a3: shell-mediated (0 witnessed) closed
  const turns = [
    turn({ turnId: 't1', agentId: 'a1', agentTitle: 'Alpha', endedAt: null, status: 'open', witnessedPaths: ['src/shared.ts', 'src/a1only.ts'] }),
    turn({ turnId: 't2', agentId: 'a1', agentTitle: 'Alpha', endedAt: 3000, status: 'completed', witnessedPaths: ['src/a1only.ts'] }),
    turn({ turnId: 't3', agentId: 'a2', agentTitle: 'Beta', endedAt: null, status: 'open', witnessedPaths: ['src/shared.ts'] }),
    turn({ turnId: 'shell', agentId: 'a3', agentTitle: 'Gamma', endedAt: 4000, status: 'completed', witnessedPaths: [] }),
  ];

  it('workspace roll-up', () => {
    const s = computeAttributionStats(turns);
    expect(s.totalTurns).toBe(4);
    expect(s.attributedTurns).toBe(3);
    expect(s.unattributedTurns).toBe(1);
    // distinct witnessed paths workspace-wide: shared.ts, a1only.ts
    expect(s.filesTouched).toBe(2);
    // total witnessed records: 2 + 1 + 1 + 0
    expect(s.witnessedWrites).toBe(4);
    // shared.ts witnessed by two OPEN turns (t1,t3) → 1 contended path
    expect(s.contendedPaths).toBe(1);
    expect(s.byStatus).toEqual({ open: 2, completed: 2 });
  });

  it('per-agent roll-up', () => {
    const s = computeAttributionStats(turns);
    const a1 = s.byAgent.find((a) => a.agentId === 'a1')!;
    const a2 = s.byAgent.find((a) => a.agentId === 'a2')!;
    const a3 = s.byAgent.find((a) => a.agentId === 'a3')!;

    expect(a1.turnCount).toBe(2);
    expect(a1.attributedTurns).toBe(2);
    expect(a1.unattributedTurns).toBe(0);
    expect(a1.filesTouched).toBe(2); // shared.ts, a1only.ts
    expect(a1.witnessedWrites).toBe(3);
    expect(a1.contendedPaths).toBe(1); // shared.ts

    expect(a2.filesTouched).toBe(1);
    expect(a2.contendedPaths).toBe(1);

    expect(a3.turnCount).toBe(1);
    expect(a3.attributedTurns).toBe(0);
    expect(a3.unattributedTurns).toBe(1);
    expect(a3.filesTouched).toBe(0);
    expect(a3.contendedPaths).toBe(0);
  });
});

describe('distinct helpers (filter dropdowns)', () => {
  const turns = [
    turn({ turnId: 't1', agentId: 'a1', agentTitle: 'Alpha', status: 'completed' }),
    turn({ turnId: 't2', agentId: 'a2', agentTitle: 'Beta', status: 'open' }),
    turn({ turnId: 't3', agentId: 'a1', agentTitle: 'Alpha', status: 'crashed' }),
  ];
  it('distinctAgents dedupes by id', () => {
    expect(distinctAgents(turns).map((a) => a.agentId).sort()).toEqual(['a1', 'a2']);
  });
  it('distinctStatuses sorted + deduped', () => {
    expect(distinctStatuses(turns)).toEqual(['completed', 'crashed', 'open']);
  });
});

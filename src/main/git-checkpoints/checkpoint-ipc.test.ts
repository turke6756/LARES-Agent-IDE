// WP-G2.2 (plans/git-native-implementation-v2.md — "IPC for the human renderer") —
// the human checkpoint IPC registrar + the Open #4 force gate.
//
// Load-bearing properties, exercised against the REAL registrar over a fake
// ipcMain + a fake HumanCheckpointRoutes:
//   - the five channels are registered and delegate workspace-scoped;
//   - a human `force` is REFUSED while an active turn witnesses a requested path
//     (contention non-empty) — no mutation reaches the engine;
//   - a `force` is ACCEPTED once the turn is closed (contention empty) and is the
//     ONLY thing that overrides a stale preview-token conflict (a non-force restore
//     against a stale token fails);
//   - inputs are validated (missing workspace/turn/paths), and an unwired engine
//     answers an honest "unavailable" instead of a silent empty result.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/checkpoint-ipc.test.js

import assert from 'node:assert/strict';
import {
  registerCheckpointIpc,
  FORCE_REFUSED_ACTIVE_TURN,
  type HumanCheckpointRoutes,
  type IpcLike,
} from './checkpoint-ipc';
import { CHECKPOINT_CHANNELS } from '../../shared/types';
import type {
  CheckpointPreviewResult,
  CheckpointRestoreResult,
} from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── a fake ipcMain that records handlers and can invoke them ─────────────────────

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h({}, ...args);
  }
}

// ── a recording fake HumanCheckpointRoutes ──────────────────────────────────────

interface FakeCfg {
  /** contention `preview` reports for the requested paths (the active-turn witness). */
  contention?: { path: string; turnId: string }[];
  /** when true, a restore/revert WITHOUT force but WITH tokens fails as a stale
   *  preview; force flips it to completed (models the service's token bypass). */
  staleTokens?: boolean;
  /** CONTENT-semantics diagnostic surfaced on the list summary. Left undefined to
   *  model the absent case; set true/false to model the wired flag. */
  rawFilterBypassed?: boolean;
}

interface FakeState {
  calls: { method: string; args: unknown[] }[];
}

function makeRoutes(cfg: FakeCfg = {}): HumanCheckpointRoutes & { state: FakeState } {
  const state: FakeState = { calls: [] };
  const rec = (method: string, args: unknown[]): void => { state.calls.push({ method, args }); };
  const contention = cfg.contention ?? [];

  const previewOf = (turnId: string): CheckpointPreviewResult => ({
    available: true,
    reason: null,
    turnId,
    witnessedSet: ['a.txt'],
    tokens: { 'a.txt': 'oid-at-preview' },
    validatedPaths: ['a.txt'],
    rejectedPaths: [],
    contention,
  });

  const outcome = (
    kind: 'restore_paths' | 'revert_turn',
    paths: string[],
    force: boolean | undefined,
  ): CheckpointRestoreResult => {
    // Stale token + NOT force → the service would abort on the mismatch.
    const staleFail = cfg.staleTokens === true && force !== true;
    return staleFail
      ? {
          status: 'failed', operationId: '', kind, preRef: null, preOid: null,
          requestedPaths: paths, completedPaths: [], rejectedPaths: [], failures: [],
          contention: [], failureReason: 'preview-token-mismatch',
        }
      : {
          status: 'completed', operationId: 'op1', kind, preRef: 'r', preOid: 'o',
          requestedPaths: paths, completedPaths: paths, rejectedPaths: [], failures: [],
          contention: [], failureReason: null,
        };
  };

  const routes: HumanCheckpointRoutes = {
    list: async (workspaceId, opts) => {
      rec('list', [workspaceId, opts]);
      return {
        workspaceId,
        turns: [{
          turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'A', taskLabel: 'task',
          status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
          beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['a.txt'], failureReason: null,
          ...(cfg.rawFilterBypassed === undefined ? {} : { beforeRawFilterBypassed: cfg.rawFilterBypassed }),
        }],
      };
    },
    fileHistory: async (workspaceId, filePath, opts) => {
      rec('fileHistory', [workspaceId, filePath, opts]);
      return {
        workspaceId, path: filePath,
        versions: [{
          turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'A', taskLabel: 'task',
          status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
          beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPath: filePath, op: 'write' as const,
          afterVerified: true, beforeRawFilterBypassed: false,
        }],
      };
    },
    diff: async (workspaceId, turnId) => {
      rec('diff', [workspaceId, turnId]);
      return {
        workspaceId, turnId,
        witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'W', provenance: 'witnessed' },
        window: { available: true, reason: null, label: 'unattributed changes in this window', text: 'R', provenance: 'raw-window' },
      };
    },
    preview: async (workspaceId, turnId, paths) => {
      rec('preview', [workspaceId, turnId, paths]);
      return previewOf(turnId);
    },
    restore: async (args) => {
      rec('restore', [args]);
      return outcome('restore_paths', args.paths, args.force);
    },
    revert: async (args) => {
      rec('revert', [args]);
      return outcome('revert_turn', ['a.txt'], args.force);
    },
  };
  return Object.assign(routes, { state });
}

function wire(cfg: FakeCfg = {}): { ipc: FakeIpc; routes: ReturnType<typeof makeRoutes> } {
  const routes = makeRoutes(cfg);
  const ipc = new FakeIpc();
  registerCheckpointIpc(ipc, () => routes);
  return { ipc, routes };
}

// ── 1. Registration + workspace-scoped delegation ───────────────────────────────

test('registers all five checkpoint channels', () => {
  const { ipc } = wire();
  for (const ch of Object.values(CHECKPOINT_CHANNELS)) {
    assert.ok(ipc.handlers.has(ch), `missing handler for ${ch}`);
  }
});

test('list/diff/preview delegate with the workspace + turn, scoped', async () => {
  const { ipc, routes } = wire();
  const list = await ipc.invoke(CHECKPOINT_CHANNELS.list, 'ws-1', { agentId: 'a1' }) as { workspaceId: string; turns: unknown[] };
  assert.equal(list.workspaceId, 'ws-1');
  assert.equal(list.turns.length, 1);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'list', args: ['ws-1', { agentId: 'a1' }] });

  await ipc.invoke(CHECKPOINT_CHANNELS.diff, 'ws-1', 't1');
  assert.deepEqual(routes.state.calls.at(-1), { method: 'diff', args: ['ws-1', 't1'] });

  await ipc.invoke(CHECKPOINT_CHANNELS.preview, 'ws-1', 't1', ['a.txt']);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'preview', args: ['ws-1', 't1', ['a.txt']] });
});

test('file-history delegates workspace-scoped with the canonical path + optional agent filter', async () => {
  const { ipc, routes } = wire();
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.fileHistory, 'ws-1', 'src/a.txt', { agentId: 'a1' }) as {
    workspaceId: string; path: string; versions: unknown[];
  };
  assert.equal(res.workspaceId, 'ws-1');
  assert.equal(res.path, 'src/a.txt');
  assert.equal(res.versions.length, 1);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'fileHistory', args: ['ws-1', 'src/a.txt', { agentId: 'a1' }] });

  // A missing path is rejected before any engine call.
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.fileHistory, 'ws-1', ''), /path/);
});

// ── 1b. beforeRawFilterBypassed rides the list summary to the renderer ───────────
// The CONTENT-semantics diagnostic must survive the IPC list contract so
// RestoreDialog can warn on filter-managed (LFS/git-crypt) paths.

test('list summary carries beforeRawFilterBypassed=true through the IPC contract', async () => {
  const { ipc } = wire({ rawFilterBypassed: true });
  const list = await ipc.invoke(CHECKPOINT_CHANNELS.list, 'ws-1') as { turns: { beforeRawFilterBypassed?: boolean }[] };
  assert.equal(list.turns[0].beforeRawFilterBypassed, true);
});

test('list summary carries beforeRawFilterBypassed=false / absent through the IPC contract', async () => {
  const falseCase = await wire({ rawFilterBypassed: false }).ipc
    .invoke(CHECKPOINT_CHANNELS.list, 'ws-1') as { turns: { beforeRawFilterBypassed?: boolean }[] };
  assert.equal(falseCase.turns[0].beforeRawFilterBypassed, false);

  const absentCase = await wire().ipc
    .invoke(CHECKPOINT_CHANNELS.list, 'ws-1') as { turns: { beforeRawFilterBypassed?: boolean }[] };
  assert.equal(absentCase.turns[0].beforeRawFilterBypassed, undefined);
});

// ── 2. Input validation ─────────────────────────────────────────────────────────

test('missing workspaceId / turnId / paths are rejected before any engine call', async () => {
  const { ipc, routes } = wire();
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.list, ''), /workspaceId/);
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.diff, 'ws-1', ''), /turnId/);
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.restore, { workspaceId: 'ws-1', turnId: 't1', paths: [] }), /paths/);
  // None of those reached the engine.
  assert.equal(routes.state.calls.length, 0);
});

test('an unwired engine answers "unavailable", never a silent empty result', async () => {
  const ipc = new FakeIpc();
  registerCheckpointIpc(ipc, () => null);
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.list, 'ws-1'), /unavailable|bootstrapping/i);
});

// ── 3. Non-force restore rides the preview token (no gate consulted) ─────────────

test('a non-force restore delegates straight through, without consulting the force gate', async () => {
  const { ipc, routes } = wire({ contention: [{ path: 'a.txt', turnId: 'other' }] });
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'oid-at-preview' },
  }) as CheckpointRestoreResult;
  assert.equal(res.status, 'completed');
  // No `preview` call (the gate only runs for force); exactly one `restore`.
  assert.equal(routes.state.calls.filter((c) => c.method === 'preview').length, 0);
  const restore = routes.state.calls.find((c) => c.method === 'restore');
  assert.ok(restore);
  assert.equal((restore!.args[0] as { force?: boolean }).force, false);
});

// ── 4. Open #4 — force REFUSED while an active turn witnesses the path ────────────

test('force restore is refused while an active turn witnesses a requested path', async () => {
  const { ipc, routes } = wire({ contention: [{ path: 'a.txt', turnId: 'live-turn' }], staleTokens: true });
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'stale' }, force: true,
  }) as CheckpointRestoreResult;
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, FORCE_REFUSED_ACTIVE_TURN);
  assert.deepEqual(res.contention, [{ path: 'a.txt', turnId: 'live-turn' }]);
  // The gate consulted the shared preview, and NO mutation reached the engine.
  assert.equal(routes.state.calls.filter((c) => c.method === 'preview').length, 1);
  assert.equal(routes.state.calls.filter((c) => c.method === 'restore').length, 0);
});

test('force revert is refused while an active turn witnesses the turn set', async () => {
  const { ipc, routes } = wire({ contention: [{ path: 'a.txt', turnId: 'live-turn' }] });
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.revert, {
    workspaceId: 'ws-1', turnId: 't1', force: true,
  }) as CheckpointRestoreResult;
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, FORCE_REFUSED_ACTIVE_TURN);
  // preview called with no paths (full witnessed set); no revert mutation.
  const pv = routes.state.calls.find((c) => c.method === 'preview');
  assert.deepEqual(pv!.args, ['ws-1', 't1', undefined]);
  assert.equal(routes.state.calls.filter((c) => c.method === 'revert').length, 0);
});

// ── 5. Open #4 — force ACCEPTED once the turn is closed, over a stale preview ─────

test('force restore is accepted once no active turn witnesses the path, overriding a stale preview', async () => {
  // contention empty = the witnessing turn has ended/stopped. staleTokens=true so a
  // plain restore would fail on the mismatch; only force gets through.
  const { ipc, routes } = wire({ contention: [], staleTokens: true });

  // Baseline: WITHOUT force, the stale token aborts the restore (proves force is
  // what overrides, not the gate being a no-op).
  const noForce = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'stale' },
  }) as CheckpointRestoreResult;
  assert.equal(noForce.status, 'failed');
  assert.equal(noForce.failureReason, 'preview-token-mismatch');

  // WITH force + turn closed → the gate passes and force reaches the engine.
  const forced = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'stale' }, force: true,
  }) as CheckpointRestoreResult;
  assert.equal(forced.status, 'completed');
  const forcedCall = routes.state.calls.filter((c) => c.method === 'restore').at(-1);
  assert.equal((forcedCall!.args[0] as { force?: boolean }).force, true);
});

// ── Run ─────────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} checkpoint-ipc tests passed`);
})();

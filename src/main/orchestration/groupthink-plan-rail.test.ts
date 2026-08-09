
// WP6 — planning-surface rail on the GroupThink launch + done-detection paths.
//
// Proves the two hops that carry plan_id + section_anchor from a dispatched run
// all the way to a launched member agent's environment, plus the done-detection
// swap (whole-file existsSync → post-dispatch document mtime):
//
//   1. RUN → LAUNCH INPUT (behavioral): runSerial/runParallel stamp
//      launchInput.planId / launchInput.planSection onto EVERY member from
//      ctx.run.planId / ctx.run.sectionAnchor.
//   2. LAUNCH INPUT → AGENT ENV (structural, mirrors supervisor-plan-env.test):
//      BOTH launch sites in supervisor/index.ts inject agent.planId /
//      agent.planSection into AGENT_DASHBOARD_PLAN_ID / _PLAN_SECTION — the
//      native `extraEnv` record AND the WSL `wslEnvPrefix` array (§7 risk 1,
//      the dual-injection trap). Together these pin the whole chain so a member
//      launched by a rail-carrying run demonstrably receives the plan env under
//      Windows and WSL alike.
//   3. DONE-DETECTION SWAP (behavioral): a bound run completes only after its
//      folder-native document changes after dispatch; a pre-existing file alone
//      never short-circuits it.
//
//   npm run build:main
//   node dist/main/main/orchestration/groupthink-plan-rail.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSerial, runParallel } from './groupthink-v2';
import { OrchestrationService } from './service';
import { Agent } from '../../shared/types';
import { DashboardClient, OrchestrationRun, OrchestrationRunContext } from './types';

// ── In-memory DB patch (mirrors orchestration-service.test): the SQLite native
// binding is Electron-ABI, so the service reads patched db exports at call time.
// The planning-surface demo-fix test below dispatches a REAL rail run through
// OrchestrationService + the REAL runSerial runner, so we need getPlan (the new
// path-resolution hop) plus the orchestration store fns. The runner-level tests
// above never touch db, so this patch is inert for them.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../database') as Record<string, any>;
const svcRunsStore = new Map<string, OrchestrationRun>();
const svcPlansStore = new Map<string, { id: string; workspaceId: string; path: string }>();
const svcEvents: Array<{ runId: string; kind: string; payload: unknown }> = [];
const svcClone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
db.getWorkspace = (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: os.tmpdir() } : null);
db.getPlan = (id: string) => (svcPlansStore.has(id) ? svcClone(svcPlansStore.get(id)!) : null);
db.getActivePlanningIntentForLaunch = (_workspaceId: string, planId: string, intentId: string) =>
  planId === 'plan-demo' && intentId === 'int_1234abcd'
    ? { planId, intentId, status: 'active' }
    : null;
db.insertOrchestration = (r: OrchestrationRun) => { svcRunsStore.set(r.runId, svcClone(r)); };
db.updateOrchestration = (r: OrchestrationRun) => { svcRunsStore.set(r.runId, svcClone(r)); };
db.getOrchestrationRun = (id: string) => (svcRunsStore.has(id) ? svcClone(svcRunsStore.get(id)!) : null);
db.listOrchestrationRuns = () => Array.from(svcRunsStore.values()).map(svcClone);
db.insertOrchestrationEvent = (e: any) => { svcEvents.push(svcClone(e)); };
db.insertOrchestrationMember = () => {};
db.markActiveRunsAborted = () => [];
// Clamp setTimeout so 2000ms polls fire in ≤2ms (same trick as groupthink-v2.test).
const realSetTimeout = global.setTimeout;
(global as any).setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(fn, Math.min(typeof ms === 'number' ? ms : 0, 2), ...rest)) as typeof setTimeout;

interface RelayMessage { content: string; ts: string; turnComplete?: boolean }

interface FakeAgent {
  id: string; title: string; provider: string; status: string;
  latest: RelayMessage | null; counter: number;
  pending: boolean; getCalls: number; revealAt: number; sendCount: number;
}
interface FakeState { agents: Map<string, FakeAgent>; launchInputs: any[]; events: string[]; sentPrompts: Array<{ id: string; text: string }>; }
interface FakeConfig {
  onTurn?: (a: FakeAgent, state: FakeState) => void;
}

let agentSeq = 0;
function makeFake(cfg: FakeConfig = {}): { client: DashboardClient; state: FakeState } {
  const state: FakeState = { agents: new Map(), launchInputs: [], events: [], sentPrompts: [] };
  const arm = (a: FakeAgent, revealAt: number) => { a.pending = true; a.getCalls = 0; a.revealAt = revealAt; };
  const reveal = (a: FakeAgent) => {
    a.counter++;
    a.latest = { content: `${a.title} :: turn ${a.counter}`, ts: `${a.id}#${String(a.counter).padStart(4, '0')}`, turnComplete: true };
    a.pending = false;
    state.events.push(`turn:${a.id}#${a.counter}`);
    cfg.onTurn?.(a, state);
  };
  const client: DashboardClient = {
    launchAgent: async (input) => {
      const id = `agent-${++agentSeq}`;
      const a: FakeAgent = { id, title: input.title || id, provider: String(input.provider), status: 'idle', latest: null, counter: 0, pending: false, getCalls: 0, revealAt: 1, sendCount: 0 };
      state.agents.set(id, a);
      state.launchInputs.push(input);
      state.events.push(`launch:${a.title}`);
      return { id, status: 'idle' } as unknown as Agent;
    },
    getAgent: (id) => (state.agents.get(id) as unknown as Agent) ?? null,
    getMessages: async (id) => {
      const a = state.agents.get(id);
      if (!a) return [];
      a.getCalls++;
      if (a.pending && a.getCalls >= a.revealAt) reveal(a);
      return a.latest ? [{ ...a.latest }] : [];
    },
    sendInput: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInput to unknown agent ${id}`);
      state.sentPrompts.push({ id, text: String(text ?? '') });
      a.sendCount++;
      arm(a, a.sendCount === 1 ? 2 : 1);
    },
    sendInputConfirmed: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInputConfirmed to unknown agent ${id}`);
      state.sentPrompts.push({ id, text: String(text ?? '') });
      a.sendCount++;
      arm(a, a.sendCount === 1 ? 2 : 1);
      return { delivered: true, confirmed: true, mode: 'hook' as const };
    },
    resubmitEnter: () => {},
    recoverChatBinding: () => {},
    isInputInFlight: () => false,
    stopAgent: async () => {},
  };
  return { client, state };
}

let planSeq = 0;
function freshPlanPath(): string { return path.join(os.tmpdir(), `gt-rail-${process.pid}-${++planSeq}.md`); }
function rm(p: string): void { try { fs.unlinkSync(p); } catch { /* ignore */ } }

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    runId: 'run-rail', name: 'groupthink', mode: 'serial', status: 'running',
    workspaceId: 'ws-1', supervisorId: 'sup-1', topic: 'Plan a thing',
    planPath: freshPlanPath(), leadProvider: 'claude', reviewerProvider: 'codex',
    turnTimeoutMs: 600000, recoveryRepollMs: 30, lastRelayedTs: {},
    startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
function makeCtx(run: OrchestrationRun): OrchestrationRunContext {
  return { run, signal: new AbortController().signal, persist: () => {}, emit: () => {} };
}

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }
// ── Hop 1: run → launch input ────────────────────────────────────────────────

test('serial: every launched member carries the run planId + sectionAnchor', async () => {
  const run = makeRun({ planId: 'plan-9', sectionAnchor: 'sec_z' });
  // Terminate only once BOTH members have launched: fire the section change after
  // the Reviewer produces its first turn (BUG-29 launches it after lead turn 1).
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Reviewer')) fs.writeFileSync(run.planPath, 'updated'); },
  });
  try {
    await runSerial(client, makeCtx(run));
    assert.equal(state.launchInputs.length, 2, 'lead + reviewer both launched');
    for (const input of state.launchInputs) {
      assert.equal(input.planId, 'plan-9', `${input.title} launch input carries planId`);
      assert.equal(input.planSection, 'sec_z', `${input.title} launch input carries planSection`);
    }
    assert.equal(fs.existsSync(run.planPath), true, 'completion came from the bound document update');
  } finally { rm(run.planPath); }
});

test('parallel: both planners carry the run planId + sectionAnchor', async () => {
  const run = makeRun({ mode: 'parallel', planId: 'plan-p', sectionAnchor: 'sec_syn' });
  // Complete at R3: let the synthesizer's R3 turn fire the section change.
  let synthTurns = 0;
  const { client, state } = makeFake({
    onTurn: (a) => {
      if (a.title.startsWith('Synthesizer') && ++synthTurns >= 3) fs.writeFileSync(run.planPath, 'updated');
    },
  });
  try {
    await runParallel(client, makeCtx(run));
    assert.equal(state.launchInputs.length, 2, 'synthesizer + peer launched');
    for (const input of state.launchInputs) {
      assert.equal(input.planId, 'plan-p', `${input.title} carries planId`);
      assert.equal(input.planSection, 'sec_syn', `${input.title} carries planSection`);
    }
    assert.equal(fs.existsSync(run.planPath), true, 'R3 completed on the bound document update');
  } finally { rm(run.planPath); }
});

test('rail-less run leaves planId/planSection unset on launch inputs (unchanged legacy behavior)', async () => {
  const run = makeRun();   // no planId/sectionAnchor
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 2) fs.writeFileSync(run.planPath, 'plan'); },
  });
  try {
    await runSerial(client, makeCtx(run));
    for (const input of state.launchInputs) {
      assert.equal(input.planId, undefined, 'no planId stamped on a rail-less run');
      assert.equal(input.planSection, undefined, 'no planSection stamped on a rail-less run');
    }
  } finally { rm(run.planPath); }
});

// ── Hop 2: launch input → agent env, at BOTH sites (structural parity) ────────

// __dirname at runtime is dist/main/main/orchestration → four hops to repo root.
const SUPERVISOR_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'src', 'main', 'supervisor', 'index.ts'),
  'utf8',
);
test('native site: extraEnv injects AGENT_DASHBOARD_PLAN_ID/_SECTION from agent.plan*', () => {
  assert.match(SUPERVISOR_SRC, /extraEnv\.AGENT_DASHBOARD_PLAN_ID\s*=\s*agent\.planId/);
  assert.match(SUPERVISOR_SRC, /extraEnv\.AGENT_DASHBOARD_PLAN_SECTION\s*=\s*agent\.planSection/);
});
test('WSL site: wslEnvPrefix injects AGENT_DASHBOARD_PLAN_ID/_SECTION from agent.plan*', () => {
  assert.match(SUPERVISOR_SRC, /wslEnvPrefix\.push\(`AGENT_DASHBOARD_PLAN_ID=\$\{[^}]*agent\.planId[^}]*\}`\)/);
  assert.match(SUPERVISOR_SRC, /wslEnvPrefix\.push\(`AGENT_DASHBOARD_PLAN_SECTION=\$\{[^}]*agent\.planSection[^}]*\}`\)/);
});

// ── Hop 3: done-detection swap (existsSync → post-dispatch mtime) ─────────────

test('done-detection: a bound run ignores a file older than dispatch and completes after it changes', async () => {
  const startedAt = new Date().toISOString();
  const run = makeRun({ planId: 'plan-x', sectionAnchor: 'sec_q', startedAt });
  // A file at planPath would short-circuit the LEGACY existsSync gate on turn 1.
  fs.writeFileSync(run.planPath, 'pre-existing registered surface');
  const old = new Date(Date.parse(startedAt) - 10_000);
  fs.utimesSync(run.planPath, old, old);
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead')) fs.writeFileSync(run.planPath, 'updated after dispatch'); },
  });
  try {
    await runSerial(client, makeCtx(run));
    assert.equal(state.launchInputs.length, 1, 'the first post-dispatch update completes the run');
  } finally { rm(run.planPath); }
});

test('done-detection: a bound run completes as soon as its document is created', async () => {
  const run = makeRun({ planId: 'plan-y', sectionAnchor: 'sec_done' });
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead')) fs.writeFileSync(run.planPath, 'created'); },
  });
  try {
    await runSerial(client, makeCtx(run));   // resolves (no throw)
    assert.equal(state.launchInputs.length, 1, 'only the Lead launched — document creation ended the run at turn 1');
    assert.equal(fs.existsSync(run.planPath), true, 'completed with the bound document on disk');
  } finally { rm(run.planPath); }
});

// ── Fix 3 (planning-surface demo, 2026-07-06): rail runs resolve the plan row's
//    REAL path — never the legacy `plans/new-plan.md` default ─────────────────
//
// The demo GroupThink (a rail run: planId + sectionAnchor) baked the default
// plan_path into the Lead's termination instructions AND the groupthink.complete
// message, forcing the Lead to self-correct. These pin the fix end-to-end: a
// service.start_run rail dispatch resolves getPlan(planId).path into run.planPath,
// so every prompt hop (writebackClause → serialLeadPrompt kickoff) and the
// completion delivery reference that real path, and the default appears nowhere.

async function svcWaitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => realSetTimeout(r, 5));
  }
  throw new Error('svcWaitFor timed out');
}

const REAL_PLAN_REL = 'plans/demo-plan-planning-surface-acceptance.html';
const REAL_PLAN_BASENAME = 'demo-plan-planning-surface-acceptance.html';

test('rail dispatch resolves the plan row path into run.planPath (never plans/new-plan.md)', async () => {
  svcPlansStore.set('plan-demo', { id: 'plan-demo', workspaceId: 'ws-1', path: REAL_PLAN_REL });
  const realPlanPath = path.join(os.tmpdir(), REAL_PLAN_REL);
  const { client, state } = makeFake({
    onTurn: (a) => {
      if (!a.title.startsWith('Reviewer')) return;
      fs.mkdirSync(path.dirname(realPlanPath), { recursive: true });
      fs.writeFileSync(realPlanPath, 'updated');
    },
  });
  const delivered: string[] = [];
  const svc = new OrchestrationService(client, async (_sup, text) => { delivered.push(text); return { ok: true }; },
    { serial: runSerial, parallel: runParallel });

  const { runId } = svc.start_run({
    name: 'groupthink', workspaceId: 'ws-1', supervisorId: 'sup-1',
    topic: 'Plan the acceptance demo', mode: 'serial',
    planId: 'plan-demo', planningIntentId: 'int_1234abcd', sectionAnchor: 'sec_demo',
  } as any);

  await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'complete');
  const run = db.getOrchestrationRun(runId)!;

  // 1. run.planPath is the plan row's real path (joined to the workspace), NOT the default.
  assert.ok(run.planPath.includes(REAL_PLAN_BASENAME), `run.planPath resolves to the plan row path (got ${run.planPath})`);
  assert.ok(!run.planPath.includes('new-plan.md'), 'run.planPath is not the plans/new-plan.md default');

  // 2. Every kickoff/relay prompt sent references the real path; the default appears in NONE.
  const leadKickoff = state.sentPrompts.find((p) => p.text.includes('Termination contract'));
  assert.ok(leadKickoff, 'the Lead received a kickoff carrying the termination contract');
  assert.ok(leadKickoff!.text.includes(REAL_PLAN_BASENAME), 'the termination contract writes back to the real plan path');
  for (const p of state.sentPrompts) {
    assert.ok(!p.text.includes('new-plan.md'), `no sent prompt mentions the plan_path default (offending: ${p.id})`);
  }

  // 3. The groupthink.complete delivery references the real path, never the default.
  const completeMsg = delivered.find((t) => t.includes('groupthink.complete'));
  assert.ok(completeMsg, 'a groupthink.complete message was delivered');
  assert.ok(completeMsg!.includes(REAL_PLAN_BASENAME), 'completion message references the real plan path');
  assert.ok(!completeMsg!.includes('new-plan.md'), 'completion message never names the plan_path default');
  rm(realPlanPath);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

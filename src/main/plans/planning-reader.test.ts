// WP-P1A — planning-reader: bounded enumeration + safe read IPC.
//   npm run build:main
//   node dist/main/main/plans/planning-reader.test.js
//
// Fixtures (per the WP Verify list): bare proposal, valid folder, missing
// plan.json, stray dir, legacy .html, symlink/junction escape, ..-traversal,
// mixed-separator, oversize file, oversize manifest, rename, delete,
// atomic-replace, late plan.md — plus disk-derived rungs, `ran` unavailable,
// opaque ids, no write, and no demand-probe (`reader_open`) on mount.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  listPlanningEntries,
  readPlanningDocument,
  resetPlanningReaderRegistryForTests,
  safeRelPath,
  parseMarkdownLinkTargets,
  parseFrontmatter,
} from './planning-reader';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

const created: string[] = [];
/** Fresh temp workspace root; a `.lares` state dir is used (neither exists). */
function makeWorkspace(): string {
  resetWorkspaceStateDirCacheForTests();
  resetPlanningReaderRegistryForTests();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'planning-reader-'));
  created.push(root);
  fs.mkdirSync(nodePath.join(root, '.lares', 'proposals'), { recursive: true });
  fs.mkdirSync(nodePath.join(root, '.lares', 'plans'), { recursive: true });
  return root;
}
function proposalsDir(root: string): string { return nodePath.join(root, '.lares', 'proposals'); }
function plansDir(root: string): string { return nodePath.join(root, '.lares', 'plans'); }

/** Write a §R0-valid plan folder; returns its absolute path. */
function makePlanFolder(
  root: string,
  sku: string,
  opts: { planJson?: any; planMd?: string; sourceProposalRel?: string } = {},
): string {
  const folder = nodePath.join(plansDir(root), sku);
  fs.mkdirSync(nodePath.join(folder, 'deliberations'), { recursive: true });
  fs.mkdirSync(nodePath.join(folder, 'research'), { recursive: true });
  fs.mkdirSync(nodePath.join(folder, 'supplements'), { recursive: true });
  fs.writeFileSync(nodePath.join(folder, 'deliberations', '.gitkeep'), '');
  const planJson = opts.planJson ?? {
    schema_version: 1,
    plan_artifact_id: 'plan_deadbeef',
    plan_sku: sku,
    ...(opts.sourceProposalRel
      ? { source_proposal: { artifact_id: 'prop_1', rel_path: opts.sourceProposalRel } }
      : {}),
  };
  fs.writeFileSync(nodePath.join(folder, 'plan.json'), JSON.stringify(planJson));
  if (opts.planMd !== undefined) fs.writeFileSync(nodePath.join(folder, 'plan.md'), opts.planMd);
  return folder;
}

const INTENT_A = `<!--PLAN-INTENT
{ "intent_id": "int_aaaa0001", "part": "attribution-timing", "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" } ],
  "reason": "needs deliberation" }
-->`;

function outputDoc(intentId: string, planArtifactId = 'plan_deadbeef'): string {
  return `---\nplan_artifact_id: ${planArtifactId}\nintent_id: ${intentId}\norchestration_id: orc_self123\nkind: deliberation\n---\n\n# result\nbody\n`;
}

// ── enumeration ─────────────────────────────────────────────────────────────

test('lists bare proposals (flat *.md) and a valid plan folder', () => {
  const root = makeWorkspace();
  fs.writeFileSync(nodePath.join(proposalsDir(root), '2026-08-02-alpha.md'), '# Alpha');
  fs.writeFileSync(nodePath.join(proposalsDir(root), '2026-08-02-beta.md'), '# Beta');
  makePlanFolder(root, '2026-08-02-gamma-deadbeef', { planMd: '# Gamma plan' });

  const { entries } = listPlanningEntries(root);
  const proposals = entries.filter((e) => e.kind === 'proposal');
  const folders = entries.filter((e) => e.kind === 'plan-folder');
  assert.equal(proposals.length, 2, 'two bare proposals');
  assert.equal(folders.length, 1, 'one plan folder');
  assert.deepEqual(proposals.map((p) => p.title).sort(), ['2026-08-02-alpha', '2026-08-02-beta']);
  assert.equal(folders[0].planArtifactId, 'plan_deadbeef');
});

test('proposal enumeration is FLAT — supporting/ subdir docs are not listed', () => {
  const root = makeWorkspace();
  fs.writeFileSync(nodePath.join(proposalsDir(root), 'top.md'), '# top');
  fs.mkdirSync(nodePath.join(proposalsDir(root), 'supporting'), { recursive: true });
  fs.writeFileSync(nodePath.join(proposalsDir(root), 'supporting', 'nested.md'), '# nested');
  const { entries } = listPlanningEntries(root);
  const titles = entries.filter((e) => e.kind === 'proposal').map((e) => e.title);
  assert.deepEqual(titles, ['top'], 'only the flat top-level md, not the nested one');
});

test('manifest hides .gitkeep and plan.json; categorizes plan.md / ARC.md / subdirs', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-a-deadbeef', { planMd: '# plan' });
  fs.writeFileSync(nodePath.join(folder, 'ARC.md'), '# arc');
  fs.writeFileSync(nodePath.join(folder, 'deliberations', 'd1.md'), outputDoc('int_x'));
  fs.writeFileSync(nodePath.join(folder, 'research', 'r1.md'), '# r');
  fs.writeFileSync(nodePath.join(folder, 'supplements', 's1.md'), '# s');

  const { entries } = listPlanningEntries(root);
  const folder0 = entries.find((e) => e.kind === 'plan-folder')!;
  const names = folder0.documents.map((d) => d.name).sort();
  assert.ok(!names.includes('.gitkeep'), '.gitkeep suppressed');
  assert.ok(!names.includes('plan.json'), 'plan.json suppressed');
  assert.deepEqual(names, ['ARC.md', 'd1.md', 'plan.md', 'r1.md', 's1.md']);
  const cat = (n: string) => folder0.documents.find((d) => d.name === n)!.category;
  assert.equal(cat('plan.md'), 'plan');
  assert.equal(cat('ARC.md'), 'arc');
  assert.equal(cat('d1.md'), 'deliberation');
  assert.equal(cat('r1.md'), 'research');
  assert.equal(cat('s1.md'), 'supplement');
});

test('missing plan.json → folder not adopted (diagnostic, not an entry)', () => {
  const root = makeWorkspace();
  const folder = nodePath.join(plansDir(root), 'no-json-dir');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(nodePath.join(folder, 'plan.md'), '# orphan');
  const { entries, warnings } = listPlanningEntries(root);
  assert.equal(entries.filter((e) => e.kind === 'plan-folder').length, 0);
  assert.ok(warnings.some((w) => w.includes('no-json-dir')), 'diagnostic emitted');
});

test('stray dir with malformed plan.json → not adopted', () => {
  const root = makeWorkspace();
  const folder = nodePath.join(plansDir(root), 'stray');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(nodePath.join(folder, 'plan.json'), '{ not valid json');
  const { entries, warnings } = listPlanningEntries(root);
  assert.equal(entries.filter((e) => e.kind === 'plan-folder').length, 0);
  assert.ok(warnings.some((w) => w.includes('stray')));
});

test('legacy .html is excluded (directory scope only)', () => {
  const root = makeWorkspace();
  // A legacy HTML file dropped into proposals/ must not surface (only *.md).
  fs.writeFileSync(nodePath.join(proposalsDir(root), 'legacy-plan.html'), '<html></html>');
  fs.writeFileSync(nodePath.join(proposalsDir(root), 'real.md'), '# real');
  // And an .html file directly under plans/ is not a directory → ignored.
  fs.writeFileSync(nodePath.join(plansDir(root), 'legacy.html'), '<html></html>');
  const { entries } = listPlanningEntries(root);
  assert.deepEqual(entries.filter((e) => e.kind === 'proposal').map((e) => e.title), ['real']);
  assert.equal(entries.filter((e) => e.kind === 'plan-folder').length, 0);
});

// ── opaque ids + safe read ────────────────────────────────────────────────

test('manifest ids are opaque and reads resolve by id only', () => {
  const root = makeWorkspace();
  makePlanFolder(root, 'sku-b-deadbeef', { planMd: '# hardened plan body' });
  const { entries } = listPlanningEntries(root);
  const folder0 = entries.find((e) => e.kind === 'plan-folder')!;
  const planDoc = folder0.documents.find((d) => d.name === 'plan.md')!;

  assert.match(planDoc.docId, /^pdoc_[0-9a-f]{24}$/, 'opaque hashed id');
  assert.ok(!planDoc.docId.includes(root), 'id leaks no absolute path');
  assert.ok(!/[a-zA-Z]:[\\/]/.test(planDoc.docId), 'id leaks no drive path');

  const read = readPlanningDocument(planDoc.docId);
  assert.ok(!('error' in read), 'read succeeds by opaque id');
  if (!('error' in read)) {
    assert.equal(read.content, '# hardened plan body');
    assert.equal(read.truncated, false);
    assert.equal(read.name, 'plan.md');
  }
});

test('unknown manifest id → error, no throw', () => {
  makeWorkspace();
  const res = readPlanningDocument('pdoc_ffffffffffffffffffffffff');
  assert.ok('error' in res);
});

test('oversize file → read truncated + flagged at the per-file cap', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-c-deadbeef', {});
  const big = 'x'.repeat(5000);
  fs.writeFileSync(nodePath.join(folder, 'supplements', 'big.md'), big);
  const { entries } = listPlanningEntries(root, { caps: { maxReadBytes: 1000 } });
  const doc = entries[0].documents.find((d) => d.name === 'big.md')!;
  const read = readPlanningDocument(doc.docId, { caps: { maxReadBytes: 1000 } });
  assert.ok(!('error' in read));
  if (!('error' in read)) {
    assert.equal(read.truncated, true);
    assert.equal(read.content.length, 1000, 'content capped');
    assert.equal(read.sizeBytes, 5000, 'true size reported');
  }
});

test('oversize manifest → enumeration stops at the total-byte cap with a warning', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-d-deadbeef', {});
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(nodePath.join(folder, 'supplements', `s${i}.md`), 'y'.repeat(500));
  }
  const { entries } = listPlanningEntries(root, { caps: { maxManifestBytes: 1200 } });
  const folder0 = entries.find((e) => e.kind === 'plan-folder')!;
  const totalBytes = folder0.documents.reduce((n, d) => n + d.sizeBytes, 0);
  assert.ok(totalBytes <= 1200, `manifest bounded (${totalBytes} <= 1200)`);
  assert.ok((folder0.warnings ?? []).some((w) => /byte cap/.test(w)), 'cap warning surfaced');
});

test('doc-count cap bounds the manifest', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-e-deadbeef', {});
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(nodePath.join(folder, 'supplements', `s${i}.md`), 'z');
  }
  const { entries } = listPlanningEntries(root, { caps: { maxDocsPerFolder: 3 } });
  const folder0 = entries.find((e) => e.kind === 'plan-folder')!;
  assert.ok(folder0.documents.length <= 3);
  assert.ok((folder0.warnings ?? []).some((w) => /document cap/.test(w)));
});

// ── path safety ─────────────────────────────────────────────────────────────

test('safeRelPath rejects ..-traversal and mixed separators, normalizes the rest', () => {
  assert.equal(safeRelPath('deliberations/d1.md'), 'deliberations/d1.md');
  assert.equal(safeRelPath('deliberations\\d1.md'), 'deliberations/d1.md', 'mixed separator normalized');
  assert.equal(safeRelPath('a\\b/c.md'), 'a/b/c.md');
  assert.equal(safeRelPath('../outside.md'), null, 'posix traversal rejected');
  assert.equal(safeRelPath('..\\outside.md'), null, 'windows traversal rejected');
  assert.equal(safeRelPath('deliberations/../../etc/passwd'), null, 'nested traversal rejected');
  assert.equal(safeRelPath('/abs/path'), null, 'absolute rejected');
  assert.equal(safeRelPath('C:\\abs'), null, 'drive path rejected');
  assert.equal(safeRelPath(''), null);
});

test('symlink/junction escape is rejected — escaped docs never enter the manifest', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-f-deadbeef', { planMd: '# plan' });
  // A secret outside the plan folder.
  const secretDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'planning-secret-'));
  created.push(secretDir);
  fs.writeFileSync(nodePath.join(secretDir, 'secret.md'), 'TOP SECRET');
  // Replace `deliberations/` with a junction pointing outside the folder.
  fs.rmSync(nodePath.join(folder, 'deliberations'), { recursive: true, force: true });
  try {
    fs.symlinkSync(secretDir, nodePath.join(folder, 'deliberations'), 'junction');
  } catch (err) {
    console.log(`    (skipped: junction unavailable — ${err instanceof Error ? err.message : err})`);
    return;
  }
  const { entries } = listPlanningEntries(root);
  const folder0 = entries.find((e) => e.kind === 'plan-folder')!;
  assert.ok(
    !folder0.documents.some((d) => d.name === 'secret.md'),
    'the escaped secret is NOT reachable through the manifest',
  );
});

// ── §R1 disk-derived lifecycle ────────────────────────────────────────────

test('rungs: marked + returned; `ran` is unavailable pre-ledger; unfolded keeps intent open', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-g-deadbeef', { planMd: `# Plan\n\n${INTENT_A}\n` });
  fs.writeFileSync(nodePath.join(folder, 'deliberations', 'attr.md'), outputDoc('int_aaaa0001'));

  const { entries } = listPlanningEntries(root);
  const folder0 = entries.find((e) => e.kind === 'plan-folder')!;
  assert.equal(folder0.intents!.length, 1);
  const intent = folder0.intents![0];
  assert.equal(intent.intentId, 'int_aaaa0001');
  assert.equal(intent.marked, true);
  assert.equal(intent.ran, 'unavailable-pre-ledger', 'ran never disk-derived');
  assert.equal(intent.returned, true, 'a present matching output ⇒ returned');
  assert.equal(intent.fullyFoldedIn, false, 'no plan.md link ⇒ still open');
  assert.equal(intent.outputs.length, 1);
  assert.equal(intent.outputs[0].foldedIn, false);
  assert.equal(intent.outputs[0].orchestrationIdSelfDeclared, 'orc_self123');
});

test('folded-in requires a resolved Markdown link — a raw substring is insufficient', () => {
  const root = makeWorkspace();
  // Substring-only: the path appears as prose, not as a link.
  const substringOnly = `# Plan\n\n${INTENT_A}\n\nSee deliberations/attr.md for details.\n`;
  const folder1 = makePlanFolder(root, 'sku-h1-deadbeef', { planMd: substringOnly });
  fs.writeFileSync(nodePath.join(folder1, 'deliberations', 'attr.md'), outputDoc('int_aaaa0001'));

  // Real link.
  const linked = `# Plan\n\n${INTENT_A}\n\nFolded in [the deliberation](deliberations/attr.md).\n`;
  const folder2 = makePlanFolder(root, 'sku-h2-deadbeef', { planMd: linked });
  fs.writeFileSync(nodePath.join(folder2, 'deliberations', 'attr.md'), outputDoc('int_aaaa0001'));

  const { entries } = listPlanningEntries(root);
  const byId = (sku: string) => entries.find((e) => e.planSku === sku)!.intents![0];
  assert.equal(byId('sku-h1-deadbeef').fullyFoldedIn, false, 'substring ⇒ NOT folded');
  assert.equal(byId('sku-h2-deadbeef').fullyFoldedIn, true, 'resolved link ⇒ folded');
  assert.equal(byId('sku-h2-deadbeef').outputs[0].foldedIn, true);
});

test('supersession: a new intent carrying supersedes_intent_id marks the old one superseded', () => {
  const root = makeWorkspace();
  const supersede = `<!--PLAN-INTENT
{ "intent_id": "int_bbbb0002", "part": "attribution-timing", "kind": "groupthink-serial",
  "targets": [], "reason": "reopened", "supersedes_intent_id": "int_aaaa0001" }
-->`;
  makePlanFolder(root, 'sku-i-deadbeef', { planMd: `# Plan\n\n${INTENT_A}\n\n${supersede}\n` });
  const { entries } = listPlanningEntries(root);
  const intents = entries.find((e) => e.kind === 'plan-folder')!.intents!;
  const a = intents.find((i) => i.intentId === 'int_aaaa0001')!;
  const b = intents.find((i) => i.intentId === 'int_bbbb0002')!;
  assert.equal(a.status, 'superseded');
  assert.equal(b.status, 'active');
  assert.equal(b.supersedesIntentId, 'int_aaaa0001');
});

test('malformed PLAN-INTENT is skipped with a diagnostic (not a crash)', () => {
  const root = makeWorkspace();
  const bad = `<!--PLAN-INTENT\n{ not: valid json }\n-->`;
  makePlanFolder(root, 'sku-j-deadbeef', { planMd: `# Plan\n\n${INTENT_A}\n\n${bad}\n` });
  const { entries } = listPlanningEntries(root);
  const folder0 = entries.find((e) => e.kind === 'plan-folder')!;
  assert.equal(folder0.intents!.length, 1, 'the one valid intent survives');
  assert.ok((folder0.warnings ?? []).some((w) => /malformed/.test(w)));
});

// ── robustness: rename / delete / atomic-replace / late plan.md ──────────────

test('folder rename is handled — re-enumeration reflects the new location', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-old-deadbeef', { planMd: '# plan' });
  assert.equal(listPlanningEntries(root).entries.filter((e) => e.kind === 'plan-folder').length, 1);
  fs.renameSync(folder, nodePath.join(plansDir(root), 'sku-new-deadbeef'));
  const after = listPlanningEntries(root).entries.filter((e) => e.kind === 'plan-folder');
  assert.equal(after.length, 1, 're-enumerated at the new location, no crash');
  assert.equal(after[0].planArtifactId, 'plan_deadbeef', 'stable identity survives the rename');
  // The renamed folder is a distinct path, so its opaque entryId differs from
  // the pre-rename one — the surface tracks it by fresh enumeration, not a
  // stale id (identity stays keyed on plan_artifact_id).
  const planDoc = after[0].documents.find((d) => d.name === 'plan.md')!;
  const read = readPlanningDocument(planDoc.docId);
  assert.ok(!('error' in read), 'the renamed folder\'s doc reads via its fresh id');
});

test('folder deletion is handled — absent → empty, no crash; stale read → error', () => {
  const root = makeWorkspace();
  const folder = makePlanFolder(root, 'sku-del-deadbeef', { planMd: '# plan' });
  const { entries } = listPlanningEntries(root);
  const planDoc = entries[0].documents.find((d) => d.name === 'plan.md')!;
  fs.rmSync(folder, { recursive: true, force: true });
  // Re-list: gone, no throw.
  assert.equal(listPlanningEntries(root).entries.filter((e) => e.kind === 'plan-folder').length, 0);
  // Stale read of the pre-delete docId degrades to an error, never a throw.
  const stale = readPlanningDocument(planDoc.docId);
  assert.ok('error' in stale, 'stale read errors gracefully');
});

test('atomic replacement (temp-dir → rename) is handled — new content on re-list', () => {
  const root = makeWorkspace();
  makePlanFolder(root, 'sku-atomic-deadbeef', { planMd: '# v1' });
  const first = listPlanningEntries(root).entries.find((e) => e.kind === 'plan-folder')!;
  const firstDoc = first.documents.find((d) => d.name === 'plan.md')!;
  const r1 = readPlanningDocument(firstDoc.docId);
  assert.ok(!('error' in r1) && r1.content === '# v1');

  // Build a replacement in a sibling temp dir, then atomically swap.
  const target = nodePath.join(plansDir(root), 'sku-atomic-deadbeef');
  const tmp = nodePath.join(plansDir(root), '.sku-atomic-deadbeef.tmp');
  makePlanFolder(root, '.sku-atomic-deadbeef.tmp', { planMd: '# v2' });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);

  const second = listPlanningEntries(root).entries.find((e) => e.kind === 'plan-folder')!;
  const secondDoc = second.documents.find((d) => d.name === 'plan.md')!;
  const r2 = readPlanningDocument(secondDoc.docId);
  assert.ok(!('error' in r2) && r2.content === '# v2', 'reflects atomically-replaced content');
});

test('late plan.md — intents fall back to the linked source proposal, then adopt plan.md', () => {
  const root = makeWorkspace();
  // Source proposal carries the mark; plan.md not written yet.
  fs.writeFileSync(nodePath.join(proposalsDir(root), 'src.md'), `# Proposal\n\n${INTENT_A}\n`);
  const folder = makePlanFolder(root, 'sku-late-deadbeef', {
    sourceProposalRel: '.lares/proposals/src.md',
  });
  fs.writeFileSync(nodePath.join(folder, 'deliberations', 'attr.md'), outputDoc('int_aaaa0001'));

  const before = listPlanningEntries(root).entries.find((e) => e.kind === 'plan-folder')!;
  assert.equal(before.intents!.length, 1, 'intent derived from source proposal pre-hardening');
  assert.equal(before.intents![0].returned, true);

  // Later hardening writes plan.md (with a link ⇒ folded).
  fs.writeFileSync(
    nodePath.join(folder, 'plan.md'),
    `# Plan\n\n${INTENT_A}\n\n[folded](deliberations/attr.md)\n`,
  );
  const after = listPlanningEntries(root).entries.find((e) => e.kind === 'plan-folder')!;
  assert.equal(after.intents!.length, 1);
  assert.equal(after.intents![0].fullyFoldedIn, true, 'plan.md link now folds the output');
});

// ── read-only guarantee + no demand-probe on mount ──────────────────────────

test('enumeration writes nothing to disk (read-only) and emits no demand-probe', () => {
  const root = makeWorkspace();
  fs.writeFileSync(nodePath.join(proposalsDir(root), 'p.md'), '# p');
  makePlanFolder(root, 'sku-ro-deadbeef', { planMd: '# plan' });

  const snapshot = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(full);
      }
    };
    walk(nodePath.join(root, '.lares'));
    return out.sort();
  };
  const before = snapshot();
  listPlanningEntries(root);
  // Also exercise a read.
  const entries = listPlanningEntries(root).entries;
  const doc = entries[0].documents[0];
  readPlanningDocument(doc.docId);
  const after = snapshot();

  assert.deepEqual(after, before, 'no files created or removed by list/read');
  // `reader_open` is a user-gesture event stamped elsewhere — the reader emits
  // no demand-probe on mount/refresh.
  assert.ok(
    !fs.existsSync(nodePath.join(root, '.lares', 'usage', 'demand-probe.jsonl')),
    'no demand-probe sink written by the reader',
  );
});

// ── small pure-parser guards ────────────────────────────────────────────────

test('parseMarkdownLinkTargets strips titles/fragments and ignores URLs', () => {
  const md = `[a](deliberations/x.md) [b](research/y.md "title") [c](#anchor) [d](https://e.com) [e](s.md#frag)`;
  assert.deepEqual(parseMarkdownLinkTargets(md), [
    'deliberations/x.md',
    'research/y.md',
    's.md',
  ]);
});

test('parseFrontmatter reads flat key:value and strips quotes/comments', () => {
  const fm = parseFrontmatter(`---\nintent_id: int_1\nkind: "deliberation"  # note\n---\nbody`);
  assert.deepEqual(fm, { intent_id: 'int_1', kind: 'deliberation' });
  assert.equal(parseFrontmatter('no frontmatter here'), null);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

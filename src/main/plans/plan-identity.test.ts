import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  derivePlanIdentityFromMarkdown,
  type PlanIdentityOverrides,
} from '../../shared/plan-identity';
import {
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS,
} from '../../shared/constants';

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');

function deployedIdentities(
  modulePath: string,
  rows: Array<{ markdown: string; overrides: PlanIdentityOverrides }>,
): unknown[] {
  const script = [
    `import { derivePlanIdentityFromMarkdown } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
    'const rows = JSON.parse(process.env.PLAN_IDENTITY_ROWS);',
    'process.stdout.write(JSON.stringify(rows.map((row) => derivePlanIdentityFromMarkdown(row.markdown, row.overrides))));',
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PLAN_IDENTITY_ROWS: JSON.stringify(rows) },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as unknown[];
}

test('WP-A identity generator output is the deployed module byte-for-byte', () => {
  const generated = spawnSync(process.execPath, [path.join(workspaceRoot, 'scripts', 'generate-plan-identity-module.mjs')], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(generated.stdout, PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS);
});

test('WP-A main and deployed identity implementations match the full fixture matrix', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-plan-identity-'));
  try {
    const deployedPath = path.join(temp, 'plan-identity.mjs');
    fs.writeFileSync(deployedPath, PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS, 'utf8');
    const rows: Array<{ markdown: string; overrides: PlanIdentityOverrides }> = [
      { markdown: '---\nartifact_id: prop_a1b2c3d4\ntitle: Filename disagrees completely\nauthored_at: 2026-01-02T03:04:05Z\n---\n', overrides: {} },
      { markdown: '---\nartifact_id: "prop_deadbeef"\ntitle: "Punctuation!!! and spaces"\nauthored_at: "2026-02-03"\n---\n', overrides: {} },
      { markdown: "---\nartifact_id: 'cafebabe'\ntitle: 'Single quoted title'\nauthored_at: '2026-03-04T00:00:00Z'\n---\n", overrides: {} },
      { markdown: '---\nartifact_id: prop_01020304\ntitle: !!!\n---\n', overrides: { now: '2026-04-05T12:00:00Z' } },
      { markdown: `---\nartifact_id: prop_ffffffff\ntitle: ${'Long title '.repeat(20)}\nauthored_at: 2026-05-06\n---\n`, overrides: {} },
      { markdown: '---\nartifact_id: prop_12345678\ntitle: ignored\nauthored_at: 1999-01-01\n---\n', overrides: { date: '2027-07-08', slug: 'explicit-slug', proposalArtifactId: 'prop_87654321' } },
    ];
    const expected = rows.map((row) => derivePlanIdentityFromMarkdown(row.markdown, row.overrides));
    assert.deepEqual(deployedIdentities(deployedPath, rows), expected);
    assert.equal(expected[0].slug, 'filename-disagrees-completely');
    assert.equal(expected[3].slug, 'plan');
    assert.equal(expected[4].slug.length, 48);
    assert.equal(expected[2].planArtifactId, 'plan_cafebabe');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function scaffoldFixture(stateLeaf: '.lares' | '.dashboard'): { root: string; proposal: string; plans: string; scripts: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-plan-path-'));
  const state = path.join(root, stateLeaf);
  const proposalRoot = path.join(state, 'proposals');
  const plans = path.join(state, 'plans');
  const scripts = path.join(root, 'skill', 'scripts');
  fs.mkdirSync(proposalRoot, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'plan-identity.mjs'), PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS, 'utf8');
  fs.writeFileSync(path.join(scripts, 'plan-manifest.mjs'), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS, 'utf8');
  const proposal = path.join(proposalRoot, 'filename-does-not-drive-identity.md');
  fs.writeFileSync(proposal, '---\nartifact_id: prop_a1b2c3d4\ntitle: Canonical Title\nauthored_at: 2026-08-05T00:00:00Z\n---\n\n## Hardening scope\n', 'utf8');
  return { root, proposal, plans, scripts };
}

test('WP-A deployed scaffold writes canonical source paths for both state roots and rejects fallback/escape', () => {
  for (const stateLeaf of ['.lares', '.dashboard'] as const) {
    const fixture = scaffoldFixture(stateLeaf);
    try {
      const helper = path.join(fixture.scripts, 'plan-manifest.mjs');
      const ok = spawnSync(process.execPath, [helper, 'scaffold', '--proposal', fixture.proposal, '--plans-home', fixture.plans, '--request-id', 'test'], { encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stderr);
      const result = JSON.parse(ok.stdout) as { target: string };
      const manifest = JSON.parse(fs.readFileSync(path.join(result.target, 'plan.json'), 'utf8')) as {
        source_proposal: { rel_path: string };
      };
      assert.equal(manifest.source_proposal.rel_path, `${stateLeaf}/proposals/filename-does-not-drive-identity.md`);

      const basename = spawnSync(process.execPath, [helper, 'scaffold', '--proposal', path.basename(fixture.proposal), '--plans-home', fixture.plans], { encoding: 'utf8' });
      assert.notEqual(basename.status, 0, 'basename-only fallback must reject');
      const outside = path.join(fixture.root, 'outside.md');
      fs.writeFileSync(outside, fs.readFileSync(fixture.proposal));
      const escape = spawnSync(process.execPath, [helper, 'scaffold', '--proposal', outside, '--plans-home', fixture.plans], { encoding: 'utf8' });
      assert.notEqual(escape.status, 0, 'proposal-root escape must reject');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('WP-A deployed scaffold rejects a proposal-root symlink or junction escape', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-plan-link-'));
  try {
    const state = path.join(root, '.lares');
    const outside = path.join(root, 'outside-proposals');
    const plans = path.join(state, 'plans');
    const scripts = path.join(root, 'skill', 'scripts');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(plans, { recursive: true });
    fs.mkdirSync(scripts, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(state, 'proposals'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction unavailable: ${(error as Error).message}`);
      return;
    }
    const proposal = path.join(state, 'proposals', 'escape.md');
    fs.writeFileSync(path.join(outside, 'escape.md'), '---\nartifact_id: prop_a1b2c3d4\ntitle: Escape\nauthored_at: 2026-08-05\n---\n', 'utf8');
    fs.writeFileSync(path.join(scripts, 'plan-identity.mjs'), PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS, 'utf8');
    fs.writeFileSync(path.join(scripts, 'plan-manifest.mjs'), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS, 'utf8');
    const run = spawnSync(process.execPath, [path.join(scripts, 'plan-manifest.mjs'), 'scaffold', '--proposal', proposal, '--plans-home', plans], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /symlink\/reparse|cross-root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

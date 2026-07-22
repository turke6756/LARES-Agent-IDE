// WP3 (G3) — recommendation-draft construction + target-policy tests.
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/recommendation-draft.test.js
//
// Coverage: the causal-token denylist (test-enforced), template slot-citation
// (every substituted slot mechanically cites an evidence row), the cross-surface
// bar, the same-generation join, the command_family workspace-level-only bar, the
// humanReviewRequired literal, and the WP2 audienceProviders target policy
// (single-audience → file; ambiguous/unknown → unresolved; NEVER a CLAUDE.md default).

import assert from 'node:assert/strict';
import type { GuidanceSource } from '../../shared/types';
import {
  buildRecommendationDraft,
  commandFamilyClaimTemplate,
  findCausalToken,
  hotUncoveredClaimTemplate,
  hotUncoveredSuggestedBullet,
  renderClaim,
  selectRecommendationTarget,
  targetIsFile,
  CAUSAL_TOKEN_DENYLIST,
  RECOMMENDATION_EVIDENCE_SURFACE,
  RecommendationDraftError,
  type ClaimTemplate,
  type RecommendationEvidenceInput,
} from './recommendation-draft';

const GEN = 'gen-1';

function evidence(over: Partial<RecommendationEvidenceInput> = {}): RecommendationEvidenceInput {
  return { kind: 'file-heat', rowIds: ['row-1'], generationId: GEN, surface: RECOMMENDATION_EVIDENCE_SURFACE, ...over };
}

function template(over: Partial<ClaimTemplate> = {}): ClaimTemplate {
  return {
    template: 'File {path} was touched in {streams} stream(s).',
    slots: {
      path: { value: '/w/src/app.ts', citedRowId: 'row-1' },
      streams: { value: 2, citedRowId: 'row-1' },
    },
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildRecommendationDraft>[0]> = {}) {
  return buildRecommendationDraft({
    target: { unresolved: true, reason: 'test' },
    claimTemplate: template(),
    evidence: [evidence()],
    generationId: GEN,
    ...over,
  });
}

// ── guidance-source fixtures (WP2 shapes) ─────────────────────────────────────

function agentsMd(over: Partial<GuidanceSource> = {}): GuidanceSource {
  return {
    path: '/w/AGENTS.md', fileKind: 'agents-md', audienceProviders: ['codex'],
    applicability: { model: 'directory-chain' }, loadingSemanticsConfidence: 'documented',
    ...over,
  };
}
function claudeMd(over: Partial<GuidanceSource> = {}): GuidanceSource {
  return {
    path: '/w/CLAUDE.md', fileKind: 'claude-md', audienceProviders: ['claude'],
    applicability: { model: 'walk-up-chain' }, loadingSemanticsConfidence: 'documented',
    ...over,
  };
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}`); console.error('       ', err instanceof Error ? err.message : err); failed++; }
}
function throwsDraftError(fn: () => void, re: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof RecommendationDraftError && re.test((e as Error).message));
}

// ── causal-token denylist ─────────────────────────────────────────────────────

check('denylist contains exactly the three plan tokens', () => {
  assert.deepEqual([...CAUSAL_TOKEN_DENYLIST], ['because', 'in order to', 'so that']);
});

check('findCausalToken: word-boundary + case-insensitive; multiword tokens matched', () => {
  assert.equal(findCausalToken('this exists because agents did X'), 'because');
  assert.equal(findCausalToken('Because agents did X'), 'because');
  assert.equal(findCausalToken('added in order to reduce churn'), 'in order to');
  assert.equal(findCausalToken('split so that tests pass'), 'so that');
  assert.equal(findCausalToken('the Becauseless file'), null, 'no substring false positives');
  assert.equal(findCausalToken('a plain descriptive sentence'), null);
});

for (const token of CAUSAL_TOKEN_DENYLIST) {
  check(`a claim containing '${token}' is rejected at construction`, () => {
    throwsDraftError(
      () => build({ claimTemplate: template({ template: `File {path} in {streams} stream(s), ${token} it matters.` }) }),
      /denied causal token/);
  });
}

check('suggestedBulletText is denylist-checked too', () => {
  throwsDraftError(
    () => build({ suggestedBulletText: 'Add a line so that agents behave.' }),
    /suggestedBulletText contains the denied causal token/);
});

// ── template slot-citation ────────────────────────────────────────────────────

check('every substituted slot mechanically cites an evidence row (unknown row → throws)', () => {
  const t = template();
  t.slots.path = { value: '/w/x', citedRowId: 'not-in-evidence' };
  throwsDraftError(() => build({ claimTemplate: t }), /cites row 'not-in-evidence'/);
});

check('an unreplaced placeholder (no slot) → throws', () => {
  throwsDraftError(
    () => build({ claimTemplate: template({ template: 'File {path} in {streams} stream(s) at {mystery}.' }) }),
    /placeholder '\{mystery\}' has no slot/);
});

check('a slot with no placeholder in the template → throws', () => {
  const t = template({ template: 'File {path}.' });
  throwsDraftError(() => build({ claimTemplate: t }), /has no \{streams\} placeholder/);
});

check('renderClaim substitutes deterministically', () => {
  const claim = renderClaim(template(), new Set(['row-1']));
  assert.equal(claim, 'File /w/src/app.ts was touched in 2 stream(s).');
});

// ── evidence bars ─────────────────────────────────────────────────────────────

check('cross-surface evidence is barred at construction (until WP8)', () => {
  throwsDraftError(
    () => build({ evidence: [evidence({ surface: 'mcp-usage' })] }),
    /cross-surface evidence \('mcp-usage'\) is barred/);
});

check('evidence from another generation is rejected (same-generation join only)', () => {
  throwsDraftError(
    () => build({ evidence: [evidence({ generationId: 'gen-OTHER' })] }),
    /does not match the draft's analysis generation/);
});

check('an evidence entry with no rows is rejected (no claim without a recorded join)', () => {
  throwsDraftError(() => build({ evidence: [evidence({ rowIds: [] })] }), /cites no rows/);
});

check('a draft with no evidence at all is rejected', () => {
  throwsDraftError(() => build({ evidence: [] }), /at least one evidence entry/);
});

check('command_family evidence + FILE target → rejected at construction (WP9 bar)', () => {
  throwsDraftError(
    () => build({
      target: { file: '/w/AGENTS.md' },
      evidence: [evidence({ kind: 'command_family' })],
    }),
    /command_family evidence may only support workspace-level candidates/);
});

check('command_family evidence + unresolved target → allowed (workspace-level)', () => {
  const d = build({ evidence: [evidence({ kind: 'command_family' })] });
  assert.equal(d.humanReviewRequired, true);
  assert.equal(d.evidence[0].kind, 'command_family');
});

check('stored evidence entries carry {kind,rowIds,generationId} ONLY (surface stripped)', () => {
  const d = build();
  assert.deepEqual(Object.keys(d.evidence[0]).sort(), ['generationId', 'kind', 'rowIds']);
});

check('humanReviewRequired is the literal true on every draft', () => {
  assert.equal(build().humanReviewRequired, true);
});

// ── shipped templates stay clean ──────────────────────────────────────────────

check('hotUncoveredClaimTemplate renders a denylist-clean, fully-cited claim', () => {
  const t = hotUncoveredClaimTemplate({
    pathDisplay: '/w/src/app.ts', pathHash: 'row-1', reads: 4, writes: 3, executes: 0,
    distinctStreams: 2,
    coverageChecks: { totalPredicatesTested: 3, matched: 0, sample: [], truncated: false, limit: 10 },
  });
  const d = build({ claimTemplate: t });
  assert.equal(findCausalToken(d.claim), null);
  assert.match(d.claim, /3 guidance path prediction\(s\) were tested/);
  assert.match(d.claim, /0 matched/);
});

check('commandFamilyClaimTemplate renders denylist-clean; bullet template clean too', () => {
  const t = commandFamilyClaimTemplate({ family: 'git status', count: 3, distinctStreams: 2, rowId: 'row-1' });
  const d = build({ claimTemplate: t });
  assert.equal(findCausalToken(d.claim), null);
  assert.equal(findCausalToken(hotUncoveredSuggestedBullet({ pathDisplay: '/w/x.ts', distinctStreams: 2 })), null);
});

// ── target policy (WP2 audienceProviders) ─────────────────────────────────────

check('single applicable source for the cohort → file target', () => {
  const t = selectRecommendationTarget({ guidanceSources: [agentsMd()], observingProviders: ['codex'] });
  assert.ok(targetIsFile(t));
  assert.equal((t as { file: string }).file, '/w/AGENTS.md');
});

check('audience filtering: only the source applicable to the cohort counts', () => {
  const t = selectRecommendationTarget({
    guidanceSources: [claudeMd(), agentsMd()], observingProviders: ['codex'],
  });
  assert.ok(targetIsFile(t));
  assert.equal((t as { file: string }).file, '/w/AGENTS.md');
});

check('two applicable sources → unresolved (ambiguous)', () => {
  const t = selectRecommendationTarget({
    guidanceSources: [agentsMd(), agentsMd({ path: '/w/sub/AGENTS.md' })],
    observingProviders: ['codex'],
  });
  assert.equal(targetIsFile(t), false);
  assert.match((t as { reason: string }).reason, /ambiguous: 2 guidance sources/);
});

check('mixed cohort with no single covering source → unresolved', () => {
  const t = selectRecommendationTarget({
    guidanceSources: [agentsMd()], observingProviders: ['codex', 'claude'],
  });
  assert.equal(targetIsFile(t), false);
  assert.match((t as { reason: string }).reason, /provider 'claude'/);
});

check("an 'unknown' audience never resolves a target", () => {
  const t = selectRecommendationTarget({
    guidanceSources: [agentsMd({ audienceProviders: 'unknown', loadingSemanticsConfidence: 'unknown' })],
    observingProviders: ['codex'],
  });
  assert.equal(targetIsFile(t), false);
});

check('inventory-only files never resolve a target', () => {
  const t = selectRecommendationTarget({
    guidanceSources: [agentsMd({ applicability: { model: 'inventory-only' } })],
    observingProviders: ['codex'],
  });
  assert.equal(targetIsFile(t), false);
});

check('empty cohort → unresolved with reason', () => {
  const t = selectRecommendationTarget({ guidanceSources: [agentsMd()], observingProviders: [] });
  assert.equal(targetIsFile(t), false);
  assert.match((t as { reason: string }).reason, /no attributed provider/);
});

check('no inventory → unresolved with reason', () => {
  const t = selectRecommendationTarget({ guidanceSources: [], observingProviders: ['codex'] });
  assert.equal(targetIsFile(t), false);
  assert.match((t as { reason: string }).reason, /no guidance-source inventory/);
});

check('NEVER a CLAUDE.md default: a codex cohort with only CLAUDE.md → unresolved', () => {
  const t = selectRecommendationTarget({ guidanceSources: [claudeMd()], observingProviders: ['codex'] });
  assert.equal(targetIsFile(t), false, 'must not fall back to CLAUDE.md');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

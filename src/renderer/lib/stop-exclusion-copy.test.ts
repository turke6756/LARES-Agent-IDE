import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StopExclusionCode } from '@shared/types';
import {
  STOP_EXCLUSION_CODES,
  STOP_EXCLUSION_COPY,
  groupExclusionsByCode,
  stopExclusionExplanation,
  stopExclusionLabel,
  summarizeStopExclusions,
} from './stop-exclusion-copy';

/** The 12 codes of §B4, written out rather than derived, so a silent rename in
 *  the union is a test failure and not an invisibly-renamed chip. */
const EXPECTED_CODES: StopExclusionCode[] = [
  'not_idle',
  'threshold_not_met',
  'active_child',
  'active_orchestration',
  'pending_delivery',
  'human_attention',
  'browser_lease',
  'detached_process',
  'ownership_unverified',
  'lifecycle_busy',
  'guard_unavailable',
  'not_found',
];

describe('stop-exclusion-copy exhaustiveness', () => {
  it('covers exactly the expected code set, in declaration order', () => {
    expect(STOP_EXCLUSION_CODES).toEqual(EXPECTED_CODES);
  });

  // The Record<StopExclusionCode, …> makes a MISSING code a compile error, but
  // nothing at compile time keeps this test's own list in sync with the union.
  // Parsing the declaration catches a code added to types.ts that both the copy
  // table (via a widened type) and EXPECTED_CODES failed to notice.
  it('matches the StopExclusionCode union as declared in src/shared/types.ts', () => {
    const typesPath = path.resolve(__dirname, '../../shared/types.ts');
    const source = readFileSync(typesPath, 'utf8');
    const decl = /export type StopExclusionCode\s*=([\s\S]*?);/.exec(source);
    expect(decl, 'StopExclusionCode declaration not found in src/shared/types.ts').toBeTruthy();
    const declared = Array.from(decl![1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    expect(declared.slice().sort()).toEqual(EXPECTED_CODES.slice().sort());
  });

  it('gives every code a non-empty label and a sentence explanation', () => {
    for (const code of STOP_EXCLUSION_CODES) {
      const copy = STOP_EXCLUSION_COPY[code];
      expect(copy.label.length, code).toBeGreaterThan(0);
      // Copy must be human, not the raw code echoed back at the user.
      expect(copy.label).not.toContain('_');
      expect(copy.explanation.length, code).toBeGreaterThan(20);
    }
  });

  it('uses a distinct label per code', () => {
    const labels = STOP_EXCLUSION_CODES.map((c) => STOP_EXCLUSION_COPY[c].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('exposes label/explanation accessors', () => {
    expect(stopExclusionLabel('not_idle')).toBe(STOP_EXCLUSION_COPY.not_idle.label);
    expect(stopExclusionExplanation('not_found')).toBe(STOP_EXCLUSION_COPY.not_found.explanation);
  });
});

describe('summarizeStopExclusions', () => {
  it('returns null for an empty list', () => {
    expect(summarizeStopExclusions([])).toBeNull();
  });

  it('joins labels in the given order', () => {
    expect(summarizeStopExclusions(['not_idle', 'browser_lease'])).toBe(
      `${STOP_EXCLUSION_COPY.not_idle.label} · ${STOP_EXCLUSION_COPY.browser_lease.label}`,
    );
  });

  it('dedupes repeated codes', () => {
    expect(summarizeStopExclusions(['not_idle', 'not_idle'])).toBe(STOP_EXCLUSION_COPY.not_idle.label);
  });
});

describe('groupExclusionsByCode', () => {
  it('groups agents under each of their codes, in declaration order', () => {
    const grouped = groupExclusionsByCode([
      { agentId: 'a', codes: ['browser_lease', 'not_idle'] },
      { agentId: 'b', codes: ['not_idle'] },
    ]);
    expect(grouped.map((g) => g.code)).toEqual(['not_idle', 'browser_lease']);
    expect(grouped[0].agentIds).toEqual(['a', 'b']);
    expect(grouped[1].agentIds).toEqual(['a']);
    expect(grouped[0].copy).toBe(STOP_EXCLUSION_COPY.not_idle);
  });

  it('dedupes a code repeated within one agent', () => {
    const grouped = groupExclusionsByCode([{ agentId: 'a', codes: ['not_idle', 'not_idle'] }]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].agentIds).toEqual(['a']);
  });

  it('returns an empty array when nothing was excluded', () => {
    expect(groupExclusionsByCode([])).toEqual([]);
  });
});

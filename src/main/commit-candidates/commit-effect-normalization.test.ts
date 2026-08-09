import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeReviewedSemanticManifest,
  normalizeCommitEffects,
  type CommitEffectRepresentation,
  type NormalizedCommitEffect,
  type ReviewedSemanticManifest,
} from '../../shared/commit-candidates';
import { canonicalize } from './jcs';

const path = (value: string): string => Buffer.from(value).toString('base64');
const representation = (suffix: string, mode = '100644'): CommitEffectRepresentation => ({
  rawBlobOid: `raw-${suffix}`,
  commitBlobOid: `commit-${suffix}`,
  commitMode: mode,
});

function paths(effects: NormalizedCommitEffect[]): string[] {
  return effects.map((effect) => Buffer.from(effect.pathBytesBase64, 'base64').toString());
}

test('rename covers source, destination, and every commit pathspec', () => {
  const effects = normalizeCommitEffects({
    changeKind: 'rename',
    finalPathBytesBase64: path('new.txt'),
    finalRepresentation: representation('new'),
    originalPathBytesBase64: path('old.txt'),
    commitPathspecs: [path('sidecar.txt'), path('new.txt'), path('old.txt')],
    additionalPathspecEffects: [{
      pathBytesBase64: path('sidecar.txt'), operation: 'write', expectedState: 'present',
      rawBlobOid: 'raw-sidecar', commitBlobOid: 'commit-sidecar', commitMode: '100644',
    }],
  });

  assert.deepEqual(paths(effects), ['new.txt', 'old.txt', 'sidecar.txt']);
  assert.equal(effects.find((effect) => effect.pathBytesBase64 === path('old.txt'))?.operation, 'delete');
});

test('copy retains its explicitly represented source', () => {
  const effects = normalizeCommitEffects({
    changeKind: 'copy',
    finalPathBytesBase64: path('copy.txt'),
    finalRepresentation: representation('copy'),
    originalPathBytesBase64: path('source.txt'),
    originalRepresentation: representation('source'),
    commitPathspecs: [path('source.txt'), path('copy.txt')],
  });

  assert.deepEqual(paths(effects), ['copy.txt', 'source.txt']);
  assert.equal(effects[1].operation, 'retain');
  assert.equal(effects[1].commitBlobOid, 'commit-source');
});

test('delete normalizes to one absent effect', () => {
  const effects = normalizeCommitEffects({
    changeKind: 'delete',
    finalPathBytesBase64: path('gone.txt'),
    finalRepresentation: { rawBlobOid: null, commitBlobOid: null, commitMode: null },
    commitPathspecs: [path('gone.txt')],
  });

  assert.deepEqual(effects, [{
    pathBytesBase64: path('gone.txt'), operation: 'delete', expectedState: 'absent',
    rawBlobOid: null, commitBlobOid: null, commitMode: null,
  }]);
});

test('mode change binds the new mode and canonicalizes independently of input order', () => {
  const additional: NormalizedCommitEffect = {
    pathBytesBase64: path('z.txt'), operation: 'retain', expectedState: 'present',
    rawBlobOid: 'raw-z', commitBlobOid: 'commit-z', commitMode: '100644',
  };
  const first = normalizeCommitEffects({
    changeKind: 'mode-change', finalPathBytesBase64: path('script.sh'),
    finalRepresentation: representation('script', '100755'),
    commitPathspecs: [path('z.txt'), path('script.sh')], additionalPathspecEffects: [additional],
  });
  const second = normalizeCommitEffects({
    changeKind: 'mode-change', finalPathBytesBase64: path('script.sh'),
    finalRepresentation: representation('script', '100755'),
    commitPathspecs: [path('script.sh'), path('z.txt')], additionalPathspecEffects: [additional],
  });

  assert.equal(first[0].commitMode, '100755');
  assert.equal(canonicalize(first), canonicalize(second));
});

test('reviewed manifest canonicalization ignores insertion order of set-like arrays', () => {
  const effectA = normalizeCommitEffects({
    changeKind: 'write', finalPathBytesBase64: path('a.txt'),
    finalRepresentation: representation('a'), commitPathspecs: [path('a.txt')],
  })[0];
  const effectB = normalizeCommitEffects({
    changeKind: 'write', finalPathBytesBase64: path('b.txt'),
    finalRepresentation: representation('b'), commitPathspecs: [path('b.txt')],
  })[0];
  const manifest: ReviewedSemanticManifest = {
    manifestVersion: 1, candidateContractVersion: 7,
    repositoryKey: 'repo', objectDatabaseKey: 'odb', gitObjectFormat: 'sha1',
    finalizations: [],
    members: [
      { finalPathBytesBase64: path('b.txt'), expectedState: 'present', ...representation('b'),
        coveringFinalizationIds: ['fin-b'], commitEffects: [effectB] },
      { finalPathBytesBase64: path('a.txt'), expectedState: 'present', ...representation('a'),
        coveringFinalizationIds: ['fin-a'], commitEffects: [effectA] },
    ],
    attributionTopology: {
      componentPathSets: [[path('b.txt')], [path('a.txt')]], contributors: [],
      ownershipGroupKeys: ['z', 'a'], componentEdges: [],
      selectedUnattributedPathBytesBase64: [path('b.txt'), path('a.txt')],
    },
    closureObligations: [], challengeVersion: 1, challengeAtoms: [],
  };
  const reversed: ReviewedSemanticManifest = {
    ...manifest,
    members: [...manifest.members].reverse(),
    attributionTopology: {
      ...manifest.attributionTopology,
      componentPathSets: [...manifest.attributionTopology.componentPathSets].reverse(),
      ownershipGroupKeys: [...manifest.attributionTopology.ownershipGroupKeys].reverse(),
      selectedUnattributedPathBytesBase64:
        [...manifest.attributionTopology.selectedUnattributedPathBytesBase64].reverse(),
    },
  };

  assert.equal(canonicalizeReviewedSemanticManifest(manifest), canonicalizeReviewedSemanticManifest(reversed));
});

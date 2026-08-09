import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import { ComposeLockRegistry } from '../commit-candidates/compose-lock-registry';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import type { CandidateMember, CommitCandidate, RepositoryIdentity } from '../../shared/commit-candidates';
import { CheckpointQueue } from './checkpoint-queue';
import { CommitCoordinator, type CoordinatorTokenStore } from './commit-coordinator';
import { runGit, runGitBytes } from './git-command';
import { resolveInternalGit } from '../git/git-runtime';

class Tokens implements CoordinatorTokenStore {
  private state: 'issued' | 'consuming' | 'consumed' = 'issued';
  constructor(private readonly snapshot: CandidateTokenSnapshot) {}
  resolve(): CandidateTokenSnapshot | null { return this.state === 'issued' ? this.snapshot : null; }
  tryConsume(): CandidateTokenSnapshot | null {
    if (this.state !== 'issued') return null;
    this.state = 'consuming';
    return this.snapshot;
  }
  markConsumed(): boolean { this.state = 'consumed'; return true; }
}

async function main(): Promise<void> {
  const internal = await resolveInternalGit();
  if (!internal?.execPath) {
    console.log('commit-coordinator validation production: skipped (no internal git)');
    return;
  }
  const gitExe = internal.execPath;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-coordinator-validation-production-'));
  const git = (args: string[]): string => execFileSync(gitExe, args, { cwd: repo, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Production Seam Test']);
    git(['config', 'user.email', 'production-seam@lares.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'main.cjs'), "const dep = require('./dependent.cjs'); if (dep !== 1) throw new Error('mismatch');\n");
    fs.writeFileSync(path.join(repo, 'dependent.cjs'), 'module.exports = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    const head = git(['rev-parse', 'HEAD']).trim();

    fs.writeFileSync(path.join(repo, 'main.cjs'), "const dep = require('./dependent.cjs'); if (dep !== 2) throw new Error('mismatch');\n");
    fs.writeFileSync(path.join(repo, 'dependent.cjs'), 'module.exports = 2;\n');
    git(['config', 'lares.candidateValidation.enabled', 'true']);
    git(['config', '--add', 'lares.candidateValidation.command', 'node main.cjs']);

    const makeSnapshot = (paths: string[], tokenId: string): CandidateTokenSnapshot => {
      const members: CandidateMember[] = paths.map((relative, index) => {
        const oid = git(['hash-object', '-w', '--path', relative, '--', relative]).trim();
        return {
          entryId: `entry-${index}`,
          path: encodeGitPath(Buffer.from(relative)),
          expectedWorktreeState: 'present',
          rawWorktreeBlobOid: oid,
          expectedCommitBlobOid: oid,
          expectedCommitMode: '100644',
          checkpointMode: '100644',
          coveringFinalizationIds: [],
          packageVerification: 'verified-match',
          protection: 'checkpoint-protected',
        };
      });
      const repository: RepositoryIdentity = {
        repositoryKey: 'r'.repeat(64),
        objectDatabaseKey: `odb:${repo}`,
        gitObjectFormat: 'sha1',
        bareRepo: false,
        workspaces: [{ workspaceId: 'ws', workspacePrefix: '' }],
      };
      const candidate: CommitCandidate = {
        candidateId: `candidate-${tokenId}`,
        contractVersion: 2,
        repository,
        componentIds: [],
        selectedUnattributedEntryIds: [],
        members,
        finalizations: [],
        eligibility: { eligible: true },
        token: { tokenId, candidateId: `candidate-${tokenId}`, contractVersion: 2, issuedAt: 1, expiresAt: 2 },
        saveIntentIds: [],
        selectedNamedSaveSetIds: [],
        attributionResolutions: [],
      };
      return {
        token: candidate.token!, candidate, repositoryKey: repository.repositoryKey,
        normalizedRequest: { selectedIntentIds: [], selectedNamedSaveSetIds: [], resolutionIds: [], finalizationIds: [], acknowledgeUnattributedEntryIds: [] },
        componentTopologyDigest: 'topology', pinnedHeadOid: head, indexFingerprint: 'index', indexWriteTreeOid: null,
        commitEffects: members.map((member) => ({
          pathBytesBase64: member.path.pathBytesBase64, operation: 'write', expectedState: 'present',
          rawBlobOid: member.rawWorktreeBlobOid, commitBlobOid: member.expectedCommitBlobOid, commitMode: member.expectedCommitMode,
        })),
        finalizationManifests: [], associations: [],
      };
    };

    const commit = async (paths: string[], tokenId: string) => {
      const snapshot = makeSnapshot(paths, tokenId);
      const expected = new Map(snapshot.candidate.members.map((member) => [member.entryId, member]));
      const coordinator = new CommitCoordinator({
        composeLocks: new ComposeLockRegistry(), queue: new CheckpointQueue(), tokens: new Tokens(snapshot),
        attempts: { insertPending: () => undefined, resolve: () => undefined },
        runGit: (cwd, args, opts) => runGit(cwd, args, { ...opts, gitExe }),
        runGitBytes: (cwd, args, opts) => runGitBytes(cwd, args, { ...opts, gitExe }),
        reassemble: async () => ({
          candidateId: snapshot.candidate.candidateId, componentTopologyDigest: snapshot.componentTopologyDigest,
          eligible: true, ineligibleReason: null, pinnedHeadOid: head,
          members: snapshot.candidate.members.map((member) => ({
            entryId: member.entryId, path: member.path, commitPathspecs: [member.path],
            expectedWorktreeState: member.expectedWorktreeState, rawWorktreeBlobOid: member.rawWorktreeBlobOid,
          })),
        }),
        readMemberRepresentation: async ({ member }) => {
          const frozen = expected.get(member.entryId)!;
          return { expectedState: frozen.expectedWorktreeState, rawBlobOid: frozen.rawWorktreeBlobOid,
            commitBlobOid: frozen.expectedCommitBlobOid, commitMode: frozen.expectedCommitMode };
        },
        locateRepository: () => ({ repoRoot: repo, gitExe }),
        writeIntentLedger: () => undefined,
      });
      return coordinator.commit({ tokenId, message: 'candidate validation production seam' });
    };

    const refused = await commit(['main.cjs'], 'token-incomplete');
    assert.equal(refused.kind, 'outcome');
    assert.equal(refused.kind === 'outcome' ? refused.outcome.status : null, 'aborted-error');
    assert.match(refused.kind === 'outcome' && 'reason' in refused.outcome ? refused.outcome.reason : '', /candidate-tree validation refused/);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), head, 'validation refusal occurs before the HEAD CAS');

    const accepted = await commit(['main.cjs', 'dependent.cjs'], 'token-complete');
    assert.equal(accepted.kind, 'outcome');
    assert.equal(accepted.kind === 'outcome' ? accepted.outcome.status : null, 'committed');
    assert.notEqual(git(['rev-parse', 'HEAD']).trim(), head);
    console.log('ok - production-default coordinator validates the exact tree before CAS');
    console.log('\ncommit-coordinator validation production: 1 passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

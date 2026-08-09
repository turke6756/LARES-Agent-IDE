/**
 * Reviewed verification targets for production-reachability proofs.
 *
 * Plan prose selects only a key in this registry. It cannot supply a command,
 * executable, argument, test path, or protected path.
 */
export type ReachabilityRunner = 'node-test' | 'vitest';

export interface ReachabilityVerificationTarget {
  runner: ReachabilityRunner;
  file: string;
  test_name: string;
  protected_test_paths: readonly string[];
}

export interface ReachabilityTargetRegistry {
  version: string;
  targets: Readonly<Record<string, ReachabilityVerificationTarget>>;
}

/** Bump this version whenever a target, adapter, or protected-path set changes. */
export const REACHABILITY_TARGET_REGISTRY: ReachabilityTargetRegistry = Object.freeze({
  version: '1',
  targets: Object.freeze({
    'wp-b3-real-ipc-registration': Object.freeze({
      runner: 'node-test' as const,
      file: 'src/main/plans/reachability-prover.test.ts',
      test_name: 'registerIpcHandlers registers the prove_reachability production channel',
      protected_test_paths: Object.freeze([
        'src/main/plans/reachability-prover.test.ts',
      ]),
    }),
  }),
});

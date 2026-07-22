// optimizer-config.ts — shared tunables for the WP5 context-optimizer core.
//
// Centralised so the classifier, epoch diff, attribution and drift passes all read
// ONE source of truth (design §5.2 floors + hardening-epochs-outcomes §2.5/§3.3).
// Values are the spec defaults; a later settings surface may override at runtime.

export const OPTIMIZER_CONFIG = {
  // ── Exposure floors (design §5.2, §3.3) — a section may only be called `never`
  //    once it has accrued at least this much in-epoch exposure. "Young" ≡ few
  //    exposure turns measured IN-WINDOW, never a wall-clock age (Bug-2).
  MIN_EXPOSURE_TURNS: 20,
  MIN_STREAMS: 2,

  // ── WP-E per-lane subtract sample gate (P4). A BEHAVIORAL subtract (occurrence-
  //    derived `never`) needs a minimum cross-session attributed sample before it is
  //    actionable; below it the subtract is withheld and surfaced as a
  //    `coverage-insufficient` diagnostic, never an actionable proposal (researcher,
  //    n≈1). Conservative pre-C signal = the proposal's `exposure.streams`; upgrades to
  //    the four-tier attribution coverage when WP-C lands. Grant-mismatch is
  //    verified-by-construction and NEEDS no sample, so it is exempt.
  SUBTRACT_MIN_SAMPLE_STREAMS: 2,

  // ── Improvisation-cluster floors (design §5.2/§5.3) — a repeated behaviour is only
  //    an ADD candidate when it recurs at least REPEAT_MIN times across at least
  //    REPEAT_MIN_STREAMS distinct streams (cross-session — one agent's tic doesn't
  //    qualify). Conservative defaults; tune during Phase E.
  REPEAT_MIN: 3,
  REPEAT_MIN_STREAMS: 2,

  // ── §2.5 diff — fuzzy lineage tier (2d). OFF by default so the day-one ledger is
  //    fully deterministic (master A2c defers similarity-merge). Enable once tuned.
  ENABLE_FUZZY_LINEAGE: false,
  SIM_HEADING: 0.8,   // heading-path similarity threshold
  SIM_BODY: 0.72,     // body-token Jaccard threshold

  // ── §5 reconciliation window (A4/WP6 consumes; defined here for shared reference).
  APPLY_RECONCILE_WINDOW_MS: 24 * 60 * 60 * 1000,

  // ── A1 file-coverage / skill-bypass (hardening-classifier-agent-surface §1/§2).
  //    Bypass min-support thresholds (G7 flood-guard). The known read-comments case
  //    (24 exec streams / 5 skill streams) clears these with headroom.
  BYPASS_MIN_EXECUTIONS: 5,
  BYPASS_MIN_EXEC_STREAMS: 5,
  BYPASS_MIN_STREAM_DELTA_OVER_SKILL: 3,          // execStreams >= skillStreams + 3
  BYPASS_MIN_RATIO_WITH_SKILL_CALLS: 2.0,         // when skillStreams > 0
  BYPASS_MIN_EXEC_STREAMS_WHEN_ZERO_SKILL_CALLS: 8,
  // File-heat rollup: default top-N per lane (§2.3).
  FILE_HEAT_TOP_N: 20,

  // ── A9 phrase-gap determinism (hardening-classifier-agent-surface §1/§3).
  //    Trigger-phrase gap/lift evidence: terms over-represented in a skill's BYPASS
  //    corpus vs its INVOCATION corpus. All scoring is integer basis-points (no float
  //    compare → byte-identical output). Min-support floors below the gate a section
  //    (docs floors) and each term (df/streams/gap/lift floors). Phase-E-tunable.
  PHRASE_GAP_MIN_INVOCATION_SNIPPETS: 3,   // section gate: min INVOCATION docs
  PHRASE_GAP_MIN_BYPASS_SNIPPETS: 5,       // section gate: min BYPASS docs
  PHRASE_GAP_MIN_BYPASS_DF: 2,             // term gate: min distinct-hash bypass df
  PHRASE_GAP_MIN_BYPASS_STREAMS: 2,        // term gate: min distinct bypass streams (cross-session)
  PHRASE_GAP_MIN_GAP_BPS: 1500,            // term gate: min gap (15 percentage points)
  PHRASE_GAP_MIN_LIFT_BPS: 15000,          // term gate: min lift (1.5x)
  PHRASE_GAP_MAX_TERMS: 10,                // cap on surfaced terms per (lane,skill,script)

  // ── §4 compiler-parity gate (hardening-classifier-agent-surface §1/§4).
  //    Flagship counts (orchestration histogram + persona occurs/never split) must
  //    match the frozen empirical reference EXACTLY — any nonzero delta re-opens the
  //    gate (`derivationVerified → stale`). Phase-E-tunable if a deliberate,
  //    enumerated-in-`notes` drift is later accepted.
  PARITY_DRIFT_TOLERANCE: 0,

  // ── §7.3/§7.4 proposal ranking + A8 cost normalization (WP6b engine) ──────────
  //    Primary rank is `tokenTurnsWeight = residentTokens × exposureTurns` WITHIN a
  //    confidence tier — tiers are HARD groups, never blended (a high-token guess
  //    never outranks a low-token certainty). The scalars below only reorder WITHIN
  //    a tier; they can never move a proposal across a tier boundary.
  //
  //    Low-confidence epoch birthdays down-rank within their tier (epochConfidence
  //    surfaced by the classifier for exactly this): the effective ranking weight is
  //    multiplied by this factor when `epochConfidence==='low'`.
  EPOCH_LOW_CONFIDENCE_WEIGHT_FACTOR: 0.5,
  //    Intra-tier mutability penalty (P4.2 safety, §7.4): editing a scaffold constant
  //    is the clean routed edit (0); a source-constant/vendor edit is a step removed
  //    (1); a user-owned file is "consider only" → sinks last (2). Tie-break only.
  MUTABILITY_RANK_PENALTY: { 'scaffold-managed': 0, 'generated-vendor': 1, 'user-owned': 2 },
  //    All surfaced rates are per-100-turns, never raw counts (A4/A8 rule).
  RATE_NORMALIZATION_TURNS: 100,
  //    A section only qualifies as `relocate-to-progressive-disclosure` (a long,
  //    occasionally-useful section worth moving to a skill body) above this size.
  RELOCATE_MIN_SECTION_TOKENS: 400,

  // ── R2 WP-3 (Priority 1) skill-advertisement subtract gating ───────────────────
  //    A `subtract-unused-skill-advertisement` requires that the lane demonstrably
  //    surfaces skill usage AT ALL (usageCoveragePct = share of lane streams with any
  //    captured skill invocation). Below this floor the absence of a specific skill's
  //    invocations is as likely capture/provider-specific as genuine disuse, so the
  //    row is WITHHELD (spec risk: indirect/provider-specific invocation). Because
  //    advertisement epochs are not derivable, every surfaced row is UNVERIFIED
  //    (candidate) regardless — the floor only stops fabricating on empty capture.
  SKILL_ADVERTISEMENT_MIN_COVERAGE_PCT: 20,
  //    Don't spend a proposal row on a trivially-small header. Below this the reclaim
  //    is noise vs. the review cost.
  SKILL_ADVERTISEMENT_MIN_HEADER_TOKENS: 30,

  // ── A4 proposal-outcome tracking (hardening-epochs-outcomes §4.3–§4.5, WP6) ─────
  //    `before`/`after` recompute is OUTCOME REPORTING ONLY — never the `never`
  //    death denominator (Bug-3). `before` is bounded + recency-matched; a long-run
  //    average is unsound for change detection, and per-100-turns normalization
  //    (RATE_NORMALIZATION_TURNS above) handles length imbalance. Days here because
  //    the caller resolves the actual ms window; spec default = ANALYSIS_WINDOW_DAYS
  //    (the view/staleness filter), reused here purely as a bounded reporting window.
  OUTCOME_WINDOW_DAYS: 30,
  //    Regret is NON-VACUOUS (§4.5): a SUBTRACT only regrets when the removed section
  //    was `never` (before≈0) AND the after-rate crosses REGRET_RATE_PER_100 with
  //    cross-session support — one agent's tic never triggers a revert. The earlier
  //    `afterRate ≥ beforeRate·0.75` clause is vacuous when before≈0 and is dropped.
  REGRET_RATE_PER_100: 0.5,            // after-rate (per-100-turns) that counts as regret
  REGRET_MIN_AFTER_TURNS: 20,          // = MIN_EXPOSURE_TURNS; below it → no verdict
  REGRET_MIN_OCCURRENCES: 3,           // cross-session guard on the regret EVENT
  REGRET_MIN_STREAMS: 2,               // ≥2 distinct streams (one tic ≠ a revert)
  //    ADD rework ⇔ after cluster-rate ≥ before · this (cluster didn't shrink).
  ADD_REWORK_SHRINK_FLOOR: 0.8,
  //    TUNE success ⇔ bypass-exec rate down ≥ this OR skill-invocation rate up ≥ this.
  TUNE_SUCCESS_DELTA: 0.5,

  // ── WP-1A fail-closed `never` evidence (Priority-0 auditable subtracts) ─────────
  //    A `never` verdict must carry a same-generation, reproducible evidence object
  //    (the matcher that ran, the queried epoch/window, capped denominator EXPOSURE
  //    samples, numerator occurrence samples, and per-provider capture coverage).
  //    Samples are HARD-capped so the audit payload stays identifiers-only and small.
  EVIDENCE_SAMPLE_STREAMS_CAP: 10,   // denominator exposure-sample streams cap
  EVIDENCE_SAMPLE_EVENTS_CAP: 10,    // numerator occurrence-sample events cap
  //    Declared fail-closed threshold: if the fraction of unresolved-path events in
  //    the denominator window meets/exceeds this, a file-access provisional-`never`
  //    downgrades to `capture-incomplete` (we cannot honestly say the path never
  //    occurred when path capture itself was lossy).
  NEVER_MAX_UNRESOLVED_PATH_RATE: 0.10,

  // ── R2 WP-4B (Phase 4) improve-lever consolidation ─────────────────────────────
  //    Step 1 — a `granted-but-undocumented` drift finding is only worth a real
  //    `add-missing-guidance` proposal when a BEHAVIORAL need signal crosses a floor;
  //    otherwise it demotes to a single `config-completeness` lane card (never adds
  //    resident tokens merely for grant↔doc symmetry). Each predicate is independent —
  //    any one crossing its floor triggers a real ADD.
  BEHAVIORAL_NEED_MIN_DISCOVERABILITY_FAILURES: 2,  // repeated tool use w/ discoverability failures
  BEHAVIORAL_NEED_MIN_SHELL_IMPROVISATIONS: 3,      // repeated equivalent shell improvisation
  BEHAVIORAL_NEED_MIN_FAILED_OR_UNKNOWN_CALLS: 2,   // failed / unknown tool calls
  BEHAVIORAL_NEED_MIN_NAVIGATION_COST_TOKENS: 200,  // measured navigation cost (tokens)
  //    Step 2 — cap on opaque member refs / top-K member summaries carried on a
  //    hash-only cluster rollup (keeps the rollup payload identifiers-only + small).
  ROLLUP_MEMBER_REFS_CAP: 20,
  ROLLUP_TOP_MEMBERS_K: 5,
  //    Step 3 — exemplar drill page + per-exemplar caps (redaction-safe, identifiers-
  //    only). A page never returns more than DEFAULT/MAX exemplars; each exemplar caps
  //    its input-key set, search terms, and event references.
  CLUSTER_EXEMPLARS_DEFAULT_LIMIT: 20,
  CLUSTER_EXEMPLARS_MAX_LIMIT: 50,
  CLUSTER_EXEMPLAR_INPUT_KEYS_CAP: 12,
  CLUSTER_EXEMPLAR_SEARCH_TERMS_CAP: 12,
  CLUSTER_EXEMPLAR_EVENT_REFS_CAP: 5,

  // ── WP3 (G3) hot-uncovered candidate + recommendation drafts ───────────────────
  //    A hot UNCOVERED workflow file (explicit role allowlist, file-coverage.ts) only
  //    becomes an ADD candidate at/above this canonical heat score
  //    (`canonicalHeatScore` = executes×3 + writes×2 + reads). Disclosed threshold —
  //    surfaced in the candidate's coverageChecks disclosure, never a silent filter.
  HOT_UNCOVERED_MIN_SCORE: 10,
  //    Bounded predicate-ref sample on `coverageChecks` (truncation metadata is
  //    always attached; the FULL predicate list is never exported).
  COVERAGE_CHECKS_SAMPLE_LIMIT: 10,
} as const;

/** Script file extensions that make a file under a skill root a bypass-candidate
 *  "owned script" (§2.1). Everything else under the root is a heat-only resource. */
export const SKILL_SCRIPT_EXTS = [
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.sh', '.bash', '.zsh',
  '.ps1', '.rb', '.php', '.r', '.pl', '.cmd', '.bat',
] as const;

/** Basename stoplist: a script whose basename (sans ext) is one of these is too
 *  generic to attribute by basename alone → basename matches to these are NOT
 *  skill-owned (§2.2 rule 3 / G6). */
export const GENERIC_SCRIPT_NAMES = [
  'run', 'main', 'index', 'test', 'build', 'setup', '__init__', 'app',
] as const;

/** Default retroactive ignore globs (§1 `SYSTEM_FILE_COVERAGE_IGNORES`). Seeds the
 *  `file_coverage_ignores` table on first run (WP6 writer) and is also used inline
 *  by `scriptGlobs()` to exclude vendored/build noise from skill-script enumeration.
 *  `pattern_kind='glob'`, `scope='global'`. */
export const SYSTEM_FILE_COVERAGE_IGNORES = [
  '**/node_modules/**', '**/.git/**', '**/.next/**', '**/.turbo/**', '**/.cache/**',
  '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', '**/vendor/**',
  '**/.venv/**', '**/site-packages/**', '**/*.bak.*', '**/*.map', '**/*-lock.json',
  '**/{package-lock,pnpm-lock,yarn}.lock', '**/*.min.*',
  '**/appdata/local/temp/claude/**',              // scratchpad temp root (normalized lower)
] as const;

/** A9 phrase-gap stopwords (§1/§3.2 step 4): a vendored, reviewed ~80-word English
 *  function-word list. A token in this set is dropped before df/gap scoring. Kept
 *  inline + deterministic (no external corpus, no network) so the same snippets in
 *  always yield byte-identical terms out. No stemming / synonym expansion anywhere. */
export const PHRASE_GAP_STOPWORDS: readonly string[] = [
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'once', 'here',
  'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 'can', 'will', 'just', 'should', 'now', 'this', 'that', 'these',
  'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'of', 'as', 'it', 'its', 'you', 'your',
  'i', 'me', 'my', 'we', 'our', 'they', 'them', 'their', 'he', 'she',
] as const;

/** A9 short-token allowlist (§1/§3.2 step 4): tokens of length < 3 are normally
 *  dropped as noise, EXCEPT these domain abbreviations, which carry signal. */
export const PHRASE_GAP_SHORT_TOKEN_ALLOW: readonly string[] = [
  'ci', 'ui', 'db', 'pr', 'wp',
] as const;

/** Parser version stamped on every epoch row. Bump when the sectioning / hashing /
 *  anchor-derivation logic changes in a way that would alter identity — a bump
 *  invalidates the parity gate (classifier addendum §4) and re-opens backfill. */
export const RESIDENT_PARSER_VERSION = 1;

/** Compiler version stamped on every parity artifact + sign-off (classifier addendum
 *  §1/§4). Bump when `guidance-action-model.ts` (the §5.1 compiler) or
 *  `occurrence-classifier.ts` (the §5.2 classification) changes in a way that would
 *  alter a `PredictedAction`'s identity/predicate or its occurs/never classification.
 *  A bump is a fingerprint mismatch → any signed parity gate goes `stale` and must be
 *  re-signed (compiler-parity-gate.ts §4.4). Independent of `RESIDENT_PARSER_VERSION`,
 *  which tracks the sectioning/hashing layer. */
export const PREDICTED_ACTION_COMPILER_VERSION = 1;

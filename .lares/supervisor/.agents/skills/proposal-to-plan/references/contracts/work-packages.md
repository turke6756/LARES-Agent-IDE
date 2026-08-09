# Contract reference — PLAN-WORK-PACKAGES:v2

The responsible supervisor writes exactly one regular, non-symlink Markdown file under
`supplements/` with frontmatter `kind: work-packages` and the plan's exact
`plan_artifact_id`. The existing prose remains in the bundle-contract shape: every package has
`Files`, `Dep`, `Do`, `Accept`, `Non-goals`, `Verify`, and `Entry` sections, and opens
with exactly one:

`**Outcome:** <one plain sentence: what the user can newly see or do when this package lands; for a
non-visible prerequisite, what user-facing capability or safety it unlocks and why it must land
first. No file paths or identifiers.>`

The complete Outcome line must be at most 200 characters. Re-read `Do`, `Accept`, and
`Non-goals`: the Outcome must promise no behavior outside them, and at least one acceptance
condition must observably prove it.

The prose `Entry` section mirrors the machine reachability contract. For `behavior`, list every
production entry seam, every resource production constructs, the entering test for each obligation,
and each mutation reference. Otherwise write `Entry: none — <reviewed one-line rationale>`.

Immediately before the prose package sections, emit exactly one hidden machine block:

```markdown
<!--PLAN-WORK-PACKAGES:v2
{
  "schema_version": 2,
  "plan_artifact_id": "plan_e0001372",
  "packages": [
    {
      "id": "WP-1",
      "order": 10,
      "title": "WP schema and parser",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Invalid input leaves package, layout, path, assignment, and lifecycle rows unchanged."
      ],
      "paths": [
        { "path": "src/main/plans/plan-work-package-ingest.ts", "intent_kind": "edit" },
        { "path": "reachability-mutations/ingest-entry.patch", "intent_kind": "create" }
      ],
      "depends_on": [],
      "reachability": {
        "kind": "behavior",
        "entry_seam_links": [
          {
            "seam_kind": "route",
            "path": "src/main/plans/plan-work-package-ingest.ts",
            "symbol": "parsePlanWorkPackageDocument",
            "entering_test": "src/main/plans/plan-work-package-ingest.test.ts",
            "mutation": "reachability-mutations/ingest-entry.patch",
            "verification": {
              "target": "plan-work-package-ingest-entry",
              "expect_failure": "REACHABILITY:plan-work-package-ingest"
            }
          }
        ],
        "production_constructs": []
      }
    }
  ]
}
-->
```

For a package with no independently reachable behavior, use only:

```json
"reachability": {
  "kind": "none",
  "rationale": "Internal documentation-only change; adds or changes no independently reachable behavior."
}
```

## Validation

- Bound both file and block to 1 MiB. Parse strict JSON: comments, trailing commas, duplicate keys,
  unknown top-level/package/reachability keys, and strings containing `-->` are invalid.
- `schema_version` and the block sentinel are both `2`; block, frontmatter, and `plan.json`
  artifact IDs match exactly; `packages` is non-empty. v1 remains parseable as a legacy shape and
  does not carry reachability, but new authoring uses v2.
- IDs match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and are unique case-insensitively. Derive DB IDs as
  `wp:<plan_artifact_id>:<lowercase logical id>`; retain authored casing for display.
- `order` is a unique non-negative integer. Gaps are allowed; display order is
  `(order, lowercase id)`. Titles are trimmed, non-empty, and at most 300 characters.
- `initial_state` is exactly `ready` or `blocked`. Disk cannot declare runtime lifecycle,
  assignment, revision, or completion state.
- `acceptance_conditions` is a non-empty array of non-empty strings, stored joined by `\n` in
  authored order.
- `paths` may be empty. Each entry has `path` and optional `intent_kind` in
  `create | edit | delete | verify`. Paths are normalized workspace-relative POSIX paths; reject
  absolute, drive, UNC, backslash, empty/`.`, NUL, and outward-traversal paths.
- `depends_on` references projected logical IDs only. Reject missing/self references, cycles, or a
  dependency whose `order` is not lower than its dependent.
- Every v2 package has exactly one `reachability` object. `kind: none` permits only a trimmed,
  non-empty `rationale` of at most 300 characters. The rationale is author-asserted and reviewed;
  ingest cannot prove that a package has no behavior.
- `kind: behavior` permits only `entry_seam_links` and `production_constructs` besides `kind`.
  `entry_seam_links` is non-empty; `production_constructs` is required and may be empty.
- Each entry-seam link has exactly `seam_kind`, `path`, `symbol`, `entering_test`, `mutation`,
  and `verification`. `seam_kind` is `ipc | preload | route | ui-caller | job | other`.
- Each production construct has exactly `name`, `producer_path`, `producer_symbol`,
  `consumer_path`, `entering_test`, `mutation`, and `verification`.
- Reachability paths use the same normalized-plan-path rules. Symbols, names, rationale, and
  `verification.target` / `verification.expect_failure` are trimmed, non-empty strings of at most
  300 characters. The full block also rejects `-->` in every nested string.
- Package content digests use canonical JSON over ID, title, initial state, acceptance conditions,
  normalized paths, dependencies, and normalized reachability, excluding `order`. The projection
  digest includes ordered package records and `order`.
- Require exactly one matching prose `## <id> - <title>` or `## <id> — <title>` heading for each
  projected package and no extra prose WP headings. ARC duplicate/unknown-ID checks are advisory.

Ingest distinguishes a legitimate legacy omission (no Outcome label) from a malformed Outcome, but
it cannot tell a legitimate legacy omission from a new-authoring omission. New-authoring compliance
is enforced by the semantic self-check and review gate.

This block is additive machine metadata. It does not replace bundle prose, the ARC ledger,
PLAN-INTENT/PLAN-INTEGRATION sentinels, or the rung ladder. A prose-only legacy supplement is
invalid until its responsible supervisor adds a reviewed machine block.

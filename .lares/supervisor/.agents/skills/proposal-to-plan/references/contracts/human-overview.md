# Contract reference — PLAN-TAB-OVERVIEWS:v1

`OVERVIEW.md` lives beside `ARC.md` and is the human-register source for structured-plan tab
summaries. During `package`, the responsible supervisor authors this file; the app then parses and
projects it. Application code does not auto-synthesize `OVERVIEW.md`, and its prose is not rewritten
on lifecycle transitions. It begins with exact frontmatter identity:

```markdown
---
plan_artifact_id: plan_e0001372
kind: human-overview
schema_version: 1
---

# Plan overview

<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_e0001372",
  "sections": [
    { "tab": "overview", "heading": "What this plan changes" },
    { "tab": "proposal", "heading": "Why this work exists" },
    { "tab": "plan", "heading": "How the work will proceed" },
    { "tab": "deliberations", "heading": "Important decisions" },
    { "tab": "supplements", "heading": "Supporting material" },
    { "tab": "packages", "heading": "Work packages" }
  ]
}
-->

<!--PLAN-TAB-SECTION:overview:BEGIN-->
## What this plan changes

Human-readable summary text.
<!--PLAN-TAB-SECTION:overview:END-->
```

The index binds stable tab keys to explicitly delimited sections. The first nonblank line after a
begin delimiter is the indexed `## <heading>`; the body continues to its matching end delimiter.
Unmapped prose is permitted, ignored by projection, and preserved by structured edits.

## Validation

- File size is at most 1 MiB. Frontmatter uses the bounded scalar subset, has one leading fence,
  unique keys, and exact `plan_artifact_id`, `kind: human-overview`, and `schema_version: 1` values.
- Require exactly one v1 index outside fenced code and exactly one begin/end pair for every indexed
  tab. Reject unindexed delimiters, duplicate/unknown tabs, duplicate headings, crossed/nested
  delimiters, missing headings, and empty bodies.
- Parse the index as strict JSON. Reject comments, trailing commas, duplicate/unknown keys, and any
  string containing `-->`.
- Delimiter-like text in fenced code is prose. CRLF and LF parse identically; a mapped EOF section
  is valid with or without a final newline. Raw bytes are not normalized for source observation.

## Package-time inventory

Derive tabs from bounded, contained disk evidence, never SQLite: Overview and Plan always; Proposal
when the manifest source resolves to a contained regular non-symlink file; Deliberations, Research,
and Supplements when their directories contain a regular non-symlink output other than
`.gitkeep`; Packages always during `package`; never infer Legacy HTML.

The `deliberations` body is 3-6 plain-language bullets stating what was decided and why. It is a
decision readout, not a transcript.

The `packages` body is a package-time structural readout only: package count, dependency/start
sequence, and a pointer to the live package board. Do not copy runtime lifecycle state
(ready/executing/done) or per-package Outcome text into it; the live board owns current progress and
outcomes. Example: "Eight packages; three can start independently, then five land in dependency
order. See the package board for live progress and outcomes."

Any later change to package count, ordering, or dependencies requires refreshing the Packages
overview before dispatch readiness.

When editing a valid file, preserve unrelated sections and unmapped prose byte-for-byte. Replace
only the selected body; insert/remove the index entry and complete delimited section together;
retain newline style and final-newline presence. Canonical index rewrites use two-space JSON,
top-level order `schema_version`, `plan_artifact_id`, `sections`, canonical tab order, and entry
order `tab`, `heading`.

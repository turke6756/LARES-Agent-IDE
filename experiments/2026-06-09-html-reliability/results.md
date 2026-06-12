# Experiment 14.1 — Agent HTML-generation reliability benchmark

**Date:** 2026-06-09
**Spec:** `docs/INTERACTIVE_PLAN_SURFACE_PROPOSAL.md` §14.1
**Gates:** GroupThink output-format lock, substrate synthesis (Q1), compilation flavor (Q4), validation strictness (§12.8).

## Verdict

**87/90 documents pass all applicable checks (96.7%). Every provider clears the
spec's ≥90% band: the GroupThink HTML lock holds; HTML-canonical stands.**
Zero failures on the structural checks the experiment was most worried about
(unique IDs, zone scaffold) across all 90 documents.

## Method (as run)

- **Brief:** `brief.md` — feature-flag system, three phases (schema, evaluation
  engine, admin UI), per the spec's candidate brief. Fixed across all runs.
- **Variants:**
  - **A** (`prompt-a.md`) — brief + §4 schema described in prose only.
  - **B** (`prompt-b.md`) — same prose schema + the §4.1 worked example
    (extracted verbatim from the proposal doc).
  - **edit** (`prompt-edit.md`) — check-6 sub-test: a fixed valid host document
    (`host.html`) plus an instruction to splice a given recommendation
    `<article>` into phase p1's `recommendations` zone and reproduce the rest
    of the document unchanged.
- **Providers** (headless CLIs actually present on this machine; see
  `provider-versions.txt`):

  | provider | CLI invocation | model |
  |---|---|---|
  | claude | claude 2.1.170, `claude -p --model sonnet` | Sonnet 4.6 (alias `sonnet`) |
  | codex | codex-cli 0.136.0, `codex exec --skip-git-repo-check -o <out> -` | gpt-5.5, reasoning effort high (CLI default) |
  | gemini | gemini 0.45.2, `gemini -p "<prompt>"` | CLI default (gemini-2.5-pro line), oauth-personal |

- **Replicates:** N = 10 per provider per variant (a, b, edit) → 90 documents.
- **Execution:** each run in a fresh temp cwd (no repo context, no CLAUDE.md
  pickup), parallelism 4 per provider, all three providers concurrent
  (`run-provider.sh`). Timeout 600 s (raised to 900 s for claude retries — see
  deviations).
- **Scoring:** `score.js` (cheerio + parse5). Checks 1–5 for generation runs;
  checks 1–6 for edit runs (check 6 = spliced fragment landed inside
  p1/recommendations AND all untargeted host content preserved). Pass = all
  applicable checks. Harness self-tested against synthetic good/bad documents
  (duplicate IDs, renamed zones, wrong-zone splice) before any provider run.

## Aggregate results

| provider | variant A | variant B | edit (check 6) | provider total |
|---|---|---|---|---|
| claude (Sonnet 4.6) | 8/10 | 10/10 | 10/10 | 28/30 (93.3%) |
| codex (gpt-5.5) | 10/10 | 10/10 | 10/10 | **30/30 (100%)** |
| gemini (2.5-pro) | 10/10 | 10/10 | 9/10 | 29/30 (96.7%) |
| **all** | 28/30 | **30/30** | 29/30 | **87/90 (96.7%)** |

## Failure distribution (per check, across all 90 documents)

| check | failures | notes |
|---|---|---|
| 1 parses | 2 | both = claude stdout truncation (below) |
| 2 required attrs | 2 | same two documents — downstream of truncation |
| 3 unique IDs | **0** | |
| 4 zone scaffold | **0** | |
| 5 well-formed free-form HTML | 1 | same truncated doc (orphaned tasks after the missing head) |
| 6 edit targeting | 1 | gemini dropped an empty host zone |

Three failing documents, two root causes:

1. **`claude/a/7`, `claude/a/8` — head-truncated stdout (delivery artifact,
   not an HTML-competence failure).** Both files begin mid-sentence inside a
   `<p>` and end with a perfectly clean `</html>`; the head of the document
   never reached the output file. Every intact claude variant-A document is
   52–65 KB — the largest outputs in the experiment by 3–4× — and all eight
   intact ones pass cleanly. All ten variant-B documents (38–47 KB, anchored
   smaller by the worked example) are intact. The truncation is a
   `claude -p`-stdout-capture artifact on very large single responses, which
   the production dispatch loop (§6: workers edit the plan file directly)
   does not exercise. Counted as failures anyway; raw outputs untouched.
   Strictly-counted HTML-competence failures are therefore 1/90 — 88
   intact deliveries, 87 passes (98.9%).
2. **`gemini/edit/6` — preservation violation.** The splice itself landed in
   the right zone, but the model silently dropped the host's empty
   `assumptions` zone while reproducing the document. Exactly the failure mode
   check 6 exists to catch; 1/30 edit runs across providers.

Zero documents required fence/prose normalization (`normalized: false` for all
90): every provider emitted a bare HTML document with no markdown wrapper. The
only parse5 error code observed anywhere was `missing-doctype` on the two
truncated documents. No duplicate IDs, no missing zones, no tag-balance
errors, no content leaking past section boundaries — in any document from any
provider.

## A→B delta

A = 28/30, B = 30/30. The delta is small and not structural: both A failures
are the truncation artifact above. **Agents understand the format from the
prose description alone** — the worked example's measurable benefit was
anchoring output length (claude A median 59 KB vs B median 41 KB), which
incidentally avoided the truncation zone. Per the spec's diagnostic: failures
are neither "don't know the format" nor structural — no prompt change is
needed for correctness; few-shot helps with size discipline.

## Outcome mapping (spec §14.1 outcomes table)

| spec band | this run |
|---|---|
| **≥ 90% across all providers** → GroupThink lock holds; Q1 confirmed HTML-canonical; compilation can lean agent-driven (§7.2.B) or hybrid; parser can be moderately strict | **← lands here** (93.3% / 100% / 96.7%; 96.7% overall) |

Consequences as specified:
- **GroupThink output format:** lock holds — agents emit page-schema HTML directly.
- **Substrate synthesis (Q1):** HTML-canonical confirmed; JSON-canonical (§11.2) not needed.
- **Compilation flavor (Q4):** deterministic compilation over `data-*` attrs is viable
  (zero attribute/ID/scaffold errors in 88 intact documents); §7.2.A or hybrid both open.
- **Validation strictness (§12.8):** parser can be moderately strict. The realized error
  distribution suggests one lax rule worth having: tolerate (warn, don't reject) a
  missing doctype / truncated head, since the only malformed inputs seen were
  transport-truncated, and a strict parser cleanly rejects them anyway.
- One caution flag for §12.3/§6: the single gemini edit failure was *silent content
  loss during whole-document rewrite*. Whole-document rewrites are riskier than
  zone-scoped edits; the dispatch loop should prefer targeted edits (or diff plan
  files after agent passes) rather than asking agents to re-emit full documents.

## Deviations from the spec

1. **Models.** Spec named Claude Opus 4.7 + Sonnet 4.6, Codex (GPT-5), Gemini
   2.5 Pro. Run with what the machine's CLIs actually provide (spec permits:
   "adjust to match which agents this dashboard actually orchestrates"):
   Sonnet 4.6 only for Claude (no separate Opus cell), codex default gpt-5.5,
   gemini CLI default. 3 providers × 3 cells instead of 4 providers × 2.
2. **Check 6 as a third variant.** Implemented as a dedicated edit prompt
   (`prompt-edit.md`, N=10 per provider) against a fixed host document, rather
   than instrumenting Edit-tool calls inside pass-B generation runs. The agent
   re-emits the full updated document; targeting + preservation are verified
   structurally. This makes check 6 a like-for-like cross-provider comparison
   but means generation runs (a, b) are scored on checks 1–5 only.
3. **Retry policy.** Runs that produced *no document* (timeout exit 124,
   transport error) were retried: claude a/8 (timeout → delivered truncated on
   retry, kept and counted as fail), claude a/9 (timeout → API socket error →
   passed on second retry). Delivered outputs were never rerolled. Retries
   used a 900 s ceiling instead of 600 s.
4. **Scoring library.** cheerio + parse5 (spec offered jsdom or cheerio).
   parse5's `onParseError` provides the tag-balance signal for check 5.
5. **Unused leniency.** The harness can strip markdown fences / leading prose
   before `<!DOCTYPE>` (flagged `normalized`), reasoning that the production
   write path is programmatic. In practice 0/90 documents needed it.
6. **Check 4 scope.** Scored on `recommendations` + `open-questions` per the
   spec's literal check text; the prompts requested all four per-phase zones.
7. **Extra artifacts** beyond the spec list: `host.html`, `prompt-edit.md`,
   `run-provider.sh`, `logs/` (driver + provider transcripts),
   `provider-versions.txt`.

## Re-running

```
cd experiments/2026-06-09-html-reliability
npm install                      # local deps: cheerio, parse5
bash run-provider.sh claude 10 4 # resumable; skips non-empty outputs
bash run-provider.sh codex  10 4
bash run-provider.sh gemini 10 4
node score.js                    # writes results.json, prints the table
```

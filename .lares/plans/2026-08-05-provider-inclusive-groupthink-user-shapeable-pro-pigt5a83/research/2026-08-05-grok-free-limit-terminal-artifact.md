---
plan_artifact_id: plan_pigt5a83
kind: evidence-artifact
captured_at: 2026-08-05
captured_by: supervisor f56fe814-3702-477f-a492-75e64b4ec141
source_agent: f2bf79fb-3500-44cf-a48b-99b261347967 ("PROBE-GROK-GUARD: git-discard hook enforcement", provider grok, status done)
source: read_agent_log (last 120 PTY lines), escape-stripped
---

# Grok free-usage-limit exhaustion — real terminal artifact (WP-6b evidence gate)

This is the REAL exhausted-terminal capture required by [DELIB-B3a] Decision 3
before the grok `free-usage-limit` classifier may be built. Captured from the
grok worker that hit account-wide free-quota exhaustion on 2026-08-05 (see
memory mb-2026-08-05-redbar-grok-quota).

## Rendered dialog text (escape-stripped, verbatim segment)

The dialog as rendered on the current screen (box-drawing `┃` borders preserved;
runs of spaces collapsed to one during cleaning):

```text
███ Help improve Grok[Opt out][Opt in] Off by default. Opt-in to allow SpaceXAI to retain coding data, e.g., prompts, traces, & metrics, for training and debugging purposes. Change anytime via settings. Read Terms and Privacy Policy.┃┃ You hit your free usage limit.┃┃┃ 1 (○) Upgrade to SuperGrok For everyday coding and productivity tasks ┃ 2 (○) Upgrade to SuperGrok Heavy Get the most out of Grok Build. Highest usage limits.┃┃ ↑/↓ navigate · y copy Enter:submit ┃Esc:unselect │ Tab:scrollback │ Shift+x:dismis
```

Key stable strings for the classifier:

- `You hit your free usage limit.` — the definitive exhaustion sentence.
- `Upgrade to SuperGrok` / `Upgrade to SuperGrok Heavy` — picker options.
- OSC-8 hyperlink target observed on the same screen: `https://grok.com/supergrok?referrer=grok-build` with anchor text `[Click here to Upgrade]`.
- The dialog appeared AFTER the worker's turn output, co-rendered with an
  unrelated "Help improve Grok" opt-in banner — the classifier must key on the
  exhaustion sentence, not on dialog position or the banner.

## Cleaning provenance

Raw PTY line (line 81 of the 120-line tail) cleaned with:
`perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/\e\][^\a]*\a//g; s/[\x00-\x08\x0b-\x1f]/ /g; s/ {2,}/ /g'`
Full cleaned line preserved verbatim at
`research/grok-free-limit-terminal-line81-cleaned.txt` (832 bytes) in this plan
folder. Note: space-collapsing was applied during cleaning; fixture authors
should treat inter-word whitespace as variable and match on the stable strings
above, and should derive fixtures resembling `getCurrentScreen()` output (the
classifier's actual input), not the raw ring.

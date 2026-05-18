# GroupThink duplicate-relay investigation

## TL;DR

The script makes a **single** POST per relay. The duplicate the Codex Reviewer
sees is produced inside the dashboard's chat-display layer: `_doSendInput`
emits a *synthetic* user-text event for codex/gemini agents, the real
PTY-echoed user-text later arrives from codex's on-disk session log, and the
dedupe that's supposed to merge them silently fails when the input contains
non-ASCII characters (em-dashes, smart quotes). The dedupe key only collapses
whitespace — it does not normalize away the unicode → ASCII flattening that
happens between `winRunner.write(ch)` and codex's input ingestion.

Claude relays don't double because the synthetic-echo path is provider-gated
to codex/gemini only.

---

## 1. Root cause

### The chain

1. **Script POSTs once.** `scripts/groupthink-v1.js:342-344` (Lead → Reviewer)
   and `:351-353` (Reviewer → Lead) each make exactly one
   `POST /api/agents/<id>/input` per turn. The run log
   (`plans/.runs/groupthink-v1-20260517172733-1442.log`) shows one
   "Relaying Lead -> Reviewer" line per turn — no retries, no fallback,
   no second send. The script is innocent.

2. **`_doSendInput` types the message into Codex via PTY.**
   `src/main/supervisor/index.ts:1717-1739` — the Windows codex/gemini branch
   normalizes line endings, then loops over the string and calls
   `winRunner.write(ch)` per character at
   `WINDOWS_CODEX_TYPING_DELAY_MS = 8` ms (line 47). For an ~11 KB Lead draft
   this takes ~90 s of wall time, which matches the gap between the
   "Relaying Lead -> Reviewer" log line (00:30:43.155Z) and the synthetic
   event timestamp (00:33:34.602Z).

3. **After typing, `emitSyntheticUserEcho` fires.** Same file, line 1740 then
   line 1749-1752. It's gated to codex/gemini only:
   ```ts
   private emitSyntheticUserEcho(agent: Agent, text: string): void {
     if (agent.provider !== 'codex' && agent.provider !== 'gemini') return;
     this.sessionLogReader.appendSyntheticUserText(agent.id, text);
   }
   ```
   Codex's own on-disk session log lags by seconds, and the dashboard chat is
   reconstructed from that log — so the synthetic event exists to give the
   chat an immediate user-side echo without waiting for the on-disk write.

4. **`appendSyntheticUserText` records a marker AND emits a synthetic event.**
   `src/main/supervisor/session-log-dispatcher.ts:107-126`. The marker's text
   is `normalizeUserText(text)` of the **original** dashboard string (unicode
   intact). The synthetic event is emitted immediately into the chat ring
   buffer with `timestamp: new Date(now).toISOString()`. That's the first
   copy in the Reviewer's inbox (00:33:34.602Z, em-dashes preserved).

5. **Codex eventually writes the real user-text to disk.** The dispatcher's
   `tick()` poll picks it up, `pollOne` calls `dedupeAgainstSynthetic`
   (`session-log-dispatcher.ts:147-163`) to suppress the duplicate, but the
   match **fails**:
   ```ts
   function normalizeUserText(s: string): string {
     return s.trim().replace(/\s+/g, ' ');
   }
   ```
   This only collapses whitespace. It does nothing about the unicode →
   ASCII-fallback substitution the PTY layer applies (see §4). So the real
   event passes through, gets appended to the ring buffer, and is emitted as
   a second user-text event ~100 ms after the synthetic.

### Concrete diff of the two duplicates

Decoded from the Reviewer chat (agent `7faf4967…`, Turn 1):

| message | ts | text fragment | character codes at the diff site |
|---------|----|--------------|----------------------------------|
| `[3]` (synthetic, dashboard's original) | `00:33:34.602Z` | `Draft 1 — review of` | `32 8212 32` (space, em-dash, space) |
| `[2]` (real, from codex session log) | `00:33:34.707Z` | `Draft 1  review of` | `32 32` (space, space) |

The em-dash (U+2014) becomes a single space. Length drops by 33 bytes across
the Turn-1 message, consistent with ~16 em-dashes flattened (3 UTF-8 bytes →
1 ASCII byte each, –2 bytes per occurrence). Same pattern in Turn 2: smart
apostrophes (U+2019) and em-dashes are all replaced by single spaces;
non-ASCII chars elsewhere in the text get the same treatment.

After `normalizeUserText` collapses whitespace, the synthetic key looks like
`… Draft 1 — review …` and the real key looks like `… Draft 1 review …`.
Those strings are not `===`. Dedupe returns `false`. Both events ship.

---

## 2. Why Codex but not Claude

`emitSyntheticUserEcho` is hard-gated to `codex`/`gemini` providers at
`src/main/supervisor/index.ts:1749-1752`. The Claude branch
(`:1708-1716`) bracketed-pastes the text and never touches the synthetic
dispatcher. Claude's session log emits a single `user-text` event per real
input, and that event is what the chat shows — there's no second source to
dedupe against, so there's nothing for the broken normalizer to break.

The Lead in this run was Claude (`2b68ea59…`, runner = Windows claude),
which is why every Reviewer → Lead relay appears exactly once in the Lead's
inbox.

---

## 3. Where the ASCII flattening originates (not the script)

The script (`groupthink-v1.js`) sends raw `${leadMsg.content}` into the API
without any sanitization. The API handler (`src/main/api-server.ts:159-198`)
parses JSON and passes the string straight into `supervisor.sendInput`.
`_doSendInput` only normalizes `\r\n`/`\r` to `\n`; it then calls
`winRunner.write(ch)` per character. None of those steps flatten unicode.

Independent evidence: the Reviewer's own assistant output preserves smart
quotes correctly. The latest assistant message contains `don't` (U+2019) and
that survives untouched through codex's session log into the chat API
response. So codex's output path handles unicode fine. The flattening is
unique to the **input** path — i.e., between `winRunner.write(ch)` and
codex's `user-text` ingestion on disk.

The agent was a Windows runner (`tmuxSessionName: null`), so the byte stream
goes through node-pty → ConPTY with Win32 Input Mode (`ESC[?9001h`) active —
codex's documented input encoding. ConPTY's auto-conversion of raw bytes to
single `KEY_DOWN` events, plus whatever filter codex applies to its
interactive prompt buffer, is dropping anything outside basic ASCII and
substituting a space. The dashboard isn't doing this; the system layer
between the dashboard and codex is. The fix has to live in the dedupe path
on the dashboard side because we cannot stop the flattening at the source
without rewriting the PTY input encoding.

(WSL codex agents take the `tmuxSendInput` branch at `:1696`, which also
emits the synthetic echo. tmux's `send-keys` is generally more UTF-8
tolerant, so the bug may be milder on WSL — but the same code path runs and
the same dedupe is in effect, so it's not structurally safe there either.
This run was Windows.)

---

## 4. Fix recommendation

**Minimal patch:** widen `normalizeUserText` in
`src/main/supervisor/session-log-dispatcher.ts:34-36` so the dedupe key
ignores the difference between a unicode character and its PTY-flattened
ASCII fallback. Concretely: strip all non-`[0x20-0x7E\n]` characters before
collapsing whitespace. That turns both `"Draft 1 — review"` and
`"Draft 1  review"` into `"Draft 1 review"` after whitespace collapse, and
they match. This only affects the dedupe *key* — the synthetic event still
carries the original unicode-rich text into the chat, so the chat UI is
unaffected.

**Better patch (worth one extra paragraph of design):** stop trying to do
text-equality dedupe at all. `_doSendInput` is the only path that produces a
PTY-echoed `user-text` event for a codex/gemini agent, and every send
records a marker. So within the 35-second dedupe window, treat *any*
incoming real `user-text` event as the echo of the oldest unconsumed
marker — consume the marker by recency, not by text equality. This is
robust to whatever the PTY does to the bytes (substitution, line wrapping,
control-char stripping) and to whatever codex does (truncation, paste-mode
mangling). The only failure mode is if a human types into the codex TUI
directly during the dedupe window — that's already rare for orchestration
runs and easy to bound by clearing markers on detached/manual terminal use
if it ever matters.

Either fix is one small function change. The "by recency" version eliminates
this class of bug; the "strip non-ASCII" version closes the immediate hole
but leaves a similar trap for the next non-obvious PTY transformation.

---

## 5. Risk if unfixed

- **Every Codex turn in every GroupThink/orchestration with non-ASCII content
  produces a duplicate user-message in chat.** Claude is the
  default Lead provider in this script (`groupthink-v1.js:281`), and Claude
  reliably uses em-dashes, smart quotes, and bullet glyphs. So this fires
  more or less every run where a Codex is on the receiving end.
- **Chat record pollution scales linearly with turn count.** A 6-turn
  deliberation with a Codex reviewer produces 6 duplicate user messages on
  the Codex side; a 10-turn one produces 10. Anyone reading
  `read_agent_chat` (humans, future agents, audit tooling) sees the noise.
- **Cost amplification for downstream consumers.** Any tool that reads chat
  back and feeds it into a prompt (a wrap-up summarizer, a planner
  reviewing the deliberation, the supervisor sanity-checking the run) pays
  for the duplicate tokens. With Lead drafts in the 10–20 KB range this is
  hundreds of duplicated tokens per turn.
- **No correctness impact inside the live deliberation.** Codex itself only
  receives the input once (the PTY write is single), so its response loop
  isn't confused. The script reads only `role: 'assistant'` messages
  (`groupthink-v1.js:166`), so the dedupe failure doesn't affect turn
  detection or stall logic. The damage is bounded to chat-record
  faithfulness and downstream consumption cost.
- **Adjacent fragility.** The same `normalizeUserText` is the only defense
  against the next PTY-mangling surprise (codex updating its input filter,
  Win32 Input Mode behavior changing, a new tab/control-char being dropped).
  Whatever the PTY does that the script doesn't, this dedupe will silently
  miss it. The "by recency" fix retires that risk class entirely.

---

## 6. Test idea

1. **Unit test against `dedupeAgainstSynthetic`** (a new case in
   `src/main/supervisor/session-log-dispatcher.test.ts`, alongside the
   existing "whitespace differences still match" test at line 92):
   - synthetic marker with `"Draft 1 — review"` (U+2014)
   - real event with `"Draft 1  review"` (em-dash → space)
   - assert the second batch is suppressed (`emitted.length === 1`)
   - parametrize over: em-dash, en-dash (U+2013), right single quote
     (U+2019), left/right double quotes (U+201C/U+201D), bullet (U+2022),
     ellipsis (U+2026), and a mixed-payload case.

2. **Direct integration test** along the lines of the existing
   `groupthink-v1.resume-no-replay.test.js`: stub the runner so it can
   simulate the codex-side ASCII flattening, send an input string
   containing em-dashes via `supervisor.sendInput`, and assert that
   `getMessages(agentId, { role: 'user' })` returns exactly one row.

3. **End-to-end regression** the human can eyeball: run a two-turn
   GroupThink with a Lead system prompt that explicitly asks for em-dashes
   and smart quotes in the draft, then assert
   `read_agent_chat(reviewer, role: 'user').length === turn_count` (no
   duplicates). This is the same shape as the just-completed run, so the
   evidence pattern is well known.

# Troubleshooting — cause → symptom → correction (rule-ID'd)

Derived from `OrchestrationScriptStructure.md` §1.6 + §6.

| Rule | Cause | Symptom | Correction |
|---|---|---|---|
| TS-AUTH | unauthenticated call | 401 | Bearer on every request; fail closed |
| TS-PORT | hardcoding 24678 | wrong/no service | prefer injected `AGENT_DASHBOARD_API_PORT` |
| TS-LEGACY | `AGENT_ID` / `.dashboard/` | wrong owner / paths | `AGENT_DASHBOARD_SELF_ID`, `.lares/` |
| TS-SELFID | `X-Self-Id` as scope/ownership | mis-set expectations | scope = workspace/supervisor hdrs; ownership = `owner_agent_id` |
| TS-WS | omit/mismatch `workspaceId` | invisible / wrong-workspace + dropped edge | always send explicit `workspaceId` |
| TS-OWNER | omit/invent `owner_agent_id` | un-nested child | forward `SELF_ID` verbatim (safe if stale) |
| TS-FLAGS | conflicting role flags | surprising lane | set exactly the lane's fields; know precedence |
| TS-CWD | assume `workingDirectory` = cwd | artifacts under `.lares/` | absolute artifact paths |
| TS-KICK | kickoff in `systemPrompt` | turn never starts | kickoff via confirmed `/input` |
| TS-409 | send while receiver busy | 409 crash + orphans | `waitReceiverReady` first |
| TS-QUEUE | treat HTTP 200 as turn-started | false progress | require `confirmed:true` or verify |
| TS-DUP | re-send prompt on confirm timeout | duplicate task | evidence-gated submit-only Enter |
| TS-IDLE | treat idle/status as terminal | false FAILED | message-stream `turnComplete` beyond highwater |
| TS-HW | timestamp-only highwater | same-ts collisions | composite (ts + content hash) |
| TS-RESEED | reseed valid highwater on resume | re-relay / re-stall | seed fresh only; preserve on resume |
| TS-STALE-TURN | ignore non-forwarded completed turns | stale-turn bug | advance every participant's highwater |
| TS-FRESH | artifact existence w/o freshness | false success | verify hash change after flush grace |
| TS-TOKEN | token without artifact | false success | two-factor when both exist; token newest-first |
| TS-FINALLY | unconditional `finally` delete | destroys resume context | terminal-state-specific cleanup |
| TS-STALLKILL | clean up on recoverable stall | unresumable | leave alive + `resume_hint` |
| TS-UNBOUNDED | unlimited retries/waits | hangs | bound everything |
| TS-WRITERS | multiple writers / one-agent-per-cwd assumption | races | one-writer protection; per-agent disambiguation |
| TS-SPLITBRAIN | duplicate/self-forked supervisor | split-brain | newest-live discovery; relaunch fresh w/ pointer |

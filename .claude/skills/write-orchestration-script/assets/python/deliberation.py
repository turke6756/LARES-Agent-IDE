#!/usr/bin/env python3
"""deliberation.py — N-AGENT DELIBERATION / RELAY shape (Python), parallel-round
subtype. Launch N members; each round: kick every member in parallel, wait each
turn, BARRIER, capture and markRelayed EVERY participant's output (even output
not fed to synthesis), exchange peer drafts; then designate exactly one
synthesizer/final writer and verify the final write after a grace window.

Invoked core subset: connectApi, launchAgent, waitReady, seedHighwater,
    confirmedSend/kickoff, waitTurnComplete, waitReceiverReady, relay,
    markRelayed, verifyArtifact, retire, reconcile, resumeHint, plus the
    shape-scoped round barrier.

Everything marked `# user policy` is a customization slot.
"""

from __future__ import annotations

import concurrent.futures
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lares_client import LaresClient, Highwater  # noqa: E402


def launch_members(client: LaresClient, specs: list[dict]) -> list[dict]:
    members = []
    for spec in specs:                          # user policy — count/providers/lanes
        a = client.launchAgent({
            "title": spec["title"],             # user policy
            "provider": spec.get("provider", "claude"),
            "isSupervised": True,
            "notify_owner": spec.get("notify_owner", False),  # user policy — muted member?
        })
        client.waitReady(a["id"])
        members.append(a)
    return members


def _round_barrier(client: LaresClient, members: list[dict], highwaters: dict,
                   prompt_for) -> dict:
    """Parallel round with a BARRIER: send every member, wait every turn, and
    markRelayed EVERY participant (omitting a non-synthesized one caused a real
    stale-turn bug, §3)."""
    outputs: dict[str, str] = {}

    def one(member):
        aid = member["id"]
        hw = highwaters[aid]
        client.confirmedSend(aid, prompt_for(member), pre_hw=hw)  # user policy — round prompt
        tc = client.waitTurnComplete(aid, hw)
        return aid, tc

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(members)) as ex:
        futures = [ex.submit(one, m) for m in members]
        for f in concurrent.futures.as_completed(futures):
            aid, tc = f.result()
            if tc["status"] == "complete":
                highwaters[aid] = tc["highwater"]            # advance EVERY participant
                outputs[aid] = (tc["message"] or {}).get("content", "")
    # BARRIER reached — all members' turns consumed and highwaters advanced.
    return outputs


def deliberate(client: LaresClient, specs: list[dict], *, rounds: int = 2,
               synthesizer_index: int = 0, artifact: str | None = None,
               run_id: str = "delib-run") -> dict:
    members = launch_members(client, specs)
    highwaters = {m["id"]: client.seedHighwater(m["id"]) for m in members}

    def prompt_for(member):
        return f"Deliberate on the task (round). You are {member['title']}."  # user policy

    for r in range(rounds):                     # user policy — round/turn cap
        outputs = _round_barrier(client, members, highwaters, prompt_for)
        # Exchange peer drafts in parallel (relay); every send gated by receiver-ready.
        for m in members:                       # user policy — serial vs parallel exchange
            peers = "\n\n".join(v for k, v in outputs.items() if k != m["id"])
            if peers:
                client.relay("peers", m["id"], peers)
                highwaters[m["id"]] = client.waitTurnComplete(m["id"], highwaters[m["id"]])["highwater"]

    # Exactly ONE synthesizer/final writer.
    synth = members[synthesizer_index]
    client.confirmedSend(synth["id"], "Synthesize the final answer and write it.",  # user policy
                         pre_hw=highwaters[synth["id"]])
    client.waitTurnComplete(synth["id"], highwaters[synth["id"]])
    verdict = {"ok": True}
    if artifact:
        verdict = client.verifyArtifact(artifact)  # verify the final write after grace
    if not verdict["ok"]:
        client.retire("stalled", [m["id"] for m in members])  # leave-alive on failure to resume
        return {"ok": False, "resume": client.resumeHint(run_id, "synthesis", [m["id"] for m in members])}
    client.retire("complete", [m["id"] for m in members])
    return {"ok": True}


if __name__ == "__main__":
    c = LaresClient.connectApi()
    specs = [{"title": "member-A"}, {"title": "member-B"}]  # user policy — topology
    print(deliberate(c, specs))

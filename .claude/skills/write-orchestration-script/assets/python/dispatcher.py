#!/usr/bin/env python3
"""dispatcher.py — DISPATCHER FAN-OUT shape (Python). Fan out a bounded-
concurrency pool of workers, one per work item; kick each off; wait for the
STRICT completion profile (idle + stable (msg-count,newest-ts) signature for N
polls + flush grace); verify the per-item deliverable; record a per-item result;
retire; aggregate exit.

Invoked core subset: connectApi, launchAgent, waitReady, seedHighwater,
    confirmedSend/kickoff, waitTurnComplete (STRICT profile), verifyArtifact,
    retire (terminal-state-specific). Reconcile/resume machinery is NOT part of
    the dispatcher profile — see deliberation.py / scheduler.py / pipeline.py.

Everything marked `# user policy` is a customization slot. Do NOT edit the
fixed-core client (lares_client.py); adjust behavior via these hooks only.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lares_client import LaresClient, POLL_MS, EXIT_OK  # noqa: E402

_TRACE = os.environ.get("LARES_TRACE") == "1"


def _emit(event, **data):
    if _TRACE:
        sys.stdout.write("TRACE " + json.dumps({"event": event, **data}) + "\n")
        sys.stdout.flush()


def default_item_to_work(item: dict) -> dict:
    # user policy — how a work item becomes a launch payload + kickoff prompt.
    return {
        "payload": {"title": f"dispatch: {item['id']}", "provider": "claude",  # user policy
                    "isSupervised": True},
        "kickoff": (f"Do the task for {item['id']}. Write the result to "  # user policy
                    f"{item.get('artifact')} (absolute path). End your final "
                    "message with the token DONE."),
        "artifact": item.get("artifact"),   # user policy — absolute path or None
        "baseline_hash": None,              # user policy — set to gate on freshness
    }


def _wait_stable_idle(client: LaresClient, agent_id: str, *, stable_polls: int = 3,
                      hard_ms: int = 60_000) -> bool:
    """STRICT one-shot completion (dispatcher hardening, §2 step 7 strict
    profile): status idle AND a stable (msg-count,newest-ts) signature for N
    polls before verify+delete."""
    deadline = time.time() * 1000 + hard_ms
    last_sig, stable = None, 0
    while time.time() * 1000 < deadline:
        agent = client._get_agent(agent_id)
        if agent is None:
            return False
        if agent.get("status") in ("crashed", "done"):
            return agent.get("status") == "done"
        msgs = client.readMessages(agent_id, limit=1)
        sig = f"{len(msgs)}:{msgs[0].get('timestamp') if msgs else ''}"
        if agent.get("status") == "idle" and sig == last_sig:
            stable += 1
            if stable >= stable_polls:
                return True
        else:
            stable, last_sig = 0, sig
        time.sleep(POLL_MS / 1000.0)
    return False


def _run_one(client: LaresClient, item: dict, policy: dict) -> dict:
    work = policy["item_to_work"](item)
    agent = client.launchAgent(work["payload"])
    _emit("launch", id=agent["id"], item=item["id"])
    record = {"item": item["id"], "agentId": agent["id"], "ok": False, "reason": None}
    try:
        client.waitReady(agent["id"])
        hw = client.seedHighwater(agent["id"])
        res = client.kickoff(agent["id"], work["kickoff"], pre_hw=hw, trace=_emit)
        _emit("kickoff", id=agent["id"], confirmed=res["confirmed"])
        tc = client.waitTurnComplete(agent["id"], hw, trace=_emit)
        if tc["status"] != "complete":
            record["reason"] = "stalled"
            return record
        _wait_stable_idle(client, agent["id"], stable_polls=policy["stable_polls"])
        if work.get("artifact"):
            v = client.verifyArtifact(work["artifact"], baseline_hash=work["baseline_hash"])
            record["ok"], record["reason"] = v["ok"], v["reason"]
        else:
            msgs = client.readMessages(agent["id"], limit=5)
            tok = client.verifyToken(msgs, policy["accept_token"])  # user policy predicate
            record["ok"], record["reason"] = bool(tok), ("token" if tok else "no-token")
        return record
    finally:
        if not policy["keep_workers"]:
            client.retire("complete" if record["ok"] else "error", [agent["id"]], trace=_emit)


def run_dispatcher(client: LaresClient, items: list[dict], **overrides) -> list[dict]:
    policy = {
        "item_to_work": default_item_to_work,
        "concurrency": 4,               # user policy — concurrency cap
        "stable_polls": 3,              # user policy — strict-idle stability polls
        "keep_workers": False,          # user policy — retire successful workers?
        "accept_token": lambda t: t == "DONE",  # user policy — success token predicate
    }
    policy.update(overrides)
    queue = list(items)
    lock = threading.Lock()
    results: list[dict] = []

    def worker():
        while True:
            with lock:
                if not queue:
                    return
                item = queue.pop(0)
            r = _run_one(client, item, policy)
            with lock:
                results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(min(policy["concurrency"], max(1, len(items))))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


if __name__ == "__main__":
    c = LaresClient.connectApi()
    items = json.loads(os.environ.get("LARES_ITEMS", '[{"id":"item-1"}]'))  # user policy — item selection
    out = run_dispatcher(c, items)
    sys.stdout.write(json.dumps({"results": out}, indent=2) + "\n")
    sys.exit(EXIT_OK if all(r["ok"] for r in out) else EXIT_OK + 1)  # aggregate exit

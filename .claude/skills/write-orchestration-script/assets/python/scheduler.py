#!/usr/bin/env python3
"""scheduler.py — SCHEDULER LOOP shape (Python). A periodically-triggered driver
that ensures exactly one structural supervisor is making progress on a workspace,
resends once after verified silence, escalates, and recovers a crashed supervisor
by relaunching fresh — never by self-forking.

Invoked core subset: connectApi, launchAgent, waitReady, confirmedSend/kickoff,
    waitTurnComplete, retire, reconcile, resumeHint, plus the shape-scoped
    runLock and progressFingerprint.

Everything marked `# user policy` is a customization slot. The DURABLE run-state
mechanism (file / sentinel / db) is policy (§4) — this template uses a lock file.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lares_client import LaresClient, _write_sentinel  # noqa: E402


# ── runLock: single-run guard (durable). Mechanism is policy; contract is core.
class runLock:
    def __init__(self, path: str):
        self.path = path
        self.fd = None

    def __enter__(self):
        # Fail if another run holds the lock (O_EXCL). Prevents duplicate runs /
        # duplicate structural supervisors (§3 scheduler).
        try:
            self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(self.fd, str(os.getpid()).encode())
        except FileExistsError:
            raise SystemExit("scheduler: another run holds the runLock")
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


def newest_live_supervisor(client: LaresClient) -> dict | None:
    """Newest-wins discovery: never self-fork a crashed supervisor; find the
    newest live structural supervisor instead."""
    agents = client.request("GET", "/api/agents")
    sups = [a for a in agents if a.get("isSupervisor") and a.get("status") not in ("done", "crashed")]
    sups.sort(key=lambda a: a.get("createdAt", ""), reverse=True)
    return sups[0] if sups else None


def progressFingerprint(client: LaresClient, supervisor_id: str) -> str:
    """Derive progress from DURABLE artifacts/messages, not dashboard status.
    Silence = an unchanged fingerprint across triggers."""
    msgs = client.readMessages(supervisor_id, limit=1)  # user policy — extend with artifact mtimes/hashes
    newest = msgs[0] if msgs else {}
    return f"{newest.get('timestamp', '')}:{len(newest.get('content', '') or '')}"


def ensure_supervisor(client: LaresClient, state_dir: str) -> dict:
    """Launch isSupervisor:true ONLY when none is live; otherwise reuse."""
    live = newest_live_supervisor(client)
    if live is not None:
        return live
    sup = client.launchAgent({
        "isSupervisor": True,                 # user policy — the ONLY way to set the supervisor role
        "title": "workspace supervisor",      # user policy
        "provider": "claude",
    })
    client.waitReady(sup["id"])
    client.kickoff(sup["id"], "Resume workspace supervision.")  # user policy — kickoff text
    return sup


def tick(client: LaresClient, state_dir: str, *, quiet_hours=False) -> int:
    """One scheduler trigger. Returns an exit code (0 ok · 2 stalled/escalated)."""
    if quiet_hours:                            # user policy — triggers/quiet-hours/quotas/cooldowns
        return 0
    os.makedirs(state_dir, exist_ok=True)
    fp_path = os.path.join(state_dir, "fingerprint.json")
    with runLock(os.path.join(state_dir, "scheduler.lock")):
        sup = ensure_supervisor(client, state_dir)
        fp = progressFingerprint(client, sup["id"])
        prev = None
        if os.path.exists(fp_path):
            prev = json.load(open(fp_path)).get("fp")
        json.dump({"fp": fp, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}, open(fp_path, "w"))
        if prev is not None and prev == fp:
            # Verified silence → ONE bounded resend, then escalate.
            try:
                client.waitReceiverReady(sup["id"])
                client.kickoff(sup["id"], "Status check: continue the current plan.")  # user policy
            except Exception:
                # Crash-recovery: stop the stale supervisor + relaunch FRESH with a
                # session/artifact pointer — NEVER self-fork a crashed supervisor.
                client.retire("error", [sup["id"]])
                fresh = client.launchAgent({"isSupervisor": True, "title": "workspace supervisor (relaunch)"})
                _write_sentinel(os.path.join(state_dir, "escalation.json"),
                                {"reason": "supervisor-relaunched", "prior": sup["id"], "fresh": fresh["id"]})
                return 2
    return 0


if __name__ == "__main__":
    c = LaresClient.connectApi()
    sys.exit(tick(c, os.environ.get("LARES_STATE_DIR", ".runs")))  # user policy — run cap/escalation deadlines

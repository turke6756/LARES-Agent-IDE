#!/usr/bin/env python3
"""Behavioral scenario driver (Python). Imports the fixed-core client as a
library and drives it through one §G scenario against the mock server, emitting
`TRACE <json>` lines that validate_templates.mjs parses into semantic
partial-order assertions. This is a TEST harness — it is never shipped as an
asset and never talks to a live dashboard."""

import json
import os
import sys

_ASSETS = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "python")
sys.path.insert(0, os.path.abspath(_ASSETS))

from lares_client import LaresClient, Highwater  # noqa: E402


def emit(event, **data):
    sys.stdout.write("TRACE " + json.dumps({"event": event, **data}) + "\n")
    sys.stdout.flush()


def hwstr(hw):
    return f"{hw.ts}|{hw.hash}"


def tmpdir():
    d = os.environ.get("LARES_TMPDIR", ".")
    os.makedirs(d, exist_ok=True)
    return d


def _boot(client, supervised=True):
    a = client.launchAgent({"title": "worker", "isSupervised": supervised})
    emit("launch", id=a["id"])
    client.waitReady(a["id"])
    emit("ready", id=a["id"])
    return a["id"]


def scenario_1(client):
    aid = _boot(client)
    hw = client.seedHighwater(aid)
    emit("seed", id=aid, hw=hwstr(hw), reseed=False)
    res = client.kickoff(aid, "KICKOFF TASK", pre_hw=hw, trace=_trace)
    emit("kickoff", id=aid, confirmed=res["confirmed"], full_sends=res["full_sends"])
    tc = client.waitTurnComplete(aid, hw, trace=_trace)
    emit("result", id=aid, status=tc["status"])


def scenario_2(client):
    aid = _boot(client)
    hw = client.seedHighwater(aid)
    emit("seed", id=aid, hw=hwstr(hw), reseed=False)
    res = client.kickoff(aid, "KICKOFF TASK", pre_hw=hw, trace=_trace)
    emit("kickoff", id=aid, confirmed=res["confirmed"], full_sends=res["full_sends"],
         started=res.get("started"))


def scenario_3(client):
    aid = _boot(client)
    hw = client.seedHighwater(aid)
    emit("seed", id=aid, hw=hwstr(hw), reseed=False)
    res = client.kickoff(aid, "ROUND 1", pre_hw=hw, trace=_trace)
    emit("kickoff", id=aid, confirmed=res["confirmed"], full_sends=res["full_sends"])
    hws = {}
    tc1 = client.waitTurnComplete(aid, hw, trace=_trace)
    client.markRelayed(hws, aid, tc1["highwater"])
    emit("mark_relayed", id=aid, hw=hwstr(tc1["highwater"]))
    client.confirmedSend(aid, "ROUND 2", pre_hw=tc1["highwater"], trace=_trace)
    tc2 = client.waitTurnComplete(aid, tc1["highwater"], trace=_trace)
    emit("mark_relayed", id=aid, hw=hwstr(tc2["highwater"]))


def scenario_4(client):
    persisted = Highwater(ts="400", hash="cafef00dcafef00d")
    aid = _boot(client)
    hw = client.seedHighwater(aid, persisted=persisted)
    emit("seed", id=aid, hw=hwstr(hw), persisted=hwstr(persisted),
         reseed=(hwstr(hw) != hwstr(persisted)))


def scenario_5(client):
    aid = _boot(client)
    hw = client.seedHighwater(aid)
    emit("seed", id=aid, hw=hwstr(hw), reseed=False)
    res = client.kickoff(aid, "KICKOFF TASK", pre_hw=hw, trace=_trace)
    emit("kickoff", id=aid, confirmed=res["confirmed"], full_sends=res["full_sends"])
    tc = client.waitTurnComplete(aid, hw, trace=_trace)
    emit("result", id=aid, status=tc["status"])


def scenario_6(client):
    aid = _boot(client)
    msgs = client.readMessages(aid, limit=10)
    tok = client.verifyToken(msgs, accept=lambda t: t in ("PASS", "FAIL"))
    emit("token", value=tok)


def scenario_7(client):
    import hashlib
    _boot(client)
    path = os.path.join(tmpdir(), "artifact.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("baseline v1")
    baseline = hashlib.sha256(b"baseline v1").hexdigest()
    r_stale = client.verifyArtifact(path, baseline_hash=baseline, grace_ms=0)
    emit("verify", case="stale", ok=r_stale["ok"], reason=r_stale["reason"])
    with open(path, "w", encoding="utf-8") as f:
        f.write("updated v2 — fresh content")
    r_fresh = client.verifyArtifact(path, baseline_hash=baseline, grace_ms=0)
    emit("verify", case="fresh", ok=r_fresh["ok"], reason=r_fresh["reason"])


def scenario_8(client):
    aid = _boot(client)
    hw = client.seedHighwater(aid)
    emit("seed", id=aid, hw=hwstr(hw), reseed=False)
    res = client.kickoff(aid, "KICKOFF TASK", pre_hw=hw, trace=_trace)
    emit("kickoff", id=aid, confirmed=res["confirmed"], full_sends=res["full_sends"])
    tc = client.waitTurnComplete(aid, hw, soft_ms=800, hard_ms=1200, trace=_trace)
    emit("classified", id=aid, status=tc["status"])
    client.retire("stalled", [aid], trace=_trace)
    hint = client.resumeHint("run-x", "phase-1", [aid], {"round": 1})
    emit("resume_hint", members=hint["members"], phase=hint["phase"])


def scenario_9(client):
    ids = []
    for i in range(3):
        a = client.launchAgent({"title": f"w{i}", "isSupervised": True})
        emit("launch", id=a["id"])
        client.waitReady(a["id"])
        ids.append(a["id"])
    client.retire("complete", ids, trace=_trace)


def scenario_10(client):
    sup = client.launchAgent({"title": "supervisor", "isSupervisor": True})
    emit("launch", id=sup["id"])
    client.waitReady(sup["id"])
    client.supervisor_id = sup["id"]
    sentinel = os.path.join(tmpdir(), "undelivered.json")
    r = client.deliverToSupervisor("terminal notice for supervisor",
                                   sentinel_path=sentinel, trace=_trace)
    emit("delivery", delivered=r["delivered"], sentinel=r.get("sentinel"),
         exists=os.path.exists(sentinel))


SCENARIOS = {
    "1": scenario_1, "2": scenario_2, "3": scenario_3, "4": scenario_4,
    "5": scenario_5, "6": scenario_6, "7": scenario_7, "8": scenario_8,
    "9": scenario_9, "10": scenario_10,
}


def _trace(event, data):
    emit(event, **data)


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--scenario":
        sys.stderr.write("usage: driver.py --scenario <name>\n")
        return 64
    name = sys.argv[2]
    fn = SCENARIOS.get(name)
    if fn is None:
        sys.stderr.write(f"unknown scenario {name}\n")
        return 64
    client = LaresClient.connectApi()
    fn(client)
    return 0


if __name__ == "__main__":
    sys.exit(main())

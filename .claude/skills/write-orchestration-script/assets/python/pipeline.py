#!/usr/bin/env python3
"""pipeline.py — PIPELINE STAGES shape (Python). Run an explicit stage dependency
graph; each stage has its own lane/prompt/token/artifact contract; advance to a
downstream stage only after BOTH turn completion AND artifact verify; persist
completed stages for idempotent resume; retire stage-local agents after a
verified handoff.

Invoked core subset: connectApi, launchAgent, waitReady, seedHighwater,
    confirmedSend/kickoff, waitTurnComplete, verifyArtifact, retire, reconcile,
    resumeHint, plus a durable completed-stage ledger.

Everything marked `# user policy` is a customization slot.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lares_client import LaresClient  # noqa: E402


def load_ledger(path: str) -> dict:
    if os.path.exists(path):
        return json.load(open(path))
    return {"completed": []}


def save_ledger(path: str, ledger: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    json.dump(ledger, open(path, "w"))


def run_stage(client: LaresClient, stage: dict) -> dict:
    """A single stage: launch a stage-local agent, kickoff, wait completion, THEN
    verify the artifact; only a verified stage may hand off."""
    a = client.launchAgent({
        "title": stage["title"],                       # user policy
        "provider": stage.get("provider", "claude"),   # user policy — per-stage lane/provider
        "isSupervised": True,
    })
    try:
        client.waitReady(a["id"])
        hw = client.seedHighwater(a["id"])
        client.kickoff(a["id"], stage["kickoff"], pre_hw=hw)   # user policy — per-stage prompt
        tc = client.waitTurnComplete(a["id"], hw)
        if tc["status"] != "complete":
            return {"ok": False, "reason": "stalled", "agentId": a["id"]}
        # Advance ONLY after BOTH turn completion AND artifact verify.
        if stage.get("artifact"):
            v = client.verifyArtifact(stage["artifact"], baseline_hash=stage.get("baseline_hash"))
            if not v["ok"]:
                return {"ok": False, "reason": v["reason"], "agentId": a["id"]}
        return {"ok": True, "agentId": a["id"]}
    finally:
        # Retire stage-local agents AFTER the verified handoff (reverse order).
        client.retire("complete", [a["id"]])


def run_pipeline(client: LaresClient, stages: list[dict], *, ledger_path: str,
                 run_id: str = "pipeline-run") -> dict:
    """`stages` are topologically ordered; each names its `depends_on`. A stage in
    the durable ledger is skipped (idempotent resume)."""
    ledger = load_ledger(ledger_path)
    done = set(ledger["completed"])
    for stage in stages:                        # user policy — stages/graph/retry-skip policy
        for dep in stage.get("depends_on", []):
            if dep not in done:
                raise RuntimeError(f"stage {stage['name']} depends on unmet {dep}")
        if stage["name"] in done:
            continue                            # idempotent resume — already verified
        result = run_stage(client, stage)
        if not result["ok"]:
            return {"ok": False, "stage": stage["name"], "reason": result["reason"],
                    "resume": client.resumeHint(run_id, stage["name"], [result["agentId"]])}
        done.add(stage["name"])
        ledger["completed"] = list(done)
        save_ledger(ledger_path, ledger)        # persist completed stages
    return {"ok": True, "completed": list(done)}


if __name__ == "__main__":
    c = LaresClient.connectApi()
    stages = [                                  # user policy — the stage graph
        {"name": "extract", "title": "extract", "kickoff": "extract; write /abs/out1", "depends_on": []},
        {"name": "transform", "title": "transform", "kickoff": "transform; write /abs/out2", "depends_on": ["extract"]},
    ]
    print(run_pipeline(c, stages, ledger_path=os.environ.get("LARES_LEDGER", ".runs/ledger.json")))

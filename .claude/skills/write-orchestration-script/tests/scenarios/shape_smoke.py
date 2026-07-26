#!/usr/bin/env python3
"""Python shape compose-smoke: drive the dispatcher through one item against the
mock's `happy` scenario, and import scheduler/deliberation/pipeline to prove they
load. Emits TRACE {"event":"smoke","ok":true}. TEST harness only."""

import importlib.util
import json
import os
import sys

_ASSETS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "assets", "python"))
sys.path.insert(0, _ASSETS)

from lares_client import LaresClient  # noqa: E402
import dispatcher  # noqa: E402


def _import(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_ASSETS, f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# import-load the other shapes (they must not auto-run under import)
for shape in ("scheduler", "deliberation", "pipeline"):
    _import(shape)

client = LaresClient.connectApi()
results = dispatcher.run_dispatcher(
    client, [{"id": "smoke-item"}],
    item_to_work=lambda item: {
        "payload": {"title": f"smoke {item['id']}", "provider": "claude", "isSupervised": True},
        "kickoff": "do smoke work; end with DONE",
        "artifact": None, "baseline_hash": None,
    },
    accept_token=lambda t: True,
    concurrency=1,
)
ok = len(results) == 1 and results[0]["agentId"] is not None
sys.stdout.write("TRACE " + json.dumps({"event": "smoke", "ok": ok, "results": results}) + "\n")
sys.exit(0 if ok else 1)

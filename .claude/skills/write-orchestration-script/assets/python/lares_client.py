#!/usr/bin/env python3
"""Lares orchestration — fixed-core HTTP client (Python).

This module is the FIXED CORE. It implements the invariant lifecycle from
`OrchestrationScriptStructure.md` §2 and the attribution contract of §1. Do NOT
edit helper bodies except transport/storage/error/packaging adaptation (which
requires re-running validation). All per-workflow policy lives in the SHAPE
templates (dispatcher.py, scheduler.py, deliberation.py, pipeline.py), never here.

Fixed-core symbols (normative §5 + §2, verbatim across languages):
    connectApi, launchAgent, waitReady, seedHighwater, confirmedSend, kickoff,
    waitTurnComplete, waitReceiverReady, relay, markRelayed, verifyArtifact,
    retire, reconcile, plus the composite `highwater` (ts+hash).

This file carries NO customization markers — it is pure fixed core.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


# ── Composite highwater (§2 step 5; anti-pattern: timestamp-only) ─────────────
@dataclass(frozen=True)
class Highwater:
    """Composite per-agent watermark: (timestamp, content-hash). Timestamp alone
    collides on same-ts messages (BUG); the hash disambiguates."""
    ts: str
    hash: str

    @staticmethod
    def of(message: dict[str, Any]) -> "Highwater":
        content = message.get("content") or ""
        ts = str(message.get("timestamp") or message.get("createdAt") or "")
        h = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
        return Highwater(ts=ts, hash=h)

    def is_older_than(self, message: dict[str, Any]) -> bool:
        """True when `message` is strictly newer than this highwater. Same ts +
        different hash counts as newer (composite), which timestamp-only misses."""
        other = Highwater.of(message)
        if other.ts != self.ts:
            return other.ts > self.ts
        return other.hash != self.hash


# ── Tunable bounds (bounded everything — §6). Test overrides via env. ─────────
def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


POLL_MS = _int_env("LARES_POLL_MS", 500)
READY_TIMEOUT_MS = _int_env("LARES_READY_TIMEOUT_MS", 120_000)
SOFT_STALL_MS = _int_env("LARES_SOFT_STALL_MS", 90_000)
HARD_DEADLINE_MS = _int_env("LARES_HARD_DEADLINE_MS", 600_000)
MAX_409_RETRIES = _int_env("LARES_MAX_409_RETRIES", 8)
MAX_SUBMIT_RECOVERY = _int_env("LARES_MAX_SUBMIT_RECOVERY", 3)
FLUSH_GRACE_MS = _int_env("LARES_FLUSH_GRACE_MS", 1500)
SUPERVISOR_409_RETRIES = _int_env("LARES_SUPERVISOR_409_RETRIES", 8)
STANDALONE_PORT_RANGE = (24678, 24679, 24680, 24681)  # §1.1 standalone only


class LaresError(RuntimeError):
    def __init__(self, message: str, status: Optional[int] = None, code: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code


def _sleep_ms(ms: int) -> None:
    time.sleep(ms / 1000.0)


def _now_ms() -> int:
    return int(time.time() * 1000)


# ── The client ────────────────────────────────────────────────────────────────
class LaresClient:
    def __init__(self, base_url: str, token: str, *, self_id: Optional[str],
                 workspace_id: Optional[str], supervisor_id: Optional[str] = None,
                 project_id: Optional[str] = None, standalone: bool = False):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.self_id = self_id
        self.workspace_id = workspace_id
        self.supervisor_id = supervisor_id
        self.project_id = project_id
        self.standalone = standalone

    # -- transport --------------------------------------------------------------
    def _headers(self, has_body: bool) -> dict[str, str]:
        # §1.2 four concerns: auth on EVERY request; scope headers only when the
        # env var exists; X-Self-Id is provenance ONLY (never scope/ownership).
        h = {"Authorization": f"Bearer {self.token}"}
        if has_body:
            h["Content-Type"] = "application/json"
        if self.self_id:
            h["X-Self-Id"] = self.self_id
        if self.workspace_id:
            h["X-Workspace-Id"] = self.workspace_id
        if self.supervisor_id:
            h["X-Supervisor-Id"] = self.supervisor_id
        if self.project_id:
            h["X-Project-Id"] = self.project_id
        return h

    def request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            self.base_url + path, data=data, method=method,
            headers=self._headers(body is not None),
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            code = None
            try:
                code = json.loads(raw).get("code")
            except Exception:
                pass
            raise LaresError(f"HTTP {e.code} {method} {path}: {raw[:200]}",
                             status=e.code, code=code) from None

    # -- 1. connectApi (§2 step 1) ---------------------------------------------
    @staticmethod
    def connectApi() -> "LaresClient":
        """Resolve the endpoint and fail closed. On-behalf mode (PORT injected):
        token+workspace+self are REQUIRED; a missing SELF_ID is FATAL (§1.1).
        Standalone mode: range-probe the STANDALONE_PORT_RANGE."""
        token = os.environ.get("AGENT_DASHBOARD_API_TOKEN")
        host = os.environ.get("AGENT_DASHBOARD_API_HOST", "127.0.0.1")
        workspace = os.environ.get("AGENT_DASHBOARD_WORKSPACE_ID")
        self_id = os.environ.get("AGENT_DASHBOARD_SELF_ID")
        supervisor = os.environ.get("AGENT_DASHBOARD_SUPERVISOR_ID")
        project = os.environ.get("AGENT_DASHBOARD_PROJECT_ID")
        injected_port = os.environ.get("AGENT_DASHBOARD_API_PORT")

        if injected_port:
            # On-behalf mode — fail closed on missing attribution.
            if not token:
                raise LaresError("on-behalf mode: AGENT_DASHBOARD_API_TOKEN required")
            if not workspace:
                raise LaresError("on-behalf mode: AGENT_DASHBOARD_WORKSPACE_ID required")
            if not self_id:
                raise LaresError(
                    "on-behalf mode: AGENT_DASHBOARD_SELF_ID missing — refusing to "
                    "launch UNOWNED agents (attribution contract §1.1)")
            client = LaresClient(f"http://{host}:{injected_port}", token,
                                 self_id=self_id, workspace_id=workspace,
                                 supervisor_id=supervisor, project_id=project)
            client._probe()
            return client

        # Standalone mode — deliberate, logged; range-probe is allowed ONLY here.
        if not token:
            raise LaresError("standalone mode: AGENT_DASHBOARD_API_TOKEN required")
        for port in STANDALONE_PORT_RANGE:
            candidate = LaresClient(f"http://{host}:{port}", token, self_id=self_id,
                                    workspace_id=workspace, supervisor_id=supervisor,
                                    project_id=project, standalone=True)
            try:
                candidate._probe()
                sys.stderr.write(f"[connectApi] standalone: bound port {port}\n")
                return candidate
            except Exception:
                continue
        raise LaresError(f"standalone: no Lares API on ports {STANDALONE_PORT_RANGE}")

    def _probe(self) -> None:
        agents = self.request("GET", "/api/agents")
        if not isinstance(agents, list):
            raise LaresError("GET /api/agents did not return a JSON array")

    # -- 3. launchAgent (§2 step 3, payload §1.3/§1.4) -------------------------
    def launchAgent(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Launch with the exact lane payload. NO task prompt goes here (§0.2);
        the kickoff is delivered post-launch via confirmed /input."""
        body = dict(payload)
        body.setdefault("workspaceId", self.workspace_id)
        # Forward SELF_ID verbatim as the ownership edge — safe to over-send; the
        # server re-validates and drops a stale/foreign edge, never throws (§1.4).
        if self.self_id and "owner_agent_id" not in body and "ownerAgentId" not in body:
            body["owner_agent_id"] = self.self_id
        agent = self.request("POST", "/api/agents", body)
        return agent

    # -- 4. waitReady (§2 step 4) ----------------------------------------------
    def waitReady(self, agent_id: str) -> dict[str, Any]:
        """Warm-up gate. Poll until idle/waiting; continue through permitted
        auto-restart; fail on done/crashed/disappearance/timeout. Distinct from
        waitReceiverReady."""
        deadline = _now_ms() + READY_TIMEOUT_MS
        while _now_ms() < deadline:
            agent = self._get_agent(agent_id)
            if agent is None:
                raise LaresError(f"waitReady: agent {agent_id} disappeared")
            status = agent.get("status")
            if status in ("idle", "waiting"):
                return agent
            if status in ("done", "crashed"):
                raise LaresError(f"waitReady: agent {agent_id} terminal ({status})")
            _sleep_ms(POLL_MS)
        raise LaresError(f"waitReady: timeout for {agent_id}")

    def _get_agent(self, agent_id: str) -> Optional[dict[str, Any]]:
        try:
            return self.request("GET", f"/api/agents/{agent_id}")
        except LaresError as e:
            if e.status == 404:
                return None
            raise

    def _newest_assistant(self, agent_id: str) -> Optional[dict[str, Any]]:
        msgs = self.request("GET", f"/api/agents/{agent_id}/messages?limit=1&role=assistant")
        if isinstance(msgs, list) and msgs:
            return msgs[0]
        return None

    # -- 5. seedHighwater (§2 step 5) ------------------------------------------
    def seedHighwater(self, agent_id: str, *, persisted: Optional[Highwater] = None) -> Highwater:
        """On a FRESH launch, seed from chat. On RESUME, preserve the persisted
        highwater — reseed from chat only if it is absent or corrupt. Reseeding a
        valid highwater re-stalls the run (BUG-06/BUG-37)."""
        if persisted is not None:
            return persisted  # do NOT reseed a valid highwater on resume
        newest = self._newest_assistant(agent_id)
        if newest is None:
            return Highwater(ts="", hash="")
        return Highwater.of(newest)

    # -- 6. confirmedSend / kickoff (§2 step 6) --------------------------------
    def confirmedSend(self, agent_id: str, text: str, *, pre_hw: Optional[Highwater] = None,
                      trace: Optional[Callable] = None) -> dict[str, Any]:
        """Deliver text with the confirm handshake. Handles 409 (waitReceiverReady
        + bounded retry) and confirmed:false (evidence-gated, submit-only Enter
        recovery — NEVER resend the full prompt on a mere confirmation timeout)."""
        attempts = 0
        while True:
            attempts += 1
            try:
                res = self.request("POST", f"/api/agents/{agent_id}/input", {
                    "text": text, "submit": True, "confirm": True,
                    "sender_agent_id": self.self_id,
                })
            except LaresError as e:
                if e.status == 409 and attempts <= MAX_409_RETRIES:
                    if trace:
                        trace("retry_after_409", {"id": agent_id, "attempt": attempts})
                    self.waitReceiverReady(agent_id)
                    _sleep_ms(POLL_MS)
                    continue
                raise  # 502 delivery/confirm throw ⇒ no turn will start
            if res.get("confirmed"):
                return {"confirmed": True, "full_sends": attempts}
            # delivered-unconfirmed (HTTP 200): NOT an automatic failure.
            recovered = self._recover_unconfirmed(agent_id, pre_hw, trace)
            return {"confirmed": False, "full_sends": attempts, "started": recovered}

    def _recover_unconfirmed(self, agent_id: str, pre_hw: Optional[Highwater],
                             trace: Optional[Callable]) -> bool:
        """Duplicate-send protection for confirmed:false. Re-press Enter only
        while still idle with NO turn-start evidence; never resend the prompt."""
        for _ in range(MAX_SUBMIT_RECOVERY):
            agent = self._get_agent(agent_id)
            status = agent.get("status") if agent else None
            if status in ("working", "done", "crashed"):
                return True  # a turn started (or terminal) — do nothing
            newest = self._newest_assistant(agent_id)
            if newest is not None and pre_hw is not None and pre_hw.is_older_than(newest):
                return True  # newer assistant activity ⇒ turn started invisibly
            # still idle, no evidence — submit-only Enter (NOT a full re-send)
            if trace:
                trace("enter_press", {"id": agent_id})
            self.request("POST", f"/api/agents/{agent_id}/keys", {"keys": "\r"})
            _sleep_ms(POLL_MS)
        return False

    def kickoff(self, agent_id: str, text: str, *, pre_hw: Optional[Highwater] = None,
                trace: Optional[Callable] = None) -> dict[str, Any]:
        """Deliver the task AFTER launch. Alias of confirmedSend that names the
        first delivery, so the kickoff is never a launch-time systemPrompt."""
        return self.confirmedSend(agent_id, text, pre_hw=pre_hw, trace=trace)

    # -- 7. waitTurnComplete (§2 step 7) ---------------------------------------
    def waitTurnComplete(self, agent_id: str, highwater: Highwater, *,
                         soft_ms: int = SOFT_STALL_MS, hard_ms: int = HARD_DEADLINE_MS,
                         trace: Optional[Callable] = None) -> dict[str, Any]:
        """Completion truth lives in the message stream, not status. Completion =
        a turnComplete message whose composite identity is newer than `highwater`.
        Status is used ONLY to hard-exit on crashed/done and to extend the soft
        deadline while demonstrably working. Returns {status:'complete'|'stalled',
        message?, highwater}."""
        start = _now_ms()
        soft_deadline = start + soft_ms
        hard_deadline = start + hard_ms
        while True:
            agent = self._get_agent(agent_id)
            status = agent.get("status") if agent else None
            if status in ("done", "crashed"):
                # Terminal — but a completed message may still be the deliverable.
                newest = self._newest_assistant(agent_id)
                if newest and newest.get("turnComplete") and highwater.is_older_than(newest):
                    return {"status": "complete", "message": newest, "highwater": Highwater.of(newest)}
                raise LaresError(f"waitTurnComplete: {agent_id} terminal ({status}) with no new turn")
            newest = self._newest_assistant(agent_id)
            if newest and newest.get("turnComplete") and highwater.is_older_than(newest):
                if trace:
                    trace("turn_complete", {"id": agent_id, "hw": _hw_str(Highwater.of(newest))})
                return {"status": "complete", "message": newest, "highwater": Highwater.of(newest)}
            now = _now_ms()
            if status == "working":
                soft_deadline = now + soft_ms  # demonstrably working extends soft
            if now >= hard_deadline or now >= soft_deadline:
                if trace:
                    trace("stall", {"id": agent_id, "status": status})
                return {"status": "stalled", "message": None, "highwater": highwater}
            _sleep_ms(POLL_MS)

    # -- 8. waitReceiverReady + relay (§2 step 8) ------------------------------
    def waitReceiverReady(self, agent_id: str) -> dict[str, Any]:
        """Gate before EVERY cross-agent send. Poll to idle/waiting; hard-exit on
        crashed/done. Prevents the BUG-17b 409 crash that orphans agents."""
        deadline = _now_ms() + READY_TIMEOUT_MS
        while _now_ms() < deadline:
            agent = self._get_agent(agent_id)
            if agent is None:
                raise LaresError(f"waitReceiverReady: {agent_id} disappeared")
            status = agent.get("status")
            if status in ("idle", "waiting"):
                return agent
            if status in ("done", "crashed"):
                raise LaresError(f"waitReceiverReady: {agent_id} terminal ({status})")
            _sleep_ms(POLL_MS)
        raise LaresError(f"waitReceiverReady: timeout for {agent_id}")

    def markRelayed(self, highwaters: dict[str, Highwater], agent_id: str,
                    hw: Highwater) -> None:
        """Advance a participant's highwater. MUST be called for every consumed
        turn — even one whose content is not forwarded — or a completed turn will
        be re-relayed (stale-turn bug, §3 parallel-round)."""
        highwaters[agent_id] = hw

    def relay(self, from_id: str, to_id: str, content: str, *,
              trace: Optional[Callable] = None) -> dict[str, Any]:
        """Forward peer content with preserved provenance, via the pre-send gate
        and confirmedSend."""
        self.waitReceiverReady(to_id)
        framed = f"[from {from_id}]\n{content}"
        if trace:
            trace("relay", {"from": from_id, "to": to_id})
        return self.confirmedSend(to_id, framed, trace=trace)

    # -- 9. verifyArtifact / deliverable (§2 step 9) ---------------------------
    @staticmethod
    def verifyArtifact(path: str, *, baseline_hash: Optional[str] = None,
                       min_bytes: int = 1, grace_ms: int = FLUSH_GRACE_MS,
                       predicate: Optional[Callable[[str], bool]] = None) -> dict[str, Any]:
        """A token is NOT success. Verify existence + content + freshness/hash
        change after a bounded flush grace. A stale artifact already at the target
        path is NOT success."""
        _sleep_ms(grace_ms)
        if not os.path.exists(path):
            return {"ok": False, "reason": "missing"}
        with open(path, "rb") as f:
            data = f.read()
        if len(data) < min_bytes:
            return {"ok": False, "reason": "empty"}
        digest = hashlib.sha256(data).hexdigest()
        if baseline_hash is not None and digest == baseline_hash:
            return {"ok": False, "reason": "stale", "hash": digest}
        if predicate is not None and not predicate(data.decode("utf-8", "replace")):
            return {"ok": False, "reason": "predicate", "hash": digest}
        return {"ok": True, "reason": "fresh", "hash": digest}

    @staticmethod
    def verifyToken(messages: list[dict], accept: Callable[[str], bool]) -> Optional[str]:
        """Validate a status token NEWEST-FIRST so an early retry's stale token
        cannot shadow the final verdict (§2 step 9)."""
        for msg in messages:  # caller passes newest-first
            content = msg.get("content") or ""
            for tok in ("PASS", "FAIL", "CONSENSUS", "APPROVED", "REJECTED",
                        "SKILL_BUILD_OK", "DONE"):
                if tok in content and accept(tok):
                    return tok
        return None

    def readMessages(self, agent_id: str, limit: int = 10) -> list[dict]:
        msgs = self.request("GET", f"/api/agents/{agent_id}/messages?limit={limit}&role=assistant")
        return msgs if isinstance(msgs, list) else []

    # -- 10. retire / terminal-policy dispatch (§2 step 10) --------------------
    def retire(self, terminal_state: str, members: list[str], *,
               keep_agents: bool = False, trace: Optional[Callable] = None) -> dict[str, Any]:
        """Cleanup is terminal-state-specific; it is NOT an unconditional finally
        delete. A recoverable stall leaves members ALIVE (do not delete the very
        ids named by resume_hint)."""
        survivors: list[str] = []
        if terminal_state == "stalled":
            # Recoverable — leave alive by default; persist + emit resume_hint.
            for m in members:
                if trace:
                    trace("retain", {"id": m})
            survivors = list(members)
            return {"retired": [], "retained": survivors}
        if keep_agents and terminal_state == "complete":
            return {"retired": [], "retained": list(members)}
        retired: list[str] = []
        for m in reversed(members):  # reverse launch order
            try:
                self.request("DELETE", f"/api/agents/{m}")
                if trace:
                    trace("delete", {"id": m})
                retired.append(m)
            except LaresError as e:
                survivors.append(m)
                sys.stderr.write(f"[retire] failed to delete {m} (surviving): {e}\n")
        return {"retired": retired, "retained": survivors}

    # -- 11. reconcile / resume + terminal notification (§2 step 11) -----------
    def resumeHint(self, run_id: str, phase: str, members: list[str],
                   params: Optional[dict] = None) -> dict[str, Any]:
        """Machine-readable resume descriptor: command/tool, runId, member ids,
        phase/round, and required parameters."""
        return {
            "kind": "resume_hint", "runId": run_id, "phase": phase,
            "members": members, "params": params or {},
        }

    def deliverToSupervisor(self, text: str, *, sentinel_path: str,
                            trace: Optional[Callable] = None) -> dict[str, Any]:
        """Terminal/stall notice to the supervisor must survive its protective
        working-latch (409s while working). Poll→ready, POST /input, retry on 409;
        on persistent failure write a sentinel file so the result is not lost, then
        proceed with cleanup anyway. (Recommended CLI convention, not an HTTP
        invariant.)"""
        sup = self.supervisor_id
        if not sup:
            _write_sentinel(sentinel_path, {"reason": "no-supervisor", "text": text})
            if trace:
                trace("sentinel", {"path": sentinel_path})
            return {"delivered": False, "sentinel": sentinel_path}
        for attempt in range(1, SUPERVISOR_409_RETRIES + 1):
            try:
                self.waitReceiverReady(sup)
                self.request("POST", f"/api/agents/{sup}/input",
                             {"text": text, "submit": True, "sender_agent_id": self.self_id})
                return {"delivered": True, "attempts": attempt}
            except LaresError as e:
                if e.status == 409 and attempt < SUPERVISOR_409_RETRIES:
                    _sleep_ms(POLL_MS)
                    continue
                break
        _write_sentinel(sentinel_path, {"reason": "undelivered", "text": text})
        if trace:
            trace("sentinel", {"path": sentinel_path})
        return {"delivered": False, "sentinel": sentinel_path}

    def reconcile(self, run_state: dict[str, Any]) -> dict[str, Any]:
        """Restore members, phase, retry counters, baselines, and highwaters;
        NEVER reseed a valid highwater; detect terminal/missing members."""
        restored = {"phase": run_state.get("phase"), "members": [], "missing": []}
        for m in run_state.get("members", []):
            agent = self._get_agent(m)
            if agent is None or agent.get("status") in ("done", "crashed"):
                restored["missing"].append(m)
            else:
                restored["members"].append(m)
        return restored


def _hw_str(hw: Highwater) -> str:
    return f"{hw.ts}|{hw.hash}"


def _write_sentinel(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


# ── Exit-code convention (CLI templates, §2 step 11): 0 ok · 2 stall · 1 crash.
EXIT_OK, EXIT_STALL, EXIT_CRASH = 0, 2, 1


if __name__ == "__main__":
    # This module is a LIBRARY. The behavioral suite drives it through a separate
    # per-language driver (tests/scenarios/driver.py) that imports these symbols.
    sys.stderr.write("lares_client.py is a fixed-core library — import it.\n")
    sys.exit(64)

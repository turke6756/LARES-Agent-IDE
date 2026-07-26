#!/usr/bin/env node
// run_evals.mjs — deterministic trigger-fixture checks ONLY (spec §H). Asserts
// the skill's intended routing on fixtures under tests/triggers/; does NOT create
// provider sessions. Fresh-agent evals are a separate integration harness (§H).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRIG = path.join(__dirname, '..', 'tests', 'triggers');
const fails = [];

function load(name) {
  const p = path.join(TRIG, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
}

// Routing heuristic mirrors SKILL.md's decision gate (§0): authoring an external
// script → this skill; running/monitoring a built-in groupthink → run-orchestration.
function routes(text) {
  const t = text.toLowerCase();
  const runOrch = /(run|start|monitor|check).*(groupthink|built-in|in-process|orchestration run)|call run_orchestration/.test(t);
  const authoring = /(write|author|scaffold|review|debug|convert).*(script|dispatcher|scheduler|pipeline|deliberation|orchestrat)/.test(t)
    || /(fan-out|relay script|bash loop)/.test(t);
  if (runOrch && !authoring) return 'run-orchestration';
  if (authoring) return 'write-orchestration-script';
  return 'other';
}

for (const { text, expect } of load('positive.json')) {
  const got = routes(text);
  if (got !== expect) fails.push(`positive: "${text}" → ${got}, expected ${expect}`);
}
for (const { text, expect } of load('negative.json')) {
  const got = routes(text);
  if (got !== expect) fails.push(`negative: "${text}" → ${got}, expected ${expect}`);
}

if (fails.length) {
  process.stderr.write(`FAIL (${fails.length}):\n${fails.map((f) => '  ' + f).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('OK\n');

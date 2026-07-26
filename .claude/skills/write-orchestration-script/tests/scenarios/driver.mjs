// Behavioral scenario driver (Node). Imports the fixed-core client as a library
// and drives it through one §G scenario against the mock, emitting `TRACE <json>`
// lines validate_templates.mjs parses into semantic partial-order assertions.
// TEST harness only — never shipped as an asset, never a live dashboard.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientMod = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'assets', 'node', 'lares-client.mjs')).href);
const { LaresClient, Highwater } = clientMod;

const emit = (event, data = {}) => process.stdout.write('TRACE ' + JSON.stringify({ event, ...data }) + '\n');
const trace = (event, data) => emit(event, data);
const tmpdir = () => {
  const d = process.env.LARES_TMPDIR || '.';
  fs.mkdirSync(d, { recursive: true });
  return d;
};

async function boot(client, supervised = true) {
  const a = await client.launchAgent({ title: 'worker', isSupervised: supervised });
  emit('launch', { id: a.id });
  await client.waitReady(a.id);
  emit('ready', { id: a.id });
  return a.id;
}

const scenarios = {
  async '1'(client) {
    const aid = await boot(client);
    const hw = await client.seedHighwater(aid);
    emit('seed', { id: aid, hw: hw.toString(), reseed: false });
    const res = await client.kickoff(aid, 'KICKOFF TASK', { preHw: hw, trace });
    emit('kickoff', { id: aid, confirmed: res.confirmed, full_sends: res.fullSends });
    const tc = await client.waitTurnComplete(aid, hw, { trace });
    emit('result', { id: aid, status: tc.status });
  },
  async '2'(client) {
    const aid = await boot(client);
    const hw = await client.seedHighwater(aid);
    emit('seed', { id: aid, hw: hw.toString(), reseed: false });
    const res = await client.kickoff(aid, 'KICKOFF TASK', { preHw: hw, trace });
    emit('kickoff', { id: aid, confirmed: res.confirmed, full_sends: res.fullSends, started: res.started });
  },
  async '3'(client) {
    const aid = await boot(client);
    const hw = await client.seedHighwater(aid);
    emit('seed', { id: aid, hw: hw.toString(), reseed: false });
    const res = await client.kickoff(aid, 'ROUND 1', { preHw: hw, trace });
    emit('kickoff', { id: aid, confirmed: res.confirmed, full_sends: res.fullSends });
    const hws = {};
    const tc1 = await client.waitTurnComplete(aid, hw, { trace });
    client.markRelayed(hws, aid, tc1.highwater);
    emit('mark_relayed', { id: aid, hw: tc1.highwater.toString() });
    await client.confirmedSend(aid, 'ROUND 2', { preHw: tc1.highwater, trace });
    const tc2 = await client.waitTurnComplete(aid, tc1.highwater, { trace });
    emit('mark_relayed', { id: aid, hw: tc2.highwater.toString() });
  },
  async '4'(client) {
    const persisted = new Highwater('400', 'cafef00dcafef00d');
    const aid = await boot(client);
    const hw = await client.seedHighwater(aid, { persisted });
    emit('seed', { id: aid, hw: hw.toString(), persisted: persisted.toString(),
      reseed: hw.toString() !== persisted.toString() });
  },
  async '5'(client) {
    const aid = await boot(client);
    const hw = await client.seedHighwater(aid);
    emit('seed', { id: aid, hw: hw.toString(), reseed: false });
    const res = await client.kickoff(aid, 'KICKOFF TASK', { preHw: hw, trace });
    emit('kickoff', { id: aid, confirmed: res.confirmed, full_sends: res.fullSends });
    const tc = await client.waitTurnComplete(aid, hw, { trace });
    emit('result', { id: aid, status: tc.status });
  },
  async '6'(client) {
    const aid = await boot(client);
    const msgs = await client.readMessages(aid, 10);
    const tok = LaresClient.verifyToken(msgs, (t) => t === 'PASS' || t === 'FAIL');
    emit('token', { value: tok });
  },
  async '7'(client) {
    await boot(client);
    const p = path.join(tmpdir(), 'artifact.txt');
    fs.writeFileSync(p, 'baseline v1');
    const baseline = crypto.createHash('sha256').update('baseline v1').digest('hex');
    const rStale = await LaresClient.verifyArtifact(p, { baselineHash: baseline, graceMs: 0 });
    emit('verify', { case: 'stale', ok: rStale.ok, reason: rStale.reason });
    fs.writeFileSync(p, 'updated v2 — fresh content');
    const rFresh = await LaresClient.verifyArtifact(p, { baselineHash: baseline, graceMs: 0 });
    emit('verify', { case: 'fresh', ok: rFresh.ok, reason: rFresh.reason });
  },
  async '8'(client) {
    const aid = await boot(client);
    const hw = await client.seedHighwater(aid);
    emit('seed', { id: aid, hw: hw.toString(), reseed: false });
    const res = await client.kickoff(aid, 'KICKOFF TASK', { preHw: hw, trace });
    emit('kickoff', { id: aid, confirmed: res.confirmed, full_sends: res.fullSends });
    const tc = await client.waitTurnComplete(aid, hw, { softMs: 800, hardMs: 1200, trace });
    emit('classified', { id: aid, status: tc.status });
    await client.retire('stalled', [aid], { trace });
    const hint = client.resumeHint('run-x', 'phase-1', [aid], { round: 1 });
    emit('resume_hint', { members: hint.members, phase: hint.phase });
  },
  async '9'(client) {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const a = await client.launchAgent({ title: `w${i}`, isSupervised: true });
      emit('launch', { id: a.id });
      await client.waitReady(a.id);
      ids.push(a.id);
    }
    await client.retire('complete', ids, { trace });
  },
  async '10'(client) {
    const sup = await client.launchAgent({ title: 'supervisor', isSupervisor: true });
    emit('launch', { id: sup.id });
    await client.waitReady(sup.id);
    client.supervisorId = sup.id;
    const sentinel = path.join(tmpdir(), 'undelivered.json');
    const r = await client.deliverToSupervisor('terminal notice for supervisor', { sentinelPath: sentinel, trace });
    emit('delivery', { delivered: r.delivered, sentinel: r.sentinel, exists: fs.existsSync(sentinel) });
  },
};

const idx = process.argv.indexOf('--scenario');
const name = idx >= 0 ? process.argv[idx + 1] : null;
if (!name || !scenarios[name]) {
  process.stderr.write(`usage: driver.mjs --scenario <1..10>\n`);
  process.exit(64);
}
const client = await LaresClient.connectApi();
await scenarios[name](client);

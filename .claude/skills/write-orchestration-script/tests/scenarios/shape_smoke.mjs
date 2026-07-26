// Node shape compose-smoke: drive the dispatcher through one item against the
// mock's `happy` scenario (client → launch → kickoff → complete → retire), and
// exercise the control-skeleton import. Emits TRACE {event:"smoke",ok:true}.
// TEST harness only.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(__dirname, '..', '..', 'assets', 'node');
const url = (f) => pathToFileURL(path.join(base, f)).href;
const { LaresClient } = await import(url('lares-client.mjs'));
const dispatcher = await import(url('dispatcher.mjs'));
await import(url('control-skeleton.mjs')); // import-loads (no auto-run)

const client = await LaresClient.connectApi();
// token-only deliverable (no artifact) — the happy mock ends turns with a message.
const results = await dispatcher.runDispatcher(client, [{ id: 'smoke-item' }], {
  itemToWork: (item) => ({
    payload: { title: `smoke ${item.id}`, provider: 'claude', isSupervised: true },
    kickoff: 'do smoke work; end with DONE',
    artifact: null,
    baselineHash: null,
  }),
  acceptToken: () => true, // happy mock returns "done"; accept any completion token
  concurrency: 1,
});
const ok = results.length === 1 && results[0].agentId != null;
process.stdout.write('TRACE ' + JSON.stringify({ event: 'smoke', ok, results }) + '\n');
process.exit(ok ? 0 : 1);

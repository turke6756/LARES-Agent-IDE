// memory-review-channel-isolation.test.js — WP-H1 renderer-only boundary.
//
// The `memory:listReview` channel (and the WP-H1 review-read surface generally)
// MUST be reachable ONLY from the renderer over Electron IPC. This test fails
// if anyone ever leaks it into:
//   - the `memory` or `migration` MCP toolsets (agent-callable tool names), or
//   - any MCP tool module / the toolset registry, or
//   - the api-server HTTP routes.
//
// It is BOTH registry-based (enumerates the real MCP tool definitions and
// asserts no tool name is the channel) and grep-based (asserts the channel
// literal is absent from the agent-facing source, and — as a meaningfulness
// guard — PRESENT in the renderer-side seam, so a silent rename can't pass it).
//
//   node scripts/memory-review-channel-isolation.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The single source of truth for the channel names (compiled from memory-ipc.ts).
const { MEMORY_REVIEW_CHANNELS } = require(
  path.join(ROOT, 'dist/main/main/memory-index/memory-ipc.js'),
);
const CHANNEL = MEMORY_REVIEW_CHANNELS.listReview;
// Every renderer-only memory channel: the WP-H1 read + the WP-H2 janitor
// siblings + the WP-H3 human-only graduation approve/reject + migration approval.
// The isolation invariant is identical for all of them.
const ALL_CHANNELS = Object.values(MEMORY_REVIEW_CHANNELS);
// The bare (un-prefixed) tokens each channel must never leak into agent source.
const BARE_TOKENS = [
  'listReview',
  'generateJanitorBrief',
  'dispatchJanitor',
  'graduationApprove',
  'graduationReject',
  'migrationApprove',
];

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n`, e); }
}

// ── The channels are real, well-formed values ─────────────────────────────
test('channel constants are the expected renderer-only strings', () => {
  assert.equal(CHANNEL, 'memory:listReview');
  assert.equal(MEMORY_REVIEW_CHANNELS.generateJanitorBrief, 'memory:generateJanitorBrief');
  assert.equal(MEMORY_REVIEW_CHANNELS.dispatchJanitor, 'memory:dispatchJanitor');
  assert.equal(MEMORY_REVIEW_CHANNELS.graduationApprove, 'memory:graduationApprove');
  assert.equal(MEMORY_REVIEW_CHANNELS.graduationReject, 'memory:graduationReject');
  assert.equal(MEMORY_REVIEW_CHANNELS.migrationApprove, 'memory:migrationApprove');
});

// ── Registry-based: no MCP tool advertises any of these channels ──────────
test('no memory/migration MCP tool name is a renderer-only memory channel', () => {
  const memoryTools = require(path.join(ROOT, 'scripts/mcp-tools-memory.js')).getMemoryToolDefinitions();
  const migrationTools = require(path.join(ROOT, 'scripts/mcp-tools-migration.js')).getMigrationToolDefinitions();
  const names = [...memoryTools, ...migrationTools].map((t) => t.name);
  for (const n of names) {
    for (const ch of ALL_CHANNELS) {
      assert.notEqual(n, ch, `MCP tool must not be the channel: ${n}`);
      assert.notEqual(n, ch.replace('memory:', ''), `MCP tool must not be ${ch}: ${n}`);
    }
    // Belt and suspenders — no tool advertises the review read or janitor verbs.
    assert.ok(!/listreview|janitor/i.test(n), `MCP tool name leaks a renderer-only channel: ${n}`);
  }
  // Sanity: the memory toolset really is the WP-D recall surface we expect, so
  // this assertion is checking a populated registry, not an empty one.
  assert.ok(names.includes('recall_memory'), 'memory toolset present (recall_memory)');
});

// ── Grep-based: no channel literal appears in any agent-facing seam ────────
const AGENT_FACING = [
  'scripts/mcp-tools-memory.js',
  'scripts/mcp-tools-migration.js',
  'scripts/mcp-dashboard.js',
  'src/main/api-server.ts',
];
test('channel literals appear in NO MCP tool module, the registry, or api-server', () => {
  for (const rel of AGENT_FACING) {
    const src = read(rel);
    for (const ch of ALL_CHANNELS) {
      assert.ok(!src.includes(ch), `${rel} must not reference ${ch}`);
    }
    for (const tok of BARE_TOKENS) {
      assert.ok(!src.includes(tok), `${rel} must not reference ${tok}`);
    }
  }
});

// ── Meaningfulness guard: every channel IS wired on the renderer-only seam ─
// If a future edit renamed a channel and simultaneously leaked it into an agent
// path, the grep above would still pass against the OLD literal; anchoring on the
// renderer seam with the SAME constants keeps the test honest.
test('channel literals are present in the renderer-only seam (main IPC + preload)', () => {
  const ipc = read('src/main/memory-index/memory-ipc.ts');
  const preload = read('src/preload/index.ts');
  for (const ch of ALL_CHANNELS) {
    assert.ok(ipc.includes(ch), `memory-ipc.ts registers ${ch}`);
    assert.ok(preload.includes(ch), `preload exposes ${ch}`);
  }
});

if (failed > 0) { console.error(`\n${failed} failed`); process.exit(1); }
console.log(`\nmemory-review-channel-isolation.test: passed`);

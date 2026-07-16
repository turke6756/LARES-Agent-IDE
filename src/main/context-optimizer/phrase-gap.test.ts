// phrase-gap unit tests (A9, hardening-classifier-agent-surface §3).
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/phrase-gap.test.js
//
// Coverage: the byte-stable tokenize/redact pipeline; corpus df + cross-session
// stream support; the section gate + per-term floors; integer basis-point
// gap/lift scoring (incl. the pure-bypass lift=999999 case and the
// disproportionate-but-not-absent case); the full deterministic tie-break +
// MAX_TERMS cap; the engine-DTO mapping. Plus the two REQUIRED tests:
//   • acceptance determinism — same corpus (any row order) → byte-identical output
//   • structural no-LLM-import — the shipped source imports nothing LLM/network.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OPTIMIZER_CONFIG } from './optimizer-config';
import {
  computePhraseGap,
  tokenize,
  redactAndCasefold,
  toProposalPhraseGap,
  buildPhraseGapByScript,
  type PhraseGapInput,
  type PhraseGapSnippet,
} from './phrase-gap';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

let hashSeq = 0;
/** A snippet row with an explicit hash + stream. If hash omitted, a fresh unique
 *  hash is minted (distinct document). */
function snip(text: string, streamId: string, snippetHash?: string): PhraseGapSnippet {
  return { snippet: text, streamId, snippetHash: snippetHash ?? `h${hashSeq++}` };
}

/** The canonical read-comments fixture: users who BYPASSED said "notes" /
 *  "annotations"; the INVOCATION vocabulary is "comments". */
function readCommentsInput(): PhraseGapInput {
  return {
    skillName: 'read-comments',
    lane: 'supervisor',
    scriptPath: '/w/.claude/skills/read-comments/run.py',
    invocation: [
      snip('read the comments on this document', 's1', 'iv1'),
      snip('read comments please', 's1', 'iv2'),
      snip('show me the comments', 's2', 'iv3'),
      snip('read comments', 's2', 'iv4'),
      snip('comments review', 's3', 'iv5'),
    ],
    bypass: [
      snip('add my notes and annotations here', 's10', 'bp1'),
      snip('these notes need review', 's10', 'bp2'),
      snip('my annotations on the notes', 's11', 'bp3'),
      snip('notes please', 's11', 'bp4'),
      snip('leave notes for me', 's12', 'bp5'),
      snip('annotations matter', 's12', 'bp6'),
    ],
  };
}

// ── tokenization (§3.2) ───────────────────────────────────────────────────────

check('tokenize: lowercases, drops stopwords, keeps content words', () => {
  assert.deepEqual(tokenize('Read THE Comments on this Document'),
    ['read', 'comments', 'document']);
});

check('tokenize: strips possessive \'s and edge quotes/hyphens', () => {
  assert.deepEqual(tokenize("Edward's -notes- 'review'"), ['edward', 'notes', 'review']);
});

check('tokenize: drops numeric-only and short tokens, keeps short allowlist', () => {
  // "42" numeric-only → drop; "ab" short → drop; "ci"/"db" allowlisted → keep.
  assert.deepEqual(tokenize('run 42 ab the ci db pipeline'), ['run', 'ci', 'db', 'pipeline']);
});

check('redactAndCasefold: strips urls, emails, uuids, paths, hex, KEY=value', () => {
  const raw =
    'see https://x.io/p and mail a@b.com id 123e4567-e89b-12d3-a456-426614174000 ' +
    'path C:\\Users\\ed\\secret.txt unix /home/ed/key.pem hex deadbeefdeadbeef ' +
    'TOKEN=hunter2 keep words';
  const toks = tokenize(raw);
  // none of the redacted material survives as a token…
  for (const bad of ['https', 'com', 'users', 'secret', 'home', 'deadbeefdeadbeef',
    'hunter2', 'token', 'pem', '426614174000']) {
    assert.ok(!toks.includes(bad), `leaked redacted token: ${bad}`);
  }
  // …but the plain trailing words do.
  assert.ok(toks.includes('keep') && toks.includes('words'));
  // sanity: redaction runs on the lowercased string.
  assert.ok(!/secret/.test(redactAndCasefold('C:\\Users\\ed\\secret.txt')));
});

// ── df + gap/lift scoring (§3.2–§3.3) ─────────────────────────────────────────

check('computePhraseGap: surfaces the pure-bypass gap terms, correctly scored', () => {
  const gap = computePhraseGap(readCommentsInput());
  assert.equal(gap.status, 'ok');
  assert.equal(gap.invocationDocs, 5);
  assert.equal(gap.bypassDocs, 6);
  assert.deepEqual(gap.terms.map((t) => t.term), ['notes', 'annotations']);

  const notes = gap.terms[0];
  assert.equal(notes.bypassDf, 5);
  assert.equal(notes.bypassStreams, 3);
  assert.equal(notes.invokeDf, 0);
  assert.equal(notes.gapBps, 8333);   // floor(10000 * 5/6)
  assert.equal(notes.liftBps, 999999); // invokeDf 0 → pure-bypass sentinel

  const ann = gap.terms[1];
  assert.equal(ann.bypassDf, 3);
  assert.equal(ann.gapBps, 5000);      // floor(10000 * 3/6)
  assert.equal(ann.liftBps, 999999);
});

check('computePhraseGap: disproportionate-but-not-absent term (finite lift)', () => {
  // "flag" appears in 1/4 invocation docs and 4/8 bypass docs → gap 2500, lift 20000.
  const input: PhraseGapInput = {
    skillName: 's', lane: 'worker', scriptPath: '/x/run.sh',
    invocation: [
      snip('flag config', 'a', 'i1'),
      snip('config only', 'a', 'i2'),
      snip('config change', 'b', 'i3'),
      snip('config value', 'b', 'i4'),
    ],
    bypass: [
      snip('flag on', 'a', 'b1'), snip('flag it', 'a', 'b2'),
      snip('flag please', 'b', 'b3'), snip('flag now', 'b', 'b4'),
      snip('config here', 'a', 'b5'), snip('config there', 'a', 'b6'),
      snip('config gone', 'b', 'b7'), snip('config again', 'b', 'b8'),
    ],
  };
  const gap = computePhraseGap(input);
  const flag = gap.terms.find((t) => t.term === 'flag');
  assert.ok(flag, 'flag should qualify');
  assert.equal(flag!.invokeDf, 1);
  assert.equal(flag!.bypassDf, 4);
  assert.equal(flag!.gapBps, 2500);   // floor(10000 * (0.5 - 0.25))
  assert.equal(flag!.liftBps, 20000); // floor(10000 * 0.5 / 0.25)
});

// ── floors / gates (§3.3) ─────────────────────────────────────────────────────

check('section gate: too few bypass docs → insufficient-phrase-evidence', () => {
  const input = readCommentsInput();
  input.bypass = input.bypass.slice(0, 4); // 4 < PHRASE_GAP_MIN_BYPASS_SNIPPETS(5)
  const gap = computePhraseGap(input);
  assert.equal(gap.status, 'insufficient-phrase-evidence');
  assert.deepEqual(gap.terms, []);
});

check('section gate: too few invocation docs → insufficient-phrase-evidence', () => {
  const input = readCommentsInput();
  input.invocation = input.invocation.slice(0, 2); // 2 < MIN(3)
  assert.equal(computePhraseGap(input).status, 'insufficient-phrase-evidence');
});

check('term gate: single-stream bypass term is dropped (cross-session guard)', () => {
  // "solo" appears twice but on ONE stream → bypassStreams 1 < MIN(2) → dropped.
  const input: PhraseGapInput = {
    skillName: 's', lane: 'worker', scriptPath: '/x/run.sh',
    invocation: [snip('alpha', 'a', 'i1'), snip('beta', 'a', 'i2'), snip('gamma', 'a', 'i3')],
    bypass: [
      snip('solo word', 'z', 'b1'), snip('solo word', 'z', 'b2'),
      snip('other', 'y', 'b3'), snip('more', 'x', 'b4'), snip('again', 'w', 'b5'),
    ],
  };
  const gap = computePhraseGap(input);
  assert.equal(gap.status, 'ok');
  assert.ok(!gap.terms.some((t) => t.term === 'solo'));
});

check('term gate: below gap-bps floor is dropped', () => {
  // "even" appears in 2/5 bypass and 2/5 invocation → gapBps 0 < MIN(1500).
  const input: PhraseGapInput = {
    skillName: 's', lane: 'worker', scriptPath: '/x/run.sh',
    invocation: [
      snip('even keel', 'a', 'i1'), snip('even split', 'b', 'i2'),
      snip('other one', 'a', 'i3'), snip('other two', 'b', 'i4'), snip('other three', 'a', 'i5'),
    ],
    bypass: [
      snip('even more', 'a', 'b1'), snip('even less', 'b', 'b2'),
      snip('filler one', 'a', 'b3'), snip('filler two', 'b', 'b4'), snip('filler three', 'a', 'b5'),
    ],
  };
  assert.ok(!computePhraseGap(input).terms.some((t) => t.term === 'even'));
});

// ── tie-break + cap (§3.3) ────────────────────────────────────────────────────

check('MAX_TERMS cap + gapBps-DESC ordering', () => {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot',
    'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']; // 12 candidates
  const DOCS = 20;
  const bypass: PhraseGapSnippet[] = [];
  for (let d = 0; d < DOCS; d++) {
    // doc d contains wordK for every k with df(k)=DOCS-k > d  → gaps strictly decrease.
    const inDoc = words.filter((_, k) => DOCS - k > d);
    bypass.push(snip(inDoc.join(' '), `s${d % 2}`, `b${d}`)); // 2 streams → clears stream floor
  }
  const input: PhraseGapInput = {
    skillName: 's', lane: 'worker', scriptPath: '/x/run.sh',
    invocation: [snip('zeta', 'a', 'i1'), snip('zeta', 'b', 'i2'), snip('zeta', 'c', 'i3')],
    bypass,
  };
  const gap = computePhraseGap(input);
  assert.equal(gap.terms.length, OPTIMIZER_CONFIG.PHRASE_GAP_MAX_TERMS); // 10, not 12
  assert.deepEqual(gap.terms.map((t) => t.term), words.slice(0, 10));
});

check('tie-break: equal gap+lift falls back to token ASC', () => {
  // "banana" and "apple" each appear in 2/6 bypass docs, 0 invocation → identical
  // gap+lift → alphabetical: apple before banana.
  const input: PhraseGapInput = {
    skillName: 's', lane: 'worker', scriptPath: '/x/run.sh',
    invocation: [snip('zeta', 'a', 'i1'), snip('zeta', 'b', 'i2'), snip('zeta', 'c', 'i3')],
    bypass: [
      snip('banana apple', 's0', 'b1'), snip('banana apple', 's1', 'b2'),
      snip('padone', 's0', 'b3'), snip('padtwo', 's1', 'b4'),
      snip('padthree', 's0', 'b5'), snip('padfour', 's1', 'b6'),
    ],
  };
  const gap = computePhraseGap(input);
  assert.deepEqual(gap.terms.map((t) => t.term), ['apple', 'banana']);
});

// ── REQUIRED: acceptance determinism ──────────────────────────────────────────

check('acceptance determinism: same corpus, any row order → byte-identical output', () => {
  const a = computePhraseGap(readCommentsInput());

  const shuffled = readCommentsInput();
  shuffled.bypass = [...shuffled.bypass].reverse();
  shuffled.invocation = [shuffled.invocation[2], shuffled.invocation[0],
    shuffled.invocation[4], shuffled.invocation[1], shuffled.invocation[3]];
  const b = computePhraseGap(shuffled);

  assert.equal(JSON.stringify(a), JSON.stringify(b), 'output must be row-order-invariant');
  // and re-running the identical input is byte-identical too.
  assert.equal(JSON.stringify(a), JSON.stringify(computePhraseGap(readCommentsInput())));
});

// ── engine DTO mapping ────────────────────────────────────────────────────────

check('toProposalPhraseGap: maps df to bypassCount/invocationCount', () => {
  const dto = toProposalPhraseGap(computePhraseGap(readCommentsInput()));
  assert.deepEqual(dto, {
    terms: [
      { term: 'notes', bypassCount: 5, invocationCount: 0, gapBps: 8333, liftBps: 999999 },
      { term: 'annotations', bypassCount: 3, invocationCount: 0, gapBps: 5000, liftBps: 999999 },
    ],
  });
});

check('toProposalPhraseGap: insufficient status → null (caller omits key)', () => {
  const input = readCommentsInput();
  input.bypass = input.bypass.slice(0, 3);
  assert.equal(toProposalPhraseGap(computePhraseGap(input)), null);
});

check('buildPhraseGapByScript: keys ok units by scriptPath, omits insufficient', () => {
  const ok = readCommentsInput();
  const thin: PhraseGapInput = {
    skillName: 'thin', lane: 'worker', scriptPath: '/x/thin.sh',
    invocation: [snip('a', 'a', 'i1'), snip('b', 'b', 'i2'), snip('c', 'c', 'i3')],
    bypass: [snip('nope', 'z', 'b1')],
  };
  const map = buildPhraseGapByScript([ok, thin]);
  assert.deepEqual(Object.keys(map), [ok.scriptPath]);
  assert.equal(map[ok.scriptPath].terms[0].term, 'notes');
});

// ── REQUIRED: structural no-LLM-import ────────────────────────────────────────

check('structural: the shipped source imports nothing LLM / network', () => {
  const srcPath = path.resolve(__dirname, '../../../../src/main/context-optimizer/phrase-gap.ts');
  const src = readFileSync(srcPath, 'utf8');

  const importLines = src.split('\n')
    .filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l));
  const forbiddenImport =
    /anthropic|openai|langchain|cohere|mistral|ollama|embedding|generativeai|@ai-sdk|\bllm\b|node:https?|node:http\b|node:net|node:dns|node:tls/i;
  for (const line of importLines) {
    assert.ok(!forbiddenImport.test(line), `forbidden import: ${line.trim()}`);
  }
  // and no runtime network calls anywhere in the body.
  assert.ok(!/\bfetch\s*\(/.test(src), 'source must not call fetch()');
  assert.ok(!/XMLHttpRequest|new WebSocket\(/.test(src), 'source must not open a socket');
  // sanity: we actually read the real module (it imports the config).
  assert.ok(/from '\.\/optimizer-config'/.test(src), 'did not read the expected source file');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

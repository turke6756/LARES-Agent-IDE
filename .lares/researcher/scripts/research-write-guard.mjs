#!/usr/bin/env node
// Research-store PreToolUse(Write) guard — WP-G.
// Blocks researcher writes that escape .dashboard/research/inbox/ or violate the
// artifact naming / frontmatter schema. Validation mirrors
// src/main/research/frontmatter.ts. Dependency-free.

import fs from 'node:fs';

const MAX_STDIN_BYTES = 5 * 1024 * 1024;
const RESEARCH_MARKER = '.dashboard/research/';
const REQUIRED_FRONTMATTER_KEYS = ['id', 'topic', 'created', 'source_urls', 'trust', 'summary'];
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function allow() { process.exit(0); }

function block(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  try { process.stdout.write(JSON.stringify(out)); } catch {}
  try { process.stderr.write(reason + '\n'); } catch {}
  process.exit(2);
}

function fail(reason) { return { ok: false, reason: 'Research artifact rejected: ' + reason }; }

function parseFrontmatter(fileContent) {
  if (typeof fileContent !== 'string') return null;
  const normalized = fileContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  const fmLines = lines.slice(1, closeIdx);
  const scalars = {};
  let sourceUrls = null;
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (line.trim() === '') continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    if (key === 'source_urls') {
      const urls = [];
      let j = i + 1;
      for (; j < fmLines.length; j++) {
        const item = fmLines[j].match(/^\s*-\s+(.*\S)\s*$/);
        if (!item) break;
        urls.push(item[1].trim());
      }
      i = j - 1;
      sourceUrls = urls;
      continue;
    }
    scalars[key] = rest.trim();
  }
  return { scalars, sourceUrls };
}

function validateResearchFrontmatter(fileContent, opts) {
  const parsed = parseFrontmatter(fileContent);
  if (parsed === null) return fail('missing leading --- frontmatter block');
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (key === 'source_urls') {
      if (parsed.sourceUrls === null) return fail('missing frontmatter key: source_urls');
      continue;
    }
    if (!(key in parsed.scalars) || parsed.scalars[key] === '') {
      return fail('missing frontmatter key: ' + key);
    }
  }
  const urls = parsed.sourceUrls || [];
  if (urls.length === 0 || !urls.every((u) => /^https?:\/\/\S+/i.test(u))) {
    return fail('source_urls must be a non-empty list of http(s) URLs');
  }
  const created = parsed.scalars['created'];
  if (!ISO_8601_RE.test(created) || Number.isNaN(Date.parse(created))) {
    return fail('created must be an ISO-8601 timestamp (e.g. 2026-06-14T12:00:00Z)');
  }
  const trust = parsed.scalars['trust'];
  if (trust !== opts.expectTrust) {
    if (opts.expectTrust === 'untrusted' && trust === 'cleared') {
      return fail('only the review gate (WP-F) may set trust: cleared; use trust: untrusted in inbox/');
    }
    return fail('trust must be "' + opts.expectTrust + '" (got "' + trust + '")');
  }
  return { ok: true };
}

// ── main ──────────────────────────────────────────────────────────────
let raw = '';
try {
  const buf = fs.readFileSync(0);
  raw = (buf.length > MAX_STDIN_BYTES ? buf.subarray(0, MAX_STDIN_BYTES) : buf).toString('utf-8');
} catch {
  // No / unreadable stdin — cannot identify a Write; do not block unrelated calls.
  allow();
}

let payload;
try { payload = JSON.parse(raw); } catch { allow(); }
if (!payload || typeof payload !== 'object') allow();

// Only guard Write.
if (payload.tool_name !== 'Write') allow();

const input = payload.tool_input || {};
const filePath = typeof input.file_path === 'string' ? input.file_path : null;
const content = typeof input.content === 'string' ? input.content : null;
if (!filePath || content === null) {
  block('Write hook could not inspect file path/content');
}

// Hard containment (default-deny): the researcher's Write TOOL may ONLY target
// the research store. Any path outside .dashboard/research/ is blocked outright
// — this inverts the previous allow-by-default so arbitrary-location writes can
// no longer slip through. (This gates the agent's Write tool, not internal
// harness file ops, which is the intended containment boundary.)
const norm = filePath.replace(/\\/g, '/');
const at = norm.indexOf(RESEARCH_MARKER);
if (at === -1) {
  block('researcher Write is confined to .dashboard/research/inbox/ (path is outside the research store)');
}
const rel = norm.slice(at + RESEARCH_MARKER.length);

// Defense in depth behind WP-B's permission rule: researcher may only write
// under inbox/.
if (!rel.startsWith('inbox/')) {
  block('researcher may only write under .dashboard/research/inbox/');
}

// Naming: inbox/<topic-slug>/<timestamp>-<slug>.md
const parts = rel.split('/');
if (parts.length !== 3) {
  block('research artifacts must live at inbox/<topic-slug>/<timestamp>-<slug>.md');
}
const topicSlug = parts[1];
const filename = parts[2];
if (!/^[a-z0-9][a-z0-9-]*$/.test(topicSlug)) {
  block('inbox topic folder must be a lowercase slug: inbox/<topic-slug>/...');
}
if (!filename.endsWith('.md')) {
  block('research artifact filename must end in .md');
}
if (!/^\d[\w.:-]*-[a-z0-9][a-z0-9-]*\.md$/.test(filename)) {
  block('research artifact filename must be <timestamp>-<slug>.md (timestamp first)');
}

// Frontmatter schema (untrusted tier).
const result = validateResearchFrontmatter(content, { expectTrust: 'untrusted' });
if (!result.ok) block(result.reason);

allow();

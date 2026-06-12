#!/usr/bin/env node
/**
 * Scoring harness for experiment 14.1 — agent HTML-generation reliability.
 *
 * Scans outputs/<provider>/<variant>/<run>.html and scores each document
 * against the six checks from docs/INTERACTIVE_PLAN_SURFACE_PROPOSAL.md §14.1:
 *
 *   1. parses            — parse5 yields a document with an <html> element
 *   2. requiredAttrs     — <html> has data-plan-id/data-run-state/data-schema-version;
 *                          every phase has data-phase-id; every task data-task-id;
 *                          every zone has data-role="zone" + non-empty data-zone
 *   3. uniqueIds         — no duplicate data-task-id / data-phase-id
 *   4. zoneScaffold      — every phase contains `recommendations` and
 *                          `open-questions` zones (per the spec's check 4)
 *   5. wellFormed        — no tag-balance parse errors; tasks live inside
 *                          phases; phases live inside the implementation tab
 *                          (nothing leaks past a section boundary)
 *   6. editTargeting     — (edit variant only) the spliced fragment landed
 *                          inside phase p1's recommendations zone and the rest
 *                          of the host document is preserved
 *
 * Generation runs (variants a, b): pass = checks 1–5.
 * Edit runs (variant edit):        pass = checks 1–6 (4 is checked against the
 *                                  host's phase set; host phases already have
 *                                  the scaffold).
 *
 * Leniency (documented in results.md): if the raw output wraps the document in
 * a markdown code fence or has prose before <!DOCTYPE html>, the harness
 * extracts the HTML and records `normalized: true`. The raw file on disk is
 * never modified.
 */

const fs = require('fs');
const path = require('path');
const parse5 = require('parse5');
const cheerio = require('cheerio');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'outputs');
const HOST_PATH = path.join(ROOT, 'host.html');

// parse5 error codes that indicate tag-balance / structure problems in the
// free-form HTML (check 5). Codes not in this set (e.g. missing-doctype,
// non-void-html-element-start-tag-with-trailing-solidus) are recorded but not
// failed on.
const STRUCTURAL_ERROR_CODES = new Set([
  'end-tag-without-matching-open-element',
  'closing-of-element-with-open-child-elements',
  'unexpected-html-element',
  'misplaced-start-tag-for-head-element',
  'unexpected-start-tag',
  'unexpected-end-tag',
  'open-elements-left-after-eof',
  'abandoned-head-element-child',
  'disallowed-content-in-noscript-in-head',
  'nested-form',
  'misplaced-doctype',
]);

function normalizeOutput(raw) {
  let text = raw.replace(/^﻿/, '');
  let normalized = false;
  // strip markdown fences anywhere wrapping the doc
  const fenceMatch = text.match(/```(?:html)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch && /<html[\s>]/i.test(fenceMatch[1])) {
    text = fenceMatch[1];
    normalized = true;
  }
  // strip leading prose before doctype/<html>
  const start = text.search(/<!DOCTYPE\s+html/i);
  const htmlStart = text.search(/<html[\s>]/i);
  const sliceFrom = start >= 0 ? start : htmlStart;
  if (sliceFrom > 0) {
    text = text.slice(sliceFrom);
    normalized = true;
  }
  // strip trailing prose after </html>
  const end = text.toLowerCase().lastIndexOf('</html>');
  if (end >= 0 && end + 7 < text.trimEnd().length) {
    text = text.slice(0, end + 7);
    normalized = true;
  }
  return { text, normalized };
}

function parseWithErrors(html) {
  const errors = [];
  let doc = null;
  let threw = null;
  try {
    doc = parse5.parse(html, {
      sourceCodeLocationInfo: true,
      onParseError: (e) => errors.push(e.code),
    });
  } catch (e) {
    threw = String(e && e.message ? e.message : e);
  }
  return { doc, errors, threw };
}

function check1_parses(normText, parsed, $) {
  const diags = [];
  if (parsed.threw) return { pass: false, diags: [`parser threw: ${parsed.threw}`] };
  if (!normText.trim()) return { pass: false, diags: ['empty output'] };
  if (!/<html[\s>]/i.test(normText)) diags.push('no <html> element in output');
  if ($('html').length === 0) diags.push('parsed document has no html element');
  if ($('body').length === 0) diags.push('parsed document has no body');
  return { pass: diags.length === 0, diags };
}

function check2_requiredAttrs($) {
  const diags = [];
  const html = $('html');
  for (const attr of ['data-plan-id', 'data-run-state', 'data-schema-version']) {
    if (!html.attr(attr)) diags.push(`<html> missing ${attr}`);
  }
  $('[data-role="phase"]').each((i, el) => {
    if (!$(el).attr('data-phase-id')) diags.push(`phase #${i} missing data-phase-id`);
  });
  $('[data-role="task"]').each((i, el) => {
    if (!$(el).attr('data-task-id')) diags.push(`task #${i} missing data-task-id`);
  });
  // every zone has both halves of the contract
  $('[data-role="zone"]').each((i, el) => {
    const z = $(el).attr('data-zone');
    if (!z) diags.push(`zone #${i} (data-role="zone") missing data-zone`);
  });
  $('[data-zone]').each((i, el) => {
    if ($(el).attr('data-role') !== 'zone')
      diags.push(`element with data-zone="${$(el).attr('data-zone')}" lacks data-role="zone"`);
  });
  if ($('[data-role="phase"]').length === 0) diags.push('no phases found');
  if ($('[data-role="task"]').length === 0) diags.push('no tasks found');
  return { pass: diags.length === 0, diags };
}

function check3_uniqueIds($) {
  const diags = [];
  for (const [sel, attr] of [
    ['[data-role="phase"]', 'data-phase-id'],
    ['[data-role="task"]', 'data-task-id'],
  ]) {
    const seen = new Map();
    $(sel).each((_, el) => {
      const id = $(el).attr(attr);
      if (!id) return; // missing → check 2's problem
      seen.set(id, (seen.get(id) || 0) + 1);
    });
    for (const [id, n] of seen) {
      if (n > 1) diags.push(`duplicate ${attr}="${id}" (${n}x)`);
    }
  }
  return { pass: diags.length === 0, diags };
}

function check4_zoneScaffold($) {
  const diags = [];
  const REQUIRED = ['recommendations', 'open-questions'];
  $('[data-role="phase"]').each((_, el) => {
    const pid = $(el).attr('data-phase-id') || '(no id)';
    for (const z of REQUIRED) {
      const found = $(el).find(`[data-role="zone"][data-zone="${z}"]`);
      if (found.length === 0) diags.push(`phase ${pid} missing zone "${z}"`);
    }
  });
  return { pass: diags.length === 0, diags };
}

function check5_wellFormed($, parseErrors) {
  const diags = [];
  const structural = parseErrors.filter((c) => STRUCTURAL_ERROR_CODES.has(c));
  if (structural.length > 0) {
    diags.push(`structural parse errors: ${[...new Set(structural)].join(', ')}`);
  }
  // containment: tasks inside phases, phases inside the implementation tab
  $('[data-role="task"]').each((_, el) => {
    if ($(el).closest('[data-role="phase"]').length === 0) {
      diags.push(`task ${$(el).attr('data-task-id') || '(no id)'} not inside a phase`);
    }
  });
  $('[data-role="phase"]').each((_, el) => {
    if ($(el).closest('[data-tab="implementation"]').length === 0) {
      diags.push(`phase ${$(el).attr('data-phase-id') || '(no id)'} leaked outside the implementation tab`);
    }
  });
  // per-phase zones must sit inside their phase or a tab section, not float at body level
  $('[data-role="zone"]').each((_, el) => {
    const inPhase = $(el).closest('[data-role="phase"]').length > 0;
    const inTab = $(el).closest('[data-tab]').length > 0;
    if (!inPhase && !inTab) {
      diags.push(`zone "${$(el).attr('data-zone')}" floats outside any tab/phase`);
    }
  });
  return { pass: diags.length === 0, diags };
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

function check6_editTargeting($, $host) {
  const diags = [];
  const frag = $('[data-rec-id="rec-cache-ttl"]');
  if (frag.length === 0) {
    diags.push('spliced fragment (data-rec-id="rec-cache-ttl") not found');
    return { pass: false, diags };
  }
  if (frag.length > 1) diags.push(`fragment appears ${frag.length} times`);
  const el = frag.first();
  const zone = el.closest('[data-role="zone"][data-zone="recommendations"]');
  if (zone.length === 0) {
    diags.push('fragment is not inside a recommendations zone');
  } else {
    const phase = zone.closest('[data-role="phase"]');
    const pid = phase.attr('data-phase-id');
    if (pid !== 'p1') diags.push(`fragment landed in phase "${pid}" not p1`);
  }
  // preservation: every host phase/task/zone/question still present with same text
  $host('[data-role="task"]').each((_, hel) => {
    const id = $host(hel).attr('data-task-id');
    const out = $(`[data-role="task"][data-task-id="${id}"]`);
    if (out.length !== 1) diags.push(`host task ${id} missing or duplicated in output`);
    else if (norm(out.text()) !== norm($host(hel).text()))
      diags.push(`host task ${id} text changed`);
  });
  $host('[data-role="zone"]').each((_, hel) => {
    const zname = $host(hel).attr('data-zone');
    const hPhase = $host(hel).closest('[data-role="phase"]').attr('data-phase-id') || '';
    // locate matching zone in output
    let out;
    if (hPhase) out = $(`[data-phase-id="${hPhase}"] [data-role="zone"][data-zone="${zname}"]`);
    else out = $(`[data-tab] > [data-role="zone"][data-zone="${zname}"]`).filter((_, oel) => $(oel).closest('[data-role="phase"]').length === 0);
    if (out.length !== 1) {
      diags.push(`host zone ${hPhase ? hPhase + '/' : ''}${zname} missing or duplicated`);
      return;
    }
    const isTarget = hPhase === 'p1' && zname === 'recommendations';
    if (!isTarget && norm(out.text()) !== norm($host(hel).text())) {
      diags.push(`untargeted zone ${hPhase ? hPhase + '/' : ''}${zname} was modified`);
    }
  });
  // header + framing prose preserved
  if (norm($('header[data-role="plan-header"]').text()) !== norm($host('header[data-role="plan-header"]').text())) {
    diags.push('plan header was modified');
  }
  return { pass: diags.length === 0, diags };
}

function scoreFile(file, variant, $host) {
  const raw = fs.readFileSync(file, 'utf8');
  const { text, normalized } = normalizeOutput(raw);
  const parsed = parseWithErrors(text);
  const result = {
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    variant,
    normalized,
    rawBytes: raw.length,
    checks: {},
    parseErrorCodes: [...new Set(parsed.errors)],
  };
  let $;
  try {
    $ = cheerio.load(text);
  } catch (e) {
    $ = null;
  }
  if (!$ || parsed.threw) {
    result.checks.parses = { pass: false, diags: [parsed.threw || 'cheerio failed to load'] };
    for (const c of ['requiredAttrs', 'uniqueIds', 'zoneScaffold', 'wellFormed']) {
      result.checks[c] = { pass: false, diags: ['unparseable'] };
    }
    if (variant === 'edit') result.checks.editTargeting = { pass: false, diags: ['unparseable'] };
    result.pass = false;
    return result;
  }
  result.checks.parses = check1_parses(text, parsed, $);
  result.checks.requiredAttrs = check2_requiredAttrs($);
  result.checks.uniqueIds = check3_uniqueIds($);
  result.checks.zoneScaffold = check4_zoneScaffold($);
  result.checks.wellFormed = check5_wellFormed($, parsed.errors);
  if (variant === 'edit') {
    result.checks.editTargeting = check6_editTargeting($, $host);
  }
  result.pass = Object.values(result.checks).every((c) => c.pass);
  return result;
}

function main() {
  const hostHtml = fs.readFileSync(HOST_PATH, 'utf8');
  const $host = cheerio.load(hostHtml);

  const results = [];
  for (const provider of fs.readdirSync(OUT_DIR)) {
    const pdir = path.join(OUT_DIR, provider);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const variant of fs.readdirSync(pdir)) {
      const vdir = path.join(pdir, variant);
      if (!fs.statSync(vdir).isDirectory()) continue;
      for (const f of fs.readdirSync(vdir).filter((f) => f.endsWith('.html')).sort()) {
        const r = scoreFile(path.join(vdir, f), variant, $host);
        r.provider = provider;
        results.push(r);
      }
    }
  }

  // aggregate
  const agg = {};
  for (const r of results) {
    const key = `${r.provider}/${r.variant}`;
    agg[key] = agg[key] || { n: 0, pass: 0, checkFails: {} };
    agg[key].n++;
    if (r.pass) agg[key].pass++;
    for (const [name, c] of Object.entries(r.checks)) {
      if (!c.pass) agg[key].checkFails[name] = (agg[key].checkFails[name] || 0) + 1;
    }
  }

  const out = { generatedAt: new Date().toISOString(), aggregate: agg, documents: results };
  fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(out, null, 2));

  // console table
  console.log('cell                          n   pass  rate   failing checks');
  for (const [key, a] of Object.entries(agg).sort()) {
    const fails = Object.entries(a.checkFails).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
    console.log(
      key.padEnd(30) +
        String(a.n).padEnd(4) +
        String(a.pass).padEnd(6) +
        ((100 * a.pass) / a.n).toFixed(0).padStart(3) + '%   ' +
        fails
    );
  }
  console.log(`\n${results.length} documents scored. results.json written.`);
}

main();

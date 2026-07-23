#!/usr/bin/env node
// P0.3 (plans/edr-safety-hardening.md) — EDR-surface lint.
//
// Scans the repo's shippable text surface for the process-launch patterns that
// EDR heuristics anchor on (WSH, hidden PowerShell, encoded commands) and for
// the Node/Electron spawn flags whose *combination* is the risk signal
// (windowsHide / detached / shell:true / unref).
//
// IMPORTANT — walk semantics: this script implements its OWN recursive file
// walk. It deliberately does NOT shell out to ripgrep/glob with default
// semantics, because default walks silently skip gitignored files and
// dot-directories — exactly where the original mirrored launch recipes hid
// (.dashboard/, gitignored scaffolds). Everything under the scan roots is
// visited, hidden or not, ignored or not, minus only the explicit exclusions
// below.
//
// Scan roots: src/, scripts/, docs/ + the root package.json (Tier 3 only).
//
// Exclusions (each with its reason — keep this list documented):
//   - **/node_modules/**        third-party code (e.g. scripts/spike/pdfium-wasm/
//                               node_modules ships esbuild/vite with windowsHide);
//                               not ours, not shipped, audited upstream.
//   - **/.git/**                object store, not source.
//   - docs/internal/**          gitignored machine-local design notes that QUOTE
//                               the banned patterns as prose (threat write-ups).
//   - **/__fixtures__/**        recorded agent transcripts / analytics fixtures
//                               that contain verbatim captured commands
//                               (e.g. log-readers/__fixtures__/codex-rollout-sample.jsonl
//                               holds a real `powershell.exe -Command wsl --status`
//                               capture). Data about commands, not commands.
//   - dist/, release/, .lares/, .dashboard/  build output / agent state dirs —
//                               not under the roots anyway, excluded defensively.
//   - SELF_FILES                this script, its test, and edr-allowlist.json —
//                               they necessarily contain the pattern sources.
//
// Tiers:
//   Tier 1 (hard fail): .vbs/.wsf/.hta files; wscript/cscript; CreateObject("WScript;
//     -WindowStyle Hidden; -EncodedCommand/-enc; quoted 'powershell.exe' spawn
//     literals; `powershell … -Command` in prose/code. A Tier-1 hit may be
//     allowlisted ONLY for detector/remediation code, test fixtures for that
//     code, or user-facing prose describing the banned pattern — plus the
//     temporary P2.1-pending hidden-PowerShell call sites.
//   Tier 2 (allowlist-with-purpose): windowsHide:true, detached:true, .unref(),
//     shell:true. Every occurrence must match an entry in
//     scripts/edr-allowlist.json {file, lineContext, purpose, owner}.
//   Tier 3 (warn only): -ExecutionPolicy Bypass in package.json verify scripts
//     (cleanup tracked as P3.4).
//
// Known limitation: matching is line-based. A spawn whose argv spells a banned
// flag across multiple lines is caught indirectly (the quoted 'powershell.exe'
// literal and the Tier-2 spawn flags are on single lines in practice).
//
// Usage:
//   node scripts/check-edr-patterns.mjs              lint the tree (exit 1 on violations)
//   node scripts/check-edr-patterns.mjs --self-test  run built-in fixture tests
//   node scripts/check-edr-patterns.mjs --packaged   additionally run the P0.4
//                                                    packaged-scripts manifest check
//                                                    (delegates to verify-packaged-scripts.mjs)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── configuration ────────────────────────────────────────────────────────────

const SCAN_ROOTS = ['src', 'scripts', 'docs'];
const EXTRA_FILES = ['package.json']; // Tier 3 surface

const EXCLUDED_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'release', '.lares', '.dashboard', '__fixtures__',
]);
const EXCLUDED_REL_PREFIXES = [
  'docs/internal/', // gitignored machine-local notes quoting patterns as prose
];
const SELF_FILES = new Set([
  'scripts/check-edr-patterns.mjs',
  'scripts/check-edr-patterns.test.js',
  'scripts/edr-allowlist.json',
]);

// Content scan skips binary formats; the .vbs/.wsf/.hta extension check runs first.
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.wasm', '.node', '.zip',
  '.exe', '.dll', '.woff', '.woff2', '.ttf', '.eot', '.asar', '.db', '.sqlite',
]);

const BANNED_EXTENSIONS = new Set(['.vbs', '.wsf', '.hta']);

const TIER1_PATTERNS = [
  {
    name: 'wsh-interpreter',
    re: /\b(wscript|cscript)(\.exe)?\b/i,
    hint: 'Windows Script Host reference — remove; WSH launch shims are the SentinelOne false-positive class.',
  },
  {
    name: 'wsh-createobject',
    re: /CreateObject\(\s*["']?WScript/i,
    hint: 'WScript.Shell instantiation — remove.',
  },
  {
    name: 'windowstyle-hidden',
    re: /-?WindowStyle\s+Hidden/i,
    hint: 'Hidden-window PowerShell launch flag — use a visible terminal or a native API instead.',
  },
  {
    name: 'encoded-command',
    re: /-EncodedCommand\b|-enc\b/i,
    hint: 'Encoded PowerShell command — obfuscation flag; pass discrete argv instead.',
  },
  {
    name: 'powershell-spawn-literal',
    re: /["']powershell\.exe["']/i,
    hint: 'Programmatic PowerShell child — replace with a native API (P2.1) or direct exe probe.',
  },
  {
    name: 'powershell-dash-command',
    re: /powershell(\.exe)?\s+[^\n]*-Command\b/i,
    hint: '`powershell -Command` in code/prose — replace with direct argv or drop from prompt text.',
  },
];

const TIER2_PATTERNS = [
  {
    name: 'windows-hide',
    re: /windowsHide:\s*true/,
    hint: 'Hidden child window — allowed only for bounded direct probes; add an edr-allowlist.json entry with a real purpose.',
  },
  {
    name: 'detached',
    re: /detached:\s*true/,
    hint: 'Detached child — legal only for the detached-runner feature (ownership registry + spawn audit).',
  },
  {
    name: 'unref',
    re: /\.unref\(\)/,
    hint: 'unref() — fine for timers, suspicious for children; allowlist with purpose.',
  },
  {
    name: 'shell-true',
    re: /shell:\s*true/,
    hint: 'shell-wrapped spawn — pass an absolute exe + discrete argv instead.',
  },
];

const TIER3_PATTERNS = [
  {
    name: 'executionpolicy-bypass',
    re: /-ExecutionPolicy\s+Bypass/i,
    hint: 'Dev-only verify script; cleanup tracked as P3.4 (never shipped after P0.4).',
  },
];

// ── walk (explicit; no ignore semantics, dot-dirs included) ──────────────────

function walkTree(absDir, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      if (EXCLUDED_REL_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue;
      walkTree(path.join(absDir, entry.name), rel, out);
    } else if (entry.isFile()) {
      if (SELF_FILES.has(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

function collectFiles(rootDir, scanRoots, extraFiles) {
  const files = [];
  for (const r of scanRoots) {
    const abs = path.join(rootDir, r);
    if (fs.existsSync(abs)) walkTree(abs, r, files);
  }
  for (const f of extraFiles) {
    if (fs.existsSync(path.join(rootDir, f))) files.push(f);
  }
  return files;
}

// ── scan ─────────────────────────────────────────────────────────────────────

function loadAllowlist(allowlistPath) {
  if (!fs.existsSync(allowlistPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
  const entries = parsed.entries ?? [];
  for (const e of entries) {
    if (!e.file || !e.lineContext || !e.purpose || !e.owner) {
      throw new Error(`edr-allowlist.json entry missing a required field (file/lineContext/purpose/owner): ${JSON.stringify(e)}`);
    }
  }
  return entries;
}

function allowlistMatch(entries, file, lineText) {
  const norm = file.replace(/\\/g, '/');
  const lower = lineText.toLowerCase();
  return entries.find((e) =>
    e.file === norm &&
    (e.lineContext === '*' || lower.includes(e.lineContext.toLowerCase())));
}

/** Scan `rootDir`. Returns {violations, warnings, allowlisted, usedEntries}. */
function scan(rootDir, allowlistEntries, { scanRoots = SCAN_ROOTS, extraFiles = EXTRA_FILES } = {}) {
  const files = collectFiles(rootDir, scanRoots, extraFiles);
  const violations = [];
  const warnings = [];
  const allowlisted = [];
  const usedEntries = new Set();

  const record = (list, file, line, tier, name, text, hint) =>
    list.push({ file, line, tier, pattern: name, text: text.trim().slice(0, 160), hint });

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (BANNED_EXTENSIONS.has(ext)) {
      record(violations, rel, 0, 1, 'banned-extension',
        `file extension ${ext}`, 'WSH/HTA script files must not exist in the repo at all.');
      continue;
    }
    if (BINARY_EXTS.has(ext)) continue;

    let content;
    try {
      content = fs.readFileSync(path.join(rootDir, rel), 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      for (const { tier, patterns } of [
        { tier: 1, patterns: TIER1_PATTERNS },
        { tier: 2, patterns: TIER2_PATTERNS },
      ]) {
        for (const p of patterns) {
          if (!p.re.test(lineText)) continue;
          const entry = allowlistMatch(allowlistEntries, rel, lineText);
          if (entry) {
            usedEntries.add(entry);
            record(allowlisted, rel, i + 1, tier, p.name, lineText, entry.purpose);
          } else {
            record(violations, rel, i + 1, tier, p.name, lineText, p.hint);
          }
        }
      }
      for (const p of TIER3_PATTERNS) {
        if (p.re.test(lineText)) record(warnings, rel, i + 1, 3, p.name, lineText, p.hint);
      }
    }
  }

  return { violations, warnings, allowlisted, usedEntries, fileCount: files.length };
}

// ── reporting ────────────────────────────────────────────────────────────────

function printHits(label, hits, stream) {
  if (hits.length === 0) return;
  stream.write(`${label}\n`);
  for (const h of hits) {
    stream.write(`  ${h.file}:${h.line}  [tier ${h.tier}] ${h.pattern}\n`);
    stream.write(`      ${h.text}\n`);
    stream.write(`      → ${h.hint}\n`);
  }
}

function runLint({ verbose = false } = {}) {
  const allowlistPath = path.join(ROOT, 'scripts', 'edr-allowlist.json');
  const entries = loadAllowlist(allowlistPath);
  const { violations, warnings, allowlisted, usedEntries, fileCount } = scan(ROOT, entries);

  const stale = entries.filter((e) => !usedEntries.has(e));

  if (verbose) {
    printHits('Allowlisted occurrences:', allowlisted, process.stdout);
  }
  printHits('EDR-pattern violations:', violations, process.stderr);
  printHits('Warnings (tier 3, non-blocking):', warnings, process.stderr);
  for (const e of stale) {
    process.stderr.write(`  stale allowlist entry (matched nothing): ${e.file} :: ${e.lineContext}\n`);
  }

  if (violations.length > 0) {
    process.stderr.write(`check-edr-patterns: FAIL — ${violations.length} violation(s) across ${fileCount} files scanned.\n`);
    return 1;
  }
  process.stdout.write(`check-edr-patterns: OK — ${fileCount} files scanned, ${allowlisted.length} allowlisted occurrence(s), ${warnings.length} tier-3 warning(s), ${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'}.\n`);
  return 0;
}

// ── --packaged: P0.4 manifest assertion (delegated) ──────────────────────────
// TODO(P0.4 absorption): fold verify-packaged-scripts.mjs' checks in natively
// once the packaged job wiring settles; delegation keeps one source of truth.

function runPackaged() {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-packaged-scripts.mjs')], {
    stdio: 'inherit',
  });
  return res.status ?? 1;
}

// ── --self-test: fixture tree exercised end-to-end ───────────────────────────

function selfTest() {
  let failed = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { console.log(`  ok  ${name}`); } else { console.error(`  FAIL ${name} ${detail}`); failed++; }
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edr-selftest-'));
  try {
    const write = (rel, text) => {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf-8');
    };

    // Tier-1 fixtures — each must be flagged.
    write('src/launch.vbs', 'Set s = CreateObject("WScript.Shell")');
    write('src/a.ts', 'exec("wscript launch.vbs")');
    write('src/b.ts', 'const flag = "-WindowStyle Hidden";');
    write('src/c.ts', 'args.push("-EncodedCommand", payload);');
    write('src/d.ts', "spawn('powershell.exe', ['-NoProfile']);");
    write('docs/e.md', 'Run `powershell -NoProfile -Command Get-Process` to check.');
    // Tier-2 fixture — unlisted must fail; listed must pass.
    write('src/f.ts', 'spawn(exe, argv, { windowsHide: true });');
    write('src/g.ts', 'spawn(exe, argv, { shell: true, detached: true });');
    // Hidden + "gitignored-shaped" locations must still be scanned (own walk).
    write('src/.hidden/h.ts', 'child.unref();\nspawn(x, { windowsHide: true });');
    // Excluded locations must NOT be scanned.
    write('src/node_modules/pkg/z.js', 'spawn(x, { windowsHide: true, shell: true });');
    write('docs/internal/notes.md', '-EncodedCommand prose quote');
    write('src/__fixtures__/capture.jsonl', '"powershell.exe -Command wsl --status"');
    // Tier-3 fixture — warn only.
    write('package.json', '{"scripts": {"v": "powershell -NoProfile -ExecutionPolicy Bypass -File x.ps1"}}');
    // Clean file.
    write('src/ok.ts', 'export const fine = 1;');

    const r1 = scan(tmp, []);
    const got = (file, pattern) => r1.violations.some((v) => v.file === file && v.pattern === pattern);

    check('banned .vbs extension flagged', got('src/launch.vbs', 'banned-extension'));
    check('wscript invocation flagged', got('src/a.ts', 'wsh-interpreter'));
    check('-WindowStyle Hidden flagged', got('src/b.ts', 'windowstyle-hidden'));
    check('-EncodedCommand flagged', got('src/c.ts', 'encoded-command'));
    check('powershell.exe spawn literal flagged', got('src/d.ts', 'powershell-spawn-literal'));
    check('powershell -Command prose flagged', got('docs/e.md', 'powershell-dash-command'));
    check('unlisted windowsHide flagged', got('src/f.ts', 'windows-hide'));
    check('shell:true flagged', got('src/g.ts', 'shell-true'));
    check('detached:true flagged', got('src/g.ts', 'detached'));
    check('hidden dot-dir IS scanned (unref)', got('src/.hidden/h.ts', 'unref'));
    check('hidden dot-dir IS scanned (windowsHide)', got('src/.hidden/h.ts', 'windows-hide'));
    check('node_modules NOT scanned', !r1.violations.some((v) => v.file.includes('node_modules')));
    check('docs/internal NOT scanned', !r1.violations.some((v) => v.file.startsWith('docs/internal')));
    check('__fixtures__ NOT scanned', !r1.violations.some((v) => v.file.includes('__fixtures__')));
    check('ExecutionPolicy Bypass is warn-only', !r1.violations.some((v) => v.pattern === 'executionpolicy-bypass')
      && r1.warnings.some((w) => w.pattern === 'executionpolicy-bypass'));

    // Allowlist behavior: listed occurrence passes, and only that one.
    const allow = [
      { file: 'src/f.ts', lineContext: 'windowsHide: true', purpose: 'self-test bounded probe', owner: 'self-test' },
    ];
    const r2 = scan(tmp, allow);
    check('allowlisted windowsHide passes', !r2.violations.some((v) => v.file === 'src/f.ts')
      && r2.allowlisted.some((a) => a.file === 'src/f.ts'));
    check('allowlist is file-scoped', r2.violations.some((v) => v.file === 'src/.hidden/h.ts' && v.pattern === 'windows-hide'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`check-edr-patterns --self-test: FAIL (${failed})`);
    return 1;
  }
  console.log('check-edr-patterns --self-test: OK');
  return 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  process.exit(selfTest());
}
let code = runLint({ verbose: argv.includes('--verbose') });
if (code === 0 && argv.includes('--packaged')) {
  code = runPackaged();
}
process.exit(code);

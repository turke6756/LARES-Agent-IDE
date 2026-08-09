#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLAN_ROOTS = ['.lares/plans', '.dashboard/plans'];
const EPHEMERAL_BASENAME = /^plan\.json\.(?:lock.*|wtmp-.*)$/;

function toGitPath(value) {
  return value.split(path.sep).join('/');
}

function git(root, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
  }
  return result;
}

function walkRegularFiles(root, relDir, files, planFolders) {
  const absDir = path.join(root, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = toGitPath(path.join(relDir, entry.name));
    if (entry.isDirectory()) {
      planFolders.add(rel);
      walkRegularFiles(root, rel, files, planFolders);
    } else if (entry.isFile()) {
      files.add(rel);
    }
  }
}

function isEphemeral(rel) {
  const parts = rel.split('/');
  if (parts.length !== 4 || !PLAN_ROOTS.includes(parts.slice(0, 2).join('/'))) return false;
  return EPHEMERAL_BASENAME.test(parts[3]);
}

function isValidPlanManifest(text, folderRel) {
  try {
    const value = JSON.parse(text);
    const folderName = folderRel.slice(folderRel.lastIndexOf('/') + 1);
    return value !== null
      && typeof value === 'object'
      && value.schema_version === 1
      && typeof value.plan_artifact_id === 'string'
      && /^plan_[a-z0-9]{8}$/i.test(value.plan_artifact_id)
      && value.plan_sku === folderName
      && value.source_proposal !== null
      && typeof value.source_proposal === 'object'
      && typeof value.source_proposal.artifact_id === 'string'
      && /^prop_[a-z0-9]{8}$/i.test(value.source_proposal.artifact_id)
      && Array.isArray(value.responsibility_events);
  } catch {
    return false;
  }
}

export function inspectPlanFolderVersioning(root = process.cwd()) {
  const worktreeFiles = new Set();
  const planFolders = new Set();
  for (const planRoot of PLAN_ROOTS) {
    const absRoot = path.join(root, planRoot);
    if (!fs.existsSync(absRoot)) continue;
    for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderRel = `${planRoot}/${entry.name}`;
      planFolders.add(folderRel);
      walkRegularFiles(root, folderRel, worktreeFiles, new Set());
    }
  }

  const trackedResult = git(root, ['ls-files', '-z', '--', ...PLAN_ROOTS], { encoding: 'buffer' });
  const tracked = new Set(
    trackedResult.stdout.toString('utf8').split('\0').filter(Boolean).map((item) => item.replaceAll('\\', '/')),
  );
  for (const rel of tracked) {
    const parts = rel.split('/');
    if (parts.length >= 3) planFolders.add(parts.slice(0, 3).join('/'));
  }

  const durable = [...worktreeFiles].filter((rel) => !isEphemeral(rel)).sort();
  const ephemeral = [...worktreeFiles].filter(isEphemeral).sort();
  const trackedDurable = [];
  const untrackedDurable = [];
  const violations = [];

  for (const rel of durable) {
    const result = git(root, ['ls-files', '--error-unmatch', '--', rel], { allowFailure: true });
    if (result.status === 0) trackedDurable.push(rel);
    else {
      untrackedDurable.push(rel);
      violations.push({ code: 'untracked-durable', path: rel });
    }
  }

  for (const rel of [...tracked].filter(isEphemeral).sort()) {
    violations.push({ code: 'tracked-ephemeral', path: rel });
  }
  for (const rel of [...tracked].filter((item) => !isEphemeral(item)).sort()) {
    if (!fs.existsSync(path.join(root, rel))) violations.push({ code: 'missing-tracked', path: rel });
  }

  for (const folderRel of [...planFolders].sort()) {
    const manifestRel = `${folderRel}/plan.json`;
    if (!tracked.has(manifestRel)) {
      violations.push({ code: 'missing-tracked-plan-json', path: manifestRel });
      continue;
    }
    const shown = git(root, ['show', `:${manifestRel}`], { allowFailure: true });
    if (shown.status !== 0 || !isValidPlanManifest(shown.stdout, folderRel)) {
      violations.push({ code: 'invalid-tracked-plan-json', path: manifestRel });
    }
  }

  violations.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  return { trackedDurable, untrackedDurable, ephemeral, violations };
}

export function formatReport(report) {
  const lines = ['Plan-folder versioning report'];
  for (const rel of report.trackedDurable) lines.push(`TRACKED   ${rel}`);
  for (const rel of report.untrackedDurable) lines.push(`UNTRACKED ${rel}`);
  for (const rel of report.ephemeral) lines.push(`LOCAL     ${rel}`);
  for (const item of report.violations) lines.push(`VIOLATION ${item.code} ${item.path}`);
  lines.push(`Summary: ${report.trackedDurable.length} tracked durable, ${report.untrackedDurable.length} untracked durable, ${report.ephemeral.length} local ephemeral, ${report.violations.length} violation(s).`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const check = process.argv.slice(2).includes('--check');
  const report = inspectPlanFolderVersioning();
  process.stdout.write(formatReport(report));
  if (check && report.violations.length > 0) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();

// WP-P2L-ingest — filesystem-owned planning-intent ledger reconciliation.
// A scan observes one complete plan-folder generation, then commits its DB
// projection atomically. Disk remains authoritative; missing rows are retained
// as history (withdrawn intents / present_on_disk=0 outputs), never deleted.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../database';

export const PLAN_INTENT_DOCUMENT_MAX_BYTES = 1_000_000;
export const PLAN_INTENT_OUTPUT_MAX_BYTES = 2_000_000;
export const PLAN_INTENT_OUTPUT_MAX_FILES = 400;
const OUTPUT_SUBDIRS = ['deliberations', 'research', 'supplements'] as const;
const INTENT_KINDS = new Set(['groupthink-serial', 'groupthink-parallel', 'research']);
const OUTPUT_KINDS = new Set(['deliberation', 'research']);
const DISPOSITIONS = new Set(['active', 'superseded', 'withdrawn']);

export type PlanIntentLedgerDiagnosticKind =
  | 'scan-read-failed'
  | 'scan-cap-exceeded'
  | 'malformed-intent'
  | 'malformed-integration'
  | 'invalid-output'
  | 'reused-withdrawn-sentinel'
  | 'transaction-failed';

export interface PlanIntentLedgerDiagnostic {
  kind: PlanIntentLedgerDiagnosticKind;
  relPath: string;
  detail: string;
}

export interface PlanIntentOutputProjection {
  relPath: string;
  orchestrationId: string | null;
  presentOnDisk: boolean;
  disposition: 'active' | 'superseded' | 'withdrawn';
  foldedIn: boolean;
}

export interface PlanIntentProjection {
  intentId: string;
  status: 'active' | 'withdrawn' | 'superseded';
  returned: boolean;
  fullyFoldedIn: boolean;
  open: boolean;
  outputs: PlanIntentOutputProjection[];
}

export interface ScanPlanIntentLedgerOptions {
  workspaceId: string;
  workspaceRoot: string;
  planId: string;
  folderAbs: string;
  folderRelPath: string;
  now?: () => number;
  maxDocumentBytes?: number;
  maxOutputBytes?: number;
  maxOutputFiles?: number;
}

export interface ScanPlanIntentLedgerResult {
  /** False only when the prior projection was retained without any writes. */
  committed: boolean;
  /** False for malformed PLAN-INTENT markup (absence reconciliation withheld). */
  complete: boolean;
  diagnostics: PlanIntentLedgerDiagnostic[];
  intents: PlanIntentProjection[];
}

type ParsedIntent = {
  intentId: string;
  partSlug: string | null;
  kind: string;
  targetsJson: string | null;
  reason: string | null;
  supersedesIntentId: string | null;
};

type ParsedIntegration = {
  intentId: string;
  outputRelPath: string;
  changed: string | null;
  disposition: 'active' | 'superseded' | 'withdrawn';
};

type OutputObservation = {
  intentId: string;
  relPath: string;
  orchestrationId: string | null;
};

class ScanFailure extends Error {
  constructor(
    readonly kind: 'scan-read-failed' | 'scan-cap-exceeded' | 'malformed-integration',
    readonly relPath: string,
    message: string,
  ) { super(message); }
}

function toPosix(value: string): string { return value.split(path.sep).join('/'); }

function isContained(rootAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(rootAbs, candidateAbs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function readRegularFile(abs: string, rel: string, maxBytes: number): string {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(abs); }
  catch (err) { throw new ScanFailure('scan-read-failed', rel, `cannot stat/read ${rel}: ${String(err)}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ScanFailure('scan-read-failed', rel, `${rel} is not a regular contained file`);
  }
  if (stat.size > maxBytes) {
    throw new ScanFailure('scan-cap-exceeded', rel, `${rel} exceeds the ${maxBytes}-byte scan cap`);
  }
  try { return fs.readFileSync(abs, 'utf8'); }
  catch (err) { throw new ScanFailure('scan-read-failed', rel, `cannot read ${rel}: ${String(err)}`); }
}

function validateIntent(value: unknown): ParsedIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.intent_id !== 'string' || v.intent_id.trim() === '') return null;
  if (typeof v.kind !== 'string' || !INTENT_KINDS.has(v.kind)) return null;
  if (v.part !== undefined && typeof v.part !== 'string') return null;
  if (v.reason !== undefined && typeof v.reason !== 'string') return null;
  if (v.targets !== undefined && (!Array.isArray(v.targets) || v.targets.some((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return true;
    const item = target as Record<string, unknown>;
    return typeof item.provider !== 'string' || item.provider === ''
      || typeof item.model !== 'string' || item.model === '';
  }))) return null;
  if (v.supersedes_intent_id !== undefined
      && (typeof v.supersedes_intent_id !== 'string' || v.supersedes_intent_id.trim() === '')) return null;
  return {
    intentId: v.intent_id.trim(),
    partSlug: typeof v.part === 'string' ? v.part : null,
    kind: v.kind,
    targetsJson: v.targets === undefined ? null : JSON.stringify(v.targets),
    reason: typeof v.reason === 'string' ? v.reason : null,
    supersedesIntentId: typeof v.supersedes_intent_id === 'string' ? v.supersedes_intent_id.trim() : null,
  };
}

function parseIntentSentinels(
  body: string,
  sourceRelPath: string,
  diagnostics: PlanIntentLedgerDiagnostic[],
): { intents: ParsedIntent[]; complete: boolean } {
  const starts = [...body.matchAll(/<!--PLAN-INTENT\b/g)].length;
  const records = [...body.matchAll(/<!--PLAN-INTENT\s*([\s\S]*?)-->/g)];
  const intents: ParsedIntent[] = [];
  let malformed = starts !== records.length;
  const seen = new Set<string>();
  for (const record of records) {
    try {
      const parsed = validateIntent(JSON.parse(record[1]));
      if (!parsed || seen.has(parsed.intentId)) throw new Error(parsed ? 'duplicate intent_id' : 'invalid fields');
      seen.add(parsed.intentId);
      intents.push(parsed);
    } catch (err) {
      malformed = true;
      diagnostics.push({
        kind: 'malformed-intent', relPath: sourceRelPath,
        detail: `malformed PLAN-INTENT sentinel: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (starts !== records.length) {
    diagnostics.push({ kind: 'malformed-intent', relPath: sourceRelPath, detail: 'unterminated PLAN-INTENT sentinel' });
  }
  return { intents, complete: !malformed };
}

function normalizeOutputRelPath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  if (!OUTPUT_SUBDIRS.some((sub) => normalized.startsWith(`${sub}/`))) return null;
  return normalized;
}

function parseIntegrations(body: string, planRelPath: string): ParsedIntegration[] {
  const starts = [...body.matchAll(/<!--PLAN-INTEGRATION\b/g)].length;
  const records = [...body.matchAll(/<!--PLAN-INTEGRATION\s*([\s\S]*?)-->/g)];
  if (starts !== records.length) {
    throw new ScanFailure('malformed-integration', planRelPath, 'unterminated PLAN-INTEGRATION sentinel');
  }
  const integrations: ParsedIntegration[] = [];
  for (const record of records) {
    try {
      const value = JSON.parse(record[1]) as Record<string, unknown>;
      const rel = normalizeOutputRelPath(value.output_rel_path);
      const disposition = value.disposition ?? 'active';
      if (typeof value.intent_id !== 'string' || value.intent_id === '' || !rel
          || typeof disposition !== 'string' || !DISPOSITIONS.has(disposition)
          || (value.changed !== undefined && typeof value.changed !== 'string')) {
        throw new Error('invalid fields');
      }
      integrations.push({
        intentId: value.intent_id,
        outputRelPath: rel,
        changed: typeof value.changed === 'string' ? value.changed : null,
        disposition: disposition as ParsedIntegration['disposition'],
      });
    } catch (err) {
      throw new ScanFailure(
        'malformed-integration', planRelPath,
        `malformed PLAN-INTEGRATION sentinel: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return integrations;
}

/** Remove constructs in which Markdown-looking text is not a link. This is a
 * deliberately small Markdown link tokenizer, not a substring search. */
function markdownLinkDestinations(body: string): string[] {
  const visible = body
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2\s*$/gm, '')
    .replace(/`+[^`\n]*`+/g, '');
  const destinations: string[] = [];
  const link = /!?\[[^\]\n]*(?:\\.[^\]\n]*)*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of visible.matchAll(link)) {
    if (match[0].startsWith('!')) continue;
    const raw = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1];
    destinations.push(raw);
  }
  return destinations;
}

function resolveContainedLinks(folderAbs: string, planBody: string): Set<string> {
  const resolved = new Set<string>();
  for (const raw of markdownLinkDestinations(planBody)) {
    if (raw.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('#')) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(raw.split('#', 1)[0].split('?', 1)[0]); }
    catch { continue; }
    const abs = path.resolve(folderAbs, decoded);
    if (!isContained(folderAbs, abs)) continue;
    try {
      const stat = fs.lstatSync(abs);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
    } catch { continue; }
    resolved.add(toPosix(path.relative(folderAbs, abs)));
  }
  return resolved;
}

function parseFrontmatter(body: string): Record<string, string> | null {
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const closing = /\n---(?:\n|$)/g;
  closing.lastIndex = 4;
  const closeMatch = closing.exec(normalized);
  if (!closeMatch) return null;
  const end = closeMatch.index;
  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!match) return null;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return fields;
}

function enumerateOutputs(
  folderAbs: string,
  folderRelPath: string,
  planArtifactId: string,
  maxFiles: number,
  maxBytes: number,
  diagnostics: PlanIntentLedgerDiagnostic[],
): OutputObservation[] {
  const outputs: OutputObservation[] = [];
  let count = 0;
  for (const sub of OUTPUT_SUBDIRS) {
    const subAbs = path.join(folderAbs, sub);
    let subStat: fs.Stats;
    try { subStat = fs.lstatSync(subAbs); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ScanFailure('scan-read-failed', `${folderRelPath}/${sub}`, `cannot enumerate output directory: ${String(err)}`);
    }
    if (subStat.isSymbolicLink() || !subStat.isDirectory()) {
      throw new ScanFailure('scan-read-failed', `${folderRelPath}/${sub}`, 'output directory is not a regular contained directory');
    }
    let dir: fs.Dir;
    try { dir = fs.opendirSync(subAbs); }
    catch (err) {
      throw new ScanFailure('scan-read-failed', `${folderRelPath}/${sub}`, `cannot enumerate output directory: ${String(err)}`);
    }
    try {
      let entry: fs.Dirent | null;
      while ((entry = dir.readSync()) !== null) {
        if (entry.name === '.gitkeep') continue;
        count += 1;
        if (count > maxFiles) {
          throw new ScanFailure('scan-cap-exceeded', folderRelPath, `output enumeration exceeds the ${maxFiles}-entry cap`);
        }
        if (entry.isDirectory()) continue;
        const rel = `${sub}/${entry.name}`;
        const body = readRegularFile(path.join(subAbs, entry.name), `${folderRelPath}/${rel}`, maxBytes);
        const frontmatter = parseFrontmatter(body);
        if (!frontmatter || frontmatter.plan_artifact_id !== planArtifactId
            || !frontmatter.intent_id || !OUTPUT_KINDS.has(frontmatter.kind)) {
          diagnostics.push({
            kind: 'invalid-output', relPath: `${folderRelPath}/${rel}`,
            detail: 'output frontmatter is missing/invalid or does not match this plan artifact',
          });
          continue;
        }
        outputs.push({
          intentId: frontmatter.intent_id,
          relPath: rel,
          orchestrationId: frontmatter.orchestration_id || null,
        });
      }
    } finally {
      try { dir.closeSync(); } catch { /* best effort after an enumeration failure */ }
    }
  }
  return outputs;
}

function projection(planId: string): PlanIntentProjection[] {
  const db = getDb();
  const intents = db.prepare(
    `SELECT intent_id, status FROM plan_intents WHERE plan_id = ? ORDER BY first_seen_at, intent_id`,
  ).all(planId) as Array<{ intent_id: string; status: PlanIntentProjection['status'] }>;
  const outputs = db.prepare(
    `SELECT intent_id, rel_path, orchestration_id, present_on_disk, disposition, folded_in
       FROM plan_intent_outputs WHERE plan_id = ? ORDER BY first_seen_at, rel_path`,
  ).all(planId) as Array<{
    intent_id: string; rel_path: string; orchestration_id: string | null;
    present_on_disk: number; disposition: PlanIntentOutputProjection['disposition']; folded_in: number;
  }>;
  return intents.map((intent) => {
    const rows = outputs.filter((output) => output.intent_id === intent.intent_id).map((output) => ({
      relPath: output.rel_path,
      orchestrationId: output.orchestration_id,
      presentOnDisk: output.present_on_disk === 1,
      disposition: output.disposition,
      foldedIn: output.folded_in === 1,
    }));
    const present = rows.filter((output) => output.presentOnDisk);
    const required = present.filter((output) => output.disposition === 'active');
    const fullyFoldedIn = required.length > 0 && required.every((output) => output.foldedIn);
    return {
      intentId: intent.intent_id,
      status: intent.status,
      returned: present.length > 0,
      fullyFoldedIn,
      open: intent.status === 'active' && !fullyFoldedIn,
      outputs: rows,
    };
  });
}

export function getPlanIntentLedgerProjection(planId: string): PlanIntentProjection[] {
  return projection(planId);
}

/** Scan one adopted structured plan folder. Fatal read/parse/cap errors perform
 * zero writes. Malformed PLAN-INTENT markup may add valid observations, but
 * withholds both intent-withdrawal and output-absence reconciliation. */
export function scanPlanIntentLedger(opts: ScanPlanIntentLedgerOptions): ScanPlanIntentLedgerResult {
  const diagnostics: PlanIntentLedgerDiagnostic[] = [];
  const documentCap = opts.maxDocumentBytes ?? PLAN_INTENT_DOCUMENT_MAX_BYTES;
  const outputCap = opts.maxOutputBytes ?? PLAN_INTENT_OUTPUT_MAX_BYTES;
  const fileCap = opts.maxOutputFiles ?? PLAN_INTENT_OUTPUT_MAX_FILES;
  const planJsonRel = `${opts.folderRelPath}/plan.json`;

  let artifactId: string;
  let sourceRelPath: string;
  let sourceBody: string;
  let planBody: string | null = null;
  let parsedIntents: ReturnType<typeof parseIntentSentinels>;
  let integrations: ParsedIntegration[];
  let outputs: OutputObservation[];
  let foldedLinks: Set<string>;

  try {
    const manifestBody = readRegularFile(path.join(opts.folderAbs, 'plan.json'), planJsonRel, documentCap);
    const manifest = JSON.parse(manifestBody) as Record<string, unknown>;
    if (typeof manifest.plan_artifact_id !== 'string' || manifest.plan_artifact_id === '') {
      throw new ScanFailure('scan-read-failed', planJsonRel, 'plan.json has no valid plan_artifact_id');
    }
    artifactId = manifest.plan_artifact_id;

    const planAbs = path.join(opts.folderAbs, 'plan.md');
    try {
      planBody = readRegularFile(planAbs, `${opts.folderRelPath}/plan.md`, documentCap);
      sourceRelPath = `${opts.folderRelPath}/plan.md`;
      sourceBody = planBody;
    } catch (err) {
      if (!(err instanceof ScanFailure) || !/cannot stat\/read/.test(err.message)
          || (err.message.indexOf('ENOENT') < 0 && err.message.indexOf('no such file') < 0)) throw err;
      const sourceProposal = manifest.source_proposal;
      const candidate = sourceProposal && typeof sourceProposal === 'object' && !Array.isArray(sourceProposal)
        ? (sourceProposal as Record<string, unknown>).rel_path
        : undefined;
      if (typeof candidate !== 'string' || candidate === '' || candidate.includes('\\') || path.posix.isAbsolute(candidate)) {
        throw new ScanFailure('scan-read-failed', planJsonRel, 'plan.md absent and source_proposal.rel_path is invalid');
      }
      const sourceAbs = path.resolve(opts.workspaceRoot, candidate);
      if (!isContained(opts.workspaceRoot, sourceAbs)) {
        throw new ScanFailure('scan-read-failed', candidate, 'source proposal escapes the workspace');
      }
      sourceRelPath = path.posix.normalize(candidate);
      sourceBody = readRegularFile(sourceAbs, sourceRelPath, documentCap);
    }

    parsedIntents = parseIntentSentinels(sourceBody, sourceRelPath, diagnostics);
    integrations = planBody === null ? [] : parseIntegrations(planBody, `${opts.folderRelPath}/plan.md`);
    foldedLinks = planBody === null ? new Set<string>() : resolveContainedLinks(opts.folderAbs, planBody);
    outputs = enumerateOutputs(opts.folderAbs, opts.folderRelPath, artifactId, fileCap, outputCap, diagnostics);
  } catch (err) {
    const failure = err instanceof ScanFailure
      ? err
      : new ScanFailure('scan-read-failed', planJsonRel, err instanceof Error ? err.message : String(err));
    diagnostics.push({ kind: failure.kind, relPath: failure.relPath, detail: failure.message });
    return { committed: false, complete: false, diagnostics, intents: projection(opts.planId) };
  }

  const scannedAt = (opts.now ?? (() => Date.now()))();
  const integrationByOutput = new Map(integrations.map((item) => [`${item.intentId}\0${item.outputRelPath}`, item]));
  const observedKeys = new Set(outputs.map((item) => `${item.intentId}\0${item.relPath}`));
  const encounteredIntents = new Set(parsedIntents.intents.map((item) => item.intentId));
  const db = getDb();

  try {
    db.transaction(() => {
      const existingRows = db.prepare(
        `SELECT intent_id, status FROM plan_intents WHERE plan_id = ?`,
      ).all(opts.planId) as Array<{ intent_id: string; status: PlanIntentProjection['status'] }>;
      const existing = new Map(existingRows.map((row) => [row.intent_id, row.status]));

      const upsertIntent = db.prepare(`
        INSERT INTO plan_intents
          (id, workspace_id, plan_id, plan_artifact_id, intent_id, part_slug, kind,
           targets_json, reason, source_doc_rel_path, status, supersedes_intent_id,
           integration_note, first_seen_at, updated_at, last_scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id, intent_id) DO UPDATE SET
          plan_artifact_id = excluded.plan_artifact_id,
          part_slug = excluded.part_slug,
          kind = excluded.kind,
          targets_json = excluded.targets_json,
          reason = excluded.reason,
          source_doc_rel_path = excluded.source_doc_rel_path,
          status = excluded.status,
          supersedes_intent_id = excluded.supersedes_intent_id,
          integration_note = excluded.integration_note,
          updated_at = excluded.updated_at,
          last_scanned_at = excluded.last_scanned_at
      `);

      for (const intent of parsedIntents.intents) {
        const priorStatus = existing.get(intent.intentId);
        let status: PlanIntentProjection['status'] = priorStatus ?? 'active';
        if (priorStatus === 'withdrawn') {
          diagnostics.push({
            kind: 'reused-withdrawn-sentinel', relPath: sourceRelPath,
            detail: `withdrawn intent_id ${intent.intentId} reappeared; it remains withdrawn`,
          });
        }
        const notes = integrations.filter((item) => item.intentId === intent.intentId && item.changed !== null);
        const note = notes.length > 0 ? notes[notes.length - 1].changed : null;
        upsertIntent.run(
          `pli_${randomUUID()}`, opts.workspaceId, opts.planId, artifactId, intent.intentId,
          intent.partSlug, intent.kind, intent.targetsJson, intent.reason, sourceRelPath,
          status, intent.supersedesIntentId, note, scannedAt, scannedAt, scannedAt,
        );
      }

      for (const intent of parsedIntents.intents) {
        if (!intent.supersedesIntentId || intent.supersedesIntentId === intent.intentId) continue;
        db.prepare(`UPDATE plan_intents SET status = 'superseded', updated_at = ?, last_scanned_at = ?
                     WHERE plan_id = ? AND intent_id = ? AND status <> 'withdrawn'`)
          .run(scannedAt, scannedAt, opts.planId, intent.supersedesIntentId);
      }

      if (parsedIntents.complete) {
        if (encounteredIntents.size === 0) {
          db.prepare(`UPDATE plan_intents SET status = 'withdrawn', updated_at = ?, last_scanned_at = ?
                       WHERE plan_id = ? AND status = 'active'`).run(scannedAt, scannedAt, opts.planId);
        } else {
          const placeholders = [...encounteredIntents].map(() => '?').join(',');
          db.prepare(`UPDATE plan_intents SET status = 'withdrawn', updated_at = ?, last_scanned_at = ?
                       WHERE plan_id = ? AND status = 'active' AND intent_id NOT IN (${placeholders})`)
            .run(scannedAt, scannedAt, opts.planId, ...encounteredIntents);
        }
        db.prepare(`UPDATE plan_intents SET last_scanned_at = ? WHERE plan_id = ?`)
          .run(scannedAt, opts.planId);
      }

      const knownIntents = new Set((db.prepare(`SELECT intent_id FROM plan_intents WHERE plan_id = ?`)
        .all(opts.planId) as Array<{ intent_id: string }>).map((row) => row.intent_id));
      const upsertOutput = db.prepare(`
        INSERT INTO plan_intent_outputs
          (plan_id, intent_id, rel_path, orchestration_id, present_on_disk, disposition,
           folded_in, first_seen_at, last_present_at, last_scanned_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id, intent_id, rel_path) DO UPDATE SET
          orchestration_id = excluded.orchestration_id,
          present_on_disk = 1,
          disposition = excluded.disposition,
          folded_in = excluded.folded_in,
          last_present_at = excluded.last_present_at,
          last_scanned_at = excluded.last_scanned_at
      `);
      for (const output of outputs) {
        if (!knownIntents.has(output.intentId)) {
          diagnostics.push({
            kind: 'invalid-output', relPath: `${opts.folderRelPath}/${output.relPath}`,
            detail: `output refers to unknown intent_id ${output.intentId}`,
          });
          observedKeys.delete(`${output.intentId}\0${output.relPath}`);
          continue;
        }
        const integration = integrationByOutput.get(`${output.intentId}\0${output.relPath}`);
        upsertOutput.run(
          opts.planId, output.intentId, output.relPath, output.orchestrationId,
          integration?.disposition ?? 'active', foldedLinks.has(output.relPath) ? 1 : 0,
          scannedAt, scannedAt, scannedAt,
        );
      }

      if (parsedIntents.complete) {
        const priorOutputs = db.prepare(
          `SELECT intent_id, rel_path FROM plan_intent_outputs WHERE plan_id = ?`,
        ).all(opts.planId) as Array<{ intent_id: string; rel_path: string }>;
        const markMissing = db.prepare(
          `UPDATE plan_intent_outputs SET present_on_disk = 0, folded_in = 0, last_scanned_at = ?
             WHERE plan_id = ? AND intent_id = ? AND rel_path = ?`,
        );
        for (const prior of priorOutputs) {
          if (!observedKeys.has(`${prior.intent_id}\0${prior.rel_path}`)) {
            markMissing.run(scannedAt, opts.planId, prior.intent_id, prior.rel_path);
          }
        }
      }
    })();
  } catch (err) {
    diagnostics.push({
      kind: 'transaction-failed', relPath: opts.folderRelPath,
      detail: `intent-ledger transaction failed; prior projection retained: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { committed: false, complete: false, diagnostics, intents: projection(opts.planId) };
  }

  return {
    committed: true,
    complete: parsedIntents.complete,
    diagnostics,
    intents: projection(opts.planId),
  };
}

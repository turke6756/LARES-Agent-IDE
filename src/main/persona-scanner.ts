import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AgentPersona, PathType, PersonaLane } from '../shared/types';
import { SUPERVISOR_AGENT_NAME } from '../shared/constants';
import {
  writeScaffoldMap, scaffoldFileExists, atomicWriteScaffoldText,
  readScaffoldText, sha256Hex, type ScaffoldFile,
} from './scaffold-writer';
import {
  WORKER_CLAUDE_SETTINGS_JSON, WORKER_CLAUDE_SETTINGS_JSON_V5,
  SUPERVISOR_PERSONA_CLAUDE_SETTINGS_JSON,
  PERSONA_CREATE_PERSONA_SKILL, PERSONA_CREATE_PERSONA_SKILL_V1,
  PERSONA_READ_COMMENTS_SKILL, PERSONA_AGENT_MD_TEMPLATE,
} from '../shared/constants';

const VALID_NAME = /^[a-z0-9_-]+$/;

// ── Persona lane sidecar (#18 / D3, D7) ──────────────────────────────
// A persona may declare exactly ONE native lane in
// .dashboard/agents/<name>/persona.json {"lane":"worker"}. The sidecar is
// NEVER a member of any managed scaffold map (writeScaffoldMap can't touch it)
// and is written only when absent, so a lane choice survives every kit upgrade.
const VALID_PERSONA_LANES = new Set<PersonaLane>(['supervisor', 'researcher', 'worker']);

export function parsePersonaLane(value: unknown): PersonaLane | undefined {
  return (typeof value === 'string' && VALID_PERSONA_LANES.has(value as PersonaLane))
    ? value as PersonaLane : undefined;
}

function personaJsonRel(name: string): string { return `.dashboard/agents/${name}/persona.json`; }

/** Read .dashboard/agents/<name>/persona.json; invalid/malformed → undefined. */
export function readPersonaLane(workspacePath: string, pathType: PathType, name: string): PersonaLane | undefined {
  const raw = readScaffoldText(workspacePath, personaJsonRel(name), pathType);
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsePersonaLane((parsed as any).lane);
  } catch {
    console.warn(`[persona] persona.json for "${name}" is unparseable JSON; treating as no lane`);
  }
  return undefined;
}

/** Write persona.json ONLY when absent (never overwrites the user's lane choice). */
function writePersonaJsonIfAbsent(workspacePath: string, pathType: PathType, name: string, lane: PersonaLane): void {
  const rel = personaJsonRel(name);
  if (scaffoldFileExists(workspacePath, rel, pathType)) return;
  atomicWriteScaffoldText(workspacePath, rel, JSON.stringify({ lane }, null, 2) + '\n', false, pathType);
}

/** Delete .dashboard/agents/<name>/persona.json if it exists (path-type aware).
 *  Used by setPersonaLane to revert a persona to the legacy (no-lane) path. */
function deletePersonaJson(workspacePath: string, pathType: PathType, name: string): void {
  const rel = personaJsonRel(name);
  if (!scaffoldFileExists(workspacePath, rel, pathType)) return;
  if (pathType === 'wsl') {
    try {
      execFileSync('wsl.exe', ['bash', '-lc', `rm -f '${workspacePath}/${rel}'`], { timeout: 5000, stdio: 'ignore' });
    } catch { /* best effort */ }
    return;
  }
  try { fs.rmSync(path.join(workspacePath, rel), { force: true }); } catch { /* best effort */ }
}

/**
 * Overwrite-capable lane writer for an EXISTING persona (#18 launch-dialog lane
 * editing). Unlike writePersonaJsonIfAbsent, this REPLACES whatever lane the
 * persona currently declares:
 *  - `lane` = a valid PersonaLane → write { lane } (overwrites any prior value).
 *  - `lane` = null → DELETE persona.json (revert to legacy / no declared lane).
 * Validates the lane against VALID_PERSONA_LANES and name-guards exactly like
 * scaffoldPersona (reject invalid name + the reserved supervisor name).
 */
export function setPersonaLane(
  workspacePath: string, pathType: PathType, name: string, lane: PersonaLane | null,
): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(`Invalid persona name "${name}". Only lowercase letters, numbers, hyphens, and underscores allowed.`);
  }
  if (name === SUPERVISOR_AGENT_NAME) {
    throw new Error(`Cannot set a lane on persona "${SUPERVISOR_AGENT_NAME}" — reserved for supervisor.`);
  }
  if (lane === null) {
    deletePersonaJson(workspacePath, pathType, name);
    return;
  }
  if (!VALID_PERSONA_LANES.has(lane)) {
    throw new Error(`Invalid persona lane "${lane}". Must be one of supervisor | researcher | worker, or null.`);
  }
  atomicWriteScaffoldText(workspacePath, personaJsonRel(name), JSON.stringify({ lane }, null, 2) + '\n', false, pathType);
}

function displayNameFor(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, ' ');
}

/** Render PERSONA_AGENT_MD_TEMPLATE deterministically: substitute the display
 *  name and embed the role description as the identity body (or a stub when
 *  absent). split/join avoids the `$`-replacement pitfalls of String.replace. */
function buildPersonaClaudeMd(displayName: string, roleDescription?: string): string {
  const roleBody = (roleDescription && roleDescription.trim())
    ? roleDescription.trim()
    : `<!-- Define this agent's identity and behavior here. -->`;
  return PERSONA_AGENT_MD_TEMPLATE
    .split('${displayName}').join(displayName)
    .split('${roleBody}').join(roleBody);
}

/** The managed (version-migrated) per-persona kit — OPERATIONAL PLUMBING ONLY.
 *  CLAUDE.md is intentionally NOT here (seed-once, user-owned — see D4).
 *
 *  `lane` selects the persona's .claude/settings.json variant: a 'supervisor'-lane
 *  persona inherits the supervisor hook scaffold (double-`..` script path) so its
 *  Notification → waiting hook fires; every other persona gets the worker variant
 *  (which also gained the Notification hook). Both are version 2: version 1 → 2
 *  because the worker body gained the Notification hook, and previousHashes[1] is
 *  the pre-Notification worker hash (WORKER_CLAUDE_SETTINGS_JSON_V5) so an existing
 *  persona carrying the old worker settings on disk upgrades silently (no `.bak`). */
function buildPersonaManagedFiles(name: string, lane?: PersonaLane): Record<string, ScaffoldFile> {
  const base = `.dashboard/agents/${name}`;
  const settingsContent = lane === 'supervisor'
    ? SUPERVISOR_PERSONA_CLAUDE_SETTINGS_JSON
    : WORKER_CLAUDE_SETTINGS_JSON;
  return {
    [`${base}/.claude/settings.json`]:                  { content: settingsContent, version: 2, previousHashes: { 1: sha256Hex(WORKER_CLAUDE_SETTINGS_JSON_V5) } },
    [`${base}/.claude/skills/create-persona/SKILL.md`]: { content: PERSONA_CREATE_PERSONA_SKILL, version: 2, previousHashes: { 1: sha256Hex(PERSONA_CREATE_PERSONA_SKILL_V1) } },
    [`${base}/.claude/skills/read-comments/SKILL.md`]:  { content: PERSONA_READ_COMMENTS_SKILL, version: 1 },
  };
}

/** Seed-once writer for an identity/owned file (CLAUDE.md, MEMORY.md): write the
 *  given content ONLY when the file is absent; never overwrite an existing one. */
function seedFileIfAbsent(workspacePath: string, pathType: PathType, rel: string, content: string): void {
  if (scaffoldFileExists(workspacePath, rel, pathType)) return;
  atomicWriteScaffoldText(workspacePath, rel, content, false, pathType);
}

/** Upgrade-on-launch: refresh ONLY the managed operational kit (settings.json +
 *  skills; idempotent, version-migrated). Identity files are seed-once: CLAUDE.md
 *  and MEMORY.md are written only if absent and never touched again. Never writes
 *  persona.json. */
export function ensurePersonaScaffold(workspacePath: string, pathType: PathType, name: string): void {
  if (!VALID_NAME.test(name) || name === SUPERVISOR_AGENT_NAME) return;
  // Operational plumbing — managed/upgraded (the dashboard ensures every persona
  // has working hooks + the default skills). Lane selects the settings.json
  // variant so a supervisor-privilege persona inherits the hook scaffold.
  const lane = readPersonaLane(workspacePath, pathType, name);
  writeScaffoldMap(workspacePath, buildPersonaManagedFiles(name, lane), pathType, { logPrefix: '[persona]' });
  // Identity — seed-once. A persona created by scaffoldPersona already has both;
  // a hand-written legacy persona (mr-job-hunt-agent) keeps its own CLAUDE.md.
  const base = `.dashboard/agents/${name}`;
  seedFileIfAbsent(workspacePath, pathType, `${base}/CLAUDE.md`, buildPersonaClaudeMd(displayNameFor(name)));
  seedFileIfAbsent(workspacePath, pathType, `${base}/memory/MEMORY.md`, `# Memory Index\n`);
}

// ── Launch-input lane mapping (#18 / D6) ─────────────────────────────

function laneFromFlags(i: { isSupervisor?: boolean; isResearcher?: boolean; isWorker?: boolean; isSupervised?: boolean }): PersonaLane | undefined {
  if (i.isSupervisor) return 'supervisor';
  if (i.isResearcher) return 'researcher';
  if (i.isWorker || i.isSupervised) return 'worker';
  return undefined;
}

/** Mutate the launch input in place: stamp the persona's declared lane onto the
 *  existing lane flags. Throws on a genuine conflict; no-op when flags already
 *  match or when there is no declared lane. */
export function applyPersonaLaneToLaunchInput(
  input: { persona?: string; isSupervisor?: boolean; isResearcher?: boolean; isWorker?: boolean; isSupervised?: boolean; privilegeLane?: 'supervisor'; provider?: string },
  workspacePath: string, pathType: PathType,
): void {
  if (!input.persona) return;
  const declared = readPersonaLane(workspacePath, pathType, input.persona);
  if (!declared) return;
  const existing = laneFromFlags(input);
  if (existing && existing !== declared) {
    throw new Error(`Persona "${input.persona}" declares lane "${declared}" but the launch requested "${existing}".`);
  }
  if (existing === declared) return;
  // #19 — the 'supervisor' PRIVILEGE lane is NOT the structural supervisor UI
  // role. Granting isSupervisor here conflated the two: the renderer hides every
  // isSupervisor agent from the worker grid and keeps a single supervisor slot
  // (already owned by the workspace's .dashboard/supervisor), so a supervisor-
  // lane persona got no card. Set privilegeLane instead — the persona renders as
  // its own card (isSupervisor stays false) and roleLaneOf still grants it the
  // supervisor-tier MCP toolset. researcher/worker already render as cards, so
  // they keep their existing flag mapping.
  if (declared === 'supervisor') input.privilegeLane = 'supervisor';
  else if (declared === 'researcher') { input.isResearcher = true; input.isSupervised = true; input.provider = 'claude'; }
  else if (declared === 'worker') input.isWorker = true;
}

// Custom agent personas live under .dashboard/agents/<name>/ (relocated from the
// legacy .claude/agents/ path, which the harness gates behind an interactive
// edit-confirmation dialog even with bypass-permissions on — see CLAUDE.md
// "avoid .claude/"). migratePersonas() below lifts any pre-existing legacy
// personas into the new location on first scan.
const LEGACY_REL = ['.claude', 'agents'];
const PERSONAS_REL = ['.dashboard', 'agents'];

/**
 * One-time, idempotent migration: copy any persona that still lives under the
 * legacy `.claude/agents/<name>/` into `.dashboard/agents/<name>/`. Existing
 * `.dashboard/agents/` entries are never clobbered; the supervisor persona is
 * skipped (it lives at `.dashboard/supervisor/`, not in the agents dir). Logs
 * each persona it moves. Safe to call on every scan — once the copy exists it
 * is a no-op.
 */
export function migratePersonas(workspacePath: string, pathType: PathType): void {
  if (pathType === 'wsl') {
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.ELECTRON_RUN_AS_NODE;
      // For each legacy persona dir with a CLAUDE.md, copy it into
      // .dashboard/agents/ unless a same-named entry already exists there.
      const script =
        `legacy='${workspacePath}/.claude/agents'; dest='${workspacePath}/.dashboard/agents'; ` +
        `[ -d "$legacy" ] || exit 0; mkdir -p "$dest"; ` +
        `for d in "$legacy"/*/; do ` +
        `[ -f "$d/CLAUDE.md" ] || continue; ` +
        `name=$(basename "$d"); ` +
        `[ "$name" = "${SUPERVISOR_AGENT_NAME}" ] && continue; ` +
        `[ -e "$dest/$name" ] && continue; ` +
        `cp -r "$d" "$dest/$name" && echo "$name"; ` +
        `done 2>/dev/null || true`;
      const { stdout } = require('child_process').execFileSync(
        'wsl.exe',
        ['bash', '-lc', script],
        { encoding: 'utf-8', timeout: 15000, env },
      ) as { stdout: string };
      const moved = (stdout || '').trim().split('\n').filter(Boolean);
      for (const name of moved) {
        console.log(`[persona] Migrated legacy persona "${name}" → .dashboard/agents/${name}`);
      }
    } catch {
      // Legacy dir absent or WSL unavailable — nothing to migrate.
    }
    return;
  }

  const legacyDir = path.join(workspacePath, ...LEGACY_REL);
  if (!fs.existsSync(legacyDir)) return;
  const destDir = path.join(workspacePath, ...PERSONAS_REL);
  try {
    const entries = fs.readdirSync(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === SUPERVISOR_AGENT_NAME) continue;
      const src = path.join(legacyDir, entry.name);
      if (!fs.existsSync(path.join(src, 'CLAUDE.md'))) continue;
      const dst = path.join(destDir, entry.name);
      if (fs.existsSync(dst)) continue; // don't clobber existing .dashboard/agents entry
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      console.log(`[persona] Migrated legacy persona "${entry.name}" → .dashboard/agents/${entry.name}`);
    }
  } catch {
    // Permission error or similar — leave legacy in place.
  }
}

/**
 * Scan .dashboard/agents/ for subdirectories containing CLAUDE.md.
 * Each is a persistent agent persona (custom agent type).
 */
export function scanPersonas(workspacePath: string, pathType: PathType): AgentPersona[] {
  // Lift any legacy .claude/agents/ personas into .dashboard/agents/ first so
  // existing custom agents keep showing up after the relocation.
  migratePersonas(workspacePath, pathType);

  const personas: AgentPersona[] = [];

  if (pathType === 'wsl') {
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.ELECTRON_RUN_AS_NODE;
      const { stdout } = require('child_process').execFileSync(
        'wsl.exe',
        ['bash', '-lc', `for d in '${workspacePath}'/.dashboard/agents/*/; do [ -f "$d/CLAUDE.md" ] && basename "$d"; done 2>/dev/null || true`],
        { encoding: 'utf-8', timeout: 10000, env }
      ) as { stdout: string };
      const names = (stdout || '').trim().split('\n').filter(Boolean);
      for (const name of names) {
        const dir = `${workspacePath}/.dashboard/agents/${name}`;
        // Check if memory/MEMORY.md exists
        let hasMemory = false;
        try {
          execFileSync('wsl.exe', ['bash', '-lc', `test -f '${dir}/memory/MEMORY.md'`], { timeout: 5000, env });
          hasMemory = true;
        } catch { /* no memory dir */ }
        personas.push({
          name,
          directory: dir,
          hasMemory,
          isSupervisor: name === SUPERVISOR_AGENT_NAME,
          lane: readPersonaLane(workspacePath, pathType, name),
        });
      }
    } catch {
      // .dashboard/agents/ doesn't exist or WSL unavailable
    }
  } else {
    const agentsDir = path.join(workspacePath, ...PERSONAS_REL);
    if (!fs.existsSync(agentsDir)) return personas;

    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const claudeMdPath = path.join(agentsDir, entry.name, 'CLAUDE.md');
        if (!fs.existsSync(claudeMdPath)) continue;
        const memoryPath = path.join(agentsDir, entry.name, 'memory', 'MEMORY.md');
        personas.push({
          name: entry.name,
          directory: path.join(agentsDir, entry.name),
          hasMemory: fs.existsSync(memoryPath),
          isSupervisor: entry.name === SUPERVISOR_AGENT_NAME,
          lane: readPersonaLane(workspacePath, pathType, entry.name),
        });
      }
    } catch {
      // Permission error or similar
    }
  }

  return personas;
}

/**
 * Create a new persona under .dashboard/agents/<name>/. Writes the managed
 * operational kit (settings.json + default skills) through the shared
 * version-migrated scaffold writer, seed-once identity files (CLAUDE.md with the
 * user's role body, memory/MEMORY.md), and — if a lane is declared — the
 * write-if-absent persona.json lane sidecar (D3/D4/D7).
 */
export function scaffoldPersona(
  workspacePath: string, pathType: PathType, name: string,
  roleDescription?: string, lane?: PersonaLane,
): AgentPersona {
  if (!VALID_NAME.test(name)) {
    throw new Error(`Invalid persona name "${name}". Only lowercase letters, numbers, hyphens, and underscores allowed.`);
  }
  if (name === SUPERVISOR_AGENT_NAME) {
    throw new Error(`Cannot create persona named "${SUPERVISOR_AGENT_NAME}" — reserved for supervisor.`);
  }
  // D7 — reject an invalid non-empty lane at create time (don't silently drop).
  if (lane !== undefined && !VALID_PERSONA_LANES.has(lane)) {
    throw new Error(`Invalid persona lane "${lane}". Must be one of supervisor | researcher | worker, or omitted.`);
  }

  const base = `.dashboard/agents/${name}`;
  // Operational plumbing — managed (atomic + version-migrated + locked). The
  // declared lane selects the settings.json variant (supervisor-privilege persona
  // inherits the hook scaffold; everything else gets the worker variant).
  writeScaffoldMap(workspacePath, buildPersonaManagedFiles(name, lane), pathType, { logPrefix: '[persona]' });
  // Identity — seed-once. At create the dir is fresh, so CLAUDE.md is written here
  // with the user's role body; it is never overwritten on any later launch.
  seedFileIfAbsent(workspacePath, pathType, `${base}/CLAUDE.md`, buildPersonaClaudeMd(displayNameFor(name), roleDescription));
  seedFileIfAbsent(workspacePath, pathType, `${base}/memory/MEMORY.md`, `# Memory Index\n`);
  if (lane) writePersonaJsonIfAbsent(workspacePath, pathType, name, lane);

  const dir = pathType === 'wsl'
    ? `${workspacePath}/.dashboard/agents/${name}`
    : path.join(workspacePath, ...PERSONAS_REL, name);
  return { name, directory: dir, hasMemory: true, isSupervisor: false, lane: readPersonaLane(workspacePath, pathType, name) };
}

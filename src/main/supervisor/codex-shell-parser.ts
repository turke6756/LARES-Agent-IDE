import path from 'path';
import type { FileOperation } from '../../shared/types';

export interface ParsedShellActivity {
  filePath: string;
  operation: FileOperation;
}

/**
 * Conservative best-effort parser for the `command` string codex sends through
 * its `shell_command` tool. We only emit activity for high-confidence patterns
 * — when in doubt, return nothing. Misses are silent and acceptable; bad data
 * pollutes the UI.
 *
 * `workdir` is the cwd the shell will run in (codex's `arguments.workdir`).
 * Relative paths are resolved against it.
 *
 * Recognized read patterns:
 *   - `cat <path>`, `head [-n N] <path>`, `tail [-n N] <path>`, `nl <path>`, `wc <path>`
 *   - `sed -n '<range>' <path>` (only with `-n`; without `-n`, sed can write)
 *   - `Get-Content [-LiteralPath] <path>`
 *   - `type <path>` (only when arg looks like a path, to avoid the unix `type` builtin)
 *   - `Select-String -LiteralPath <path>`
 *   - `rg <pattern> <file>` (only when the second arg looks like a filename)
 *
 * Recognized write/create patterns:
 *   - `Set-Content [-LiteralPath] <path>` → write
 *   - `Add-Content [-LiteralPath] <path>` → write (append)
 *   - `Out-File [-LiteralPath] <path>` → create
 *   - `New-Item -Path <path>` → create
 *   - shell redirect `> <path>` → conservative write
 *   - shell redirect `>> <path>` → write
 *   - `tee`, `cp`/`mv`, `copy`/`move` destinations → write
 *   - shell-invoked `apply_patch` literal heredoc headers
 *
 * Skipped (intentionally): `ls`, `find`, `Get-ChildItem`, `dir`, bare `rg <pattern>`,
 * `chmod`, dynamic paths, inline interpreters, and individual stages containing
 * command substitution, backticks, `xargs`, or `for`/`foreach`/`while` loops.
 */
export function parseShellCommand(command: string, workdir: string): ParsedShellActivity[] {
  if (!command || typeof command !== 'string') return [];
  const out: ParsedShellActivity[] = [];

  // Patch helpers are also invoked through shell heredocs. The literal patch
  // headers are high-confidence and can reuse the structured patch parser.
  if (/(?:^|[;&|]\s*)apply_patch\b/.test(command) && /\*\*\* Begin Patch/.test(command)) {
    out.push(...parseApplyPatch(command, workdir));
  }

  for (const stage of splitShellStages(stripHeredocBodies(command))) {
    // A heredoc body is data, not more shell syntax. Its redirect target lives
    // on the header, so scan only that line and separately parse patch headers.
    const scanText = /<<\s*['"]?[-\w]+['"]?/.test(stage) && /[\r\n]/.test(stage)
      ? stage.split(/\r?\n/, 1)[0]
      : stage;
    const tokens = tokenizeShellStage(scanText);
    if (!tokens || tokens.length === 0 || hasComplexShellConstruct(stage, tokens)) continue;
    scanShellStage(out, tokens, workdir);
  }

  return dedup(out);
}

/** Parse codex's `apply_patch` input (a patch envelope with `*** Update File:` headers). */
export function parseApplyPatch(patchText: string, workdir: string): ParsedShellActivity[] {
  if (!patchText || typeof patchText !== 'string') return [];
  const out: ParsedShellActivity[] = [];
  let m: RegExpExecArray | null;

  const updateRe = /^\*\*\*\s+Update File:\s+(.+?)\s*$/gm;
  while ((m = updateRe.exec(patchText)) !== null) pushPath(out, m[1], workdir, 'write');

  const addRe = /^\*\*\*\s+Add File:\s+(.+?)\s*$/gm;
  while ((m = addRe.exec(patchText)) !== null) pushPath(out, m[1], workdir, 'create');

  return dedup(out);
}

/**
 * Parse codex's tool-result `output` text and decide if the underlying command
 * succeeded. Codex prefixes `function_call_output.output` with
 * `"Exit code: <N>\nWall time: …\n"`. Treat absence of the prefix as success.
 */
export function shellResultIndicatesSuccess(output: string): boolean {
  if (!output) return true;
  const m = /^Exit code:\s*(-?\d+)/m.exec(output);
  if (!m) return true;
  return m[1] === '0';
}

// ── Helpers ──────────────────────────────────────────────────────────

interface ShellToken {
  value: string;
  operator?: '>' | '>>' | '<' | '<<';
  quoted: boolean;
}

function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const headers: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    headers.push(line);
    const match = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (match) delimiter = match[2];
  }
  return headers.join('\n');
}

function splitShellStages(command: string): string[] {
  const stages: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let substitutionDepth = 0;
  let backtickOpen = false;
  const push = (end: number): void => {
    const stage = command.slice(start, end).trim();
    if (stage) stages.push(stage);
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (backtickOpen) {
      if (ch === '`') backtickOpen = false;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '`') { backtickOpen = true; continue; }
    if ((ch === '\\' || ch === '^') && i + 1 < command.length) { i += 1; continue; }
    if (ch === '$' && next === '(') { substitutionDepth += 1; i += 1; continue; }
    if (substitutionDepth > 0) {
      if (ch === '(') substitutionDepth += 1;
      else if (ch === ')') substitutionDepth -= 1;
      continue;
    }
    const isSeparator = ch === ';' || (ch === '&' && next === '&') ||
      (ch === '|' && next === '|') || ch === '|';
    if (!isSeparator) continue;
    push(i);
    const width = (ch === '&' || (ch === '|' && next === '|')) ? 2 : 1;
    i += width - 1;
    start = i + 1;
  }
  push(command.length);
  return stages;
}

function tokenizeShellStage(stage: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let quoted = false;
  const flush = (): void => {
    if (current) tokens.push({ value: current, quoted });
    current = '';
    quoted = false;
  };

  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < stage.length) {
        const escaped = stage[i + 1];
        if ('\\"$`|'.includes(escaped)) { current += escaped; i += 1; }
        else current += ch;
      } else if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; continue; }
    if ((ch === '\\' || ch === '^') && i + 1 < stage.length && /[\s|;&<>"'\\]/.test(stage[i + 1])) {
      current += stage[i + 1];
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    if (ch === '>' || ch === '<') {
      flush();
      const doubled = stage[i + 1] === ch;
      const operator = (doubled ? ch + ch : ch) as '>' | '>>' | '<' | '<<';
      tokens.push({ value: operator, operator, quoted: false });
      if (doubled) i += 1;
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  flush();
  return tokens;
}

function scanShellStage(out: ParsedShellActivity[], tokens: ShellToken[], workdir: string): void {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].operator !== '>' && tokens[i].operator !== '>>') continue;
    const target = tokens[i + 1];
    if (target && !target.operator) pushStaticPath(out, target.value, workdir, 'write');
  }

  const i = tokens.findIndex((token) => !token.operator);
  if (i < 0) return;
  const command = commandName(tokens[i].value);
  const args = tokens.slice(i + 1).filter((token) => !token.operator);
  const powershell = POWERSHELL_COMMANDS[command];
  if (powershell) {
    const p = extractPowerShellPath(args.map((token) => token.value), powershell.options);
    if (p) pushStaticPath(out, p, workdir, powershell.operation);
    return;
  }
  if (['cat', 'head', 'tail', 'nl', 'wc'].includes(command)) {
    if (tokens.slice(i + 1).some((token) => token.operator === '<<')) return;
    const p = firstUnixOperand(args, command === 'head' || command === 'tail');
    if (p) pushStaticPath(out, p, workdir, 'read');
    return;
  }
  if (command === 'sed') {
    const values = args.map((token) => token.value);
    if (values.includes('-n')) {
      const p = [...args].reverse().find((token) => !token.value.startsWith('-'))?.value;
      if (p) pushStaticPath(out, p, workdir, 'read');
    }
    return;
  }
  if (command === 'type') {
    const p = args[0]?.value;
    if (p && looksLikePath(p)) pushStaticPath(out, p, workdir, 'read');
    return;
  }
  if (command === 'rg') {
    const positional = args.filter((token) => !token.value.startsWith('-'));
    const p = positional[1]?.value;
    if (p && looksLikePath(p)) pushStaticPath(out, p, workdir, 'read');
    return;
  }
  if (command === 'tee') {
    for (const target of args.filter((token) => !token.value.startsWith('-'))) {
      pushStaticPath(out, target.value, workdir, 'write');
    }
    return;
  }
  if (['cp', 'mv', 'copy', 'move'].includes(command)) {
    const positional = args.filter((token) => !token.value.startsWith('-'));
    if (positional.length >= 2) pushStaticPath(out, positional[positional.length - 1].value, workdir, 'write');
  }
}

const POWERSHELL_COMMANDS: Record<string, { operation: FileOperation; options: PowerShellCmdletOptions }> = {
  'get-content': { operation: 'read', options: { pathFlags: ['Path', 'LiteralPath'], valueFlags: ['TotalCount', 'Tail', 'ReadCount', 'Encoding', 'Delimiter', 'Filter', 'Include', 'Exclude', 'Stream', 'Credential'], switchFlags: ['Raw', 'Wait', 'Force'], allowPositionalPath: true } },
  'select-string': { operation: 'read', options: { pathFlags: ['Path', 'LiteralPath'], valueFlags: ['Pattern', 'Encoding', 'Context', 'Include', 'Exclude', 'Culture'], switchFlags: ['CaseSensitive', 'SimpleMatch', 'Quiet', 'List', 'NotMatch', 'AllMatches', 'Raw', 'NoEmphasis'], allowPositionalPath: false } },
  'set-content': { operation: 'write', options: { pathFlags: ['Path', 'LiteralPath'], valueFlags: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream', 'Credential'], switchFlags: ['NoNewline', 'Force', 'Append'], allowPositionalPath: true } },
  'add-content': { operation: 'write', options: { pathFlags: ['Path', 'LiteralPath'], valueFlags: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream', 'Credential'], switchFlags: ['NoNewline', 'Force'], allowPositionalPath: true } },
  'out-file': { operation: 'create', options: { pathFlags: ['FilePath', 'LiteralPath', 'Path'], valueFlags: ['InputObject', 'Encoding', 'Width'], switchFlags: ['Append', 'NoClobber', 'NoNewline', 'Force'], allowPositionalPath: true } },
  'new-item': { operation: 'create', options: { pathFlags: ['Path', 'LiteralPath'], valueFlags: ['Name', 'ItemType', 'Value'], switchFlags: ['Force'], allowPositionalPath: true } },
  'tee-object': { operation: 'write', options: { pathFlags: ['FilePath', 'LiteralPath', 'Path'], valueFlags: ['InputObject', 'Variable'], switchFlags: ['Append'], allowPositionalPath: true } },
};

function firstUnixOperand(args: ShellToken[], flagMayTakeValue: boolean): string | null {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].value.startsWith('-')) return args[i].value;
    if (flagMayTakeValue && i + 1 < args.length && /^\d+$/.test(args[i + 1].value)) i += 1;
  }
  return null;
}

function commandName(value: string): string {
  return value.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
}

interface PowerShellCmdletOptions {
  pathFlags: string[];
  valueFlags: string[];
  switchFlags: string[];
  allowPositionalPath: boolean;
}

function extractPowerShellPath(tokens: string[], options: PowerShellCmdletOptions): string | null {
  const pathFlags = new Set(options.pathFlags.map((f) => f.toLowerCase()));
  const valueFlags = new Set(options.valueFlags.map((f) => f.toLowerCase()));
  const switchFlags = new Set(options.switchFlags.map((f) => f.toLowerCase()));

  for (let i = 0; i < tokens.length; i++) {
    const name = flagName(tokens[i]);
    if (!name || !pathFlags.has(name)) continue;
    const value = tokens[i + 1];
    if (value && !flagName(value)) return value;
    return null;
  }

  if (!options.allowPositionalPath) return null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const name = flagName(token);
    if (!name) return token;
    if (pathFlags.has(name)) return null;
    if (valueFlags.has(name)) {
      i += 1;
      continue;
    }
    if (switchFlags.has(name)) continue;
    return null;
  }

  return null;
}

function flagName(token: string | undefined): string | null {
  if (!token || !token.startsWith('-') || token === '-') return null;
  return token.replace(/^-+/, '').toLowerCase();
}

function hasComplexShellConstruct(stage: string, tokens: ShellToken[]): boolean {
  if (/\$\(|`/.test(stage)) return true;
  return tokens.some((token) =>
    !token.quoted && /^(?:for|foreach|while|xargs)$/i.test(commandName(token.value))
  );
}

function looksLikePath(s: string): boolean {
  return s.includes('.') || s.includes('/') || s.includes('\\');
}

function pushPath(out: ParsedShellActivity[], rawPath: string, workdir: string, op: FileOperation): void {
  if (!rawPath || rawPath.startsWith('-')) return;
  const resolved = resolveAgainstWorkdir(rawPath, workdir);
  if (!resolved) return;
  out.push({ filePath: resolved, operation: op });
}

function pushStaticPath(out: ParsedShellActivity[], rawPath: string, workdir: string, op: FileOperation): void {
  if (!isStaticPath(rawPath)) return;
  pushPath(out, rawPath, workdir, op);
}

function isStaticPath(rawPath: string): boolean {
  if (!rawPath || /[\r\n|;&<>()*?`]/.test(rawPath)) return false;
  if (/\$|\$\{|%[^%]+%/.test(rawPath)) return false;
  return rawPath !== '-' && rawPath !== '/dev/stdout' && rawPath !== '/dev/stderr';
}

function resolveAgainstWorkdir(raw: string, workdir: string): string | null {
  // Unix absolute path FIRST — node's path.isAbsolute returns true for `/etc/hosts`
  // even on Windows, and we don't want to backslash-normalize unix paths.
  if (raw.startsWith('/')) return raw;
  // Windows absolute (drive-letter or UNC).
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return normalizeWinPath(raw);
  if (!workdir) return null;
  if (workdir.startsWith('/')) {
    return `${workdir.replace(/\/+$/, '')}/${raw.replace(/\\/g, '/')}`;
  }
  return normalizeWinPath(path.join(workdir, raw));
}

function normalizeWinPath(p: string): string {
  return p.replace(/\//g, '\\');
}

function dedup(items: ParsedShellActivity[]): ParsedShellActivity[] {
  const seen = new Set<string>();
  const out: ParsedShellActivity[] = [];
  for (const it of items) {
    const key = `${it.operation}:${it.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

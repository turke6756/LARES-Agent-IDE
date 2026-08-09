// Safe, NON-EVALUATING parser for the JavaScript source Codex CLI 0.144+ sends
// through its `custom_tool_call/exec` payload. Codex 0.146 predominantly emits
// `exec` (JS source) plus `wait(cell_id)` rather than top-level
// `shell_command`/`apply_patch` tool calls (see the 2026-08-09 provider-capture
// audit, §Codex / §3.1). The exec source calls nested `tools.shell_command({…})`
// and `tools.apply_patch(…)`, sometimes several in an array / `Promise.all`.
//
// This module extracts only LITERAL nested-call shapes so the existing
// shell/apply_patch handling can capture file activity. It NEVER evaluates the
// source: no `eval`, no `new Function`. It is a small string-aware scanner that
// skips string/comment content (so a `tools.apply_patch(...)` mention that only
// appears *inside* a patch body or command string is never mistaken for a real
// call) and recognises exactly two literal argument shapes:
//
//   tools.shell_command({command: "…", workdir: "…"})   → literal object
//   tools.apply_patch("*** Begin Patch …")               → literal string, or
//   const patch = "…"; tools.apply_patch(patch)          → single-string-literal var
//
// Anything dynamic (a computed command, a template-interpolated string, a
// variable that wasn't a plain string literal, a spread) is counted in
// `uncaptured` and skipped rather than guessed at.

export interface CodexExecShellCall {
  kind: 'shell_command';
  command: string;
  /** The literal `workdir` from the call, or null when absent/dynamic. */
  workdir: string | null;
}

export interface CodexExecPatchCall {
  kind: 'apply_patch';
  patch: string;
  /** apply_patch is invoked with a single string arg; it carries no workdir. */
  workdir: string | null;
}

export type CodexExecNestedCall = CodexExecShellCall | CodexExecPatchCall;

export interface CodexExecParseResult {
  calls: CodexExecNestedCall[];
  /** Count of recognised `tools.shell_command(`/`tools.apply_patch(` call sites
   *  whose arguments were dynamic/non-literal and therefore deliberately left
   *  uncaptured. Surfaced as telemetry, never guessed at. */
  uncaptured: number;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Parse an exec JS payload into its literal nested shell/patch calls. */
export function parseCodexExecCalls(source: string): CodexExecParseResult {
  const calls: CodexExecNestedCall[] = [];
  const state = { uncaptured: 0 };
  if (!source || typeof source !== 'string') return { calls, uncaptured: 0 };

  const vars = new Map<string, string>(); // simple `const x = "literal"` bindings
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i];

    // Comments — skip so a `tools.apply_patch(` inside one is never a call.
    if (c === '/' && source[i + 1] === '/') { i = skipLineComment(source, i); continue; }
    if (c === '/' && source[i + 1] === '*') { i = skipBlockComment(source, i); continue; }

    // String literals in code position — skip their contents entirely.
    if (c === '"' || c === "'" || c === '`') { i = readStringLiteral(source, i).end; continue; }

    if (IDENT_START.test(c)) {
      const start = i;
      i = readIdentEnd(source, i);
      const word = source.slice(start, i);

      if (word === 'const' || word === 'let' || word === 'var') {
        i = tryCaptureAssignment(source, i, vars);
        continue;
      }

      if (word === 'tools') {
        const call = tryReadToolsCall(source, i);
        if (call) {
          i = call.end;
          resolveCall(call, vars, calls, state);
        }
        continue;
      }
      continue;
    }

    i++;
  }

  return { calls, uncaptured: state.uncaptured };
}

/** Classify an exec/wait tool-result body. Codex prefixes the flattened output
 *  with a status line:
 *   - `Script running with cell ID <N>` → the script is still running; its real
 *     result arrives later via `wait(<N>)`.
 *   - `Script failed` → the exec threw.
 *   - otherwise the nested output(s) carry `Exit code: <k>` lines.
 *  Any non-zero exit or a `Script failed` prefix is treated as failure (all
 *  nested effects dropped — conservative, matching the single-shell behaviour).
 */
export type ExecOutcome =
  | { kind: 'deferred'; cellId: string }
  | { kind: 'success' }
  | { kind: 'failure' };

export function classifyExecOutcome(content: string): ExecOutcome {
  if (!content) return { kind: 'success' };
  const cell = /Script running with cell ID\s+(\S+)/.exec(content);
  if (cell) return { kind: 'deferred', cellId: cell[1] };
  if (/^Script failed\b/m.test(content)) return { kind: 'failure' };
  const re = /^Exit code:\s*(-?\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== '0') return { kind: 'failure' };
  }
  return { kind: 'success' };
}

// ── Scanner internals ─────────────────────────────────────────────────

interface ToolsCall {
  member: 'shell_command' | 'apply_patch';
  arg:
    | { kind: 'object'; text: string }
    | { kind: 'string'; value: string | null }
    | { kind: 'ident'; name: string }
    | { kind: 'dynamic' };
  end: number; // index just past the consumed argument
}

/** `i` points just past the `tools` identifier. Try to read `.<member>(<arg>`. */
function tryReadToolsCall(source: string, i: number): ToolsCall | null {
  const n = source.length;
  i = skipWs(source, i);
  if (source[i] !== '.') return null;
  i = skipWs(source, i + 1);
  if (i >= n || !IDENT_START.test(source[i])) return null;
  const memberStart = i;
  i = readIdentEnd(source, i);
  const member = source.slice(memberStart, i);
  if (member !== 'shell_command' && member !== 'apply_patch') return null;
  i = skipWs(source, i);
  if (source[i] !== '(') return null;
  i = skipWs(source, i + 1);

  if (i >= n) return { member, arg: { kind: 'dynamic' }, end: i };

  const ch = source[i];
  if (ch === '{') {
    const obj = readBalanced(source, i, '{', '}');
    return { member, arg: { kind: 'object', text: obj.text }, end: obj.end };
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    const s = readStringLiteral(source, i);
    return { member, arg: { kind: 'string', value: s.value }, end: s.end };
  }
  if (IDENT_START.test(ch)) {
    const nameStart = i;
    i = readIdentEnd(source, i);
    // `await tools.…` never reaches here (we only enter on the `tools` ident),
    // but a bare identifier arg like `apply_patch(patch)` does.
    return { member, arg: { kind: 'ident', name: source.slice(nameStart, i) }, end: i };
  }
  return { member, arg: { kind: 'dynamic' }, end: i };
}

function resolveCall(
  call: ToolsCall,
  vars: Map<string, string>,
  calls: CodexExecNestedCall[],
  state: { uncaptured: number },
): void {
  if (call.member === 'shell_command') {
    if (call.arg.kind !== 'object') { state.uncaptured++; return; }
    const props = extractStringProps(call.arg.text);
    const command = props.get('command');
    if (command == null || command.trim().length === 0) { state.uncaptured++; return; }
    const workdir = props.get('workdir') ?? null;
    calls.push({ kind: 'shell_command', command, workdir });
    return;
  }

  // apply_patch — a single string arg, literal or a plain-string-literal var.
  let patch: string | null = null;
  if (call.arg.kind === 'string') patch = call.arg.value;
  else if (call.arg.kind === 'ident') patch = vars.get(call.arg.name) ?? null;
  if (patch == null || patch.trim().length === 0) { state.uncaptured++; return; }
  calls.push({ kind: 'apply_patch', patch, workdir: null });
}

/** `i` points just past a `const`/`let`/`var` keyword. If the RHS is a single
 *  string literal, bind `name → value` and return the index past the literal.
 *  Otherwise leave the binding alone and return `i` unchanged so the main scan
 *  re-reads the tokens harmlessly. */
function tryCaptureAssignment(source: string, i: number, vars: Map<string, string>): number {
  const n = source.length;
  let j = skipWs(source, i);
  if (j >= n || !IDENT_START.test(source[j])) return i;
  const nameStart = j;
  j = readIdentEnd(source, j);
  const name = source.slice(nameStart, j);
  j = skipWs(source, j);
  if (source[j] !== '=') return i;
  // Don't treat `==`/`=>` as assignment.
  if (source[j + 1] === '=' || source[j + 1] === '>') return i;
  j = skipWs(source, j + 1);
  if (source[j] !== '"' && source[j] !== "'" && source[j] !== '`') return i;
  const s = readStringLiteral(source, j);
  if (s.value != null) vars.set(name, s.value);
  return s.end;
}

/** Extract top-level string-valued properties from an object-literal text
 *  (`text` includes the outer braces). Non-string values are skipped. */
function extractStringProps(text: string): Map<string, string> {
  const map = new Map<string, string>();
  // Strip a single pair of outer braces if present.
  let inner = text;
  if (inner.startsWith('{')) inner = inner.slice(1);
  if (inner.endsWith('}')) inner = inner.slice(0, -1);

  const n = inner.length;
  let i = 0;
  while (i < n) {
    while (i < n && /[\s,]/.test(inner[i])) i++;
    if (i >= n) break;

    // Key: string literal or bare identifier.
    let key: string | null = null;
    const kc = inner[i];
    if (kc === '"' || kc === "'" || kc === '`') {
      const r = readStringLiteral(inner, i);
      key = r.value;
      i = r.end;
    } else if (IDENT_START.test(kc)) {
      const s = i;
      i = readIdentEnd(inner, i);
      key = inner.slice(s, i);
    } else {
      i = skipToTopLevelComma(inner, i);
      continue;
    }

    i = skipWs(inner, i);
    if (inner[i] !== ':') { i = skipToTopLevelComma(inner, i); continue; }
    i = skipWs(inner, i + 1);

    const vc = inner[i];
    if (vc === '"' || vc === "'" || vc === '`') {
      const r = readStringLiteral(inner, i);
      i = r.end;
      if (key != null && r.value != null) map.set(key, r.value);
    } else {
      i = skipToTopLevelComma(inner, i);
    }
  }
  return map;
}

/** Advance past the next top-level `,` (or to end), string/bracket/comment
 *  aware so commas inside nested structures don't terminate early. */
function skipToTopLevelComma(s: string, i: number): number {
  let depth = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = readStringLiteral(s, i).end; continue; }
    if (ch === '/' && s[i + 1] === '/') { i = skipLineComment(s, i); continue; }
    if (ch === '/' && s[i + 1] === '*') { i = skipBlockComment(s, i); continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return i; depth--; i++; continue; }
    if (ch === ',' && depth === 0) return i + 1;
    i++;
  }
  return i;
}

/** Read a balanced delimiter pair (string/comment aware). `i` points at `open`.
 *  Returns the substring INCLUDING both delimiters and the index just past it. */
function readBalanced(source: string, i: number, open: string, close: string): { text: string; end: number } {
  const n = source.length;
  const start = i;
  let depth = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = readStringLiteral(source, i).end; continue; }
    if (ch === '/' && source[i + 1] === '/') { i = skipLineComment(source, i); continue; }
    if (ch === '/' && source[i + 1] === '*') { i = skipBlockComment(source, i); continue; }
    if (ch === open) { depth++; i++; continue; }
    if (ch === close) { depth--; i++; if (depth === 0) return { text: source.slice(start, i), end: i }; continue; }
    i++;
  }
  return { text: source.slice(start), end: n }; // unterminated
}

/** Read a string literal starting at a quote/backtick. Returns the DECODED
 *  value (escapes interpreted) and the index just past the closing quote. A
 *  template literal containing `${…}` interpolation yields `value: null`
 *  (dynamic — not a usable literal). */
function readStringLiteral(source: string, i: number): { value: string | null; end: number } {
  const q = source[i];
  const n = source.length;
  i++;
  let value = '';
  let dynamic = false;
  while (i < n) {
    const ch = source[i];
    if (ch === '\\') {
      const esc = readEscape(source, i);
      value += esc.ch;
      i += esc.len;
      continue;
    }
    if (q === '`' && ch === '$' && source[i + 1] === '{') {
      dynamic = true;
      i = skipBalancedBraces(source, i + 1);
      continue;
    }
    if (ch === q) { i++; return { value: dynamic ? null : value, end: i }; }
    value += ch;
    i++;
  }
  return { value: dynamic ? null : value, end: n }; // unterminated
}

/** `i` points at `{`. Skip to just past the matching `}` (string aware). */
function skipBalancedBraces(source: string, i: number): number {
  const n = source.length;
  let depth = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = readStringLiteral(source, i).end; continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  return n;
}

function readEscape(source: string, i: number): { ch: string; len: number } {
  const next = source[i + 1];
  switch (next) {
    case 'n': return { ch: '\n', len: 2 };
    case 'r': return { ch: '\r', len: 2 };
    case 't': return { ch: '\t', len: 2 };
    case 'b': return { ch: '\b', len: 2 };
    case 'f': return { ch: '\f', len: 2 };
    case 'v': return { ch: '\v', len: 2 };
    case '0': return { ch: '\0', len: 2 };
    case 'x': {
      const hex = source.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) return { ch: String.fromCharCode(parseInt(hex, 16)), len: 4 };
      return { ch: 'x', len: 2 };
    }
    case 'u': {
      if (source[i + 2] === '{') {
        const end = source.indexOf('}', i + 3);
        if (end > 0) {
          const hex = source.slice(i + 3, end);
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            try { return { ch: String.fromCodePoint(parseInt(hex, 16)), len: end - i + 1 }; } catch { /* invalid code point */ }
          }
        }
        return { ch: 'u', len: 2 };
      }
      const hex = source.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) return { ch: String.fromCharCode(parseInt(hex, 16)), len: 6 };
      return { ch: 'u', len: 2 };
    }
    case undefined: return { ch: '', len: 1 };
    default: return { ch: next, len: 2 }; // \\  \"  \'  \`  \/  \$ … → literal char
  }
}

function skipLineComment(source: string, i: number): number {
  const idx = source.indexOf('\n', i);
  return idx < 0 ? source.length : idx + 1;
}

function skipBlockComment(source: string, i: number): number {
  const idx = source.indexOf('*/', i + 2);
  return idx < 0 ? source.length : idx + 2;
}

function skipWs(source: string, i: number): number {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

function readIdentEnd(source: string, i: number): number {
  i++; // first char already known to be IDENT_START
  while (i < source.length && IDENT_PART.test(source[i])) i++;
  return i;
}

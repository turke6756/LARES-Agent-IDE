// A1 — executed-file capture from command strings (hardening-wp2b-capture.md §4).
// Pure, IO-free, table-driven-tested. Extracts the script path(s) an interpreter
// invocation runs (node|python|bash|pwsh <script>) with an explicit GIVE-UP
// boundary (never a partial/guessed path) and a WSL/Windows dual-root fold so heat
// counts don't split (`/mnt/c/x` and `C:\x` collapse to one LOWER(arg_path) key).
//
// The §4.5 worked-cases table IS the test of record.

export type PathConfidence = 'exact' | 'normalized' | 'unresolved';

export interface ExecPath {
  rawPath: string;                 // exactly as seen (casing preserved)
  normalizedPath: string | null;   // canonical Windows/POSIX form, or null when unresolved
  confidence: PathConfidence;
}

export interface ExtractResult {
  paths: ExecPath[];               // one per distinct executed script (deduped by normalized key)
  commandFamily: string | null;    // e.g. 'npm-run:build' when a pm-script (no file) is the target
}

export type Shell = 'bash' | 'powershell';

const MAX_SEGMENTS = 12;
const MAX_RECURSE_DEPTH = 2;

const SCRIPT_EXT = new Set([
  '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.ps1', '.rb', '.php', '.r', '.pl', '.cmd', '.bat',
]);

const INTERPRETERS = new Set([
  'node', 'python', 'python3', 'py', 'bash', 'sh', 'zsh', 'ts-node', 'tsx',
  'deno', 'ruby', 'php', 'rscript', 'pwsh', 'powershell',
]);
const WRAPPERS = new Set(['npm', 'pnpm', 'yarn', 'npx']);

// Interpreter flags that consume the FOLLOWING token as a value (so it is not a script).
const VALUE_FLAGS: Record<string, Set<string>> = {
  node: new Set(['-r', '--require', '--loader', '--experimental-loader', '--import', '--conditions']),
  'ts-node': new Set(['-r', '--require', '--loader']),
  tsx: new Set(['--loader', '--import']),
  deno: new Set(['--config', '--import-map', '--lock']),
};
// Flags that mean "no file target — inline/module/eval" → hard give-up.
const GIVEUP_FLAGS: Record<string, Set<string>> = {
  node: new Set(['-e', '--eval', '-p', '--print']),
  python: new Set(['-c', '-m']),
  python3: new Set(['-c', '-m']),
  py: new Set(['-c', '-m']),
  deno: new Set(['eval']),
  ruby: new Set(['-e']),
  php: new Set(['-r']),
  pwsh: new Set(['-encodedcommand', '-e']),
  powershell: new Set(['-encodedcommand', '-e']),
};

/** True if a token in a path position is un-resolvable (variable/glob/subshell/…). */
function isUnresolvableToken(tok: string): boolean {
  return (
    tok.includes('$(') || tok.includes('`') ||
    /\$\w|\$\{|%[^%]+%/.test(tok) ||   // $VAR, ${x}, %VAR%
    /[*?]/.test(tok) ||               // glob
    tok === '-' || tok.startsWith('<<')
  );
}

function stripQuotes(tok: string): string {
  if (tok.length >= 2) {
    const a = tok[0], b = tok[tok.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return tok.slice(1, -1);
  }
  return tok;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function extLower(p: string): string {
  const b = basename(p);
  const dot = b.lastIndexOf('.');
  return dot >= 0 ? b.slice(dot).toLowerCase() : '';
}

function isScriptPath(tok: string): boolean {
  return SCRIPT_EXT.has(extLower(tok));
}

// ── Segmentation: split on shell operators, respecting quotes / here-strings ──
function segment(cmd: string, shell: Shell): string[] {
  const segs: string[] = [];
  let cur = '';
  let i = 0;
  let quote: string | null = null; // "'" or '"'
  let hereString = false;          // PS @'…'@ / @"…"@
  const push = () => { if (cur.trim()) segs.push(cur.trim()); cur = ''; };
  while (i < cmd.length) {
    const c = cmd[i];
    const next2 = cmd.slice(i, i + 2);
    if (hereString) {
      cur += c;
      if ((c === "'" || c === '"') && cmd[i + 1] === '@') { hereString = false; cur += '@'; i += 2; continue; }
      i++; continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      i++; continue;
    }
    if (shell === 'powershell' && (next2 === "@'" || next2 === '@"')) { hereString = true; cur += next2; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; i++; continue; }
    // operators
    if (c === '\n') { push(); i++; continue; }
    if (next2 === '&&' || next2 === '||') { push(); i += 2; continue; }
    if (c === '|' || c === ';') { push(); i++; continue; }
    if (shell === 'bash' && c === '&') { push(); i++; continue; }
    cur += c; i++;
  }
  push();
  return segs;
}

// ── Tokenize a segment: quote-aware whitespace split (quotes preserved on token) ──
function tokenize(seg: string): string[] {
  const toks: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) { toks.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) toks.push(cur);
  return toks;
}

function head(tok: string): string {
  let h = basename(stripQuotes(tok)).toLowerCase();
  if (h.endsWith('.exe')) h = h.slice(0, -4);
  return h;
}

// ── §4.3 normalization ──
function collapseSegments(pathParts: string[]): string[] {
  const out: string[] = [];
  for (const p of pathParts) {
    if (p === '.' || p === '') continue;
    if (p === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push(p); continue; }
    out.push(p);
  }
  return out;
}

/** Fold a resolved absolute path (Windows drive form or genuine POSIX) to canonical. */
function canonicalizeAbsolute(raw: string): { path: string; confidence: PathConfidence } | null {
  let s = raw.replace(/["']/g, '');
  // WSL UNC: \\wsl.localhost\<distro>\mnt\<x>\rest  or  \\wsl$\<distro>\...
  const unc = s.replace(/\\/g, '/').match(/^\/\/wsl(?:\.localhost|\$)\/[^/]+\/mnt\/([a-zA-Z])\/(.*)$/);
  if (unc) {
    const drive = unc[1].toUpperCase();
    const rest = collapseSegments(unc[2].split('/'));
    return { path: `${drive}:\\${rest.join('\\')}`, confidence: 'normalized' };
  }
  // WSL mount: /mnt/<x>/rest → <X>:\rest
  const mnt = s.replace(/\\/g, '/').match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mnt) {
    const drive = mnt[1].toUpperCase();
    const rest = collapseSegments(mnt[2].split('/'));
    return { path: `${drive}:\\${rest.join('\\')}`, confidence: 'normalized' };
  }
  // Drive form: C:/… or C:\…
  const drv = s.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (drv) {
    const drive = drv[1].toUpperCase();
    const rest = collapseSegments(drv[2].replace(/\\/g, '/').split('/'));
    return { path: `${drive}:\\${rest.join('\\')}`, confidence: 'exact' };
  }
  // Genuine POSIX absolute not under /mnt/<drive>
  if (s.startsWith('/')) {
    const rest = collapseSegments(s.split('/'));
    return { path: '/' + rest.join('/'), confidence: 'normalized' };
  }
  return null;
}

/** Join a cwd + relative path, then canonicalize. cwd may be Windows or POSIX. */
function resolveRelative(rel: string, cwd: string): { path: string; confidence: PathConfidence } {
  const cwdWin = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.includes('\\');
  const joiner = cwdWin ? '\\' : '/';
  const combined = cwd.replace(/[\\/]+$/, '') + joiner + rel;
  const abs = canonicalizeAbsolute(combined);
  if (abs) return { path: abs.path, confidence: 'normalized' };
  // fall through: cwd was itself relative — collapse best-effort, mark normalized
  const parts = collapseSegments(combined.replace(/\\/g, '/').split('/'));
  return { path: parts.join('/'), confidence: 'normalized' };
}

export function normalizeExecPath(raw: string, cwd: string | null | undefined): ExecPath {
  const rawPath = stripQuotes(raw);
  if (isUnresolvableToken(rawPath)) {
    return { rawPath, normalizedPath: null, confidence: 'unresolved' };
  }
  // absolute?
  const abs = canonicalizeAbsolute(rawPath);
  if (abs && (/^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.replace(/\\/g, '/').startsWith('/'))) {
    return { rawPath, normalizedPath: abs.path, confidence: abs.confidence };
  }
  // relative — needs cwd
  if (!cwd || !cwd.trim()) {
    return { rawPath, normalizedPath: null, confidence: 'unresolved' };
  }
  const r = resolveRelative(rawPath, cwd);
  return { rawPath, normalizedPath: r.path, confidence: r.confidence };
}

// ── DISPATCH one segment's tokens → executed path(s) ──
function dispatchSegment(toks: string[], shell: Shell, cwd: string | null | undefined, depth: number, out: ExecPath[], fam: { family: string | null }): void {
  if (!toks.length) return;
  const cmd0 = stripQuotes(toks[0]);
  const h = head(toks[0]);
  const args = toks.slice(1);

  // (c/DIRECT) token[0] itself is a script path (has separator + script ext)
  if ((cmd0.includes('/') || cmd0.includes('\\')) && isScriptPath(cmd0)) {
    pushPath(cmd0, cwd, out);
    return;
  }
  // PowerShell call operator: & '…\x.ps1'
  if (h === '&' || cmd0 === '&') {
    if (args.length) {
      const target = stripQuotes(args[0]);
      if (isScriptPath(target)) pushPath(target, cwd, out);
    }
    return;
  }

  // (b/WRAPPERS)
  if (WRAPPERS.has(h)) {
    handleWrapper(h, args, shell, cwd, depth, out, fam);
    return;
  }

  // (a/INTERPRETERS)
  if (INTERPRETERS.has(h)) {
    handleInterpreter(h, args, shell, cwd, depth, out);
    return;
  }
  // (d) give up — nothing to record
}

function pushPath(raw: string, cwd: string | null | undefined, out: ExecPath[]): void {
  const ep = normalizeExecPath(raw, cwd);
  const key = ep.normalizedPath ? ep.normalizedPath.toLowerCase() : `raw:${ep.rawPath.toLowerCase()}`;
  if (!out.some((e) => (e.normalizedPath ? e.normalizedPath.toLowerCase() : `raw:${e.rawPath.toLowerCase()}`) === key)) {
    out.push(ep);
  }
}

function handleWrapper(h: string, args: string[], shell: Shell, cwd: string | null | undefined, depth: number, out: ExecPath[], fam: { family: string | null }): void {
  // npm run <name> / pm script → command_family only, no file
  if ((h === 'npm' || h === 'pnpm' || h === 'yarn') && args[0] === 'run') {
    const name = args[1] ? stripQuotes(args[1]) : '';
    fam.family = `npm-run:${name}`;
    return;
  }
  // yarn <script> (bare) is also a pm script; record family, no file
  // Unwrap exec forms → re-descend once into an interpreter invocation:
  //   npm exec -- <interp> <script> | npx <interp> <script> | pnpm dlx … | yarn dlx …
  let rest: string[] | null = null;
  if (h === 'npx') rest = args;
  else if (h === 'npm' && args[0] === 'exec') {
    const dashdash = args.indexOf('--');
    rest = dashdash >= 0 ? args.slice(dashdash + 1) : args.slice(1);
  } else if ((h === 'pnpm' || h === 'yarn') && args[0] === 'dlx') {
    rest = args.slice(1);
  }
  if (rest && rest.length && depth < MAX_RECURSE_DEPTH) {
    dispatchSegment(rest, shell, cwd, depth + 1, out, fam);
  }
  // else: unknown wrapper form → give up
}

function handleInterpreter(h: string, args: string[], shell: Shell, cwd: string | null | undefined, depth: number, out: ExecPath[]): void {
  const giveup = GIVEUP_FLAGS[h] || new Set<string>();
  const valueFlags = VALUE_FLAGS[h] || new Set<string>();
  const isShellInterp = h === 'bash' || h === 'sh' || h === 'zsh';
  const isPwsh = h === 'pwsh' || h === 'powershell';

  if (h === 'deno') {
    // deno: require `run` before a path
    if (args[0] !== 'run') return;
    args = args.slice(1);
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const al = stripQuotes(a).toLowerCase();

    // pwsh -File <path> → the path directly
    if (isPwsh && (al === '-file' || al === '-f')) {
      const p = args[i + 1] ? stripQuotes(args[i + 1]) : '';
      if (p && !isUnresolvableToken(p)) pushPath(p, cwd, out);
      else if (p) out.push(normalizeExecPath(p, cwd));
      return;
    }
    // pwsh -Command "…" / bash -c "…" → recurse into the quoted command string
    if (isPwsh && (al === '-command' || al === '-c')) {
      const inner = args[i + 1];
      if (inner && depth < MAX_RECURSE_DEPTH) recurseInner(stripQuotes(inner), shell, cwd, depth, out);
      return;
    }
    if (isShellInterp && (al === '-c' || /^-[a-z]*c$/.test(al))) {
      const inner = args[i + 1];
      if (inner && depth < MAX_RECURSE_DEPTH) recurseInner(stripQuotes(inner), shell, cwd, depth, out);
      return;
    }
    // hard give-up flags (inline/module/eval)
    if (giveup.has(al)) return;
    // stdin '-'
    if (a === '-') return;
    // value-taking flag → skip its value
    if (valueFlags.has(al)) { i++; continue; }
    // any other flag → skip (treat boolean)
    if (a.startsWith('-')) continue;
    // first non-flag positional
    const cand = stripQuotes(a);
    if (isUnresolvableToken(cand)) { out.push(normalizeExecPath(cand, cwd)); return; }
    if (isScriptPath(cand)) { pushPath(cand, cwd, out); return; }
    // a positional that isn't a script (e.g. `python somedir`) → give up
    return;
  }
}

function recurseInner(inner: string, shell: Shell, cwd: string | null | undefined, depth: number, out: ExecPath[]): void {
  const segs = segment(inner, shell).slice(0, MAX_SEGMENTS);
  const fam = { family: null as string | null };
  for (const s of segs) dispatchSegment(tokenize(s), shell, cwd, depth + 1, out, fam);
}

/**
 * Extract the executed-script path(s) from a shell command string.
 * Returns { paths, commandFamily }. `paths` is empty on a hard give-up (module,
 * inline, npm-run, unknown command); a path whose position held a variable/glob
 * yields one entry with `confidence:'unresolved'` and `normalizedPath:null`.
 */
export function extractExecutedPaths(commandStr: string, shell: Shell, cwd: string | null | undefined): ExtractResult {
  const out: ExecPath[] = [];
  const fam = { family: null as string | null };
  if (!commandStr || !commandStr.trim()) return { paths: out, commandFamily: null };
  const segs = segment(commandStr, shell);
  if (segs.length > MAX_SEGMENTS) return { paths: out, commandFamily: null }; // >MAX_SEGMENTS → give up
  for (const s of segs) dispatchSegment(tokenize(s), shell, cwd, 0, out, fam);
  return { paths: out, commandFamily: fam.family };
}

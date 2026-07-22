// Rebuild every native module the packaged app ships, against the Electron ABI.
//
// Usage: node scripts/rebuild-native.js [--arch=x64]
//
// Release-safety rule for this file: every string patch below MUST be asserted.
// A silent no-op (upstream node-pty changed winpty.gyp, or MSBuild stopped
// emitting the Spectre property) produces a plausible-looking build that fails
// much later on a user's machine. Hard-fail here instead.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repoRoot = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const archArg = process.argv.slice(2).find((a) => a.startsWith('--arch='));
const arch = archArg ? archArg.slice('--arch='.length) : process.arch;
if (arch !== 'x64') {
  console.error(
    `[rebuild-native] Unsupported --arch=${arch}. Lares packages Windows x64 only ` +
    '(see plans/installable-app-packaging.md §1). Re-run with --arch=x64.',
  );
  process.exit(1);
}

const nodePtyDir = path.join(repoRoot, 'node_modules', 'node-pty');
const winptyGyp = path.join(nodePtyDir, 'deps', 'winpty', 'src', 'winpty.gyp');
const genDir = path.join(nodePtyDir, 'deps', 'winpty', 'src', 'gen');
const genVersion = path.join(genDir, 'GenVersion.h');

const electronVersion = require(path.join(repoRoot, 'node_modules', 'electron', 'package.json')).version;

function fail(msg) {
  console.error(`[rebuild-native] FAIL: ${msg}`);
  process.exit(1);
}

console.log('[rebuild-native] electronVersion=%s arch=%s', electronVersion, arch);

// ---------------------------------------------------------------------------
// node-pty
// ---------------------------------------------------------------------------
console.log(`[rebuild-native] module=node-pty  target=Electron ${electronVersion}  arch=${arch}`);

// Patch winpty.gyp to avoid bat file issues on Windows.
// Both replacements are idempotent: after a previous run the file already holds
// the patched text, so "unchanged AND already patched" is success, while
// "unchanged AND not patched" means the upstream pattern moved -> hard fail.
const gypBefore = fs.readFileSync(winptyGyp, 'utf8');
let gyp = gypBefore;

const COMMIT_HASH_PATTERN = /'WINPTY_COMMIT_HASH%': '<!\(cmd \/c "cd shared && GetCommitHash\.bat"\)'/;
const COMMIT_HASH_PATCHED = "'WINPTY_COMMIT_HASH%': 'none'";
gyp = gyp.replace(COMMIT_HASH_PATTERN, COMMIT_HASH_PATCHED);
if (!gyp.includes(COMMIT_HASH_PATCHED)) {
  fail(
    `winpty.gyp patch 1 did not match and the file is not already patched.\n` +
    `  file:     ${winptyGyp}\n` +
    `  expected: ${COMMIT_HASH_PATTERN}\n` +
    `  Upstream node-pty likely changed winpty.gyp. Re-derive the patch before packaging.`,
  );
}

const GEN_VERSION_PATTERN = /'<!\(cmd \/c "cd shared && UpdateGenVersion\.bat <\(WINPTY_COMMIT_HASH\)"\)'/;
const GEN_VERSION_PATCHED = "'gen'";
const beforeGenPatch = gyp;
gyp = gyp.replace(GEN_VERSION_PATTERN, GEN_VERSION_PATCHED);
if (gyp === beforeGenPatch && GEN_VERSION_PATTERN.test(gypBefore)) {
  fail(`winpty.gyp patch 2 failed to apply.\n  file: ${winptyGyp}`);
}
if (GEN_VERSION_PATTERN.test(gyp)) {
  fail(`winpty.gyp patch 2 left the unpatched pattern in place.\n  file: ${winptyGyp}`);
}
// If neither the pattern nor its replacement is present, the upstream layout moved.
if (!gyp.includes(GEN_VERSION_PATCHED)) {
  fail(
    `winpty.gyp patch 2 did not match and the file is not already patched.\n` +
    `  file:     ${winptyGyp}\n` +
    `  expected: ${GEN_VERSION_PATTERN}\n` +
    `  Upstream node-pty likely changed winpty.gyp. Re-derive the patch before packaging.`,
  );
}

if (gyp !== gypBefore) {
  fs.writeFileSync(winptyGyp, gyp);
  console.log('[rebuild-native] winpty.gyp patched (both patterns matched).');
} else {
  console.log('[rebuild-native] winpty.gyp already patched (both replacements present).');
}

// Create GenVersion.h manually
fs.mkdirSync(genDir, { recursive: true });
const versionTxt = fs.readFileSync(path.join(nodePtyDir, 'deps', 'winpty', 'VERSION.txt'), 'utf8').trim();
fs.writeFileSync(genVersion, [
  '// AUTO-GENERATED',
  `const char GenVersion_Version[] = "${versionTxt}";`,
  'const char GenVersion_Commit[] = "none";',
  ''
].join('\n'));

// Configure
console.log('Configuring...');
execSync(
  `npx node-gyp configure --target=${electronVersion} --arch=${arch} --dist-url=https://electronjs.org/headers`,
  { cwd: nodePtyDir, stdio: 'inherit' }
);

// Disable Spectre mitigation in generated vcxproj files
console.log('Patching Spectre mitigation...');
function patchVcxproj(dir) {
  let patched = 0;
  let seen = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = patchVcxproj(full);
      patched += sub.patched;
      seen += sub.seen;
    } else if (entry.name.endsWith('.vcxproj')) {
      seen++;
      let content = fs.readFileSync(full, 'utf8');
      if (content.includes('<SpectreMitigation>Spectre</SpectreMitigation>')) {
        content = content.replace(/<SpectreMitigation>Spectre<\/SpectreMitigation>/g, '<SpectreMitigation>false</SpectreMitigation>');
        fs.writeFileSync(full, content);
        patched++;
      }
    }
  }
  return { patched, seen };
}
const spectre = patchVcxproj(path.join(nodePtyDir, 'build'));
if (spectre.seen === 0) {
  fail(
    `no .vcxproj files found under ${path.join(nodePtyDir, 'build')} after node-gyp configure — ` +
    'the configure step did not produce an MSBuild project.',
  );
}
if (spectre.patched === 0) {
  console.warn(
    `[rebuild-native] WARNING: Spectre rewrite matched 0 of ${spectre.seen} .vcxproj files. ` +
    'Either node-gyp stopped emitting <SpectreMitigation>Spectre</SpectreMitigation> (fine), ' +
    'or the property moved (the build will fail below if the Spectre libs are absent).',
  );
} else {
  console.log(`[rebuild-native] Spectre rewrite applied to ${spectre.patched}/${spectre.seen} .vcxproj files.`);
}

// Build
console.log('Building...');
execSync(
  `npx node-gyp build --target=${electronVersion} --arch=${arch} --dist-url=https://electronjs.org/headers`,
  { cwd: nodePtyDir, stdio: 'inherit' }
);

console.log('node-pty rebuilt successfully for Electron ' + electronVersion);

// ---------------------------------------------------------------------------
// better-sqlite3
// ---------------------------------------------------------------------------
console.log(`[rebuild-native] module=better-sqlite3  target=Electron ${electronVersion}  arch=${arch}`);
execSync(
  `npx @electron/rebuild -f -o better-sqlite3 -v ${electronVersion} --arch=${arch}`,
  { cwd: repoRoot, stdio: 'inherit' }
);
console.log('better-sqlite3 rebuilt successfully for Electron ' + electronVersion);

// ---------------------------------------------------------------------------
// lares-native (ships via extraResources; see plan §4.3)
// ---------------------------------------------------------------------------
// Built through its own build.js, which already targets the same Electron
// headers and applies the same Spectre rewrite. A failure here is a WARNING,
// not a hard stop: index.js degrades gracefully and verify-native reports the
// real status, which is where the go/no-go decision is recorded.
const laresNativeDir = path.join(repoRoot, 'native', 'lares-native');
const laresNativeBuild = path.join(laresNativeDir, 'build.js');
if (!fs.existsSync(laresNativeBuild)) {
  console.warn(`[rebuild-native] WARNING: ${laresNativeBuild} not found; skipping lares-native.`);
} else {
  console.log(`[rebuild-native] module=lares-native  target=Electron ${electronVersion}  arch=${arch}`);
  try {
    execSync(`node "${laresNativeBuild}"`, { cwd: laresNativeDir, stdio: 'inherit' });
    const out = path.join(laresNativeDir, 'build', 'Release', 'lares_native.node');
    if (fs.existsSync(out)) {
      console.log('lares-native rebuilt successfully for Electron ' + electronVersion);
    } else {
      console.warn('[rebuild-native] WARNING: lares-native build reported success but lares_native.node is missing.');
    }
  } catch (err) {
    console.warn(
      '[rebuild-native] WARNING: lares-native rebuild failed; the committed binary (if any) will be shipped ' +
      'and the watchdog may run degraded. See plan §4.3 for the release gate.\n  ' + (err && err.message),
    );
  }
}

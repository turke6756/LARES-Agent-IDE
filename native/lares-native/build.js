// Build lares-native against the Electron ABI (matches the repo's node-pty path
// in scripts/rebuild-native.js: node-gyp + Electron headers, then disable the
// Spectre mitigation in the generated vcxproj so it builds without the Spectre
// libs). Run from anywhere: `node native/lares-native/build.js`.
//
// Set LARES_NATIVE_TARGET=node to build against the running Node ABI instead of
// Electron (useful only for isolated experiments — the app loads this in the
// Electron main process, so Electron is the real target).

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const moduleDir = __dirname;
const repoRoot = path.join(moduleDir, '..', '..');

function electronVersion() {
  return require(path.join(repoRoot, 'node_modules', 'electron', 'package.json')).version;
}

const targetNode = process.env.LARES_NATIVE_TARGET === 'node';
const ev = electronVersion();

const gypArgs = targetNode
  ? '--arch=x64'
  : `--target=${ev} --arch=x64 --dist-url=https://electronjs.org/headers`;

console.log(
  targetNode
    ? `Building lares-native for Node ${process.versions.node} (ABI ${process.versions.modules})...`
    : `Building lares-native for Electron ${ev}...`,
);

// Configure
console.log('Configuring...');
execSync(`npx node-gyp configure ${gypArgs}`, { cwd: moduleDir, stdio: 'inherit' });

// Disable Spectre mitigation in generated vcxproj (same as node-pty rebuild).
if (process.platform === 'win32') {
  console.log('Patching Spectre mitigation...');
  const patch = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) patch(full);
      else if (entry.name.endsWith('.vcxproj')) {
        let c = fs.readFileSync(full, 'utf8');
        if (c.includes('<SpectreMitigation>Spectre</SpectreMitigation>')) {
          c = c.replace(/<SpectreMitigation>Spectre<\/SpectreMitigation>/g, '<SpectreMitigation>false</SpectreMitigation>');
          fs.writeFileSync(full, c);
        }
      }
    }
  };
  const buildDir = path.join(moduleDir, 'build');
  if (fs.existsSync(buildDir)) patch(buildDir);
}

// Build
console.log('Building...');
execSync(`npx node-gyp build ${gypArgs}`, { cwd: moduleDir, stdio: 'inherit' });

const out = path.join(moduleDir, 'build', 'Release', 'lares_native.node');
console.log(fs.existsSync(out)
  ? `lares-native built successfully: ${out}`
  : 'WARNING: build finished but lares_native.node not found in build/Release');

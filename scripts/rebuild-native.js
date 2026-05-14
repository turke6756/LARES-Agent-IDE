const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');
const winptyGyp = path.join(nodePtyDir, 'deps', 'winpty', 'src', 'winpty.gyp');
const genDir = path.join(nodePtyDir, 'deps', 'winpty', 'src', 'gen');
const genVersion = path.join(genDir, 'GenVersion.h');

const electronVersion = require(path.join(__dirname, '..', 'node_modules', 'electron', 'package.json')).version;

console.log(`Rebuilding node-pty for Electron ${electronVersion}...`);

// Patch winpty.gyp to avoid bat file issues on Windows
let gyp = fs.readFileSync(winptyGyp, 'utf8');
gyp = gyp.replace(
  /'WINPTY_COMMIT_HASH%': '<!\(cmd \/c "cd shared && GetCommitHash\.bat"\)'/,
  "'WINPTY_COMMIT_HASH%': 'none'"
);
gyp = gyp.replace(
  /'<!\(cmd \/c "cd shared && UpdateGenVersion\.bat <\(WINPTY_COMMIT_HASH\)"\)'/,
  "'gen'"
);
fs.writeFileSync(winptyGyp, gyp);

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
  `npx node-gyp configure --target=${electronVersion} --arch=x64 --dist-url=https://electronjs.org/headers`,
  { cwd: nodePtyDir, stdio: 'inherit' }
);

// Disable Spectre mitigation in generated vcxproj files
console.log('Patching Spectre mitigation...');
function patchVcxproj(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) patchVcxproj(full);
    else if (entry.name.endsWith('.vcxproj')) {
      let content = fs.readFileSync(full, 'utf8');
      if (content.includes('<SpectreMitigation>Spectre</SpectreMitigation>')) {
        content = content.replace(/<SpectreMitigation>Spectre<\/SpectreMitigation>/g, '<SpectreMitigation>false</SpectreMitigation>');
        fs.writeFileSync(full, content);
      }
    }
  }
}
patchVcxproj(path.join(nodePtyDir, 'build'));

// Build
console.log('Building...');
execSync(
  `npx node-gyp build --target=${electronVersion} --arch=x64 --dist-url=https://electronjs.org/headers`,
  { cwd: nodePtyDir, stdio: 'inherit' }
);

console.log('node-pty rebuilt successfully for Electron ' + electronVersion);

// ── better-sqlite3 ─────────────────────────────────────────────────────────
console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion}...`);
execSync(
  `npx @electron/rebuild -f -o better-sqlite3 -v ${electronVersion}`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
);
console.log('better-sqlite3 rebuilt successfully for Electron ' + electronVersion);

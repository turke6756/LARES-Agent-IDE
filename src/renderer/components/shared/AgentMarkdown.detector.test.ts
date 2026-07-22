// @vitest-environment jsdom
// AgentMarkdown transitively imports theme-store, which touches `document` at
// module load — the detector functions themselves are pure.
import { describe, expect, it } from 'vitest';
import { extractFilePaths, truncateAtFirstFile } from './AgentMarkdown';

describe('file-path detector — merged-capture regression cases', () => {
  // Real captures pulled from agent logs where a slash-joined pair of filenames
  // was swallowed as one bogus path. Each must now stop at the first file.
  const mergedCases: Array<[string, string]> = [
    ['README.md/index.ts', 'README.md'],
    ['CLAUDE.md/AGENTS.md', 'CLAUDE.md'],
    ['CLAUDE.md/MEMORY.md', 'CLAUDE.md'],
    ['CLAUDE.md/SECURITY.md', 'CLAUDE.md'],
    ['CLAUDE.md/settings.js', 'CLAUDE.md'],
    ['AboutMe.md/ApplicationProfile.md', 'AboutMe.md'],
    ['-wiring.ts/.test.ts', '-wiring.ts'],
  ];

  it.each(mergedCases)('truncates %s -> %s', (input, expected) => {
    expect(truncateAtFirstFile(input)).toBe(expected);
  });

  it.each(mergedCases)('extracts %s as first link -> %s', (input, expected) => {
    expect(extractFilePaths(input)[0]).toBe(expected);
  });
});

describe('file-path detector — legit dotted directories are preserved', () => {
  // The dotted segment here is NOT a known extension, so it stays a directory
  // and the whole path keeps matching.
  const keepWhole = [
    '.github/workflows/ci.yml',
    'src/foo.bar/baz.ts',
    'node_modules/@scope/pkg/index.ts',
    'src/main/index.ts',
    'plans/context-optimizer-r2-wp1b-brief.md',
    './docs/ORCHESTRATION_SPIKE.md',
  ];

  it.each(keepWhole)('leaves %s intact', (path) => {
    expect(truncateAtFirstFile(path)).toBe(path);
    expect(extractFilePaths(path)[0]).toBe(path);
  });

  it('matches absolute Windows and POSIX paths whole', () => {
    expect(extractFilePaths('see C:\\Users\\x\\file.ts here')[0]).toBe('C:\\Users\\x\\file.ts');
    expect(extractFilePaths('see /home/x/file.py here')[0]).toBe('/home/x/file.py');
  });

  it('leaves an absolute path with an extension-bearing parent dir intact', () => {
    // The first file-like check only applies to trimming an over-capture; a
    // genuinely dotted dir whose suffix is unknown is safe.
    expect(truncateAtFirstFile('src/config.d/app.json')).toBe('src/config.d/app.json');
  });
});

describe('file-path detector — extraction within prose', () => {
  it('links a path embedded in a sentence and stops at the first file', () => {
    const paths = extractFilePaths('I edited README.md/index.ts just now.');
    expect(paths[0]).toBe('README.md');
  });

  it('finds multiple distinct paths in one string', () => {
    const paths = extractFilePaths('touched src/main/index.ts and docs/setup.md today');
    expect(paths).toContain('src/main/index.ts');
    expect(paths).toContain('docs/setup.md');
  });

  it('does not treat trailing sentence punctuation as part of the path', () => {
    expect(extractFilePaths('open src/main/index.ts.')[0]).toBe('src/main/index.ts');
  });
});

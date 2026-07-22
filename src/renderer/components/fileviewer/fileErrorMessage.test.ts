import { describe, expect, it } from 'vitest';
import { friendlyFileError } from './fileErrorMessage';

describe('friendlyFileError', () => {
  it('rewrites a Node ENOENT stat error into a plain not-found message', () => {
    const raw = "ENOENT: no such file or directory, stat 'C:\\repo\\README\\index.ts'";
    expect(friendlyFileError(raw, 'C:\\repo\\README\\index.ts')).toBe(
      'File not found: C:\\repo\\README\\index.ts',
    );
  });

  it('matches the "no such file or directory" phrasing case-insensitively', () => {
    expect(friendlyFileError('No Such File Or Directory', '/x/y.ts')).toBe('File not found: /x/y.ts');
  });

  it('passes through unrelated errors unchanged', () => {
    expect(friendlyFileError('File too large (12.0MB). Open in VS Code instead.', '/x/big.log')).toBe(
      'File too large (12.0MB). Open in VS Code instead.',
    );
    expect(friendlyFileError('EACCES: permission denied', '/x/y.ts')).toBe('EACCES: permission denied');
  });
});

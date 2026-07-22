// Turn a raw file-read error into a message worth showing a human. A missing
// file — the common outcome of clicking a chat link that resolved to a bogus
// path (e.g. an agent's `README.md/index.ts` shorthand) — surfaces from Node as
// `ENOENT: no such file or directory, stat '...'`, which reads like a crash. We
// render a plain "File not found: <path>" instead and keep the raw string
// available (tooltip/console) so debugging isn't lost.
export function friendlyFileError(error: string, filePath: string): string {
  if (/\bENOENT\b|no such file or directory/i.test(error)) {
    return `File not found: ${filePath}`;
  }
  return error;
}

// Shared ANSI / control-byte stripping helper used by status-monitor.ts
// (cleaning the PTY tail before prompt-pattern matching) and
// event-payload-builder.ts (cleaning the `Last output:` block in supervisor
// events so ghost-text-style escape sequences don't leak through as fake
// user input).
//
// Note: newline (\x0a) and CR (\x0d) are intentionally preserved — callers
// split on lines AFTER stripping. The runners' own `hasMeaningfulContent`
// helpers use a stricter regex that drops newlines too because they only
// care about a non-empty-stripped check, not line structure.

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

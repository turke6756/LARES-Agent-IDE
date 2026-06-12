// @vitest-environment jsdom
/**
 * Gate 2 probe (a), plan §7 Phase 0 / risk R11 (upstream milkdown #1193):
 * headless Crepe parse/serialize timing on large markdown docs, plus the
 * splice module's own cost at the same sizes.
 *
 * Excluded from the normal suite — run explicitly with:
 *   SPIKE_PROBE=1 npm run test:renderer -- markdownCanvasLargeDocProbe
 * Numbers are recorded in docs/reviews/markdown-canvas-spike-report.md.
 */
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { prepareSpliceBaseline, spliceMarkdown } from './markdownSplice';
import { polyfillJsdomForProseMirror } from './prosemirrorJsdomPolyfills';

polyfillJsdomForProseMirror();

/** Deterministic mixed-construct markdown of roughly `targetBytes`. */
function generateFixture(targetBytes: number): string {
  const parts: string[] = ['# Large document probe fixture\n'];
  let bytes = parts[0].length;
  let section = 0;
  while (bytes < targetBytes) {
    section += 1;
    const chunk = [
      `## Section ${section}: throughput scenario ${section % 7}`,
      '',
      `Paragraph ${section} covers steady-state behaviour of the splice path under ` +
        `load, with **bold spans**, _emphasis_, \`inline code\`, and a [link](https://example.com/${section}) ` +
        `to keep the inline parser honest across repetitions of realistic prose.`,
      '',
      `- bullet one for section ${section}`,
      `- bullet two with \`code\``,
      `- bullet three referencing item ${section * 3}`,
      '',
      ...(section % 4 === 0
        ? [
            '| metric | value | unit |',
            '| --- | --- | --- |',
            `| parse | ${section} | ms |`,
            `| serialize | ${section * 2} | ms |`,
            '',
          ]
        : []),
      ...(section % 5 === 0
        ? ['```ts', `function probe${section}(): number {`, `  return ${section};`, '}', '```', '']
        : []),
    ].join('\n');
    parts.push(chunk + '\n');
    bytes += chunk.length + 1;
  }
  return parts.join('\n');
}

async function timeCrepe(markdown: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const crepe = new Crepe({ root: host, defaultValue: markdown });

  const tCreate = performance.now();
  await crepe.create();
  const createMs = performance.now() - tCreate;

  const tSerialize = performance.now();
  const out = crepe.getMarkdown();
  const serializeMs = performance.now() - tSerialize;

  await crepe.destroy();
  host.remove();
  return { createMs, serializeMs, outLength: out.length };
}

describe.runIf(!!process.env.SPIKE_PROBE)('large-doc probe (Gate 2a)', () => {
  it('measures Crepe + splice timings across sizes', { timeout: 600_000 }, async () => {
    const rows: string[] = [];
    for (const targetKb of [100, 500, 1024]) {
      const fixture = generateFixture(targetKb * 1024);

      const tBaseline = performance.now();
      const baseline = prepareSpliceBaseline(fixture);
      const baselineMs = performance.now() - tBaseline;

      const crepe = await timeCrepe(fixture);

      const tSplice = performance.now();
      const outcome = spliceMarkdown(baseline, baseline.editorContent);
      const spliceMs = performance.now() - tSplice;

      rows.push(
        `| ${targetKb} KB | ${fixture.length.toLocaleString()} ch | ` +
          `${crepe.createMs.toFixed(0)} ms | ${crepe.serializeMs.toFixed(0)} ms | ` +
          `${baselineMs.toFixed(0)} ms | ${spliceMs.toFixed(0)} ms | fallback=${outcome.fallback} |`,
      );
    }
    const table = [
      '| size | chars | crepe create | crepe getMarkdown | splice baseline | splice no-op | note |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
    ].join('\n');
    writeFileSync('docs/reviews/large-doc-probe-results.md', table + '\n');
  });
});

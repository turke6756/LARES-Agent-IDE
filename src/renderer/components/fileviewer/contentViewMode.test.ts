/**
 * WP1-A mode-dispatch tests (tasks doc acceptance: "mode-migration +
 * exclusion-dispatch logic unit-tested (sniffer calls mocked)").
 *
 * The sniffer itself is owned by markdownSplice and tested there; here its
 * results are injected, which is what "mocked" means for this pure dispatch.
 */
import { describe, expect, it } from 'vitest';
import { resolveContentView } from './contentViewMode';
import type { SniffResult } from './markdownSplice';

const OK: SniffResult = { ok: true };
const BLOCKED_FRONTMATTER: SniffResult = { ok: false, reason: 'frontmatter' };
const BLOCKED_TOO_LARGE: SniffResult = { ok: false, reason: 'too-large' };

const md = (over: Partial<Parameters<typeof resolveContentView>[0]> = {}) =>
  resolveContentView({
    isMarkdown: true,
    isEditable: true,
    mode: undefined,
    wysiwygIsDefault: true,
    sniff: OK,
    ...over,
  });

describe('resolveContentView — markdown defaults', () => {
  it('defaults markdown to wysiwyg when the default flag is on and the doc is compatible', () => {
    expect(md()).toEqual({ kind: 'wysiwyg' });
  });

  it('defaults markdown to plain view when the default flag is off', () => {
    expect(md({ wysiwygIsDefault: false })).toEqual({ kind: 'view' });
  });

  it('routes excluded docs to the view branch with the sniffer reason (§6.3)', () => {
    expect(md({ sniff: BLOCKED_FRONTMATTER })).toEqual({
      kind: 'view',
      wysiwygBlockedReason: 'frontmatter',
    });
    expect(md({ sniff: BLOCKED_TOO_LARGE })).toEqual({
      kind: 'view',
      wysiwygBlockedReason: 'too-large',
    });
  });

  it('treats an unsniffable doc as blocked rather than mounting the editor', () => {
    expect(md({ sniff: null })).toEqual({
      kind: 'view',
      wysiwygBlockedReason: 'parse-failure',
    });
  });
});

describe('resolveContentView — explicit mode choices', () => {
  it('honors an explicit wysiwyg choice even when the default flag is off', () => {
    expect(md({ mode: 'wysiwyg', wysiwygIsDefault: false })).toEqual({ kind: 'wysiwyg' });
  });

  it('still excludes incompatible docs on an explicit wysiwyg choice', () => {
    expect(md({ mode: 'wysiwyg', sniff: BLOCKED_FRONTMATTER })).toEqual({
      kind: 'view',
      wysiwygBlockedReason: 'frontmatter',
    });
  });

  it('an explicit view choice overrides the wysiwyg default, with no blocked notice', () => {
    expect(md({ mode: 'view' })).toEqual({ kind: 'view' });
  });

  it('source mode always wins for editable files', () => {
    expect(md({ mode: 'source' })).toEqual({ kind: 'source' });
    expect(md({ mode: 'source', sniff: BLOCKED_FRONTMATTER })).toEqual({ kind: 'source' });
  });
});

describe('resolveContentView — non-markdown regression (CodeMirror path)', () => {
  it('non-markdown editable files keep today\'s behavior: view by default, source when editing', () => {
    const base = {
      isMarkdown: false,
      isEditable: true,
      wysiwygIsDefault: true, // flag must have no effect on non-markdown
      sniff: null,
    };
    expect(resolveContentView({ ...base, mode: undefined })).toEqual({ kind: 'view' });
    expect(resolveContentView({ ...base, mode: 'source' })).toEqual({ kind: 'source' });
    expect(resolveContentView({ ...base, mode: 'view' })).toEqual({ kind: 'view' });
  });

  it('non-editable files never leave view', () => {
    expect(
      resolveContentView({
        isMarkdown: false,
        isEditable: false,
        mode: 'source',
        wysiwygIsDefault: true,
        sniff: null,
      }),
    ).toEqual({ kind: 'view' });
  });

  it('non-editable markdown never mounts the editor', () => {
    expect(md({ isEditable: false })).toEqual({ kind: 'view' });
  });
});

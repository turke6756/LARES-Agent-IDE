// @vitest-environment jsdom
// WP-P5-B: comment-actions over the mocked comments IPC — the busy-agent
// fallback must park main's exact prompt in staging (never reject-and-lose),
// and draft creation must carry anchors + the shared content hash.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDraftComment, sendPersistedComments } from './comment-actions';
import { loadStaging } from '../prompt-staging';
import { showSelectionToast } from './selection-toast';
import { contentHash } from '../../components/fileviewer/markdownSplice';
import { SELECTION_COMMENTS_CHANGED_EVENT } from './comment-events';

const mockAgents: Array<{ id: string; title: string }> = [];
vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: { getState: () => ({ agents: mockAgents }) },
}));

vi.mock('./selection-toast', () => ({ showSelectionToast: vi.fn() }));

const create = vi.fn();
const send = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockAgents.length = 0;
  create.mockImplementation(async (input: unknown) => ({ id: 'row-1', ...(input as object) }));
  (window as unknown as { api: unknown }).api = { comments: { create, send } };
});

describe('createDraftComment', () => {
  it('computes anchors + shared doc hash and announces the change', async () => {
    const docText = 'one\ntwo with the chosen words\nthree';
    const changed = vi.fn();
    window.addEventListener(SELECTION_COMMENTS_CHANGED_EVENT, changed);

    await createDraftComment({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\doc.md',
      quotedText: 'the chosen words',
      body: 'note',
      prefix: 'two with ',
      suffix: '\nthree',
      docText,
    });

    const input = create.mock.calls[0][0];
    expect(input).toMatchObject({
      quotedText: 'the chosen words',
      body: 'note',
      docHash: contentHash(docText),
      anchorStart: docText.indexOf('the chosen words'),
      lineStart: 2,
      lineEnd: 2,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(SELECTION_COMMENTS_CHANGED_EVENT, changed);
  });

  it('omits anchors and hash when no doc text is available', async () => {
    await createDraftComment({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\doc.md',
      quotedText: 'q',
      body: 'b',
      prefix: '',
      suffix: '',
      docText: null,
    });
    const input = create.mock.calls[0][0];
    expect(input.docHash).toBeUndefined();
    expect(input.anchorStart).toBeUndefined();
  });
});

describe('sendPersistedComments', () => {
  it('agent-busy parks the prompt main built into that agent staging, verbatim', async () => {
    mockAgents.push({ id: 'a1', title: 'Builder' });
    send.mockResolvedValue({
      ok: false,
      code: 'agent-busy',
      error: 'working',
      prompt: '[SELECTION COMMENT]\nexact prompt from main',
    });

    const result = await sendPersistedComments(
      ['row-1'],
      { kind: 'existing', agentId: 'a1' },
      'C:\\ws\\doc.md',
    );

    expect(result.ok).toBe(false);
    const notes = loadStaging('a1').slots.filter((s) => s.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: '[SELECTION COMMENT]\nexact prompt from main' });
    expect(showSelectionToast).toHaveBeenCalledWith(
      'Agent "Builder" is busy — saved to its prompt staging',
    );
  });

  it('ok:true with launched toasts the launch; other failures toast errors', async () => {
    send.mockResolvedValueOnce({ ok: true, agentId: 'a-new', launched: true });
    await sendPersistedComments(['row-1'], { kind: 'new' }, 'f.md');
    expect(showSelectionToast).toHaveBeenCalledWith('Launching agent…');

    send.mockResolvedValueOnce({ ok: false, code: 'comment-not-found', error: 'gone' });
    await sendPersistedComments(['row-1'], { kind: 'new' }, 'f.md');
    expect(showSelectionToast).toHaveBeenCalledWith(
      expect.stringContaining('gone'),
      'error',
    );
  });

  it('an IPC throw is surfaced as an error result, never an exception', async () => {
    send.mockRejectedValue(new Error('ipc dead'));
    const result = await sendPersistedComments(['row-1'], { kind: 'new' }, 'f.md');
    expect(result).toMatchObject({ ok: false, error: 'ipc dead' });
  });
});

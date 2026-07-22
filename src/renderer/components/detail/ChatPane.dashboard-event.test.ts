// @vitest-environment jsdom
// (jsdom, not node: importing ChatPane pulls in theme-store, which touches
// document.documentElement at module scope.)
import { describe, it, expect } from 'vitest';
import { parseDashboardEvent } from './ChatPane';

// Supervisor agents receive dashboard notifications as text injected into their
// terminal; Claude Code records them in the session JSONL as ordinary `user`
// messages, so the renderer's ONLY signal is the text prefix. parseDashboardEvent
// owns both the classification and the header parse, so pin it directly against
// real payload shapes from src/main/supervisor/event-payload-builder.ts and
// src/main/orchestration/service.ts.

describe('parseDashboardEvent', () => {
  it('classifies a status_change payload and pulls out label + agent name', () => {
    const payload = [
      '[DASHBOARD EVENT] Agent status changed',
      'Agent: "renderer worker" (a1b2c3d4)',
      'Status: working → idle',
      'Last output:',
      '> done',
    ].join('\n');
    expect(parseDashboardEvent(payload)).toEqual({
      label: 'Agent status changed',
      agentName: 'renderer worker',
    });
  });

  it('parses the waiting-for-input and context-threshold headers', () => {
    expect(
      parseDashboardEvent('[DASHBOARD EVENT] Agent waiting for input\nAgent: "w" (deadbeef)\nWaiting kind: y-n')
        ?.label,
    ).toBe('Agent waiting for input');
    expect(
      parseDashboardEvent('[DASHBOARD EVENT] Context threshold crossed\nAgent: "w" (deadbeef)')?.label,
    ).toBe('Context threshold crossed');
  });

  it('degrades to label-only when the payload carries no Agent: line', () => {
    // Orchestration payloads (src/main/orchestration/service.ts) have no agent line.
    const payload = '[DASHBOARD EVENT] orchestration.groupthink.stalled\n{\n  "runId": "r1"\n}';
    const parsed = parseDashboardEvent(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.label).toBe('orchestration.groupthink.stalled');
    expect(parsed!.agentName).toBeUndefined();
  });

  it('degrades gracefully on a bare prefix or a malformed Agent: line', () => {
    expect(parseDashboardEvent('[DASHBOARD EVENT]')).toEqual({
      label: 'Dashboard event',
      agentName: undefined,
    });
    expect(parseDashboardEvent('[DASHBOARD EVENT] Something\nAgent: undefined')?.agentName)
      .toBeUndefined();
    expect(parseDashboardEvent('[DASHBOARD EVENT] Something\nAgent: "" (abcd1234)')?.agentName)
      .toBeUndefined();
  });

  it('keeps a title containing quotes intact (greedy up to the id)', () => {
    expect(
      parseDashboardEvent('[DASHBOARD EVENT] Agent status changed\nAgent: "the "big" one" (a1b2c3d4)')
        ?.agentName,
    ).toBe('the "big" one');
  });

  it('does NOT classify ordinary human messages as dashboard events', () => {
    expect(parseDashboardEvent('please rebase onto master')).toBeNull();
    expect(parseDashboardEvent('')).toBeNull();
    // Mentioning the phrase mid-message is still a human turn.
    expect(
      parseDashboardEvent('why does the [DASHBOARD EVENT] text look like a user message?'),
    ).toBeNull();
  });
});

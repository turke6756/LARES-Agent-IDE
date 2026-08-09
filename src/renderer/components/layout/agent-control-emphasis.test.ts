import { describe, expect, it } from 'vitest';
import { restartNeedsAttention, stopNeedsAttention } from './agent-control-emphasis';

describe('detail-pane agent control emphasis', () => {
  it('highlights Restart for a terminal agent until restart is clicked', () => {
    expect(restartNeedsAttention('done', false)).toBe(true);
    expect(restartNeedsAttention('crashed', false)).toBe(true);
    expect(restartNeedsAttention('done', true)).toBe(false);
    expect(restartNeedsAttention('idle', false)).toBe(false);
  });

  it('highlights Stop while an agent is working or idle until stop is clicked', () => {
    expect(stopNeedsAttention('working', false)).toBe(true);
    expect(stopNeedsAttention('idle', false)).toBe(true);
    expect(stopNeedsAttention('working', true)).toBe(false);
    expect(stopNeedsAttention('done', false)).toBe(false);
  });
});

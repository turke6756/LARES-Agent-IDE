import React, { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import {
  getContinuationApi,
  getContinuationEnabled,
  forceErrorMessage,
} from './continuation-controls';

// Split button for the context-brick continuation feature (Edward, 2026-07-05).
//
//   ┌───────────┬───┐
//   │  ⇥ main   │ ▾ │   main press → forceContinuationHandoff(agent)
//   └───────────┴───┘   caret     → menu with the on/off toggle
//
// ON  → amber/gold identity (ties to the card's gold transfer glow).
// OFF → desaturated gray; main press inert, caret still live so it can re-enable.
// While a transfer runs the card's existing gold glow is the progress signal;
// the main press is disabled so it can't be double-fired.
export default function ContinuationSplitButton({ agent }: { agent: Agent }) {
  // The card already lights the gold glow off this same set; we reuse it to
  // disable the main press while a transfer for this agent is in flight.
  const transferring = useDashboardStore((s) => s.continuationTransferIds.has(agent.id));
  const propEnabled = getContinuationEnabled(agent);

  // Optimistic toggle: a local override paints immediately, then clears whenever
  // the agent payload delivers a fresh continuationEnabled (the next refresh is
  // authoritative — `continuationEnabled` rides the agent object).
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  useEffect(() => {
    setOptimistic(null);
  }, [propEnabled]);
  const enabled = optimistic ?? propEnabled;

  const [menuOpen, setMenuOpen] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss the menu on outside click / Escape (mirrors AgentCard's menus).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const flashError = (msg: string) => {
    setError(msg);
    // Self-clearing inline note, mirroring AgentCard's forkError pattern.
    setTimeout(() => setError(null), 5000);
  };

  const handleForce = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!enabled || forcing || transferring) return;
    const api = getContinuationApi();
    if (!api) {
      flashError('Transfer unavailable');
      return;
    }
    setForcing(true);
    setError(null);
    try {
      const res = await api.forceContinuationHandoff(agent.id);
      const msg = forceErrorMessage(res);
      if (msg) flashError(msg);
    } catch (err) {
      flashError(forceErrorMessage(undefined, err) ?? 'Transfer failed');
    } finally {
      setForcing(false);
    }
  };

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !enabled;
    setOptimistic(next); // optimistic flip; reconciles from the next agent refresh
    setMenuOpen(false);
    const api = getContinuationApi();
    if (!api) {
      setOptimistic(null);
      flashError('Transfer unavailable');
      return;
    }
    try {
      const res = await api.setContinuationEnabled(agent.id, next);
      if (!res?.ok) {
        setOptimistic(null);
        flashError('Could not update setting');
      }
    } catch {
      setOptimistic(null);
      flashError('Could not update setting');
    }
  };

  const mainDisabled = !enabled || forcing || transferring;
  const mainTitle = !enabled
    ? 'Auto context transfer is off for this agent'
    : transferring
      ? 'Context transfer in progress…'
      : 'Transfer context';

  return (
    <div
      ref={wrapRef}
      className="csplit-wrap relative inline-flex shrink-0"
      // Guard against the card's select / open-terminal handlers firing when the
      // user clicks the control.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className={`csplit ${enabled ? 'is-on' : 'is-off'} ${transferring ? 'is-transferring' : ''}`}>
        <button
          type="button"
          className="csplit-main"
          onClick={handleForce}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={mainDisabled}
          title={mainTitle}
          aria-label="Transfer context"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={forcing || transferring ? 'animate-pulse' : ''}
          >
            <path d="M1.5 6h6" />
            <path d="M5 3.5 7.5 6 5 8.5" />
            <path d="M10 2.5v7" />
          </svg>
        </button>
        <button
          type="button"
          className="csplit-caret"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Context transfer options"
        >
          <span className={`leading-none transition-transform duration-150 ${menuOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </div>

      {menuOpen && (
        <div
          role="menu"
          className="ui-menu absolute right-0 top-full mt-1 z-50"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="ui-menu-header">Context transfer</div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={enabled}
            className="ui-menu-item flex items-center justify-between gap-4"
            onClick={handleToggle}
          >
            <span>Auto context transfer</span>
            <span className={enabled ? 'csplit-on-label font-semibold' : 'text-gray-500'}>
              {enabled ? 'On' : 'Off'}
            </span>
          </button>
        </div>
      )}

      {error && (
        <span className="csplit-error absolute right-0 top-full mt-1 z-50 whitespace-nowrap text-[11px] text-accent-red font-semibold px-1.5 py-0.5">
          {error}
        </span>
      )}
    </div>
  );
}

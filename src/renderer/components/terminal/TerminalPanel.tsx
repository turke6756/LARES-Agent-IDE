import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useThemeStore } from '../../stores/theme-store';
import { shellEscapePath, isExternalFileDrop, getDroppedNativePaths, readClipboardImage } from '../../utils/drag-file';
import { terminalCache, disposeCachedTerminal, reapOnLeave } from './terminal-cache';
import type { Agent } from '../../../shared/types';

/** Strip persona-folder suffix to show the workspace root name.
 *  Handles both the new .dashboard/supervisor layout and the legacy
 *  .claude/agents/<name> layout still in persisted agent rows. */
function getDisplayDirectory(agent: Agent): string {
  const dir = agent.workingDirectory.replace(/\\/g, '/');
  const stripped = agent.isSupervisor
    ? dir.replace(/\/\.dashboard\/supervisor$/, '').replace(/\/\.claude\/agents\/[^/]+$/, '')
    : dir;
  return stripped.split('/').filter(Boolean).pop() || stripped;
}

// Dark theme (GitHub Slate)
const DARK_TERMINAL_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  selectionBackground: '#388bfd4d',
  black: '#21262d',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#484f58',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
};

// Light theme — high-contrast, bold, professional
// Claude Code ANSI usage: foreground = body text, black/brightWhite = bold headings,
// white/brightBlack = separator lines & dim text, colors = syntax/status
// Light mode uses a dark terminal — Claude Code controls its own colors
// and looks best on a dark background regardless of app theme.
const LIGHT_TERMINAL_THEME = {
  background: '#1e1e2e',
  foreground: '#e0e0e0',
  cursor: '#58a6ff',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#3a3a5c',
  selectionForeground: undefined,
  black:   '#21262d',
  red:     '#ff7b72',
  green:   '#3fb950',
  yellow:  '#d29922',
  blue:    '#58a6ff',
  magenta: '#bc8cff',
  cyan:    '#39c5cf',
  white:   '#b1bac4',
  brightBlack:   '#484f58',
  brightRed:     '#ffa198',
  brightGreen:   '#56d364',
  brightYellow:  '#e3b341',
  brightBlue:    '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan:    '#56d4dd',
  brightWhite:   '#ffffff',
};

function getTerminalTheme(theme: string) {
  return theme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}

// The xterm cache, its single teardown helper, and the terminal-status reaper
// that disposes a DEAD agent's terminal now live in `./terminal-cache` — see
// that module's header for why the cache survives unmount but not death.

// Auto-focus the terminal WITHOUT yanking focus away from a text field the
// user is actively typing in (e.g. the chat bar). The terminal's mount/reattach
// focus runs on setTimeout, so without this guard a pending timer can steal
// focus from the chat textarea you just clicked into — keystrokes then vanish.
// xterm's own helper textarea lives inside `container`, so re-focusing when the
// terminal is already focused is still fine; we only bail for inputs elsewhere.
function focusTerminalUnlessTypingElsewhere(terminal: Terminal, container: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (active && !container.contains(active)) {
    if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable) {
      return;
    }
  }
  terminal.focus();
}

interface TerminalPanelProps {
  height: number;
}

export default function TerminalPanel({ height }: TerminalPanelProps) {
  const terminalAgentId = useDashboardStore((s) => s.terminalAgentId);
  const terminalPinned = useDashboardStore((s) => s.terminalPinned);
  const panelLayout = useDashboardStore((s) => s.panelLayout);
  const setTerminalAgent = useDashboardStore((s) => s.setTerminalAgent);
  const toggleTerminalPinned = useDashboardStore((s) => s.toggleTerminalPinned);
  const togglePanelCollapsed = useDashboardStore((s) => s.togglePanelCollapsed);
  // Subscribe to just this terminal's agent — avoids re-render on every other agent's status change.
  const agent = useDashboardStore((s) =>
    s.terminalAgentId ? s.agents.find((a) => a.id === s.terminalAgentId) ?? null : null,
  );
  const theme = useThemeStore((s) => s.theme);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const scrollLockedRef = useRef(false);
  const [scrollLocked, setScrollLocked] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  // BUG-38 — bumped when a same-id PTY swap rebinds the terminal, forcing the
  // mount effect to re-run into its create-new branch on the fresh bridge.
  const [reboundNonce, setReboundNonce] = useState(0);

  // Transient paste/drop error surfaced in the toolbar. The timeout id is
  // ref-managed (addendum J) so an older timer can't clear a newer error, and
  // it's cleared on unmount.
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pasteErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashPasteError = useCallback((msg: string) => {
    setPasteError(msg);
    if (pasteErrorTimerRef.current) clearTimeout(pasteErrorTimerRef.current);
    pasteErrorTimerRef.current = setTimeout(() => setPasteError(null), 4000);
  }, []);
  useEffect(() => () => {
    if (pasteErrorTimerRef.current) clearTimeout(pasteErrorTimerRef.current);
  }, []);

  // Shared paste routine — used by Ctrl+V, Ctrl+Shift+V, AND right-click. Reads
  // the agent cwd live from the store to avoid stale closures.
  const pasteIntoTerminal = useCallback(async (agentId: string) => {
    const img = await readClipboardImage();
    if (img && 'error' in img) { flashPasteError(img.error); return; }
    if (img) {
      const wd = useDashboardStore.getState().agents.find((a) => a.id === agentId)?.workingDirectory || '';
      const res = await window.api.files.writeImageTemp(img.bytes, img.mime, wd);
      if (res.ok) window.api.terminal.write(agentId, shellEscapePath(res.path) + ' ');
      else flashPasteError(res.error);
      return;
    }
    // No image → text fallback. readText() can also reject when the clipboard
    // permission was denied (addendum I) — don't let it become an unhandled
    // rejection.
    try {
      const text = await navigator.clipboard.readText();
      if (text) window.api.terminal.write(agentId, text);
    } catch {
      flashPasteError('Could not read the clipboard.');
    }
  }, [flashPasteError]);

  // The xterm custom-key handler is (re)bound on every mount below and reads the
  // latest paste routine through this ref, so a cached terminal that survives an
  // unmount/remount never calls a stale mount's flashPasteError (addendum H).
  const pasteHandlerRef = useRef(pasteIntoTerminal);
  useEffect(() => { pasteHandlerRef.current = pasteIntoTerminal; }, [pasteIntoTerminal]);

  const isOpen = terminalAgentId !== null;
  const isNub = panelLayout.terminalCollapsed && isOpen;
  const isLight = theme === 'light';

  // Keep scrollLocked ref in sync
  useEffect(() => {
    scrollLockedRef.current = scrollLocked;
  }, [scrollLocked]);

  // Main terminal lifecycle effect
  useEffect(() => {
    if (!termRef.current || !terminalAgentId) return;

    // Capture agentId for this effect instance — critical for correct cleanup
    const agentId = terminalAgentId;
    const container = termRef.current;

    // Copy/paste key handler. (Re)bound on EVERY mount — including the cached
    // reattach branch — so a terminal that survives unmount/remount always runs
    // the current mount's paste routine (addendum H). Reads the paste routine
    // through pasteHandlerRef so it never closes over a stale flashPasteError.
    const installKeyHandler = (terminal: Terminal) => {
      terminal.attachCustomKeyEventHandler((ev) => {
        // Ctrl+Shift+C → always copy
        if (ev.ctrlKey && ev.shiftKey && ev.key === 'C' && ev.type === 'keydown') {
          const sel = terminal.getSelection();
          if (sel) navigator.clipboard.writeText(sel);
          return false;
        }
        // Ctrl+Shift+V → always paste (image-aware)
        if (ev.ctrlKey && ev.shiftKey && ev.key === 'V' && ev.type === 'keydown') {
          pasteHandlerRef.current(agentId);
          return false;
        }
        // Ctrl+C with selection → copy (otherwise pass through as SIGINT)
        if (ev.ctrlKey && !ev.shiftKey && ev.key === 'c' && ev.type === 'keydown') {
          const sel = terminal.getSelection();
          if (sel) {
            navigator.clipboard.writeText(sel);
            terminal.clearSelection();
            return false;
          }
        }
        // Ctrl+V → paste (image-aware)
        if (ev.ctrlKey && !ev.shiftKey && ev.key === 'v' && ev.type === 'keydown') {
          pasteHandlerRef.current(agentId);
          return false;
        }
        return true;
      });
    };

    let cached = terminalCache.get(agentId);

    if (cached) {
      // Reattach existing terminal to DOM
      container.appendChild(cached.terminal.element!);
      xtermRef.current = cached.terminal;
      fitAddonRef.current = cached.fitAddon;
      installKeyHandler(cached.terminal); // rebind to THIS mount (addendum H)

      // Delayed fit to ensure container has final dimensions
      const fitReattach = () => {
        try {
          cached!.fitAddon.fit();
          window.api.terminal.resize(agentId, cached!.terminal.cols, cached!.terminal.rows);
        } catch { /* ignore */ }
      };
      fitReattach();
      setTimeout(() => { fitReattach(); focusTerminalUnlessTypingElsewhere(cached!.terminal, container); }, 50);
      setTimeout(fitReattach, 200);

      // Re-attach IPC if needed (unsub was cleaned up on detach)
      if (!cached.unsub) {
        window.api.terminal.attach(agentId);
        const unsub = window.api.terminal.onData((incomingAgentId: string, data: string) => {
          if (incomingAgentId === agentId) {
            cached!.terminal.write(data);
          }
        });
        cached.unsub = unsub;
      }
    } else {
      // Create new terminal
      const currentTheme = useThemeStore.getState().theme;
      const terminal = new Terminal({
        theme: getTerminalTheme(currentTheme),
        fontSize: 13,
        fontWeight: currentTheme === 'light' ? '600' : 'normal',
        fontFamily: "'Cascadia Code', 'Consolas', monospace",
        cursorBlink: true,
        // Generous scrollback so a long-lived agent (especially a supervisor
        // you leave running for hours) keeps its full history in the panel
        // rather than silently dropping the oldest lines.
        scrollback: 50000,
        smoothScrollDuration: 150,
        scrollSensitivity: 3,
        fastScrollSensitivity: 8,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);

      // WebGL renderer — GPU-composites the whole terminal surface.
      // Must be loaded AFTER open() because it inspects the canvas it builds
      // into the terminal's DOM element. On context loss (tab backgrounded,
      // driver hiccup) dispose it so xterm falls back to the DOM renderer.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        terminal.loadAddon(webgl);
      } catch (err) {
        console.warn('[terminal] WebGL renderer unavailable, falling back to DOM:', err);
      }

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Copy/paste key handler (image-aware; see installKeyHandler above).
      installKeyHandler(terminal);

      // Forward terminal input to agent
      terminal.onData((data) => {
        window.api.terminal.write(agentId, data);
        if (!scrollLockedRef.current) {
          terminal.scrollToBottom();
        }
      });

      // Track scroll position for "scroll to bottom" button
      terminal.onScroll(() => {
        const viewportAtBottom =
          terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        setIsAtBottom(viewportAtBottom);
      });

      // BUG-15: atomic snapshot-with-tail mount sequence.
      //   1. Subscribe to live PTY data; bytes arriving before the snapshot
      //      is written get buffered locally.
      //   2. Attach (kicks main to start forwarding).
      //   3. Fetch the ring-buffer snapshot.
      //   4. Write the snapshot in rAF-paced chunks so a 1 MB scrollback
      //      doesn't lock up the renderer.
      //   5. Drain the buffered tail in order.
      //   6. From then on, live bytes write straight through.
      // Naive ordering (snapshot → subscribe) would lose bytes emitted during
      // the IPC round-trip; this ordering closes that window.
      const pendingTail: string[] = [];
      let snapshotApplied = false;

      const unsub = window.api.terminal.onData((incomingAgentId: string, data: string) => {
        if (incomingAgentId !== agentId) return;
        if (snapshotApplied) {
          terminal.write(data);
        } else {
          pendingTail.push(data);
        }
      });
      window.api.terminal.attach(agentId);

      cached = { terminal, fitAddon, unsub };
      terminalCache.set(agentId, cached);

      // Fit the terminal multiple times after attach to ensure correct sizing.
      // The container may not have its final dimensions on the first frame,
      // causing xterm to render at the wrong size (quarter-screen bug).
      const fitAndSync = () => {
        try {
          fitAddon.fit();
          window.api.terminal.resize(agentId, terminal.cols, terminal.rows);
        } catch { /* ignore during layout transitions */ }
      };

      window.api.agents.getRingBuffer(agentId).then((snapshot) => {
        const finishMount = () => {
          for (const chunk of pendingTail) terminal.write(chunk);
          pendingTail.length = 0;
          snapshotApplied = true;

          setTimeout(() => {
            fitAndSync();
            terminal.scrollToBottom();
            focusTerminalUnlessTypingElsewhere(terminal, container);
          }, 50);
          setTimeout(fitAndSync, 200);
          setTimeout(fitAndSync, 500);
        };

        if (!snapshot) {
          finishMount();
          return;
        }

        // Chunked write: xterm's write(data, cb) yields between calls so the
        // event loop stays responsive even for a 1 MB scrollback. 8 KB strikes
        // a balance — small enough to avoid jank, large enough to limit the
        // chain depth.
        const CHUNK_SIZE = 8192;
        let offset = 0;
        const writeNext = () => {
          if (offset >= snapshot.length) {
            finishMount();
            return;
          }
          const end = Math.min(offset + CHUNK_SIZE, snapshot.length);
          terminal.write(snapshot.slice(offset, end), writeNext);
          offset = end;
        };
        writeNext();
      });
    }

    // ResizeObserver for responsive fitting
    const observer = new ResizeObserver(() => {
      const entry = terminalCache.get(agentId);
      if (entry) {
        try {
          entry.fitAddon.fit();
          window.api.terminal.resize(agentId, entry.terminal.cols, entry.terminal.rows);
        } catch {
          // ignore fit errors during layout transitions
        }
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();

      const entry = terminalCache.get(agentId);
      if (entry) {
        // Keep the IPC listener AND the main-process forwarding ALIVE while
        // the terminal is off-screen. This is what makes scrollback "stay"
        // when you switch to another workspace / agent and come back: the
        // cached xterm keeps buffering live output the whole time you're away.
        // Previously the cleanup ran unsub() + terminal.detach(), so every
        // byte emitted while detached was dropped and the reattach branch only
        // re-subscribed to NEW output — leaving a gap with no backfill. We
        // deliberately leave entry.unsub in place (the reattach branch's
        // `if (!cached.unsub)` guard then skips re-subscribing).
        //
        // Only detach from the DOM (so the element can move) — never dispose,
        // never unsubscribe.
        if (entry.terminal.element?.parentElement === container) {
          container.removeChild(entry.terminal.element);
        }
      }

      // ...UNLESS the agent is dead. A terminal agent has no live PTY to buffer
      // and nothing to come back for, so leaving here is the moment to release
      // its scrollback + WebGL context. No-op for a live agent (the whole point
      // of the block above). Re-opening the dead agent rebuilds read-only from
      // the persisted `.scrollback` via `getRingBuffer`.
      reapOnLeave(agentId);

      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalAgentId, reboundNonce]);

  // BUG-38 — same-id PTY swap (continuation, manual restart, auto-restart):
  // main killed the old runner and spawned a new one under the same agent id,
  // so the cached xterm is bound to a dead bridge. Dispose the cached terminal
  // (dropping its stale IPC subscription) so the mount effect rebuilds onto the
  // fresh PTY and re-pulls the new session's ring buffer. Other agents rebuild
  // lazily the next time they're opened — the cache is already cleared for them.
  useEffect(() => {
    const unsub = window.api.terminal.onRebound((reboundAgentId: string) => {
      disposeCachedTerminal(reboundAgentId);
      // Only force a re-mount for the terminal currently on screen.
      if (reboundAgentId === terminalAgentId) {
        setReboundNonce((n) => n + 1);
      }
    });
    return unsub;
  }, [terminalAgentId]);

  // Sync scrollOnUserInput option without re-creating terminal
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.scrollOnUserInput = !scrollLocked;
    }
  }, [scrollLocked]);

  // Update terminal theme when app theme changes
  useEffect(() => {
    const xtermTheme = getTerminalTheme(theme);
    for (const [, cached] of terminalCache) {
      cached.terminal.options.theme = xtermTheme;
      cached.terminal.options.fontWeight = theme === 'light' ? '600' : 'normal';
    }
  }, [theme]);

  const scrollToBottom = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.scrollToBottom();
      setIsAtBottom(true);
    }
  }, []);

  // Right-click context menu for copy/paste
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const terminal = xtermRef.current;
    if (!terminal || !terminalAgentId) return;
    const sel = terminal.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel);
      terminal.clearSelection();
    } else {
      pasteIntoTerminal(terminalAgentId); // image-aware, shared with Ctrl+V
    }
  }, [terminalAgentId, pasteIntoTerminal]);

  // Drag-and-drop handler (shared between full and nub modes)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!terminalAgentId) return;

    // 1. In-app path (tree/file chips) — already in workspace path space; inject as-is.
    const inApp = e.dataTransfer.getData('application/x-file-path');
    if (inApp) {
      window.api.terminal.write(terminalAgentId, shellEscapePath(inApp) + ' '); // trailing space: intentional
      xtermRef.current?.focus();
      return;
    }
    // 2. External OS files — BEFORE text/plain (Explorer drops also expose text/plain).
    if (isExternalFileDrop(e.dataTransfer)) {
      const native = getDroppedNativePaths(e.dataTransfer); // sync: call before any await
      const wd = useDashboardStore.getState().agents.find((a) => a.id === terminalAgentId)?.workingDirectory || '';
      if (native.length === 0) {
        flashPasteError('Dropped item has no file path (drag the image file from Explorer).');
        return;
      }
      const results = await window.api.files.resolveImageDrops(native, wd);
      for (const r of results) {
        if (r.ok) window.api.terminal.write(terminalAgentId, shellEscapePath(r.path) + ' ');
      }
      const bad = results.find((r) => !r.ok);
      if (bad && !bad.ok) flashPasteError(bad.error);
      xtermRef.current?.focus();
      return;
    }
    // 3. Generic text fallback.
    const text = e.dataTransfer.getData('text/plain');
    if (text) {
      window.api.terminal.write(terminalAgentId, shellEscapePath(text) + ' ');
      xtermRef.current?.focus();
    }
  }, [terminalAgentId, flashPasteError]);

  // --- Nub mode rendering ---
  if (isNub) {
    return (
      <div
        className={`flex items-center px-4 gap-3 cursor-pointer select-none transition-colors ${
          isLight
            ? 'bg-[#f5f5f5] border-t border-[#d1d1d1] hover:bg-[#e5e5e5]'
            : 'bg-surface-1 border- dark:border-white/10 light:border-black/10 hover:bg-surface-2'
        } ${isDragOver ? 'ring-1 ring-accent-blue/50 bg-accent-blue/5' : ''}`}
        style={{ height: 36, minHeight: 36 }}
        onClick={() => togglePanelCollapsed('terminalCollapsed')}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className={`font-mono text-xs font-bold ${isLight ? 'text-[#005e9e]' : 'text-accent-blue'}`}>&gt;_</span>
        {agent && (
          <>
            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-sm truncate max-w-[200px] ${
              isLight ? 'text-[#005e9e] bg-[#ddeefe]' : 'text-accent-blue bg-accent-blue/10'
            }`}>
              {agent.title}
            </span>
            {agent.workingDirectory && (
              <span className={`text-[10px] font-mono px-1 py-0.5 truncate max-w-[150px] ${
                isLight ? 'text-[#333333]' : 'text-gray-500'
              }`}>
                {getDisplayDirectory(agent)}
              </span>
            )}
          </>
        )}
        <span className={`text-[10px] uppercase tracking-wider ${isLight ? 'text-[#333333]' : 'text-gray-500'}`}>
          {isDragOver ? 'Drop file here' : 'Click to expand'}
        </span>
        <div className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); setTerminalAgent(null); }}
          className={`px-1.5 py-0.5 transition-all rounded-sm ${
            isLight ? 'text-[#666666] hover:text-[#c62828] hover:bg-[#c62828]/10' : 'text-gray-500 hover:text-white hover:bg-red-500/20'
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor">
            <path d="M1 1L11 11M11 1L1 11" strokeWidth="2" />
          </svg>
        </button>
      </div>
    );
  }

  // Shared button base for toolbar
  const toolbarBtn = (active: boolean, activeClasses: string) =>
    `text-[10px] uppercase tracking-wider border px-2 py-0.5 transition-colors ${
      active
        ? activeClasses
        : isLight
          ? 'text-[#4d4d4d] border-[#d1d1d1] hover:text-[#000000] hover:bg-[#e5e5e5]'
          : 'text-gray-500 border-transparent hover:text-white hover:bg-white/[0.06]'
    }`;

  // --- Full mode rendering ---
  return (
    <div
      className={`flex flex-col overflow-hidden transition-[border-color] duration-150 ${
        isOpen
          ? isLight
            ? 'border-t border-[#d1d1d1] bg-[#f5f5f5]'
            : 'border-t-2 border-gray-800 bg-surface-0'
          : 'border-t border-transparent pointer-events-none'
      }`}
      style={{ height: isOpen ? height : 0 }}
      aria-hidden={!isOpen}
    >
      {/* ── Toolbar ── */}
      <div className={`flex items-center justify-between px-4 py-1.5 ${
        isLight
          ? 'bg-[#f0f0f0] border-b border-[#d1d1d1]'
          : 'bg-surface-1 border- dark:border-white/10 light:border-black/10'
      }`}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold uppercase tracking-widest ${
            isLight ? 'text-[#333333]' : 'text-gray-400'
          }`}>Terminal</span>
          {agent && (
            <>
              <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-sm ${
                isLight
                  ? 'text-[#005e9e] bg-[#ddeefe] border border-[#005e9e]'
                  : 'text-accent-blue bg-accent-blue/10'
              }`}>
                {agent.title}
              </span>
              {agent.workingDirectory && (
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-sm ${
                  isLight
                    ? 'text-[#4d4d4d] bg-[#e5e5e5]'
                    : 'text-gray-500 bg-gray-500/10'
                }`}>
                  {getDisplayDirectory(agent)}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
            {pasteError && (
              <span
                className="text-[10px] text-[var(--color-accent-red)] max-w-[280px] truncate"
                title={pasteError}
              >
                {pasteError}
              </span>
            )}
            <button
                onClick={() => xtermRef.current?.clear()}
                className={toolbarBtn(false, '')}
            >
                Clear
            </button>
            <button
                onClick={() => setScrollLocked(!scrollLocked)}
                className={toolbarBtn(scrollLocked,
                  isLight
                    ? 'text-[#9d6b13] border-[#9d6b13] bg-[#9d6b13]/10 font-semibold'
                    : 'text-accent-orange border-accent-orange bg-accent-orange/10'
                )}
                title={scrollLocked ? "Auto-scroll DISABLED" : "Auto-scroll ENABLED"}
            >
                {scrollLocked ? 'Locked' : 'Auto-scroll'}
            </button>
            <button
                onClick={() => toggleTerminalPinned()}
                className={toolbarBtn(terminalPinned,
                  isLight
                    ? 'text-on-accent border-[#005e9e] bg-[#005e9e] font-semibold'
                    : 'text-on-accent border-[#005e9e] bg-[#005e9e]'
                )}
                title={terminalPinned ? "Terminal is pinned to current workspace" : "Pin terminal to persist across workspaces"}
            >
                <div className="flex items-center gap-1">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="17" x2="12" y2="22"></line>
                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
                  </svg>
                  {terminalPinned ? 'Pinned' : 'Pin'}
                </div>
            </button>
            <button
                onClick={() => togglePanelCollapsed('terminalCollapsed')}
                className={`px-2 py-1 transition-all rounded-sm ml-2 border ${
                  isLight
                    ? 'text-[#4d4d4d] border-[#d1d1d1] hover:text-[#000000] hover:border-[#999999] hover:bg-[#e5e5e5]'
                    : 'text-gray-500 border-gray-700 hover:text-white hover:border-gray-500'
                }`}
                title="Collapse Terminal"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            <button
              onClick={() => setTerminalAgent(null)}
              className={`px-2 py-1 transition-all rounded-sm ml-1 ${
                isLight
                  ? 'text-[#666666] hover:text-[#c62828] hover:bg-[#c62828]/10'
                  : 'text-gray-500 hover:text-white hover:bg-red-500/20'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                <path d="M1 1L11 11M11 1L1 11" strokeWidth="2" />
              </svg>
            </button>
        </div>
      </div>
      {/* ── Terminal viewport ── */}
      <div
        className={`relative flex-1 overflow-hidden transition-shadow ${
          isDragOver ? 'ring-1 ring-accent-blue/50' : ''
        } ${isLight ? 'terminal-viewport-light' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
      >
        <div ref={termRef} className="w-full h-full" onClick={() => xtermRef.current?.focus()} />
        {!isAtBottom && !scrollLocked && (
          <button
            onClick={scrollToBottom}
            className={`absolute bottom-3 right-5 text-[10px] px-3 py-1 transition-colors ${
              isLight
                ? 'text-[#424a53] bg-white border border-[#c8cdd3] hover:text-[#1b2733]'
                : 'text-gray-400 bg-surface-1 border border-surface-3 hover:text-gray-50'
            }`}
          >
            ↓ Scroll to bottom
          </button>
        )}
      </div>
    </div>
  );
}

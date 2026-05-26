import React, { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  chatScrollEl: HTMLDivElement | null;
  isLight: boolean;
  children: React.ReactNode;
}

const MIN_ZOOM = 1.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;
const LENS_HEIGHT_FRACTION = 0.5;
const MIN_LENS_HEIGHT = 200;
// Slower-than-native step when scrolling with cursor inside the lens. Fixed-clamped
// step per wheel event kills OS-level inertia so motion "stops on a dime".
const WHEEL_STEP_MIN = 12;
const WHEEL_STEP_MAX = 42;
const WHEEL_STEP_GAIN = 0.30;

export default function WatchGlass({ chatScrollEl, isLight, children }: Props) {
  // State-backed ref: wheel effect must re-run once the lens div actually mounts,
  // which can happen on a later render than when chatScrollEl first arrives.
  const [lensEl, setLensEl] = useState<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [lensY, setLensY] = useState(0);
  const [zoom, setZoom] = useState(1.6);
  const [chatScrollTop, setChatScrollTop] = useState(0);
  const [chatContentH, setChatContentH] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const [innerLayoutH, setInnerLayoutH] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startLensY: number; pointerId: number } | null>(null);
  const initializedPositionRef = useRef(false);

  // Underlying chat scroll position + viewport size.
  useEffect(() => {
    if (!chatScrollEl) return;
    const onScroll = () => setChatScrollTop(chatScrollEl.scrollTop);
    onScroll();
    chatScrollEl.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      setViewportH(chatScrollEl.clientHeight);
      setViewportW(chatScrollEl.clientWidth);
    });
    ro.observe(chatScrollEl);
    setViewportH(chatScrollEl.clientHeight);
    setViewportW(chatScrollEl.clientWidth);
    return () => {
      chatScrollEl.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [chatScrollEl]);

  // scrollHeight has no native change event when content streams in — rAF-poll it.
  useEffect(() => {
    if (!chatScrollEl) return;
    let stopped = false;
    let last = 0;
    let rafId = 0;
    const tick = () => {
      if (stopped) return;
      const h = chatScrollEl.scrollHeight;
      if (h !== last) {
        last = h;
        setChatContentH(h);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    };
  }, [chatScrollEl]);

  // Lens content reflows on zoom/content changes — measure its natural (unscaled) height.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setInnerLayoutH(el.offsetHeight));
    ro.observe(el);
    setInnerLayoutH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const lensH = Math.max(MIN_LENS_HEIGHT, viewportH * LENS_HEIGHT_FRACTION);

  useEffect(() => {
    if (initializedPositionRef.current || viewportH <= 0) return;
    setLensY(Math.max(0, (viewportH - lensH) / 2));
    initializedPositionRef.current = true;
  }, [viewportH, lensH]);

  useEffect(() => {
    setLensY((y) => Math.max(0, Math.min(viewportH - lensH, y)));
  }, [viewportH, lensH]);

  // Wheel inside lens: slower-than-native scroll on the SAME underlying chat container,
  // or Ctrl/Cmd+wheel = zoom.
  useEffect(() => {
    const el = lensEl;
    if (!el || !chatScrollEl) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        const delta = -e.deltaY * 0.003;
        setZoom((z) => clamp(MIN_ZOOM, MAX_ZOOM, +(z + delta).toFixed(3)));
        return;
      }
      const step =
        Math.sign(e.deltaY) *
        Math.min(WHEEL_STEP_MAX, Math.max(WHEEL_STEP_MIN, Math.abs(e.deltaY) * WHEEL_STEP_GAIN));
      const max = chatScrollEl.scrollHeight - chatScrollEl.clientHeight;
      chatScrollEl.scrollTop = clamp(0, max, chatScrollEl.scrollTop + step);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [lensEl, chatScrollEl]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('[data-lens-control]')) return;
      dragRef.current = { startY: e.clientY, startLensY: lensY, pointerId: e.pointerId };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [lensY],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const newY = d.startLensY + (e.clientY - d.startY);
      setLensY(clamp(0, viewportH - lensH, newY));
    },
    [viewportH, lensH],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setDragging(false);
  }, []);

  if (!chatScrollEl || viewportH === 0) return null;

  // Layout: render content at width = viewportW/zoom, then scale by zoom.
  // Visual width = viewportW (fits the column, no horizontal overflow).
  // Effective font size = native * zoom, so text reflows to fewer chars/line.
  const innerLayoutW = Math.max(1, viewportW / zoom);
  const innerVisualH = innerLayoutH * zoom;

  // Map underlying chat scroll → lens scroll proportionally.
  // chatLensTop = position of lens-band's top edge in chat-content coordinates.
  // Progress = where that edge sits in chat (0 = top, 1 = bottom-most lens placement).
  // lensScrollTop = same progress applied to the lens's (taller) reflowed content.
  const chatLensTop = chatScrollTop + lensY;
  const denomChat = Math.max(chatContentH - lensH, 1);
  const progress = clamp(0, 1, chatLensTop / denomChat);
  const lensScrollMax = Math.max(0, innerVisualH - lensH);
  const translateY = -progress * lensScrollMax;

  const accent = isLight ? 'rgba(31, 111, 235, 0.55)' : 'rgba(88, 166, 255, 0.55)';
  const lensBg = isLight ? 'rgba(246, 248, 250, 0.45)' : 'rgba(13, 17, 23, 0.45)';
  const controlBg = isLight ? 'rgba(255,255,255,0.92)' : 'rgba(13,17,23,0.78)';
  const controlBorder = isLight ? 'rgba(31,111,235,0.35)' : 'rgba(88,166,255,0.35)';
  const controlText = isLight ? '#1f2937' : '#c9d1d9';

  return (
    <div
      ref={setLensEl}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: lensY,
        height: lensH,
        overflow: 'hidden',
        cursor: dragging ? 'grabbing' : 'grab',
        borderTop: `1px solid ${accent}`,
        borderBottom: `1px solid ${accent}`,
        boxShadow: isLight
          ? '0 10px 28px rgba(15, 23, 42, 0.20), inset 0 0 0 1px rgba(255,255,255,0.55)'
          : '0 14px 40px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.04)',
        backgroundColor: lensBg,
        zIndex: 25,
        touchAction: 'none',
        userSelect: 'none',
        contain: 'strict',
      }}
    >
      <div
        ref={innerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: innerLayoutW,
          padding: '8px 12px 12px 12px',
          boxSizing: 'border-box',
          transform: `translate3d(0, ${translateY}px, 0) scale(${zoom})`,
          transformOrigin: '0 0',
          willChange: 'transform',
          pointerEvents: 'none',
        }}
      >
        {children}
      </div>

      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: '50%',
          left: 6,
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          opacity: 0.55,
          pointerEvents: 'none',
        }}
      >
        <span style={{ width: 4, height: 4, borderRadius: 2, background: accent }} />
        <span style={{ width: 4, height: 4, borderRadius: 2, background: accent }} />
        <span style={{ width: 4, height: 4, borderRadius: 2, background: accent }} />
      </div>

      <div
        data-lens-control
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 4,
          right: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 4px 2px 6px',
          borderRadius: 999,
          background: controlBg,
          border: `1px solid ${controlBorder}`,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10,
          color: controlText,
          backdropFilter: 'blur(6px)',
        }}
      >
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => clamp(MIN_ZOOM, MAX_ZOOM, +(z - ZOOM_STEP).toFixed(2)))}
          style={zoomButtonStyle(controlText)}
        >
          −
        </button>
        <span style={{ minWidth: 34, textAlign: 'center', letterSpacing: '0.02em' }}>{zoom.toFixed(2)}×</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => clamp(MIN_ZOOM, MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)))}
          style={zoomButtonStyle(controlText)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function clamp(min: number, max: number, v: number) {
  return Math.max(min, Math.min(max, v));
}

function zoomButtonStyle(color: string): React.CSSProperties {
  return {
    width: 18,
    height: 18,
    borderRadius: 9,
    border: 'none',
    cursor: 'pointer',
    background: 'transparent',
    color,
    fontSize: 13,
    lineHeight: '14px',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}

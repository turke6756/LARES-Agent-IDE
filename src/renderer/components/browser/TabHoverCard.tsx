import React from 'react';
import * as Icons from 'lucide-react';

// ── Rich tab hover card (replaces the native title=URL tooltip) ──────────────
//
// The user asked for a human-readable popover, not a raw URL: the page's title
// is the headline, the domain is a de-emphasized subtitle, and a status line
// reports loading / agent ownership. The group variant previews the first few
// member titles.
//
// Positioning is fixed at an anchor (the hovered element's bottom-left). The
// card lives in the chrome band ABOVE the BrowserViewHost (tab strip → address
// bar), so it never overlaps the WebContentsView and needs no pane suspension.
// Pointer events are disabled so the card can't steal the hover it describes.

export interface TabHoverStatus {
  icon: React.ReactNode;
  text: string;
  className?: string;
}

export interface TabHoverCardProps {
  /** Viewport coords of the anchor's bottom-left. */
  x: number;
  y: number;
  icon: React.ReactNode;
  title: string;
  subtitle?: string | null;
  status?: TabHoverStatus | null;
  /** Group variant: preview of member titles + overflow count. */
  members?: string[];
  moreCount?: number;
}

export default function TabHoverCard({
  x,
  y,
  icon,
  title,
  subtitle,
  status,
  members,
  moreCount = 0,
}: TabHoverCardProps) {
  return (
    <div
      className="fixed z-[60] pointer-events-none max-w-[300px] rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] shadow-lg px-3 py-2 text-[12px]"
      style={{ left: x, top: y + 6 }}
      role="tooltip"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="font-medium text-fg-primary leading-snug break-words line-clamp-2">
            {title}
          </div>
          {subtitle && (
            <div className="text-[11px] text-fg-muted truncate mt-0.5">{subtitle}</div>
          )}
          {status && (
            <div
              className={`flex items-center gap-1 text-[11px] mt-1 ${
                status.className ?? 'text-fg-secondary'
              }`}
            >
              <span className="shrink-0 inline-flex">{status.icon}</span>
              {status.text}
            </div>
          )}
          {members && members.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {members.map((m, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[11px] text-fg-secondary">
                  <Icons.Dot className="w-3 h-3 shrink-0 text-fg-muted" />
                  <span className="truncate">{m}</span>
                </li>
              ))}
              {moreCount > 0 && (
                <li className="text-[11px] text-fg-muted pl-[18px]">+{moreCount} more</li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

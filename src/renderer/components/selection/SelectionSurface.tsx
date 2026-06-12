// Thin selection-to-agent wrapper for read-mode surfaces (plan §7 WP-P4).
// Owns the container ref + useSelectionActions so each renderer's diff is one
// import + one wrapping element. The `display: contents` wrapper adds no box,
// so the wrapped renderer's h-full/flex layout chain is untouched; contextmenu
// events from children still bubble through it.
//
// Two ways to provide the selection context:
//  - `tabId`  — file-viewer shorthand: derives a 'file' context from the open
//    tab in the dashboard store (renderers only receive tabId).
//  - `getContext` — explicit context for non-file-tab surfaces (notes, WP-P6).
//    Wins over tabId when both are set.

import React, { useRef } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useSelectionActions } from '../../lib/selection/useSelectionActions';
import type { SelectionContext } from '../../lib/selection/selection-types';

export type SurfaceSelectionContext = Omit<SelectionContext, 'quotedText'>;

interface Props {
  tabId?: string;
  getContext?: () => SurfaceSelectionContext;
  children: React.ReactNode;
}

// Pure derivation, exported for unit tests. The bare path goes into
// sourceLabel — buildQuotedPrompt prefixes `Source: file ` for file targets.
export function deriveFileSelectionContext(
  tab: { filePath: string; workspaceId?: string } | undefined,
  selectedWorkspaceId: string | null,
): SurfaceSelectionContext {
  const filePath = tab?.filePath ?? '';
  return {
    targetType: 'file',
    workspaceId: tab?.workspaceId ?? selectedWorkspaceId ?? '',
    sourceLabel: filePath,
    file: { filePath },
    capabilities: { comment: false },
  };
}

export default function SelectionSurface({ tabId, getContext, children }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tab = useDashboardStore((s) =>
    tabId ? s.openTabs.find((t) => t.id === tabId) : undefined,
  );
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);

  const { menuElement } = useSelectionActions({
    containerRef,
    getContext: getContext ?? (() => deriveFileSelectionContext(tab, selectedWorkspaceId)),
  });

  return (
    <div ref={containerRef} className="contents">
      {children}
      {menuElement}
    </div>
  );
}

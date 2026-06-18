import React, { useRef } from 'react';
import { tabLabel, type TabGroup } from './tab-groups';
import * as Icons from 'lucide-react';

// ── Collapsed group chip ─────────────────────────────────────────────────────
//
// One pill standing in for a whole partition's tabs. Two affordances:
//   • body click  → expand the group inline in the strip (onToggleInline)
//   • caret click → open the vertical dropdown list (onToggleDropdown)
//
// When the active tab lives inside the collapsed group, the chip shows that
// member's favicon + title and takes the active treatment, so the human always
// knows what's on screen. If any member is pulsing for attention, the chip
// pulses too — collapsing must not hide the agent-attention signal.

interface TabGroupChipProps {
  group: TabGroup;
  dropdownOpen: boolean;
  onToggleInline: () => void;
  /** Reports the chip's bounding rect so the strip can anchor the dropdown. */
  onToggleDropdown: (rect: DOMRect | null) => void;
}

export default function TabGroupChip({
  group,
  dropdownOpen,
  onToggleInline,
  onToggleDropdown,
}: TabGroupChipProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isAgent = group.partition === 'agent';
  const accentText = isAgent ? 'text-accent-orange' : 'text-accent-blue';
  const tint = isAgent ? 'bg-accent-orange/10' : 'bg-accent-blue/10';
  const active = group.activeMember;

  return (
    <div
      ref={rootRef}
      onClick={onToggleInline}
      role="button"
      data-partition={group.partition}
      title={`${group.label} — ${group.members.length} tabs. Click to expand; use the caret for a list.`}
      className={`group/chip relative flex items-center gap-1.5 h-8 pl-2 pr-1 rounded-t-lg cursor-pointer select-none border border-transparent border-b-0 shrink-0 ${tint} ${
        active ? 'browser-tab-active' : ''
      } ${group.hasAttention ? 'animate-pulse ring-1 ring-accent-orange' : ''}`}
    >
      {/* Inline-expand chevron (points right when collapsed). */}
      <Icons.ChevronRight className="w-3.5 h-3.5 shrink-0 text-fg-muted" />

      {/* Group identity icon. */}
      {isAgent ? (
        <Icons.Bot className={`w-3.5 h-3.5 shrink-0 ${accentText}`} />
      ) : (
        <Icons.User className={`w-3.5 h-3.5 shrink-0 ${accentText}`} />
      )}

      {/* Label, or the active member's favicon + title when one is showing. */}
      {active ? (
        <span className="flex items-center gap-1 min-w-0 max-w-[140px]">
          {active.tab.loading ? (
            <Icons.Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-fg-muted" />
          ) : active.tab.favicon ? (
            <img src={active.tab.favicon} alt="" className="w-3.5 h-3.5 shrink-0" />
          ) : null}
          <span className="truncate text-[12px] text-fg-primary">{tabLabel(active.tab)}</span>
        </span>
      ) : (
        <span className="text-[12px] font-medium text-fg-primary">{group.label}</span>
      )}

      {/* Count badge. */}
      <span
        className={`shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
          isAgent ? 'bg-accent-orange/20 text-accent-orange' : 'bg-accent-blue/20 text-accent-blue'
        }`}
      >
        {group.members.length}
      </span>

      {/* Dropdown-list caret. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleDropdown(rootRef.current?.getBoundingClientRect() ?? null);
        }}
        className={`shrink-0 p-0.5 rounded hover:bg-[var(--color-tab-hover-bg)] ${
          dropdownOpen ? accentText : 'text-fg-muted'
        }`}
        title="Show all tabs in this group"
      >
        <Icons.ChevronDown className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

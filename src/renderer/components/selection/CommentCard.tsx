// Shared comment card + send controls (plan §1.10).
//
// Extracted from FileCommentGutter so the markdown gutter and the new
// PdfCommentSidebar render the SAME card — status label, quote, body, the
// Send / Send-all / Resolve / Delete controls, and the agent picker — without
// forking the send UI. The card is purely PRESENTATIONAL: it owns only the
// transient picker-open state; every location decision (where the card sits,
// what the status label says) is supplied by the host positioning adapter.
//
// The send/status/event machinery is unchanged — hosts pass `onSendOne` /
// `onSendAll` that call `sendPersistedComments`, so text and PDF comments share
// one dispatch path.
import React, { useState } from 'react';
import type { SelectionComment } from '../../../shared/types';
import type { SelectionAgentTarget } from '../../lib/selection/selection-types';
import AgentPickerDropdown from './AgentPickerDropdown';

export interface CommentCardProps {
  comment: SelectionComment;
  workspaceId: string;
  /** Already-resolved display label (host decides orphaned vs. status). */
  statusLabel: string;
  /** Whether the Send control is offered (status is in the sendable set). */
  sendable: boolean;
  /** Number of draft comments in this surface; Send-all shows when > 1. */
  draftCount: number;
  /** Optional location line under the quote, e.g. "Page 3" for PDF cards. */
  locationLabel?: string;
  /** Left border accent on the quote block (defaults to the comment blue). */
  quoteBorderClass?: string;
  /** Positioning + sizing supplied by the host adapter. */
  style?: React.CSSProperties;
  className?: string;
  onClose: () => void;
  onSendOne: (target: SelectionAgentTarget) => void;
  onSendAll?: (target: SelectionAgentTarget) => void;
  onResolve: () => void;
  onDelete: () => void;
  /** Overridable so the markdown gutter keeps its existing test id. */
  testId?: string;
}

export default function CommentCard({
  comment,
  workspaceId,
  statusLabel,
  sendable,
  draftCount,
  locationLabel,
  quoteBorderClass = 'border-accent-blue/50',
  style,
  className,
  onClose,
  onSendOne,
  onSendAll,
  onResolve,
  onDelete,
  testId = 'comment-card',
}: CommentCardProps) {
  const [pickerFor, setPickerFor] = useState<'one' | 'all' | null>(null);
  const showSendAll = draftCount > 1 && !!onSendAll;

  return (
    <div
      data-testid={testId}
      className={`ui-menu pointer-events-auto absolute p-2 ${className ?? ''}`}
      style={style}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-gray-400">
          {statusLabel}
        </span>
        <button className="ui-btn text-[11px] px-1.5 py-0" onClick={onClose} title="Collapse">
          ✕
        </button>
      </div>
      <div
        className={`px-2 py-1 mb-1.5 border-l-2 ${quoteBorderClass} text-[12px] text-gray-400 italic whitespace-pre-wrap max-h-24 overflow-auto`}
      >
        {comment.quotedText}
      </div>
      {locationLabel && (
        <div className="text-[11px] text-gray-500 mb-1.5">{locationLabel}</div>
      )}
      <div className="text-[13px] text-gray-200 whitespace-pre-wrap max-h-40 overflow-auto mb-2">
        {comment.body}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {sendable && (
          <button
            className="ui-btn text-[12px]"
            onClick={() => setPickerFor((v) => (v === 'one' ? null : 'one'))}
          >
            Send&nbsp;▸
          </button>
        )}
        {showSendAll && (
          <button
            className="ui-btn text-[12px]"
            onClick={() => setPickerFor((v) => (v === 'all' ? null : 'all'))}
            title={`Send all ${draftCount} draft comments as one message`}
          >
            Send all ({draftCount})&nbsp;▸
          </button>
        )}
        <button
          className="ui-btn text-[12px]"
          onClick={() => {
            onClose();
            onResolve();
          }}
        >
          Resolve
        </button>
        <button
          className="ui-btn text-[12px]"
          onClick={() => {
            onClose();
            onDelete();
          }}
        >
          Delete
        </button>
      </div>
      {pickerFor && (
        <div className="mt-1.5">
          <AgentPickerDropdown
            workspaceId={workspaceId}
            onPick={(target) => {
              setPickerFor(null);
              if (pickerFor === 'all') onSendAll?.(target);
              else onSendOne(target);
            }}
          />
        </div>
      )}
    </div>
  );
}

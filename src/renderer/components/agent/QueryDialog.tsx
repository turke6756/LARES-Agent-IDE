import React, { useState } from 'react';
import type { Agent, QueryResult } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useBrowserSuspension } from '../browser/useBrowserSuspension';

interface QueryDialogProps {
  sourceAgent: Agent;
  onClose: () => void;
}

export default function QueryDialog({ sourceAgent, onClose }: QueryDialogProps) {
  // The browser WebContentsView paints above this dialog — hide it while open.
  useBrowserSuspension();
  const { agents, queryAgent } = useDashboardStore();
  const [targetId, setTargetId] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  const eligibleTargets = agents.filter(
    (a) => a.id !== sourceAgent.id && a.resumeSessionId
  );

  const handleSend = async () => {
    if (!targetId || !question.trim()) return;
    setLoading(true);
    setResult(null);
    const res = await queryAgent(targetId, question.trim(), sourceAgent.id);
    setResult(res);
    setLoading(false);
  };

  const handleCopy = async () => {
    if (result?.result) {
      await navigator.clipboard.writeText(result.result);
    }
  };

  const handleInject = () => {
    if (result?.result) {
      window.api.terminal.write(sourceAgent.id, result.result);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="panel-shell w-[480px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="panel-header p-3 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Query Agent</h3>
          <button onClick={onClose} className="ui-btn ui-btn-ghost min-h-0 px-1.5 py-0.5">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <path d="M1 1L9 9M9 1L1 9" strokeWidth="2" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-3 space-y-3 flex-1 overflow-y-auto">
          <div>
            <label className="text-[11px] text-gray-500 block mb-1 uppercase tracking-wider">Target agent</label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="ui-input text-[13px]"
            >
              <option value="">Select an agent...</option>
              {eligibleTargets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} ({a.status})
                </option>
              ))}
            </select>
            {eligibleTargets.length === 0 && (
              <p className="text-[11px] text-gray-500 mt-1">No agents with session IDs available</p>
            )}
          </div>

          <div>
            <label className="text-[11px] text-gray-500 block mb-1 uppercase tracking-wider">Question</label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What would you like to ask?"
              className="ui-textarea text-[13px] resize-none h-24"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
          </div>

          <button
            onClick={handleSend}
            disabled={loading || !targetId || !question.trim()}
            className="ui-btn ui-btn-primary w-full py-2 text-[13px]"
          >
            {loading ? 'Querying... this may take up to 60s' : 'Send Query'}
          </button>

          {result && (
            <div className={`p-3 text-[13px] border ${result.isError ? 'bg-accent-red/5 border-accent-red/30' : 'bg-surface-0 border-surface-3'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-[11px] font-semibold uppercase tracking-wider ${result.isError ? 'text-accent-red' : 'text-accent-green'}`}>
                  {result.isError ? 'Error' : 'Response'}
                </span>
                <div className="flex gap-2">
                  <button onClick={handleCopy} className="ui-btn ui-btn-ghost min-h-0 px-2 py-0.5 text-[11px]">
                    Copy
                  </button>
                  {!result.isError && (
                    <button onClick={handleInject} className="ui-btn ui-btn-purple min-h-0 px-2 py-0.5 text-[11px]">
                      Inject to terminal
                    </button>
                  )}
                </div>
              </div>
              <pre className="whitespace-pre-wrap text-gray-300 max-h-48 overflow-y-auto">{result.result}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

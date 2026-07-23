import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import type { PrerequisiteCheck } from '../../../shared/types';

/** One prerequisite, rendered the same way everywhere it appears.
 *
 *  The copy rules this enforces (packaging plan §6.3) are the whole point:
 *  - `not-checked` renders as "not checked", never as a red X. Claiming
 *    something is missing when we deliberately did not look is a lie the user
 *    will act on.
 *  - The documentation LINK is the primary affordance and comes first. The
 *    copyable command sits underneath with the date it was verified, because a
 *    hard-coded `npm i -g …` goes stale and presumes npm exists — but a
 *    non-technical user with no command at all is stranded. */

function statusFace(status: PrerequisiteCheck['status']): {
  icon: React.ReactNode;
  text: string;
  className: string;
} {
  switch (status) {
    case 'available':
      return { icon: <Icons.Check className="w-3.5 h-3.5" />, text: 'Installed', className: 'text-accent-green' };
    case 'stopped':
      return { icon: <Icons.Pause className="w-3.5 h-3.5" />, text: 'Not running', className: 'text-accent-orange' };
    case 'not-checked':
      return { icon: <Icons.Minus className="w-3.5 h-3.5" />, text: 'Not checked', className: 'text-gray-500' };
    default:
      return { icon: <Icons.X className="w-3.5 h-3.5" />, text: 'Not found', className: 'text-gray-400' };
  }
}

function CopyableCommand({ command, shell }: { command: string; shell?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => { /* clipboard denied — the text is still selectable on screen */ },
    );
  };
  return (
    <div className="flex items-center gap-2 mt-1.5">
      <code className="flex-1 min-w-0 truncate bg-surface-0 rounded px-2 py-1 font-mono text-[11px] text-gray-300 select-all">
        {command}
      </code>
      <button
        onClick={copy}
        className="ui-btn px-2 py-1 text-[11px] shrink-0"
        title={shell ? `Run in ${shell}` : 'Copy'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function PrerequisiteRow({
  check,
  onOpenDocs,
}: {
  check: PrerequisiteCheck;
  onOpenDocs: (url: string) => void;
}) {
  const face = statusFace(check.status);
  const resolved = check.status === 'available';

  return (
    <div className="py-2.5 border-b border-white/5 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className={`flex items-center gap-1 shrink-0 ${face.className}`}>
          {face.icon}
          <span className="text-[13px] font-medium text-gray-100">{check.label}</span>
        </span>
        <span className={`text-[11px] ${face.className}`}>{face.text}</span>
        {check.version && (
          <span className="text-[11px] text-gray-500 truncate" title={check.version}>
            {check.version}
          </span>
        )}
      </div>

      {resolved && check.path && (
        <div className="mt-0.5 text-[11px] text-gray-600 font-mono truncate" title={check.path}>
          {check.path}
        </div>
      )}

      {!resolved && (
        <div className="mt-1 pl-5 space-y-1">
          {check.impact && <p className="text-[12px] text-gray-400">{check.impact}</p>}
          {check.remediation && <p className="text-[12px] text-gray-500">{check.remediation}</p>}

          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            {check.docsUrl && (
              <button
                onClick={() => onOpenDocs(check.docsUrl as string)}
                className="text-[12px] text-accent-blue hover:underline inline-flex items-center gap-1"
              >
                <Icons.ExternalLink className="w-3 h-3" />
                Official install guide
              </button>
            )}
          </div>

          {check.installCommand && (
            <>
              {check.installNote && (
                <p className="text-[11px] text-accent-orange">{check.installNote}</p>
              )}
              <CopyableCommand command={check.installCommand} shell={check.installShell} />
              <p className="text-[10.5px] text-gray-600">
                {check.installShell ? `${check.installShell} — ` : ''}
                {check.verifiedOn
                  ? `verified ${check.verifiedOn} — see the official docs if this fails.`
                  : 'see the official docs if this fails.'}
              </p>
              {check.altCommand && (
                <details className="text-[11px] text-gray-500">
                  <summary className="cursor-pointer hover:text-gray-400">Already have npm?</summary>
                  <CopyableCommand command={check.altCommand} />
                </details>
              )}
            </>
          )}

          {check.detail && (
            <p className="text-[11px] text-gray-600 font-mono break-words">{check.detail}</p>
          )}
        </div>
      )}
    </div>
  );
}

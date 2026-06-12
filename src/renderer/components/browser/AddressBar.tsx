import React, { useEffect, useState } from 'react';
import { useBrowserStore, normalizeAddressInput, type BrowserTabState } from '../../stores/browser-store';
import * as Icons from 'lucide-react';

interface Props {
  tab: BrowserTabState | null;
}

export default function AddressBar({ tab }: Props) {
  const navigate = useBrowserStore((s) => s.navigate);
  const createTab = useBrowserStore((s) => s.createTab);
  const goBack = useBrowserStore((s) => s.goBack);
  const goForward = useBrowserStore((s) => s.goForward);
  const reload = useBrowserStore((s) => s.reload);
  const stop = useBrowserStore((s) => s.stop);

  const [value, setValue] = useState(tab?.url ?? '');
  const [editing, setEditing] = useState(false);

  // Track the active tab's URL while the user isn't typing.
  useEffect(() => {
    if (!editing) setValue(tab?.url ?? '');
  }, [tab?.tabId, tab?.url, editing]);

  const submit = () => {
    const input = value.trim();
    if (!input) return;
    if (tab) {
      navigate(tab.tabId, input);
    } else {
      // No tab yet — Enter in the empty pane opens a fresh user tab.
      const url = normalizeAddressInput(input);
      if (url) void createTab('user', url);
    }
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-700/50 shrink-0">
      <button
        onClick={() => tab && goBack(tab.tabId)}
        disabled={!tab?.canGoBack}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Back"
      >
        <Icons.ArrowLeft className="w-4 h-4" />
      </button>
      <button
        onClick={() => tab && goForward(tab.tabId)}
        disabled={!tab?.canGoForward}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Forward"
      >
        <Icons.ArrowRight className="w-4 h-4" />
      </button>
      {tab?.loading ? (
        <button
          onClick={() => stop(tab.tabId)}
          className="ui-btn ui-btn-ghost p-1.5"
          title="Stop loading"
        >
          <Icons.X className="w-4 h-4" />
        </button>
      ) : (
        <button
          onClick={() => tab && reload(tab.tabId)}
          disabled={!tab}
          className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
          title="Reload"
        >
          <Icons.RotateCw className="w-4 h-4" />
        </button>
      )}
      <input
        type="text"
        value={value}
        spellCheck={false}
        placeholder="Enter URL — https:// is the default scheme"
        onChange={(e) => {
          setEditing(true);
          setValue(e.target.value);
        }}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            submit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setValue(tab?.url ?? '');
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        className="flex-1 min-w-0 bg-gray-800/60 border border-gray-700/60 px-3 py-1.5 text-[12px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-accent-blue/60"
      />
      {tab && (
        <span
          className={`text-[10px] px-1.5 py-0.5 font-semibold uppercase shrink-0 ${
            tab.partition === 'agent'
              ? 'text-accent-orange bg-accent-orange/10'
              : 'text-accent-blue bg-accent-blue/10'
          }`}
          title={
            tab.partition === 'agent'
              ? 'Agent partition (persist:agent) — isolated from your sign-ins'
              : 'Your partition (persist:user) — sign-ins persist here'
          }
        >
          {tab.partition}
        </span>
      )}
    </div>
  );
}

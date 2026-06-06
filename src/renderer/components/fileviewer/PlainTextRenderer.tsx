import React, { useRef } from 'react';
import { useTabScrollMemory } from './scrollMemory';

interface Props {
  content: string;
  tabId?: string;
}

export default function PlainTextRenderer({ content, tabId }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const handleScroll = useTabScrollMemory(tabId, scrollRef);
  const lines = content.split('\n');
  const gutterWidth = String(lines.length).length;

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="overflow-auto h-full font-sans text-sm">
      <pre className="p-4">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span
              className="select-none text-gray-400 text-right pr-4 shrink-0"
              style={{ minWidth: `${gutterWidth + 2}ch` }}
            >
              {i + 1}
            </span>
            <span className="text-gray-300 whitespace-pre">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

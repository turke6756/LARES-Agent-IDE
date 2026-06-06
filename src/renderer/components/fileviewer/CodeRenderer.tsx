import React, { useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import SymbolOutline from './SymbolOutline';
import { useThemeStore } from '../../stores/theme-store';
import { useTabScrollMemory } from './scrollMemory';

interface Props {
  content: string;
  language: string;
  tabId?: string;
}

export default function CodeRenderer({ content, language, tabId }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScroll = useTabScrollMemory(tabId, scrollRef);
  const theme = useThemeStore((s) => s.theme);
  const isLight = theme === 'light';

  const handleSymbolClick = (line: number) => {
    if (scrollRef.current) {
      // 13px font size * 1.5 line height = 19.5px per line
      const lineHeight = 19.5; 
      // Add padding offset
      const padding = 16; 
      const scrollPos = (line - 1) * lineHeight;
      scrollRef.current.scrollTo({ top: scrollPos, behavior: 'smooth' });
    }
  };

  return (
    <div className="flex h-full min-w-0">
      <div className="flex-1 overflow-auto h-full scrollbar-thin" ref={scrollRef} onScroll={handleScroll}>
        <SyntaxHighlighter
          language={language}
          style={isLight ? vs : vscDarkPlus}
          showLineNumbers
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.8125rem',
            lineHeight: '1.5',
          }}
          lineNumberStyle={{
            minWidth: '3em',
            paddingRight: '1em',
            color: isLight ? '#9ca3af' : '#4b5563',
            userSelect: 'none',
          }}
        >
          {content}
        </SyntaxHighlighter>
      </div>
      
      <SymbolOutline 
        content={content} 
        language={language} 
        onSymbolClick={handleSymbolClick} 
      />
    </div>
  );
}

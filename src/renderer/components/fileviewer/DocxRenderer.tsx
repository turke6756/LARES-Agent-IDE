import { useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { useTabScrollMemory } from './scrollMemory';

interface Props {
  content: string;
  warnings?: string[];
  tabId?: string;
}

export default function DocxRenderer({ content, warnings = [], tabId }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const handleScroll = useTabScrollMemory(tabId, scrollRef);
  const sanitized = useMemo(() => DOMPurify.sanitize(content, {
    ADD_TAGS: ['picture', 'source'],
    ADD_ATTR: ['srcset', 'colspan', 'rowspan'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:image\/|#|\/(?!\/)|\.\.?\/)/i,
  }), [content]);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="h-full min-w-0 overflow-auto bg-surface-0 p-6">
      <div className="max-w-3xl mx-auto">
        {warnings.length > 0 && (
          <div className="mb-4 border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-[12px] font-sans text-amber-200">
            <div className="font-medium mb-1">Converted from Word with warnings</div>
            <ul className="list-disc pl-4 space-y-1">
              {warnings.slice(0, 5).map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
              {warnings.length > 5 && <li>{warnings.length - 5} more warnings</li>}
            </ul>
          </div>
        )}
        <article
          className="prose-custom docx-content"
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      </div>
    </div>
  );
}

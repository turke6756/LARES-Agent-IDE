import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTabScrollMemory } from './scrollMemory';
import { useModifierPathOpen } from './openFileHelpers';

interface Props {
  content: string;
  filePath: string;
  tabId?: string;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function colLabel(index: number): string {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function detectDelimiter(filePath: string, sample: string): string {
  if (/\.tsv$/i.test(filePath)) return '\t';
  const firstLine = sample.split(/\r?\n/, 1)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

const MAX_ROWS = 5000;
const MIN_COL_WIDTH = 60;

// Selection highlight colors (work over both dark and light themes; inline so
// they beat the row-hover CSS rules in globals.css).
const SEL_HEADER_BG = '#316dca';
const SEL_CELL_BG = 'rgba(47, 129, 247, 0.18)';
const SEL_CELL_INTERSECT_BG = 'rgba(47, 129, 247, 0.38)';

export default function CsvRenderer({ content, filePath, tabId }: Props) {
  const [showHeaderRow, setShowHeaderRow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const handleScroll = useTabScrollMemory(tabId, scrollRef);
  // Ctrl/Cmd+click on a cell whose text looks like a file path opens it in
  // the file viewer. Plain clicks are untouched (the handler no-ops), so
  // column/row selection and column-resize behavior are unaffected.
  const handleModifierPathClick = useModifierPathOpen(tabId);
  // Selection: column indices, plus absolute row indices into `rows`
  // (header row included), so toggling "first row is header" keeps the
  // same data rows selected.
  const [selectedCols, setSelectedCols] = useState<Set<number>>(new Set());
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  // Per-column pixel widths set by drag-resizing; unset columns keep auto sizing.
  const [colWidths, setColWidths] = useState<Record<number, number>>({});

  const dragRef = useRef<{ col: number; startX: number; startWidth: number } | null>(null);

  // New file: drop selection and custom widths (but keep them across
  // content-only refreshes of the same file).
  useEffect(() => {
    setSelectedCols(new Set());
    setSelectedRows(new Set());
    setColWidths({});
  }, [filePath]);

  // Safety net: if unmounted mid-drag, restore the document cursor.
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  const { rows, truncated, delimiter } = useMemo(() => {
    const delim = detectDelimiter(filePath, content);
    const parsed = parseDelimited(content, delim);
    const trimmed = parsed.length > 0 && parsed[parsed.length - 1].every((c) => c === '')
      ? parsed.slice(0, -1)
      : parsed;
    const truncated = trimmed.length > MAX_ROWS;
    return {
      rows: truncated ? trimmed.slice(0, MAX_ROWS) : trimmed,
      truncated,
      delimiter: delim,
    };
  }, [content, filePath]);

  const colCount = useMemo(
    () => rows.reduce((max, r) => Math.max(max, r.length), 0),
    [rows],
  );

  const toggleCol = (c: number) => {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const toggleRow = (absRow: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(absRow)) next.delete(absRow);
      else next.add(absRow);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedCols(new Set());
    setSelectedRows(new Set());
  };

  const startColResize = (c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement | null;
    const startWidth = colWidths[c] ?? th?.offsetWidth ?? 120;
    dragRef.current = { col: c, startX: e.clientX, startWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const w = Math.max(MIN_COL_WIDTH, Math.round(drag.startWidth + (ev.clientX - drag.startX)));
      setColWidths((prev) => (prev[drag.col] === w ? prev : { ...prev, [drag.col]: w }));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const resetColWidth = (c: number) => {
    setColWidths((prev) => {
      if (!(c in prev)) return prev;
      const next = { ...prev };
      delete next[c];
      return next;
    });
  };

  // Inline width style for a resized column (overrides the min/max-width in CSS).
  const colWidthStyle = (c: number): React.CSSProperties | undefined => {
    const w = colWidths[c];
    return w !== undefined ? { width: w, minWidth: w, maxWidth: w } : undefined;
  };

  const cellSelectionBg = (absRow: number, c: number): string | undefined => {
    const colSel = selectedCols.has(c);
    const rowSel = selectedRows.has(absRow);
    if (colSel && rowSel) return SEL_CELL_INTERSECT_BG;
    if (colSel || rowSel) return SEL_CELL_BG;
    return undefined;
  };

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 font-sans">
        Empty file
      </div>
    );
  }

  const headerRow = showHeaderRow ? rows[0] : null;
  const dataRows = showHeaderRow ? rows.slice(1) : rows;
  const delimiterLabel = delimiter === '\t' ? 'Tab' : delimiter === ';' ? 'Semicolon' : 'Comma';
  const hasSelection = selectedCols.size > 0 || selectedRows.size > 0;

  const renderResizeHandle = (c: number) => (
    <div
      onMouseDown={(e) => startColResize(c, e)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        resetColWidth(c);
      }}
      title="Drag to resize · double-click to reset"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 8,
        height: '100%',
        cursor: 'col-resize',
        zIndex: 1,
      }}
    />
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-surface-3 bg-surface-1 text-[11px] font-sans text-gray-400 shrink-0">
        <div className="flex items-center gap-4">
          <span>
            <span className="text-gray-300">{rows.length.toLocaleString()}</span> rows
            {' · '}
            <span className="text-gray-300">{colCount.toLocaleString()}</span> cols
            {' · '}
            <span className="text-gray-300">{delimiterLabel}</span>-separated
          </span>
          {truncated && (
            <span className="text-accent-yellow">Showing first {MAX_ROWS.toLocaleString()} rows</span>
          )}
          {hasSelection && (
            <span className="flex items-center gap-2">
              <span className="text-gray-300">
                {selectedCols.size > 0 && `${selectedCols.size} col${selectedCols.size > 1 ? 's' : ''}`}
                {selectedCols.size > 0 && selectedRows.size > 0 && ' · '}
                {selectedRows.size > 0 && `${selectedRows.size} row${selectedRows.size > 1 ? 's' : ''}`}
                {' selected'}
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="px-1.5 py-0.5 rounded border border-surface-3 text-gray-300 hover:text-white hover:border-gray-400 cursor-pointer"
              >
                Clear
              </button>
            </span>
          )}
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showHeaderRow}
            onChange={(e) => setShowHeaderRow(e.target.checked)}
            className="accent-accent-blue"
          />
          First row is header
        </label>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-auto csv-grid-scroll">
        <table className="csv-grid border-separate border-spacing-0 font-sans text-[12px]">
          <thead>
            <tr>
              <th
                className="csv-corner sticky top-0 left-0 z-30"
                onClick={clearSelection}
                title={hasSelection ? 'Clear selection' : undefined}
                style={hasSelection ? { cursor: 'pointer' } : undefined}
              />
              {Array.from({ length: colCount }).map((_, c) => {
                const isSel = selectedCols.has(c);
                return (
                  <th
                    key={c}
                    className="csv-col-header sticky top-0 z-20"
                    onClick={() => toggleCol(c)}
                    title={`Click to ${isSel ? 'deselect' : 'select'} column ${colLabel(c)}`}
                    style={{
                      cursor: 'pointer',
                      ...colWidthStyle(c),
                      ...(isSel ? { background: SEL_HEADER_BG, color: '#ffffff' } : undefined),
                    }}
                  >
                    {colLabel(c)}
                    {renderResizeHandle(c)}
                  </th>
                );
              })}
            </tr>
            {headerRow && (
              <tr>
                <th
                  className="csv-row-header sticky left-0 z-20 csv-header-row-num"
                  onClick={() => toggleRow(0)}
                  title={`Click to ${selectedRows.has(0) ? 'deselect' : 'select'} row 1`}
                  style={{
                    cursor: 'pointer',
                    ...(selectedRows.has(0) ? { background: SEL_HEADER_BG, color: '#ffffff' } : undefined),
                  }}
                >
                  1
                </th>
                {Array.from({ length: colCount }).map((_, c) => {
                  const bg = cellSelectionBg(0, c);
                  return (
                    <th
                      key={c}
                      className="csv-cell csv-header-cell"
                      onClick={(e) => handleModifierPathClick(e, headerRow[c])}
                      style={{
                        ...colWidthStyle(c),
                        ...(bg ? { background: bg } : undefined),
                      }}
                    >
                      {headerRow[c] ?? ''}
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody>
            {dataRows.map((row, r) => {
              const absRow = showHeaderRow ? r + 1 : r;
              const displayRowNum = absRow + 1;
              const rowSel = selectedRows.has(absRow);
              return (
                <tr key={r}>
                  <th
                    className="csv-row-header sticky left-0 z-10"
                    onClick={() => toggleRow(absRow)}
                    title={`Click to ${rowSel ? 'deselect' : 'select'} row ${displayRowNum}`}
                    style={{
                      cursor: 'pointer',
                      ...(rowSel ? { background: SEL_HEADER_BG, color: '#ffffff' } : undefined),
                    }}
                  >
                    {displayRowNum}
                  </th>
                  {Array.from({ length: colCount }).map((_, c) => {
                    const value = row[c] ?? '';
                    const isNumeric = value !== '' && !isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value.trim());
                    const bg = cellSelectionBg(absRow, c);
                    const widthStyle = colWidthStyle(c);
                    const style = bg || widthStyle
                      ? { ...widthStyle, ...(bg ? { background: bg } : undefined) }
                      : undefined;
                    return (
                      <td
                        key={c}
                        className={`csv-cell ${isNumeric ? 'csv-cell-num' : ''}`}
                        onClick={(e) => handleModifierPathClick(e, value)}
                        style={style}
                      >
                        {value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

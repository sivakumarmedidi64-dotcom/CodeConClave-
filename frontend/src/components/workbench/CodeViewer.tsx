/**
 * CodeConClave — Workbench read-only code viewer.
 * Line numbers + lightweight syntax highlighting + in-file search/jump +
 * copy. Reads REAL file content (passed in); binary/non-text payloads render
 * an honest refusal instead of garbage.
 */
import { useMemo, useRef, useState } from 'react';
import { highlightLines, languageFromExtension } from '../../lib/workbench';
import { displayNameOf } from '../../lib/types';

const MAX_RENDER_LINES = 4000;

export function CodeViewer({
  path,
  content,
  binary,
}: {
  path: string;
  content: string | null;
  binary?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [wrap, setWrap] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const language = useMemo(() => languageFromExtension(path), [path]);
  const lines = useMemo(() => {
    if (content == null) return [];
    const all = content.split('\n');
    return all;
  }, [content]);

  const truncated = lines.length > MAX_RENDER_LINES;
  const visibleLines = truncated ? lines.slice(0, MAX_RENDER_LINES) : lines;
  const highlighted = useMemo(() => highlightLines(visibleLines.join('\n'), language), [visibleLines, language]);

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    const out: number[] = [];
    const lower = q.toLowerCase();
    lines.forEach((l, i) => {
      if (l.toLowerCase().includes(lower)) out.push(i);
    });
    return out;
  }, [search, lines]);

  const gotoMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (matchIndex + dir + matches.length) % matches.length;
    setMatchIndex(next);
    const lineNo = matches[next]!;
    const el = bodyRef.current?.querySelector(`[data-line="${lineNo}"]`);
    el?.scrollIntoView({ block: 'center' });
  };

  const copy = async () => {
    if (content == null) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="cc-card wb-code wb-pane" data-testid="code-viewer">
      <div className="wb-pane__head">
        <span className="wb-pane__title" data-testid="code-filename">
          {displayNameOf(path) || '(untitled)'}
        </span>
        <span className="cc-hint cc-mono" style={{ fontSize: 11 }}>
          {language} · {lines.length} lines{truncated ? ` · truncated (first ${MAX_RENDER_LINES})` : ''}
        </span>
        <div className="wb-pane__tools">
          <input
            className="cc-input cc-input--sm"
            type="search"
            placeholder="Search in file…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setMatchIndex(0);
            }}
            aria-label="Search in file"
            style={{ width: 150 }}
          />
          {matches.length > 0 && (
            <span className="cc-hint cc-mono" style={{ fontSize: 11 }}>
              {matchIndex + 1}/{matches.length}
            </span>
          )}
          <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={!matches.length} onClick={() => gotoMatch(-1)} aria-label="Previous match">
            ▲
          </button>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={!matches.length} onClick={() => gotoMatch(1)} aria-label="Next match">
            ▼
          </button>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setWrap((w) => !w)} aria-pressed={wrap}>
            {wrap ? 'Wrap: on' : 'Wrap: off'}
          </button>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void copy()} disabled={content == null} aria-label="Copy file">
            Copy
          </button>
        </div>
      </div>

      <div className="wb-code__body" ref={bodyRef} data-testid="code-body">
        {binary || content == null ? (
          <p className="cc-hint" data-testid="code-binary">
            {binary ? 'This file is not text — the viewer does not open it.' : 'No content to display.'}
          </p>
        ) : (
          <div className={`wb-code__scroll${wrap ? ' is-wrap' : ''}`}>
            {highlighted.map((tokens, i) => (
              <div className="wb-code__line" key={i} data-line={i}>
                <span className="wb-code__ln">{i + 1}</span>
                <span className="wb-code__text">
                  {tokens.map((tok, j) => (
                    <span key={j} className={`wb-hl wb-hl--${tok.type}`}>
                      {tok.text}
                    </span>
                  ))}
                  {tokens.length === 0 && '\u00A0'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
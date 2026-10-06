/**
 * CodeConClave — Workbench unified diff viewer.
 * Renders the REAL persisted review diffText (parsed, never fabricated).
 * Shows per-file stats and colorized hunks with line numbers.
 */
import { useMemo, useState } from 'react';
import { parseUnifiedDiff, type ParsedDiffFile } from '../../lib/workbench';

function DiffFile({
  file,
  selectedHunk,
  onSelectHunk,
}: {
  file: ParsedDiffFile;
  selectedHunk: number;
  onSelectHunk: (h: number) => void;
}) {
  const hunks = file.hunks;
  return (
    <div className="wb-diff__file" data-testid="diff-file">
      <div className="wb-diff__filehead">
        <span className="wb-pane__title" style={{ fontSize: 13 }}>
          {file.path}
        </span>
        <span className="wb-diff__stats">
          <span className="wb-diff__add">+{file.additions}</span>
          <span className="wb-diff__del">-{file.deletions}</span>
        </span>
      </div>
      {hunks.length === 0 && <p className="cc-hint" style={{ fontSize: 11 }}>No content changes in this file.</p>}
      {hunks.map((hunk, hi) => (
        <div key={hi} className="wb-diff__hunk">
          <button
            className="cc-btn cc-btn--ghost cc-btn--sm wb-diff__hunkhead"
            onClick={() => onSelectHunk(hi)}
            aria-expanded={selectedHunk === hi}
          >
            {hunk.header}
          </button>
          {selectedHunk === hi && (
            <div className="wb-diff__lines">
              {hunk.lines.map((line, li) => (
                <div
                  key={li}
                  className={`wb-diff__line wb-diff__line--${line.type}`}
                  data-testid={`diff-line-${line.type}`}
                >
                  <span className="wb-diff__mark">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                  <span className="wb-diff__text">{line.text || '\u00A0'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function DiffViewer({
  diffText,
  emptyLabel,
}: {
  diffText: string;
  emptyLabel?: string;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const [selectedHunk, setSelectedHunk] = useState<Record<string, number>>({});

  if (!parsed.files.length) {
    return (
      <div className="cc-card wb-pane" data-testid="diff-viewer">
        <div className="wb-pane__head">
          <span className="wb-pane__title">Diff</span>
        </div>
        <p className="cc-hint" data-testid="diff-empty">
          {emptyLabel ?? 'No diff available.'}
        </p>
      </div>
    );
  }

  return (
    <div className="cc-card wb-pane wb-diff" data-testid="diff-viewer">
      <div className="wb-pane__head">
        <span className="wb-pane__title">Diff</span>
        <span className="cc-hint" style={{ fontSize: 11 }}>
          {parsed.files.length} file{parsed.files.length === 1 ? '' : 's'} · real review data
        </span>
      </div>
      <div className="wb-diff__files">
        {parsed.files.map((file, i) => (
          <DiffFile
            key={`${file.path}:${i}`}
            file={file}
            selectedHunk={selectedHunk[`${file.path}:${i}`] ?? 0}
            onSelectHunk={(h) => setSelectedHunk((prev) => ({ ...prev, [`${file.path}:${i}`]: h }))}
          />
        ))}
      </div>
    </div>
  );
}
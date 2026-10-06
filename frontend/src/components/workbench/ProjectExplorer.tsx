/**
 * CodeConClave — Workbench project explorer.
 * Renders the REAL /api/v1/files/tree payload (no fabricated nodes). Folder
 * expansion is local; a status overlay (A/M/D) is drawn ONLY when the parent
 * "changed files" set was derived from real task/review data.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileTreeNode } from '../../lib/types';
import { displayNameOf } from '../../lib/types';

export type FileChangeStatus = 'created' | 'modified' | 'deleted';

const STATUS_CHIP: Record<FileChangeStatus, string> = {
  created: 'A',
  modified: 'M',
  deleted: 'D',
};

function TreeRow({
  node,
  depth,
  selectedPath,
  statuses,
  expanded,
  onToggle,
  onSelect,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  statuses: Map<string, FileChangeStatus>;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: FileTreeNode) => void;
}) {
  const isFolder = node.type === 'folder' && Array.isArray(node.children);
  const isOpen = expanded.has(node.path);
  const isSelected = !isFolder && selectedPath === node.path;
  const status = statuses.get(node.path);
  const children = isFolder ? (node.children ?? []) : [];

  return (
    <div className="cc-tree" role="tree">
      <div
        role="treeitem"
        aria-expanded={isFolder ? isOpen : undefined}
        className={`cc-tree__row${isSelected ? ' active' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => {
          if (isFolder) onToggle(node.path);
          else onSelect(node);
        }}
        title={node.path}
      >
        <span className="cc-tree__icon" aria-hidden="true">
          {isFolder ? (isOpen ? '▾' : '▸') : '·'}
        </span>
        <span className="cc-tree__name">{isFolder ? node.name : displayNameOf(node.path)}</span>
        {status && <span className={`cc-tree__status cc-tree__status--${status}`}>{STATUS_CHIP[status]}</span>}
      </div>
      {isFolder && isOpen && (
        <div role="group">
          {children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              statuses={statuses}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface ProjectExplorerHandle {
  reload: () => void;
}

export function ProjectExplorer({
  projectId,
  tree,
  selectedPath,
  statuses = new Map(),
  loading,
  error,
  filter,
  onFilterChange,
  onSelect,
  onReload,
}: {
  projectId: string;
  tree: FileTreeNode[];
  selectedPath: string | null;
  statuses?: Map<string, FileChangeStatus>;
  loading: boolean;
  error: string | null;
  filter: string;
  onFilterChange: (q: string) => void;
  onSelect: (node: { id: string; path: string }) => void;
  onReload: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current || tree.length === 0) return;
    initRef.current = true;
    setExpanded(new Set(tree.filter((n) => n.type === 'folder' && n.children != null).map((n) => n.path)));
  }, [tree]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tree;
    const out: FileTreeNode[] = [];
    const walk = (nodes: FileTreeNode[], target: FileTreeNode[]): boolean => {
      let any = false;
      for (const node of nodes) {
        const self = node.path.toLowerCase().includes(q);
        if (self) {
          target.push(node);
          any = true;
          continue;
        }
        if (node.type === 'folder' && (node.children?.length ?? 0) > 0) {
          const bucket: FileTreeNode[] = [];
          const found = walk(node.children ?? [], bucket);
          if (found) {
            target.push({ ...node, children: bucket });
            any = true;
          }
        }
      }
      return any;
    };
    walk(tree, out);
    return out;
  }, [tree, filter]);

  return (
    <div className="cc-card wb-explorer" data-testid="project-explorer">
      <div className="wb-explorer__head">
        <span className="wb-explorer__title">Explorer</span>
        <div className="wb-explorer__tools">
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onReload} disabled={loading} aria-label="Reload files">
            ↻
          </button>
        </div>
      </div>
      <input
        className="cc-input cc-input--sm"
        type="search"
        placeholder="Filter files…"
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        aria-label="Filter files"
      />
      <div className="wb-explorer__body">
        {loading && !tree.length && <p className="cc-hint">Loading files…</p>}
        {!loading && error && <p className="cc-hint cc-hint--error" data-testid="explorer-error">{error}</p>}
        {!loading && !error && visible.length === 0 && <p className="cc-hint">No files in this project.</p>}
        {!loading && !error && visible.length > 0 && (
          <div>
            {visible.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                statuses={statuses}
                expanded={expanded}
                onToggle={(p) =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(p)) next.delete(p);
                    else next.add(p);
                    return next;
                  })
                }
                onSelect={(n) => {
                  if (n.file) onSelect({ id: n.file.id, path: n.path });
                  else onSelect({ id: '', path: n.path });
                }}
              />
            ))}
          </div>
        )}
      </div>
      <span className="cc-hint wb-explorer__foot" style={{ fontSize: 11 }}>
        {projectId.slice(0, 8)}… · real file tree
      </span>
    </div>
  );
}
/**
 * CodeConClave — command palette (Cmd/Ctrl+K).
 * 16 static commands, every one performing a real action: navigate to a
 * workspace, open a real tab, or persist a real server preference. Dynamic
 * "Jump to project" items come from the live projects list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { currentTheme, persistTheme } from '../lib/theme';
import type { Project } from '../lib/types';

interface PaletteItem {
  id: string;
  icon: string;
  label: string;
  hint: string;
  keywords: string;
  run: () => void;
}

const NAV_COMMANDS: { id: string; icon: string; label: string; hint: string; keywords: string; to: string }[] = [
  { id: 'new-chat', icon: '✦', label: 'New Chat', hint: 'Open the Chat workspace', keywords: 'chat message conversation', to: '/chat' },
  { id: 'new-project', icon: '▣', label: 'New Project', hint: 'Open Projects and create', keywords: 'project create', to: '/projects?new=1' },
  { id: 'open-project', icon: '▣', label: 'Open Project', hint: 'Open the Projects workspace', keywords: 'project', to: '/projects' },
  { id: 'open-terminal', icon: '❯', label: 'Open Local Terminal', hint: 'Open the Local Terminal workspace', keywords: 'terminal shell agent', to: '/terminal' },
  { id: 'load-dna', icon: '⚬', label: 'Load DNA', hint: 'Open the DNA workspace', keywords: 'dna knowledge load', to: '/dna' },
  { id: 'search-files', icon: '▤', label: 'Search Files', hint: 'Open Files and search', keywords: 'file search', to: '/files' },
  { id: 'search-memory', icon: '◈', label: 'Search Memory', hint: 'Open Memory and search', keywords: 'memory search', to: '/memory' },
  { id: 'start-cowork', icon: '☷', label: 'Start Cowork', hint: 'Open Chat in Cowork mode', keywords: 'cowork brief task', to: '/chat?mode=cowork' },
  { id: 'start-task', icon: '◉', label: 'Start 24/7 Task', hint: 'Open the 24/7 Work queue', keywords: 'task work dispatch', to: '/work' },
  { id: 'open-approvals', icon: '✓', label: 'Open Approvals', hint: 'Review pending approvals', keywords: 'approve approval review', to: '/approvals' },
  { id: 'open-billing', icon: '₹', label: 'Open Billing', hint: 'Manage your plan and payments', keywords: 'billing plan payment upgrade', to: '/settings?tab=billing' },
  { id: 'open-plugins', icon: '⌬', label: 'Open Plugins', hint: 'Manage plugin connections', keywords: 'plugins connect github', to: '/plugins' },
  { id: 'open-remote', icon: '⇄', label: 'Open Remote Control', hint: 'Pair and control local agents', keywords: 'remote agent control', to: '/remote' },
  { id: 'open-settings', icon: '⚙', label: 'Open Settings', hint: 'Profile, security, devices', keywords: 'settings profile security', to: '/settings' },
];

export function CommandPalette({ onToggleFocus }: { onToggleFocus: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const projectsLoadedRef = useRef(false);

  const loadProjects = useCallback(() => {
    if (projectsLoadedRef.current) return;
    projectsLoadedRef.current = true;
    void api<{ projects: Project[] }>('/api/v1/projects')
      .then((res) =>
        setProjects(res.projects.filter((p) => p.deleted_at === null && p.status !== 'ARCHIVED').slice(0, 5)),
      )
      .catch(() => undefined);
  }, []);

  const toggleTheme = useCallback(async () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try {
      await persistTheme(next);
    } catch {
      /* keep previous theme */
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => {
          if (!o) loadProjects();
          return !o;
        });
      }
    };
    const onOpen = () => {
      loadProjects();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('cc:open-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('cc:open-palette', onOpen);
    };
  }, [loadProjects]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const staticItems: PaletteItem[] = [
      ...NAV_COMMANDS.map((c) => ({ ...c, run: () => navigate(c.to) })),
      { id: 'toggle-theme', icon: '◐', label: 'Toggle Theme', hint: 'Switch light/dark (saved on server)', keywords: 'theme dark light appearance', run: () => void toggleTheme() },
      { id: 'focus-mode', icon: '▤', label: 'Toggle Focus Mode', hint: 'Collapse or expand the sidebar', keywords: 'focus sidebar collapse', run: onToggleFocus },
    ];
    const q = query.trim().toLowerCase();
    const filtered = q ? staticItems.filter((i) => i.label.toLowerCase().includes(q) || i.keywords.includes(q)) : staticItems;
    const jump: PaletteItem[] = projects.map((p) => ({
      id: `jump-${p.id}`,
      icon: '▣',
      label: p.name,
      hint: 'Jump to project',
      keywords: 'project',
      run: () => navigate(`/projects?focus=${encodeURIComponent(p.id)}`),
    }));
    return [...filtered, ...(q ? [] : jump)];
  }, [query, projects, navigate, toggleTheme, onToggleFocus]);

  useEffect(() => {
    setIndex(0);
  }, [query, items.length]);

  if (!open) return null;

  const runAt = (i: number) => {
    const item = items[i];
    if (!item) return;
    setOpen(false);
    item.run();
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(index);
    }
  };

  return (
    <div
      className="cc-palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="cc-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="cc-palette__input"
          placeholder="Type a command or search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          aria-label="Command palette"
        />
        <div className="cc-palette__list">
          {items.length === 0 && <div className="cc-palette__empty">No matching command.</div>}
          {items.map((item, i) => (
            <button
              key={item.id}
              className={`cc-palette__item${i === index ? ' highlight' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => runAt(i)}
            >
              <span className="cc-palette__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              <span className="cc-palette__hint">{item.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
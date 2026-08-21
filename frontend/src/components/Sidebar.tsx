/**
 * CodeConClave — canonical 18-item sidebar (frozen spec order).
 * Chat/Cowork is a mode switch inside the Chat workspace, not an item here.
 * Model selection lives in the chat composer, not here.
 */
import { NavLink } from 'react-router-dom';
import { Moon } from './Moon';
import { useAuth } from '../auth/AuthProvider';
import type { User } from '../lib/types';

const SECTIONS: { label: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/home', label: 'Home', icon: '⌂' },
      { to: '/chat', label: 'Chat', icon: '✦' },
      { to: '/projects', label: 'Projects', icon: '▣' },
      { to: '/agents', label: 'Agents', icon: '⚡' },
      { to: '/memory', label: 'Memory', icon: '◈' },
      { to: '/dna', label: 'DNA Load', icon: '⚬' },
      { to: '/files', label: 'Files', icon: '▤' },
      { to: '/terminal', label: 'Local Terminal', icon: '❯' },
    ],
  },
  {
    label: 'Execution',
    items: [
      { to: '/work', label: '24/7 Work', icon: '◉' },
      { to: '/automation', label: 'Automation', icon: '⏱' },
      { to: '/workspace', label: 'Workspace', icon: '◧' },
      { to: '/coworkers', label: 'Coworkers', icon: '☷' },
      { to: '/teams', label: 'Teams', icon: '⧉' },
      { to: '/plugins', label: 'Plugins', icon: '⌬' },
      { to: '/control', label: 'Control Plane', icon: '⛉' },
      { to: '/remote', label: 'Remote Control', icon: '⇄' },
      { to: '/ideas', label: 'Ideas', icon: '✎' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/data', label: 'Data Centre', icon: '▦' },
      { to: '/recovery', label: 'Recovery', icon: '↩' },
      { to: '/trash', label: 'Gain Trash', icon: '⌫' },
      { to: '/history', label: 'History', icon: '↺' },
      { to: '/settings', label: 'Settings', icon: '⚙' },
      { to: '/approvals', label: 'Approvals', icon: '✓' },
    ],
  },
];

export function Sidebar({ user }: { user: User }) {
  return (
    <aside className="cc-sidebar">
      <div className="cc-sidebar__brand">
        <span className="cc-logo" aria-hidden="true">
          C
        </span>
        CodeConClave
      </div>
      <nav className="cc-sidebar__nav" aria-label="Workspace navigation">
        {SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="cc-sidebar__section">{section.label}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `cc-sidebar__item${isActive ? ' active' : ''}`}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="cc-sidebar__foot">
        <Moon name={user.displayName} size="sm" />
        <span style={{ marginLeft: 8 }}>{user.displayName ?? user.email}</span>
      </div>
    </aside>
  );
}
/**
 * CodeConClave — keyboard shortcuts help overlay (opened with "?").
 * Lists the canonical shortcuts; reuses existing command registry surfaces
 * (Command Palette on Ctrl/Cmd+K, Escape to stop).
 */
const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Ctrl/Cmd + K', what: 'Open command palette' },
  { keys: 'Ctrl/Cmd + Shift + O', what: 'New chat' },
  { keys: 'Enter', what: 'Send message' },
  { keys: 'Shift + Enter', what: 'New line' },
  { keys: 'Esc', what: 'Stop the active reply' },
  { keys: 'Ctrl/Cmd + Shift + .', what: 'Stop everything (tasks, laptop actions, schedules)' },
  { keys: 'Ctrl/Cmd + /', what: 'Show this shortcut list' },
  { keys: 'Ctrl/Cmd + B', what: 'Open or close the sidebar' },
  { keys: '?', what: 'Show this shortcut list (in chat)' },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="cc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cc-card" style={{ width: 380, maxWidth: '90vw' }}>
        <h2 style={{ margin: '0 0 10px' }}>Keyboard shortcuts</h2>
        {SHORTCUTS.map((s) => (
          <div key={s.keys} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span className="cc-hint">{s.what}</span>
            <kbd className="cc-kbd">{s.keys}</kbd>
          </div>
        ))}
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button className="cc-btn cc-btn--sm" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
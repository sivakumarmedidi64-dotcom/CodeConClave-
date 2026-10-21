/**
 * App-wide keyboard shortcuts (the list lives in ShortcutsHelp):
 *   Ctrl/Cmd + Shift + O   new chat (Home composer)
 *   Ctrl/Cmd + Shift + .   Stop everything
 *   Ctrl/Cmd + /           show all shortcuts
 *   Ctrl/Cmd + B           open/close the sidebar
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShortcutsHelp } from './ShortcutsHelp';
import { STOP_EVERYTHING } from './EmergencyStop';
import { TOGGLE_SIDEBAR } from '../lib/appEvents';

export function GlobalShortcuts() {
  const navigate = useNavigate();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        navigate('/home');
        window.setTimeout(() => (document.querySelector('[aria-label="Message CodeConClave"]') as HTMLElement | null)?.focus(), 50);
      } else if (e.shiftKey && (e.key === '.' || e.key === '>')) {
        e.preventDefault();
        window.dispatchEvent(new Event(STOP_EVERYTHING));
      } else if (!e.shiftKey && e.key === '/') {
        e.preventDefault();
        setHelp((v) => !v);
      } else if (!e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        // Rich-text editors keep Ctrl+B for bold.
        if ((e.target as HTMLElement | null)?.isContentEditable) return;
        e.preventDefault();
        window.dispatchEvent(new Event(TOGGLE_SIDEBAR));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return help ? <ShortcutsHelp onClose={() => setHelp(false)} /> : null;
}

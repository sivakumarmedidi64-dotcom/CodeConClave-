/**
 * Workspace preferences (server-authoritative, /api/v1/workspace/preferences).
 * One shared in-flight read so many components can ask without N requests;
 * `savePrefs` merges on the server and refreshes the shared copy.
 */
import { useEffect, useState } from 'react';
import { api } from './api';

export type Prefs = Record<string, unknown>;

export const PREFS_CHANGED = 'cc:prefs-changed';

let cached: Promise<Prefs> | null = null;

export function loadPrefs(force = false): Promise<Prefs> {
  if (!cached || force) {
    cached = api<{ prefs: Prefs }>('/api/v1/workspace/preferences')
      .then((res) => res?.prefs ?? {})
      .catch(() => {
        cached = null;
        return {};
      });
  }
  return cached;
}

export async function savePrefs(patch: Prefs): Promise<Prefs> {
  const res = await api<{ prefs: Prefs }>('/api/v1/workspace/preferences', { method: 'PUT', body: { prefs: patch } });
  const prefs = res?.prefs ?? {};
  cached = Promise.resolve(prefs);
  window.dispatchEvent(new Event(PREFS_CHANGED));
  return prefs;
}

/** Reactive read of one preference (undefined until loaded). */
export function usePref<T = unknown>(key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void loadPrefs().then((p) => {
        if (alive) setValue(p[key] as T | undefined);
      });
    read();
    window.addEventListener(PREFS_CHANGED, read);
    return () => {
      alive = false;
      window.removeEventListener(PREFS_CHANGED, read);
    };
  }, [key]);
  return value;
}

/** Test seam. */
export function _resetPrefsCache(): void {
  cached = null;
}

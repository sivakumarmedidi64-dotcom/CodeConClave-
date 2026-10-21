/**
 * Incognito toggle for NEW chats (like a private window): kept for this tab
 * only (sessionStorage), shared by every composer through a window event.
 * The server is the authority — a conversation is incognito because it was
 * created that way, and then it is never listed, never feeds memory, and is
 * deleted after it sits idle (INCOGNITO_RETENTION_HOURS, default 24).
 */
import { useEffect, useState } from 'react';

const KEY = 'cc-incognito';
const EVENT = 'cc:incognito-changed';

export function isIncognito(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setIncognito(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the in-memory event still updates this tab */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

export function useIncognito(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(isIncognito);
  useEffect(() => {
    const sync = (e: Event) => setOn(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return [on, setIncognito];
}

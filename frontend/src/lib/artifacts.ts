/**
 * Artifact store: one open artifact at a time (like Claude). A code block
 * opens it with its own instance id and keeps pushing updates while the
 * answer streams, so the preview builds live in front of the user.
 */
import { useSyncExternalStore } from 'react';

export interface Artifact {
  /** Owning code-block instance (stable across re-renders while streaming). */
  ownerId: string;
  language: string;
  code: string;
  title: string;
}

let current: Artifact | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const artifactStore = {
  get: () => current,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  open(a: Artifact) {
    current = a;
    emit();
  },
  /** Live update from the owning block; ignored if another artifact is open. */
  update(ownerId: string, code: string) {
    if (current && current.ownerId === ownerId && current.code !== code) {
      current = { ...current, code };
      emit();
    }
  },
  close() {
    current = null;
    emit();
  },
};

export function useArtifact(): Artifact | null {
  return useSyncExternalStore(artifactStore.subscribe, artifactStore.get, artifactStore.get);
}

const PREVIEWABLE = new Set(['html', 'htm', 'svg', 'xml']);

/** Can this block render as a live preview? */
export function isPreviewable(language: string, code: string): boolean {
  const lang = language.toLowerCase();
  if (PREVIEWABLE.has(lang)) return true;
  return /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(code);
}

/** A whole HTML document (vs. a fragment): worth opening automatically. */
export function isHtmlDocument(code: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(code);
}

/** Title from <title> or the first heading, else the language. */
export function artifactTitle(language: string, code: string): string {
  const t = /<title>([^<]{1,80})<\/title>/i.exec(code)?.[1] ?? /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(code)?.[1];
  return (t ?? `${(language || 'html').toUpperCase()} preview`).trim();
}

/** srcdoc for the sandboxed iframe; SVG fragments are centred on a page. */
export function previewDocument(language: string, code: string): string {
  if (language.toLowerCase() === 'svg' || /^\s*<svg[\s>]/i.test(code)) {
    return `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${code}</body>`;
  }
  return code;
}

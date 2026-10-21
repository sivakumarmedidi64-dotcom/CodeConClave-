/**
 * Artifact side panel (Claude-style). Preview renders in a sandboxed iframe
 * with scripts allowed but NO same-origin access, so generated code can run
 * without touching the app, its cookies or its API. Code view, copy,
 * download and open-in-new-tab. Updates live while the answer streams.
 */
import { useEffect, useMemo, useState } from 'react';
import { artifactStore, previewDocument, useArtifact } from '../lib/artifacts';
import { Icon } from './Icon';

export function ArtifactPanel() {
  const artifact = useArtifact();
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);
  // Preview is a sandboxed blob: URL (opaque origin — no app cookies/API).
  // Blob URLs render in more embedded browsers than srcdoc. Debounced so a
  // streaming answer doesn't reload the frame on every token.
  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!artifact) return;
    let url: string | null = null;
    const id = window.setTimeout(() => {
      url = URL.createObjectURL(new Blob([previewDocument(artifact.language, artifact.code)], { type: 'text/html' }));
      setFrameUrl(url);
    }, 250);
    return () => {
      window.clearTimeout(id);
      if (url) window.setTimeout(() => URL.revokeObjectURL(url as string), 1000);
    };
  }, [artifact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') artifactStore.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ext = useMemo(() => {
    const l = (artifact?.language ?? '').toLowerCase();
    return l === 'svg' ? 'svg' : l && l !== 'html' && l !== 'htm' ? l : 'html';
  }, [artifact]);

  if (!artifact) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const blobUrl = () => URL.createObjectURL(new Blob([artifact.code], { type: ext === 'svg' ? 'image/svg+xml' : 'text/html' }));

  const download = () => {
    const url = blobUrl();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'artifact'}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="cc-artifact" aria-label={`Artifact: ${artifact.title}`}>
      <header className="cc-artifact__head">
        <Icon name="panel-right" size={16} className="cc-artifact__icon" />
        <strong className="cc-artifact__title" title={artifact.title}>
          {artifact.title}
        </strong>
        <div className="cc-toggle cc-artifact__tabs" role="tablist" aria-label="Artifact view">
          <button type="button" role="tab" aria-selected={view === 'preview'} className={view === 'preview' ? 'on' : ''} onClick={() => setView('preview')}>
            Preview
          </button>
          <button type="button" role="tab" aria-selected={view === 'code'} className={view === 'code' ? 'on' : ''} onClick={() => setView('code')}>
            Code
          </button>
        </div>
        <button type="button" className="cc-msg-icon-btn" aria-label={copied ? 'Copied' : 'Copy artifact code'} title={copied ? 'Copied' : 'Copy'} onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={15} className="cc-msg-icon" />
        </button>
        <button type="button" className="cc-msg-icon-btn" aria-label="Download artifact" title="Download" onClick={download}>
          <Icon name="download" size={15} className="cc-msg-icon" />
        </button>
        <button type="button" className="cc-msg-icon-btn" aria-label="Open in new tab" title="Open in new tab" onClick={() => window.open(blobUrl(), '_blank', 'noopener')}>
          <Icon name="external" size={15} className="cc-msg-icon" />
        </button>
        <button type="button" className="cc-msg-icon-btn" aria-label="Close artifact" title="Close (Esc)" onClick={() => artifactStore.close()}>
          <Icon name="close" size={15} className="cc-msg-icon" />
        </button>
      </header>
      <div className="cc-artifact__body">
        {view === 'preview' ? (
          <iframe
            className="cc-artifact__frame"
            title={`${artifact.title} preview`}
            sandbox="allow-scripts allow-forms allow-modals"
            src={frameUrl ?? 'about:blank'}
          />
        ) : (
          <pre className="cc-artifact__code">
            <code>{artifact.code}</code>
          </pre>
        )}
      </div>
    </aside>
  );
}

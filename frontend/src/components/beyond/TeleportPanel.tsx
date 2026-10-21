/**
 * Teleport panel — pack a whole project (files + project memories) into one
 * sealed .ccteleport file, and bring one back in. Every file carries its
 * SHA-256 and the whole bundle is signed, so a changed byte is refused.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { Icon } from '../Icon';
import { errMessage, postBundle } from './shared';

interface Verified {
  name: string;
  createdAt: string;
  fileCount: number;
  memoryCount: number;
  signedHere: boolean;
}

interface Imported {
  projectId: string;
  name: string;
  fileCount: number;
  memoryCount: number;
  signedHere: boolean;
  skipped: string[];
}

/** filename="x.ccteleport" from a Content-Disposition header. Pure. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  const m = disposition?.match(/filename="([^"]+)"/);
  return m?.[1] ?? fallback;
}

export function TeleportPanel({ projectId, projectName, onImported }: { projectId: string; projectName: string; onImported?: (projectId: string) => void }) {
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ files: number; memories: number; filename: string } | null>(null);
  const [bundle, setBundle] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [imported, setImported] = useState<Imported | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const exportNow = async () => {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/beyond/projects/${encodeURIComponent(projectId)}/teleport`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
        throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `Export failed (${res.status})`, body?.error?.details);
      }
      const blob = await res.blob();
      const filename = filenameFrom(res.headers.get('Content-Disposition'), 'project.ccteleport');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExported({ files: Number(res.headers.get('X-Teleport-Files') ?? 0), memories: Number(res.headers.get('X-Teleport-Memories') ?? 0), filename });
    } catch (err) {
      setError(errMessage(err, 'Could not pack the project.'));
    } finally {
      setExporting(false);
    }
  };

  const pick = async (file: File | undefined) => {
    setVerified(null);
    setImported(null);
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      setBundle({ name: file.name, bytes });
      setVerified(await postBundle<Verified>('/api/v1/beyond/teleport/verify', bytes));
    } catch (err) {
      setError(errMessage(err, 'This file could not be checked.'));
    } finally {
      setBusy(false);
    }
  };

  const importNow = async () => {
    if (!bundle) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postBundle<{ imported: Imported }>('/api/v1/beyond/teleport/import', bundle.bytes);
      setImported(res.imported);
      onImported?.(res.imported.projectId);
      setBundle(null);
      setVerified(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError(errMessage(err, 'The import did not finish.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bx-panel" aria-label="Teleport">
      <header className="bx-panel__head">
        <div>
          <h2>Teleport</h2>
          <p className="cc-hint">
            Pack a whole project — files and project memories — into one sealed file, and bring it back on another account or server. Every file carries its fingerprint and the bundle is signed, so a single changed byte is refused.
          </p>
        </div>
      </header>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
      <div className="bx-cols">
        <div className="bx-card">
          <h3 className="bx-sub">Send</h3>
          <p className="cc-hint">
            Pack <strong>{projectName}</strong> as a <code className="cc-md-code">.ccteleport</code> file.
          </p>
          <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={exporting} onClick={() => void exportNow()}>
            <Icon name="download" size={13} /> {exporting ? 'Packing…' : 'Download sealed bundle'}
          </button>
          {exported && (
            <p className="cc-hint" role="status" data-testid="teleport-exported">
              Sealed {exported.files} file{exported.files === 1 ? '' : 's'} and {exported.memories} memor{exported.memories === 1 ? 'y' : 'ies'} into {exported.filename}.
            </p>
          )}
        </div>
        <div className="bx-card">
          <h3 className="bx-sub">Receive</h3>
          <p className="cc-hint">Pick a .ccteleport file. It is checked before anything is created.</p>
          <input ref={inputRef} type="file" accept=".ccteleport,application/octet-stream" aria-label="Teleport bundle" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
          {busy && !verified && <p className="cc-hint">Checking…</p>}
          {verified && (
            <div className="bx-verified" data-testid="teleport-verified">
              <p>
                <Icon name="shield-check" size={14} /> <strong>Intact.</strong> “{verified.name}” · {verified.fileCount} files · {verified.memoryCount} memories · packed {new Date(verified.createdAt).toLocaleString()}
              </p>
              <p className="cc-hint">
                {verified.signedHere
                  ? 'Sealed by this CodeConClave server.'
                  : 'Sealed by a different CodeConClave server: every file matches its fingerprint, but where it came from cannot be confirmed here. Import only if you trust who sent it.'}
              </p>
              <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={busy} onClick={() => void importNow()}>
                {busy ? 'Importing…' : 'Import as a new project'}
              </button>
            </div>
          )}
          {imported && (
            <div className="bx-verified" role="status" data-testid="teleport-imported">
              <p>
                Created <strong>{imported.name}</strong> with {imported.fileCount} files and {imported.memoryCount} memories.
              </p>
              {imported.skipped.length > 0 && (
                <details>
                  <summary>{imported.skipped.length} item(s) not imported</summary>
                  <ul className="bx-list bx-list--tight">
                    {imported.skipped.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
              <Link className="cc-btn cc-btn--ghost cc-btn--sm" to={`/projects?focus=${encodeURIComponent(imported.projectId)}`}>
                Open the project
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

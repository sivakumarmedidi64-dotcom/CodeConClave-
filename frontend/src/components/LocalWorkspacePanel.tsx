/**
 * CodeConClave — Local Workspace cockpit (P2).
 *
 * Drives REAL files and terminal commands on an authenticated paired device
 * through the local-workspace bridge (/api/v1/local-workspace). Every operation
 * is authorized server-side, then executed and scope-checked by the Local Agent
 * on the device. Nothing is fabricated: offline devices, policy denials and
 * command failures are shown exactly as the device reports them.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface DeviceRow {
  id: string;
  name: string;
  state: string;
  presence: string;
  capabilities: string[];
}

interface Workspace {
  root: string;
  name: string;
  capabilities: string[];
}

interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  sizeBytes: number;
  modifiedAt: string;
}

interface OpenFile {
  path: string;
  content: string;
  sha256: string;
  sizeBytes: number;
}

interface ExecResult {
  output: string;
  payload: { exitCode?: number; status?: string } | null;
}

interface HistoryRow {
  label: string;
  ok: boolean;
}

function msg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

function isDenied(e: unknown): boolean {
  return e instanceof ApiError && (e.code === 'local_action_denied' || e.code === 'local_scope_denied');
}

export function LocalWorkspacePanel({ projectId }: { projectId: string }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [root, setRoot] = useState('');
  const [dirPath, setDirPath] = useState('');
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [draft, setDraft] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [exec, setExec] = useState<ExecResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const selectedDevice = devices.find((d) => d.id === deviceId) ?? null;
  const online = selectedDevice?.presence === 'ONLINE';

  const record = useCallback((label: string, ok: boolean) => {
    setHistory((h) => [{ label, ok }, ...h].slice(0, 30));
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const res = await api<{ devices: DeviceRow[] }>('/api/v1/local-workspace/devices');
      const list = res.devices ?? [];
      setDevices(list);
      const firstOnline = list.find((d) => d.presence === 'ONLINE') ?? list[0];
      if (firstOnline) setDeviceId((cur) => cur || firstOnline.id);
    } catch (e) {
      setError(msg(e, 'Could not load paired devices'));
    }
  }, []);

  const loadWorkspaces = useCallback(async (id: string) => {
    setWorkspaces([]);
    setRoot('');
    setDirPath('');
    setEntries([]);
    setFile(null);
    if (!id) return;
    try {
      setError(null);
      const res = await api<{ workspaces: Workspace[] }>(`/api/v1/local-workspace/workspaces?deviceId=${encodeURIComponent(id)}`);
      setWorkspaces(res.workspaces ?? []);
    } catch (e) {
      if (isDenied(e)) setDenied(msg(e, 'outside the granted scope'));
      else setError(msg(e, 'Could not list workspaces on this device'));
    }
  }, []);

  const browse = useCallback(
    async (path: string) => {
      try {
        setError(null);
        const res = await api<{ root: string; entries: TreeEntry[] }>(
          `/api/v1/local-workspace/tree?deviceId=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(path)}`,
        );
        setDirPath(path);
        setEntries(res.entries ?? []);
      } catch (e) {
        if (isDenied(e)) setDenied(msg(e, 'outside the granted scope'));
        else setError(msg(e, 'Could not browse this directory'));
      }
    },
    [deviceId],
  );

  const openFile = useCallback(
    async (path: string) => {
      try {
        setError(null);
        setDenied(null);
        const res = await api<{ metadata: Record<string, unknown>; file: { content: string; sha256: string; sizeBytes: number } }>(
          `/api/v1/local-workspace/file?deviceId=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(path)}`,
        );
        setFile({
          path,
          content: String(res.file?.content ?? ''),
          sha256: String(res.file?.sha256 ?? ''),
          sizeBytes: Number(res.file?.sizeBytes ?? 0),
        });
        setDraft(String(res.file?.content ?? ''));
        setDiff(null);
        record(`read ${path}`, true);
      } catch (e) {
        if (isDenied(e)) {
          setDenied(msg(e, 'outside the granted scope'));
          record(`read ${path}`, false);
        } else {
          setError(msg(e, 'Could not read this file'));
        }
      }
    },
    [deviceId, record],
  );

  const save = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setDenied(null);
    try {
      const res = await api<{ diff: string; afterHash?: string }>('/api/v1/local-workspace/file', {
        method: 'PUT',
        body: { deviceId, path: file.path, content: draft },
      });
      setDiff(res.diff ?? '');
      setFile((f) => (f ? { ...f, content: draft, sha256: String(res.afterHash ?? f.sha256) } : f));
      record(`saved ${file.path}`, true);
    } catch (e) {
      if (isDenied(e)) {
        setDenied(msg(e, 'write not granted on this workspace'));
        record(`save ${file.path}`, false);
      } else {
        setError(msg(e, 'Could not save this file'));
      }
    } finally {
      setBusy(false);
    }
  }, [deviceId, draft, file, record]);

  const run = useCallback(async () => {
    if (!command.trim()) return;
    setBusy(true);
    setError(null);
    setDenied(null);
    setExec(null);
    try {
      const res = await api<ExecResult>('/api/v1/local-workspace/exec', {
        method: 'POST',
        body: { deviceId, command, cwd: dirPath || root || undefined },
      });
      setExec(res);
      record(`$ ${command}`, true);
    } catch (e) {
      if (isDenied(e)) {
        setDenied(msg(e, 'the device command policy denied this command'));
        record(`$ ${command}`, false);
      } else {
        setError(msg(e, 'Command could not be delivered to the device'));
      }
    } finally {
      setBusy(false);
    }
  }, [command, deviceId, dirPath, root, record]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (deviceId) void loadWorkspaces(deviceId);
  }, [deviceId, loadWorkspaces]);

  return (
    <div data-testid="local-workspace" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Local Workspace</h2>
        <span className="text-[10px] text-gray-500">project {projectId}</span>
      </div>

      <section className="rounded border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-600">Paired device:</label>
          <select
            data-testid="lws-device"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className="rounded border px-2 py-1 text-xs"
          >
            <option value="">Select a device…</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.state})
              </option>
            ))}
          </select>
          <span
            data-testid="lws-presence"
            className={`rounded px-2 py-0.5 text-xs font-semibold ${online ? 'bg-green-600 text-white' : 'bg-gray-500 text-white'}`}
          >
            {selectedDevice ? selectedDevice.presence : 'NO DEVICE'}
          </span>
        </div>
        {devices.length === 0 && <p data-testid="lws-no-devices" className="mt-1 text-xs text-gray-500">No paired device found. Pair the Local Agent first.</p>}
      </section>

      {selectedDevice && !online && (
        <p data-testid="lws-offline" className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          This device is {selectedDevice.presence}. Start the Local Agent and retry — no local action can run until it is online.
        </p>
      )}

      {online && (
        <>
          <section className="rounded border p-3 text-sm">
            <label className="block text-xs text-gray-600">
              Authorized workspace root:
              <select
                data-testid="lws-workspace"
                value={root}
                onChange={(e) => {
                  setRoot(e.target.value);
                  void browse(e.target.value);
                }}
                className="mt-1 w-full rounded border px-2 py-1 text-xs"
              >
                <option value="">Select a workspace…</option>
                {workspaces.map((w) => (
                  <option key={w.root} value={w.root}>
                    {w.name} — {w.root} [{w.capabilities.join(', ')}]
                  </option>
                ))}
              </select>
            </label>
            {workspaces.length === 0 && <p data-testid="lws-no-workspaces" className="mt-1 text-xs text-gray-500">No workspace granted on this device.</p>}
          </section>

          {root && (
            <section className="rounded border p-3 text-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Browse</h3>
                <span data-testid="lws-dir" className="font-mono text-[10px] text-gray-500">{dirPath || root}</span>
              </div>
              <ul className="mt-2 max-h-56 overflow-auto">
                {entries.map((entry) => (
                  <li key={entry.path} data-testid="lws-entry" className="flex items-center gap-2 border-b py-1 text-xs">
                    <button
                      type="button"
                      className="font-mono hover:underline"
                      onClick={() => (entry.type === 'dir' ? void browse(entry.path) : void openFile(entry.path))}
                    >
                      {entry.type === 'dir' ? '[dir]' : '[file]'} {entry.name}
                    </button>
                    <span className="ml-auto text-gray-400">{entry.type === 'file' ? `${entry.sizeBytes} B` : entry.type}</span>
                  </li>
                ))}
                {entries.length === 0 && <li className="py-1 text-xs text-gray-500">Empty directory.</li>}
              </ul>
            </section>
          )}

          {file && (
            <section data-testid="lws-file" className="rounded border p-3 text-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-sm">{file.path}</h3>
                <span className="text-[10px] text-gray-500">sha {file.sha256.slice(0, 12)} · {file.sizeBytes} B</span>
              </div>
              <textarea
                data-testid="lws-editor"
                className="mt-2 w-full rounded border p-2 font-mono text-xs"
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  data-testid="lws-save"
                  className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                  disabled={busy || draft === file.content}
                  onClick={() => void save()}
                >
                  Save (real diff + apply)
                </button>
                <span data-testid="lws-dirty" className="text-xs text-gray-500">{draft === file.content ? 'no changes' : 'unsaved changes'}</span>
              </div>
              {diff !== null && (
                <pre data-testid="lws-diff" className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-2 text-xs text-green-100">
                  {diff || '(no textual diff — content unchanged)'}
                </pre>
              )}
            </section>
          )}

          <section className="rounded border p-3 text-sm">
            <label className="block text-xs text-gray-600">
              Command (authorized through the device's own policy):
              <div className="mt-1 flex gap-2">
                <input
                  data-testid="lws-command"
                  className="w-full rounded border px-2 py-1 font-mono text-xs"
                  placeholder="e.g. npm test"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void run();
                  }}
                />
                <button
                  data-testid="lws-run"
                  className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                  disabled={busy || !command.trim()}
                  onClick={() => void run()}
                >
                  Run
                </button>
              </div>
            </label>
            {exec && (
              <div className="mt-2">
                <div data-testid="lws-exec-meta" className="text-xs text-gray-600">
                  exit {exec.payload?.exitCode ?? '—'}
                  {exec.payload?.status ? ` · ${exec.payload.status}` : ''}
                </div>
                <pre data-testid="lws-output" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-2 text-xs text-green-100">
                  {exec.output || '(no output)'}
                </pre>
              </div>
            )}
          </section>
        </>
      )}

      {denied && (
        <p data-testid="lws-denied" className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          Denied by policy: {denied}. Nothing was executed on your machine.
        </p>
      )}
      {error && <p data-testid="lws-error" className="text-sm text-red-600">{error}</p>}

      {history.length > 0 && (
        <section data-testid="lws-history" className="rounded border p-3 text-xs">
          <h3 className="text-sm font-medium">This session (recorded in the audit trail)</h3>
          {history.map((h, i) => (
            <div key={i} className="mt-1 border-t py-0.5">
              <span className={h.ok ? 'text-green-700' : 'text-amber-700'}>{h.ok ? 'ok' : 'denied'}</span>{' '}
              <span className="font-mono">{h.label}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Rich answer blocks, Claude-style. The AI writes plain fenced blocks; the
 * chat turns them into real things:
 *   ```chart        {"type":"bar|line|pie","title","labels":[…],"series":[{"name","values":[…]}]}
 *   ```file:<name>  a file the user can download (and preview when it's HTML/SVG)
 *   ```email        "Subject: …" then the body — a draft to copy or open in a mail app
 * Nothing here sends, uploads or executes anything.
 */
import { useId, useMemo, useState } from 'react';
import { artifactStore } from '../lib/artifacts';
import { Icon } from './Icon';
import { CopyButton } from './CopyButton';

// ---------------------------------------------------------------- chart

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
}

const PALETTE = ['#c96442', '#10b8a6', '#1e88ff', '#ff2e9a', '#ff6b0f', '#9b5cff', '#3fb27f', '#ffa20a'];

export function parseChart(src: string): ChartSpec | null {
  try {
    const o = JSON.parse(src) as Partial<ChartSpec>;
    if (!o || !['bar', 'line', 'pie'].includes(String(o.type))) return null;
    if (!Array.isArray(o.labels) || o.labels.length === 0 || o.labels.length > 60) return null;
    if (!Array.isArray(o.series) || o.series.length === 0 || o.series.length > 8) return null;
    const series = o.series.map((s) => ({
      name: String(s?.name ?? ''),
      values: Array.isArray(s?.values) ? s.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)) : [],
    }));
    if (series.some((s) => s.values.length !== o.labels!.length)) return null;
    return { type: o.type as ChartSpec['type'], title: o.title ? String(o.title) : undefined, labels: o.labels.map(String), series, unit: o.unit ? String(o.unit) : undefined };
  } catch {
    return null;
  }
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const fmt = (n: number) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n * 100) / 100}`);

export function ChartBlock({ spec }: { spec: ChartSpec }) {
  const [showData, setShowData] = useState(false);
  const W = 640;
  const H = 300;
  const pad = { l: 48, r: 16, t: 16, b: 48 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const all = spec.series.flatMap((s) => s.values);
  const max = niceMax(Math.max(0, ...all));
  const y = (v: number) => pad.t + ih - (Math.max(0, v) / max) * ih;
  const label = `${spec.title ?? 'Chart'}: ${spec.type} chart of ${spec.series.map((s) => s.name).join(', ')}`;

  let body: React.ReactNode;
  if (spec.type === 'pie') {
    const values = spec.series[0]!.values.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(iw, ih) / 2;
    body = values.map((v, i) => {
      const a0 = angle;
      const a1 = angle + (v / total) * Math.PI * 2;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
      const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
      const mid = (a0 + a1) / 2;
      const d = values.length === 1 ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0` : `M ${cx} ${cy} L ${p0[0]} ${p0[1]} A ${r} ${r} 0 ${large} 1 ${p1[0]} ${p1[1]} Z`;
      return (
        <g key={i}>
          <path d={d} fill={PALETTE[i % PALETTE.length]} stroke="var(--cc-bg, #22211f)" strokeWidth={2}>
            <title>{`${spec.labels[i]}: ${fmt(v)}${spec.unit ?? ''} (${Math.round((v / total) * 100)}%)`}</title>
          </path>
          {v / total >= 0.06 && (
            <text x={cx + r * 0.65 * Math.cos(mid)} y={cy + r * 0.65 * Math.sin(mid)} textAnchor="middle" dominantBaseline="middle" className="rb-chart__pielabel">
              {Math.round((v / total) * 100)}%
            </text>
          )}
        </g>
      );
    });
  } else {
    const n = spec.labels.length;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
    const grid = ticks.map((t) => (
      <g key={t}>
        <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="rb-chart__grid" />
        <text x={pad.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="rb-chart__tick">
          {fmt(t)}
        </text>
      </g>
    ));
    const step = iw / n;
    const xLabels = spec.labels.map((l, i) =>
      n <= 16 || i % Math.ceil(n / 16) === 0 ? (
        <text key={i} x={pad.l + step * i + step / 2} y={H - pad.b + 16} textAnchor="middle" className="rb-chart__tick">
          {l.length > 10 ? `${l.slice(0, 9)}…` : l}
        </text>
      ) : null,
    );
    let marks: React.ReactNode;
    if (spec.type === 'bar') {
      const groupW = step * 0.72;
      const barW = groupW / spec.series.length;
      marks = spec.series.map((s, si) =>
        s.values.map((v, i) => (
          <rect key={`${si}-${i}`} x={pad.l + step * i + (step - groupW) / 2 + barW * si} y={y(v)} width={Math.max(1, barW - 2)} height={pad.t + ih - y(v)} rx={3} fill={PALETTE[si % PALETTE.length]}>
            <title>{`${s.name} · ${spec.labels[i]}: ${fmt(v)}${spec.unit ?? ''}`}</title>
          </rect>
        )),
      );
    } else {
      marks = spec.series.map((s, si) => {
        const pts = s.values.map((v, i) => `${pad.l + step * i + step / 2},${y(v)}`).join(' ');
        return (
          <g key={si}>
            <polyline points={pts} fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2.5} strokeLinejoin="round" />
            {s.values.map((v, i) => (
              <circle key={i} cx={pad.l + step * i + step / 2} cy={y(v)} r={3.5} fill={PALETTE[si % PALETTE.length]}>
                <title>{`${s.name} · ${spec.labels[i]}: ${fmt(v)}${spec.unit ?? ''}`}</title>
              </circle>
            ))}
          </g>
        );
      });
    }
    body = (
      <>
        {grid}
        {marks}
        {xLabels}
      </>
    );
  }

  const legend = spec.type === 'pie' ? spec.labels.map((l, i) => ({ name: l, color: PALETTE[i % PALETTE.length]! })) : spec.series.map((s, i) => ({ name: s.name, color: PALETTE[i % PALETTE.length]! }));
  return (
    <figure className="rb-chart" data-testid="chart-block">
      {spec.title && <figcaption className="rb-chart__title">{spec.title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="rb-chart__svg">
        {body}
      </svg>
      <div className="rb-chart__legend">
        {legend.map((l) => (
          <span key={l.name}>
            <i style={{ background: l.color }} />
            {l.name}
          </span>
        ))}
        <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setShowData((v) => !v)} aria-expanded={showData}>
          {showData ? 'Hide data' : 'Show data'}
        </button>
      </div>
      {showData && (
        <table className="us-table rb-chart__table">
          <thead>
            <tr>
              <th />
              {spec.series.map((s) => (
                <th key={s.name}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.labels.map((l, i) => (
              <tr key={l + i}>
                <td>{l}</td>
                {spec.series.map((s) => (
                  <td key={s.name}>{fmt(s.values[i]!)}{spec.unit ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------- file card

const MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  sql: 'text/plain',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
};

export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'file.txt';
  const clean = base.replace(/[^\w.\- ]+/g, '-').replace(/^\.+/, '').slice(0, 80).trim();
  return clean || 'file.txt';
}

export function FileCard({ name, content }: { name: string; content: string }) {
  const file = safeFileName(name);
  const ext = (file.split('.').pop() ?? '').toLowerCase();
  const ownerId = useId();
  const size = useMemo(() => new Blob([content]).size, [content]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: MIME[ext] ?? 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    URL.revokeObjectURL(url);
  };
  const previewable = ext === 'html' || ext === 'htm' || ext === 'svg';
  return (
    <div className="rb-file" data-testid="file-card">
      <Icon name="file" size={20} />
      <div className="rb-file__meta">
        <strong>{file}</strong>
        <span className="cc-muted">
          {ext.toUpperCase() || 'FILE'} · {size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`} · {content.split('\n').length} lines
        </span>
      </div>
      {previewable && (
        <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => artifactStore.open({ ownerId, language: ext === 'svg' ? 'svg' : 'html', code: content, title: file })}>
          Preview
        </button>
      )}
      <CopyButton text={content} label={`Copy ${file}`} size={13} />
      <button type="button" className="cc-btn cc-btn--sm" onClick={download}>
        <Icon name="download" size={13} /> Download
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- email draft

export interface EmailDraft {
  to?: string;
  cc?: string;
  subject: string;
  body: string;
}

export function parseEmail(src: string): EmailDraft {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const head: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i += 1) {
    const m = /^(To|Cc|Subject):\s*(.*)$/i.exec(lines[i]!);
    if (!m) break;
    head[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  while (i < lines.length && !lines[i]!.trim()) i += 1;
  return { to: head.to, cc: head.cc, subject: head.subject ?? '', body: lines.slice(i).join('\n').trim() };
}

export function mailtoHref(d: EmailDraft): { href: string; truncated: boolean } {
  const q = (body: string) => `mailto:${encodeURIComponent(d.to ?? '')}?subject=${encodeURIComponent(d.subject)}${d.cc ? `&cc=${encodeURIComponent(d.cc)}` : ''}&body=${encodeURIComponent(body)}`;
  const full = q(d.body);
  // Mail apps reject very long mailto links: send the subject and ask to paste the body.
  return full.length <= 1800 ? { href: full, truncated: false } : { href: q('(Paste the draft body from CodeConClave here.)'), truncated: true };
}

export function EmailDraftCard({ src }: { src: string }) {
  const draft = parseEmail(src);
  const { href, truncated } = mailtoHref(draft);
  const full = [draft.to ? `To: ${draft.to}` : '', draft.cc ? `Cc: ${draft.cc}` : '', `Subject: ${draft.subject}`, '', draft.body].filter((l, idx) => l || idx >= 2).join('\n');
  return (
    <div className="rb-email" data-testid="email-draft">
      <div className="rb-email__bar">
        <Icon name="mail" size={14} /> Email draft <span className="cc-muted">· not sent</span>
      </div>
      {draft.to && (
        <div className="rb-email__field">
          <span>To</span>
          {draft.to}
        </div>
      )}
      {draft.cc && (
        <div className="rb-email__field">
          <span>Cc</span>
          {draft.cc}
        </div>
      )}
      <div className="rb-email__field">
        <span>Subject</span>
        <strong>{draft.subject || '(no subject)'}</strong>
      </div>
      <div className="rb-email__body">{draft.body}</div>
      <div className="rb-email__actions">
        <CopyButton text={full} label="Copy email" showLabel size={13} />
        <CopyButton text={draft.body} label="Copy body" showLabel size={13} />
        <a className="cc-btn cc-btn--sm" href={href}>
          <Icon name="external" size={13} /> Open in mail app
        </a>
        {truncated && <span className="cc-hint">Long draft: copy the body, then paste it into the email.</span>}
      </div>
    </div>
  );
}

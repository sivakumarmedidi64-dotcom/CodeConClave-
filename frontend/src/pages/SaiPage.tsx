/**
 * Agent Sai Srinivasa Athreya — the data detective. Shows his full catalog of
 * 140 public data sources (which are live, which are only catalogued) and lets
 * you pull real data from any live one. Every answer shows the source + when it
 * was fetched. Nothing is faked — a source is "live" only if it really returns data.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';

interface SaiSource {
  id: string;
  n: string;
  category: string;
  covers: string;
  access: string;
  priority: 'P1' | 'P2' | 'P3';
  keyless: boolean;
  live: boolean;
}
interface Catalog {
  agent: string;
  total: number;
  liveCount: number;
  categories: number;
  sources: SaiSource[];
}
interface Evidence {
  sourceId: string;
  source: string;
  query: string;
  summary: string;
  data: unknown;
  sourceUrl: string;
  fetchedAt: string;
}

const PLACEHOLDERS: Record<string, string> = {
  'usgs-earthquakes': 'min magnitude, e.g. 5',
  'india-post-pincode': 'a PIN code, e.g. 500001',
  'open-food-facts': 'a food, e.g. nutella',
  coingecko: 'coins, e.g. bitcoin ethereum',
  'world-bank-api': 'COUNTRY:INDICATOR, e.g. IN:NY.GDP.MKTP.CD',
  'npm-pypi-stats': 'a package, e.g. react',
  'osv-dev': 'ecosystem:name, e.g. npm:lodash',
  'crt-sh': 'a domain, e.g. github.com',
  gdelt: 'a topic, e.g. artificial intelligence',
  'wikipedia-wikidata': 'anything, e.g. Hyderabad',
  'hacker-news-api': '(no input needed)',
};

export function SaiPage() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [tryError, setTryError] = useState<string | null>(null);

  useEffect(() => {
    api<Catalog>('/api/v1/sai/sources')
      .then((c) => {
        setCat(c);
        setPick(c.sources.find((s) => s.live)?.id ?? '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load Agent Sai.'));
  }, []);

  const live = useMemo(() => (cat?.sources ?? []).filter((s) => s.live), [cat]);
  const grouped = useMemo(() => {
    const g: Record<string, SaiSource[]> = {};
    for (const s of cat?.sources ?? []) (g[s.category] ??= []).push(s);
    return g;
  }, [cat]);

  const run = async () => {
    if (!pick) return;
    setBusy(true);
    setTryError(null);
    setEvidence(null);
    try {
      const r = await api<{ evidence: Evidence }>(`/api/v1/sai/fetch/${encodeURIComponent(pick)}?q=${encodeURIComponent(query)}`);
      setEvidence(r.evidence);
    } catch (e) {
      setTryError(e instanceof Error ? e.message : 'Agent Sai could not fetch that right now.');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="cc-page"><p className="cc-error" role="alert">{error}</p></div>;
  if (!cat) return <div className="cc-page"><p className="cc-hint">Waking Agent Sai…</p></div>;

  return (
    <div className="cc-page sai-page">
      <header className="sai-hero">
        <h1>
          <Icon name="search" size={22} /> {cat.agent}
        </h1>
        <p className="cc-hint">
          The data detective 🕵️ — he watches {cat.total} free public data sources and brings back real answers with the source and the time, so nothing is ever a guess.
        </p>
        <div className="sai-stats">
          <span><strong>{cat.total}</strong> sources</span>
          <span className="sai-live"><strong>{cat.liveCount}</strong> live now</span>
          <span><strong>{cat.categories}</strong> categories</span>
          <span className="cc-muted">{cat.total - cat.liveCount} more coming online</span>
        </div>
      </header>

      <section className="sai-try">
        <h2>Ask a live source</h2>
        <div className="bx-row">
          <label className="bx-field bx-field--wide">
            <span>Source</span>
            <select className="cc-input" value={pick} onChange={(e) => { setPick(e.target.value); setQuery(''); setEvidence(null); }}>
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.n} — {s.covers}
                </option>
              ))}
            </select>
          </label>
          <label className="bx-field bx-field--wide">
            <span>Your query</span>
            <input
              className="cc-input"
              value={query}
              placeholder={PLACEHOLDERS[pick] ?? 'what to look up'}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void run()}
            />
          </label>
          <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={busy || !pick} onClick={() => void run()}>
            {busy ? 'Investigating…' : 'Ask Sai'}
          </button>
        </div>
        {tryError && <p className="cc-error" role="alert">{tryError}</p>}
        {evidence && (
          <div className="sai-evidence" data-testid="sai-evidence">
            <p className="sai-evidence__summary">{evidence.summary}</p>
            <p className="cc-hint">
              <Icon name="shield-check" size={13} /> {evidence.source} ·{' '}
              <a href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">source</a> · fetched {new Date(evidence.fetchedAt).toLocaleTimeString()}
            </p>
            <details>
              <summary>Raw data</summary>
              <pre className="sai-raw">{JSON.stringify(evidence.data, null, 2).slice(0, 4000)}</pre>
            </details>
          </div>
        )}
      </section>

      <section className="sai-catalog">
        <h2>The full catalog — {cat.total} sources</h2>
        {Object.entries(grouped).map(([category, list]) => (
          <div key={category} className="sai-cat">
            <h3 className="bx-sub">{category} <span className="cc-muted">({list.length})</span></h3>
            <ul className="bx-list bx-list--tight">
              {list.map((s) => (
                <li key={s.id} className="sai-src">
                  <span className={`cc-pill sai-badge sai-badge--${s.live ? 'live' : 'cat'}`}>{s.live ? 'LIVE' : 'catalogued'}</span>
                  <strong>{s.n}</strong> <span className="cc-muted">{s.covers}</span>
                  <span className="sai-meta cc-hint"> · {s.priority} · {s.access}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

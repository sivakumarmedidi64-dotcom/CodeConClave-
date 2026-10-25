/**
 * Agent Sai Srinivasa Athreya — live connectors.
 *
 * Each connector REALLY calls a free, keyless public API and returns normalized
 * evidence (summary + trimmed data + source URL + fetch time). A source counts
 * as "live" only if it has a connector here; everything else in the 140-source
 * catalog is "catalogued" (known, not yet pulled). Nothing is faked — a failed
 * fetch returns an honest error, never invented data.
 *
 * Connectors read ONLY fixed, hard-coded public hosts (no user-supplied URLs),
 * with a timeout and a response-size cap. Retrieved text is untrusted DATA.
 */
import { sourceById } from './sources.js';

export interface SaiEvidence {
  sourceId: string;
  source: string;
  query: string;
  summary: string;
  data: unknown;
  sourceUrl: string;
  fetchedAt: string;
}

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 4 * 1024 * 1024;

/** Safe GET for a fixed public host: timeout, size cap, JSON or text. */
async function safeGet(url: string, accept: 'json' | 'text' = 'json'): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'CodeConClave-AgentSai/1.0 (contact: founder)', Accept: accept === 'json' ? 'application/json' : 'text/plain,*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('response too large');
    const body = buf.toString('utf8');
    return accept === 'json' ? JSON.parse(body) : body;
  } finally {
    clearTimeout(t);
  }
}

async function safePost(url: string, payload: unknown): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CodeConClave-AgentSai/1.0' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('response too large');
    return JSON.parse(buf.toString('utf8'));
  } finally {
    clearTimeout(t);
  }
}

const q = (s: string) => encodeURIComponent(s.trim());
type Connector = (query: string) => Promise<{ summary: string; data: unknown; sourceUrl: string }>;

const CONNECTORS: Record<string, Connector> = {
  // ---- Earth & disasters ----
  'usgs-earthquakes': async (query) => {
    const min = /^\d+(\.\d+)?$/.test(query.trim()) ? query.trim() : '4.5';
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&limit=10&minmagnitude=${min}`;
    const r = (await safeGet(url)) as { features: { properties: { mag: number; place: string; time: number } }[] };
    const items = r.features.map((f) => ({ mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time).toISOString() }));
    return { summary: `${items.length} recent earthquakes M${min}+ worldwide. Latest: M${items[0]?.mag ?? '?'} ${items[0]?.place ?? ''}.`, data: items, sourceUrl: url };
  },

  // ---- India 🇮🇳 ----
  'india-post-pincode': async (query) => {
    const url = `https://api.postalpincode.in/pincode/${q(query)}`;
    const r = (await safeGet(url)) as { Status: string; PostOffice: { Name: string; District: string; State: string }[] | null }[];
    const po = r[0]?.PostOffice ?? [];
    const first = po[0];
    return { summary: first ? `PIN ${query}: ${first.Name}, ${first.District}, ${first.State} (${po.length} post office${po.length === 1 ? '' : 's'}).` : `No post office found for ${query}.`, data: po.map((p) => ({ name: p.Name, district: p.District, state: p.State })), sourceUrl: url };
  },

  // ---- Health / food ----
  'open-food-facts': async (query) => {
    if (/^\d{6,}$/.test(query.trim())) {
      const url = `https://world.openfoodfacts.org/api/v2/product/${q(query)}.json`;
      const r = (await safeGet(url)) as { status: number; product?: { product_name?: string; brands?: string; nutriscore_grade?: string } };
      return { summary: r.status === 1 ? `${r.product?.product_name ?? 'Product'} (${r.product?.brands ?? '?'}) — Nutri-Score ${r.product?.nutriscore_grade?.toUpperCase() ?? 'n/a'}.` : `No product for barcode ${query}.`, data: r.product ?? null, sourceUrl: url };
    }
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q(query)}&json=1&page_size=5`;
    const r = (await safeGet(url)) as { products: { product_name?: string; brands?: string }[] };
    return { summary: `${r.products.length} food products matching "${query}".`, data: r.products.map((p) => ({ name: p.product_name, brands: p.brands })), sourceUrl: url };
  },

  // ---- Finance ----
  coingecko: async (query) => {
    const ids = query.trim() ? query.trim().toLowerCase().replace(/\s+/g, ',') : 'bitcoin,ethereum';
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${q(ids)}&vs_currencies=usd,inr`;
    const r = (await safeGet(url)) as Record<string, { usd: number; inr: number }>;
    const parts = Object.entries(r).map(([k, v]) => `${k}: $${v.usd} / ₹${v.inr}`);
    return { summary: parts.join(' · ') || `No price for "${query}".`, data: r, sourceUrl: url };
  },
  'world-bank-api': async (query) => {
    const parts = (query.includes(':') ? query.split(':') : ['IN', query || 'NY.GDP.MKTP.CD']).map((s) => s.trim());
    const country = parts[0] || 'IN';
    const indicator = parts[1] || 'NY.GDP.MKTP.CD';
    const url = `https://api.worldbank.org/v2/country/${q(country)}/indicator/${q(indicator)}?format=json&mrv=3`;
    const r = (await safeGet(url)) as [unknown, { date: string; value: number | null }[] | null];
    const rows = (r[1] ?? []).filter((x) => x.value !== null).map((x) => ({ year: x.date, value: x.value }));
    return { summary: rows.length ? `${country} ${indicator}: ${rows.map((x) => `${x.year}=${x.value}`).join(', ')}.` : `No World Bank data for ${country}/${indicator}.`, data: rows, sourceUrl: url };
  },

  // ---- Dev & security ----
  'hacker-news-api': async () => {
    const url = 'https://hacker-news.firebaseio.com/v0/topstories.json';
    const ids = (await safeGet(url)) as number[];
    const top = await Promise.all(ids.slice(0, 5).map((id) => safeGet(`https://hacker-news.firebaseio.com/v0/item/${id}.json`) as Promise<{ title: string; url?: string; score: number }>));
    return { summary: `Top on Hacker News: ${top.map((s) => s.title).slice(0, 3).join(' | ')}`, data: top.map((s) => ({ title: s.title, url: s.url, score: s.score })), sourceUrl: url };
  },
  'npm-pypi-stats': async (query) => {
    const pkg = query.trim() || 'react';
    const url = `https://api.npmjs.org/downloads/point/last-week/${q(pkg)}`;
    const r = (await safeGet(url)) as { downloads?: number; package?: string; error?: string };
    return { summary: r.downloads != null ? `npm "${pkg}": ${r.downloads.toLocaleString()} downloads last week.` : `No npm stats for "${pkg}".`, data: r, sourceUrl: url };
  },
  'osv-dev': async (query) => {
    const parts = query.includes(':') ? query.split(':').map((s) => s.trim()) : ['npm', query.trim() || 'lodash'];
    const ecoRaw = parts[0] || 'npm';
    const name = parts[1] || query.trim() || 'lodash';
    // OSV uses exact ecosystem names (case-sensitive).
    const ECO: Record<string, string> = { npm: 'npm', pypi: 'PyPI', python: 'PyPI', pip: 'PyPI', go: 'Go', golang: 'Go', crates: 'crates.io', rust: 'crates.io', cargo: 'crates.io', maven: 'Maven', java: 'Maven', nuget: 'NuGet', rubygems: 'RubyGems', ruby: 'RubyGems' };
    const ecosystem = ECO[ecoRaw.toLowerCase()] ?? 'npm';
    const r = (await safePost('https://api.osv.dev/v1/query', { package: { ecosystem, name } })) as { vulns?: { id: string; summary?: string }[] };
    const vulns = r.vulns ?? [];
    return { summary: vulns.length ? `${name} (${ecosystem}) has ${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'}: ${vulns.slice(0, 3).map((v) => v.id).join(', ')}.` : `No known vulnerabilities for ${name} (${ecosystem}).`, data: vulns.map((v) => ({ id: v.id, summary: v.summary })), sourceUrl: 'https://api.osv.dev/v1/query' };
  },
  'crt-sh': async (query) => {
    const url = `https://crt.sh/?q=${q(query)}&output=json`;
    const r = (await safeGet(url)) as { name_value: string; issuer_name: string }[];
    const names = [...new Set(r.flatMap((c) => c.name_value.split('\n')))].slice(0, 20);
    return { summary: `${names.length} certificate names found for "${query}".`, data: names, sourceUrl: url };
  },

  // ---- News / knowledge ----
  gdelt: async (query) => {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q(query || 'technology')}&mode=artlist&maxrecords=5&format=json`;
    const r = (await safeGet(url)) as { articles?: { title: string; url: string; domain: string; seendate: string }[] };
    const arts = r.articles ?? [];
    return { summary: `${arts.length} recent news articles on "${query}".`, data: arts.map((a) => ({ title: a.title, url: a.url, source: a.domain })), sourceUrl: url };
  },
  'wikipedia-wikidata': async (query) => {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${q(query)}`;
    const r = (await safeGet(url)) as { title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
    return { summary: r.extract ?? `No Wikipedia summary for "${query}".`, data: { title: r.title, extract: r.extract }, sourceUrl: r.content_urls?.desktop?.page ?? url };
  },
};

/** IDs of sources Agent Sai can actually pull right now. */
export function liveSourceIds(): string[] {
  return Object.keys(CONNECTORS);
}

/** Run one connector for real. Throws an honest Error on failure (never fakes data). */
export async function runConnector(sourceId: string, query: string): Promise<SaiEvidence> {
  const src = sourceById(sourceId);
  const conn = CONNECTORS[sourceId];
  if (!src) throw new Error(`Unknown source "${sourceId}"`);
  if (!conn) throw new Error(`Agent Sai Srinivasa Athreya has catalogued "${src.n}" but it is not live yet.`);
  const { summary, data, sourceUrl } = await conn(query);
  return { sourceId, source: src.n, query, summary, data, sourceUrl, fetchedAt: new Date().toISOString() };
}

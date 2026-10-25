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

  // ---- Research & science ----
  openalex: async (query) => {
    const url = `https://api.openalex.org/works?search=${q(query)}&per_page=5`;
    const r = (await safeGet(url)) as { results: { title: string; publication_year: number; cited_by_count: number }[] };
    return { summary: `${r.results.length} papers on "${query}". Top: ${r.results[0]?.title ?? 'none'} (${r.results[0]?.publication_year ?? '?'}, ${r.results[0]?.cited_by_count ?? 0} citations).`, data: r.results.map((p) => ({ title: p.title, year: p.publication_year, citations: p.cited_by_count })), sourceUrl: url };
  },
  crossref: async (query) => {
    const url = `https://api.crossref.org/works?query=${q(query)}&rows=5`;
    const r = (await safeGet(url)) as { message: { items: { title?: string[]; DOI: string }[] } };
    return { summary: `${r.message.items.length} publications on "${query}".`, data: r.message.items.map((i) => ({ title: i.title?.[0], doi: i.DOI })), sourceUrl: url };
  },
  arxiv: async (query) => {
    const url = `http://export.arxiv.org/api/query?search_query=all:${q(query)}&max_results=5`;
    const xml = (await safeGet(url, 'text')) as string;
    const titles = [...xml.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim());
    return { summary: `${titles.length} arXiv preprints on "${query}". Latest: ${titles[0] ?? 'none'}.`, data: titles, sourceUrl: `https://arxiv.org/list/${q(query)}/recent` };
  },
  'clinicaltrials-gov': async (query) => {
    const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${q(query)}&pageSize=5`;
    const r = (await safeGet(url)) as { studies: { protocolSection?: { identificationModule?: { briefTitle?: string }; statusModule?: { overallStatus?: string } } }[] };
    return { summary: `${r.studies.length} clinical trials on "${query}".`, data: r.studies.map((s) => ({ title: s.protocolSection?.identificationModule?.briefTitle, status: s.protocolSection?.statusModule?.overallStatus })), sourceUrl: url };
  },
  pubchem: async (query) => {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${q(query)}/property/MolecularFormula,MolecularWeight/JSON`;
    const r = (await safeGet(url)) as { PropertyTable?: { Properties: { MolecularFormula: string; MolecularWeight: string }[] } };
    const p = r.PropertyTable?.Properties?.[0];
    return { summary: p ? `${query}: formula ${p.MolecularFormula}, weight ${p.MolecularWeight}.` : `No compound "${query}".`, data: p ?? null, sourceUrl: url };
  },

  // ---- Health & environment ----
  openfda: async (query) => {
    const url = `https://api.fda.gov/drug/label.json?search=${q(query)}&limit=3`;
    const r = (await safeGet(url)) as { results?: { openfda?: { brand_name?: string[] }; warnings?: string[] }[] };
    const items = r.results ?? [];
    return { summary: items.length ? `${items.length} FDA drug labels matching "${query}": ${items.map((i) => i.openfda?.brand_name?.[0]).filter(Boolean).join(', ')}.` : `No FDA data for "${query}".`, data: items.map((i) => ({ brand: i.openfda?.brand_name?.[0], warning: i.warnings?.[0]?.slice(0, 200) })), sourceUrl: url };
  },
  gbif: async (query) => {
    const url = `https://api.gbif.org/v1/species/search?q=${q(query)}&limit=5`;
    const r = (await safeGet(url)) as { results: { scientificName: string; kingdom?: string }[] };
    return { summary: `${r.results.length} species matching "${query}". Top: ${r.results[0]?.scientificName ?? 'none'}.`, data: r.results.map((s) => ({ name: s.scientificName, kingdom: s.kingdom })), sourceUrl: url };
  },
  'who-global-health-observatory': async (query) => {
    const url = `https://ghoapi.azureedge.net/api/Indicator?$filter=contains(IndicatorName,'${q(query || 'mortality')}')`;
    const r = (await safeGet(url)) as { value: { IndicatorCode: string; IndicatorName: string }[] };
    return { summary: `${r.value.length} WHO health indicators matching "${query || 'mortality'}".`, data: r.value.slice(0, 8).map((i) => ({ code: i.IndicatorCode, name: i.IndicatorName })), sourceUrl: 'https://www.who.int/data/gho' };
  },

  // ---- Dev & security ----
  'cve-nvd': async (query) => {
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${q(query || 'openssl')}&resultsPerPage=3`;
    const r = (await safeGet(url)) as { vulnerabilities?: { cve: { id: string; descriptions: { lang: string; value: string }[] } }[] };
    const v = r.vulnerabilities ?? [];
    return { summary: v.length ? `${v.length} CVEs matching "${query}": ${v.map((x) => x.cve.id).join(', ')}.` : `No CVEs for "${query}".`, data: v.map((x) => ({ id: x.cve.id, description: x.cve.descriptions.find((d) => d.lang === 'en')?.value?.slice(0, 200) })), sourceUrl: url };
  },
  'cisa-kev': async (query) => {
    const r = (await safeGet('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json')) as { vulnerabilities: { cveID: string; vendorProject: string; product: string; vulnerabilityName: string }[] };
    const ql = query.trim().toLowerCase();
    const hits = (ql ? r.vulnerabilities.filter((v) => `${v.cveID} ${v.vendorProject} ${v.product} ${v.vulnerabilityName}`.toLowerCase().includes(ql)) : r.vulnerabilities).slice(0, 10);
    return { summary: `${hits.length} actively-exploited vulnerabilities${ql ? ` matching "${query}"` : ''} (of ${r.vulnerabilities.length} total in CISA's catalog).`, data: hits.map((v) => ({ cve: v.cveID, vendor: v.vendorProject, product: v.product, name: v.vulnerabilityName })), sourceUrl: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog' };
  },
  'endoflife-date': async (query) => {
    const prod = (query.trim() || 'nodejs').toLowerCase().replace(/\s+/g, '');
    const url = `https://endoflife.date/api/${q(prod)}.json`;
    const r = (await safeGet(url)) as { cycle: string; eol: string | boolean }[];
    return { summary: `${prod}: ${r.slice(0, 4).map((c) => `${c.cycle} (EOL ${c.eol === false ? 'still supported' : c.eol})`).join(', ')}.`, data: r.slice(0, 8), sourceUrl: `https://endoflife.date/${prod}` };
  },
  github: async (query) => {
    const url = `https://api.github.com/search/repositories?q=${q(query || 'ai')}&per_page=5`;
    const r = (await safeGet(url)) as { items: { full_name: string; stargazers_count: number; description?: string }[] };
    return { summary: `Top GitHub repos for "${query}": ${r.items.slice(0, 3).map((i) => `${i.full_name} (★${i.stargazers_count})`).join(', ')}.`, data: r.items.map((i) => ({ repo: i.full_name, stars: i.stargazers_count, description: i.description })), sourceUrl: url };
  },
  'stack-overflow': async (query) => {
    const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=${q(query)}&site=stackoverflow&pagesize=5`;
    const r = (await safeGet(url)) as { items: { title: string; score: number; is_answered: boolean; link: string }[] };
    return { summary: `${r.items.length} Stack Overflow Q&A on "${query}".`, data: r.items.map((i) => ({ title: i.title, score: i.score, answered: i.is_answered, link: i.link })), sourceUrl: url };
  },
  'rdap-whois': async (query) => {
    const url = `https://rdap.org/domain/${q(query)}`;
    const r = (await safeGet(url)) as { ldhName?: string; events?: { eventAction: string; eventDate: string }[] };
    const reg = r.events?.find((e) => e.eventAction === 'registration')?.eventDate;
    const exp = r.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
    return { summary: `${r.ldhName ?? query}: registered ${reg ?? '?'}, expires ${exp ?? '?'}.`, data: { domain: r.ldhName, registration: reg, expiration: exp }, sourceUrl: url };
  },

  // ---- Business & knowledge ----
  gleif: async (query) => {
    const url = `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${q(query)}&page[size]=5`;
    const r = (await safeGet(url)) as { data: { attributes: { lei: string; entity: { legalName: { name: string }; legalAddress?: { country: string } } } }[] };
    return { summary: `${r.data.length} legal entities matching "${query}".`, data: r.data.map((d) => ({ lei: d.attributes.lei, name: d.attributes.entity.legalName.name, country: d.attributes.entity.legalAddress?.country })), sourceUrl: url };
  },
  'open-library': async (query) => {
    const url = `https://openlibrary.org/search.json?q=${q(query)}&limit=5`;
    const r = (await safeGet(url)) as { docs: { title: string; author_name?: string[]; first_publish_year?: number }[] };
    return { summary: `${r.docs.length} books matching "${query}". Top: ${r.docs[0]?.title ?? 'none'} by ${r.docs[0]?.author_name?.[0] ?? '?'}.`, data: r.docs.map((d) => ({ title: d.title, author: d.author_name?.[0], year: d.first_publish_year })), sourceUrl: url };
  },
  'project-gutenberg': async (query) => {
    const url = `https://gutendex.com/books?search=${q(query)}`;
    const r = (await safeGet(url)) as { results: { title: string; authors: { name: string }[] }[] };
    return { summary: `${r.results.length} free books matching "${query}".`, data: r.results.slice(0, 5).map((b) => ({ title: b.title, author: b.authors[0]?.name })), sourceUrl: url };
  },
  musicbrainz: async (query) => {
    const url = `https://musicbrainz.org/ws/2/artist?query=${q(query)}&fmt=json&limit=5`;
    const r = (await safeGet(url)) as { artists: { name: string; country?: string; disambiguation?: string }[] };
    return { summary: `${r.artists.length} artists matching "${query}". Top: ${r.artists[0]?.name ?? 'none'}.`, data: r.artists.map((a) => ({ name: a.name, country: a.country, note: a.disambiguation })), sourceUrl: url };
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

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
import { readCaseFile, writeCaseFile } from './caseFile.js';

export interface SaiEvidence {
  sourceId: string;
  source: string;
  query: string;
  summary: string;
  data: unknown;
  sourceUrl: string;
  fetchedAt: string;
  /** True when served from Agent Sai's warm cache (instant). */
  cached: boolean;
  /** How old the data is, in seconds (0 for a fresh pull). */
  ageSeconds: number;
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

/** Read a required API key from the environment (honest error if missing). */
function keyEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`This source needs its key (${name}) set in the server environment — add it in Render → Environment.`);
  return v;
}

/** safeGet with extra request headers (token / bearer / basic auth sources). */
async function safeGetH(url: string, headers: Record<string, string>): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'CodeConClave-AgentSai/1.0', Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('response too large');
    return JSON.parse(buf.toString('utf8'));
  } finally {
    clearTimeout(t);
  }
}

const aqiLabel = (a: number): string => (a <= 50 ? 'Good' : a <= 100 ? 'Moderate' : a <= 150 ? 'Unhealthy for sensitive groups' : a <= 200 ? 'Unhealthy' : a <= 300 ? 'Very unhealthy' : 'Hazardous');

const q = (s: string) => encodeURIComponent(s.trim());
type Connector = (query: string) => Promise<{ summary: string; data: unknown; sourceUrl: string }>;

/** Agmarknet daily mandi prices via data.gov.in (shared by data-gov-in + agmarknet). 🇮🇳 */
async function dataGovAgmarknet(query: string): Promise<{ summary: string; data: unknown; sourceUrl: string }> {
  const k = keyEnv('DATA_GOV_IN_API_KEY');
  const RES = '9ef84268-d588-465a-a308-a864a43d0070'; // "Current Daily Price of Various Commodities from Mandi"
  const filter = query.trim() ? `&filters[commodity]=${q(query.trim())}` : '';
  const url = `https://api.data.gov.in/resource/${RES}?api-key=${k}&format=json&limit=10${filter}`;
  const r = (await safeGet(url)) as { records?: { commodity: string; market: string; state: string; modal_price: string; arrival_date?: string }[] };
  const recs = r.records ?? [];
  const f = recs[0];
  return {
    summary: f ? `${recs.length} mandi prices${query ? ` for ${query}` : ''}. e.g. ${f.commodity} at ${f.market}, ${f.state}: ₹${f.modal_price}/quintal (${f.arrival_date ?? 'recent'}).` : `No mandi prices${query ? ` for "${query}"` : ''} right now (try a commodity like Tomato, Onion, Potato).`,
    data: recs.map((x) => ({ commodity: x.commodity, market: x.market, state: x.state, modalPrice: x.modal_price, date: x.arrival_date })),
    sourceUrl: 'https://agmarknet.gov.in',
  };
}

/** Turn a city name into coordinates (keyless, via Open-Meteo geocoding). */
async function geocodeCity(name: string): Promise<{ name: string; lat: number; lon: number }> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q(name.trim() || 'Hyderabad')}&count=1`;
  const r = (await safeGet(url)) as { results?: { name: string; latitude: number; longitude: number; country?: string }[] };
  const g = r.results?.[0];
  if (!g) throw new Error(`Could not find a place called "${name}".`);
  return { name: g.country ? `${g.name}, ${g.country}` : g.name, lat: g.latitude, lon: g.longitude };
}

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

  // ---- Package ecosystems ----
  gitlab: async (query) => {
    const url = `https://gitlab.com/api/v4/projects?search=${q(query || 'ai')}&per_page=5&order_by=star_count&sort=desc`;
    const r = (await safeGet(url)) as { path_with_namespace: string; star_count: number; description?: string }[];
    return { summary: `Top GitLab projects for "${query}": ${r.slice(0, 3).map((p) => `${p.path_with_namespace} (★${p.star_count})`).join(', ')}.`, data: r.map((p) => ({ project: p.path_with_namespace, stars: p.star_count, description: p.description })), sourceUrl: url };
  },
  'docker-hub': async (query) => {
    const url = `https://hub.docker.com/v2/search/repositories/?query=${q(query || 'nginx')}&page_size=5`;
    const r = (await safeGet(url)) as { results: { repo_name: string; star_count: number; pull_count?: number }[] };
    return { summary: `Docker images for "${query}": ${r.results.slice(0, 3).map((i) => `${i.repo_name} (★${i.star_count})`).join(', ')}.`, data: r.results.map((i) => ({ image: i.repo_name, stars: i.star_count })), sourceUrl: url };
  },
  'maven-central': async (query) => {
    const url = `https://search.maven.org/solrsearch/select?q=${q(query || 'guava')}&rows=5&wt=json`;
    const r = (await safeGet(url)) as { response: { docs: { id: string; latestVersion?: string }[] } };
    return { summary: `${r.response.docs.length} Maven artifacts matching "${query}".`, data: r.response.docs.map((d) => ({ artifact: d.id, latest: d.latestVersion })), sourceUrl: url };
  },
  'crates-io': async (query) => {
    const url = `https://crates.io/api/v1/crates?q=${q(query || 'serde')}&per_page=5`;
    const r = (await safeGet(url)) as { crates: { name: string; downloads: number; description?: string }[] };
    return { summary: `Rust crates for "${query}": ${r.crates.slice(0, 3).map((c) => `${c.name} (${c.downloads.toLocaleString()} dl)`).join(', ')}.`, data: r.crates.map((c) => ({ name: c.name, downloads: c.downloads, description: c.description })), sourceUrl: url };
  },
  'rubygems-nuget-go-proxy': async (query) => {
    const url = `https://rubygems.org/api/v1/search.json?query=${q(query || 'rails')}`;
    const r = (await safeGet(url)) as { name: string; downloads: number; info?: string }[];
    return { summary: `${r.length} Ruby gems matching "${query}". Top: ${r[0]?.name ?? 'none'} (${(r[0]?.downloads ?? 0).toLocaleString()} downloads).`, data: r.slice(0, 5).map((g) => ({ name: g.name, downloads: g.downloads })), sourceUrl: url };
  },
  repology: async (query) => {
    const url = `https://repology.org/api/v1/project/${q((query || 'curl').toLowerCase())}`;
    const r = (await safeGet(url)) as { repo: string; version: string; status: string }[];
    const versions = [...new Set(r.map((p) => p.version))].slice(0, 6);
    return { summary: `"${query}" is packaged in ${new Set(r.map((p) => p.repo)).size} repositories. Versions: ${versions.join(', ')}.`, data: r.slice(0, 15).map((p) => ({ repo: p.repo, version: p.version, status: p.status })), sourceUrl: `https://repology.org/project/${q((query || 'curl').toLowerCase())}/versions` };
  },
  'openssf-scorecard': async (query) => {
    const repo = query.includes('/') ? query.trim() : `nodejs/${query.trim() || 'node'}`;
    const url = `https://api.securityscorecards.dev/projects/github.com/${repo}`;
    const r = (await safeGet(url)) as { score: number; checks: { name: string; score: number }[] };
    return { summary: `${repo} OpenSSF security score: ${r.score}/10.`, data: { score: r.score, checks: r.checks?.slice(0, 8).map((c) => ({ check: c.name, score: c.score })) }, sourceUrl: url };
  },
  defillama: async (query) => {
    const slug = (query.trim() || 'uniswap').toLowerCase().replace(/\s+/g, '-');
    const r = (await safeGet(`https://api.llama.fi/tvl/${q(slug)}`, 'text')) as string;
    const tvl = Number(r);
    return { summary: Number.isFinite(tvl) ? `${slug}: $${Math.round(tvl).toLocaleString()} total value locked (TVL).` : `No DeFi protocol "${slug}".`, data: { protocol: slug, tvl }, sourceUrl: `https://defillama.com/protocol/${slug}` };
  },
  'sec-edgar': async (query) => {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${q(query || 'Apple')}`;
    const r = (await safeGet(url)) as { hits?: { hits: { _source: { display_names?: string[] } }[] } };
    const hits = r.hits?.hits ?? [];
    return { summary: `${hits.length} SEC filings matching "${query}".`, data: hits.slice(0, 5).map((h) => ({ entity: h._source.display_names?.[0] })), sourceUrl: `https://www.sec.gov/cgi-bin/srqsb?text=${q(query)}` };
  },

  // ---- Research (more) ----
  pubmed: async (query) => {
    const s = (await safeGet(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${q(query)}&retmode=json&retmax=5`)) as { esearchresult?: { idlist?: string[] } };
    const ids = s.esearchresult?.idlist ?? [];
    if (!ids.length) return { summary: `No PubMed papers for "${query}".`, data: [], sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/?term=${q(query)}` };
    const sum = (await safeGet(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`)) as { result: Record<string, { title?: string; pubdate?: string }> };
    const papers = ids.map((id) => ({ title: sum.result[id]?.title, date: sum.result[id]?.pubdate }));
    return { summary: `${papers.length} PubMed papers on "${query}". Latest: ${papers[0]?.title ?? ''}`, data: papers, sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/?term=${q(query)}` };
  },
  'europe-pmc': async (query) => {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q(query)}&format=json&pageSize=5`;
    const r = (await safeGet(url)) as { resultList?: { result: { title: string; pubYear?: string; authorString?: string }[] } };
    const res = r.resultList?.result ?? [];
    return { summary: `${res.length} biomedical papers on "${query}".`, data: res.map((p) => ({ title: p.title, year: p.pubYear })), sourceUrl: url };
  },
  'zenodo-dryad': async (query) => {
    const url = `https://zenodo.org/api/records?q=${q(query)}&size=5`;
    const r = (await safeGet(url)) as { hits?: { hits: { metadata?: { title?: string; publication_date?: string } }[] } };
    const hits = r.hits?.hits ?? [];
    return { summary: `${hits.length} research datasets matching "${query}".`, data: hits.map((h) => ({ title: h.metadata?.title, date: h.metadata?.publication_date })), sourceUrl: url };
  },

  // ---- Nature, culture, movement ----
  'ebird-inaturalist': async (query) => {
    const url = `https://api.inaturalist.org/v1/taxa?q=${q(query)}&per_page=5`;
    const r = (await safeGet(url)) as { results: { name: string; preferred_common_name?: string; observations_count?: number }[] };
    return { summary: `${r.results.length} species matching "${query}". Top: ${r.results[0]?.preferred_common_name ?? r.results[0]?.name ?? 'none'}.`, data: r.results.map((s) => ({ name: s.name, common: s.preferred_common_name, observations: s.observations_count })), sourceUrl: url };
  },
  'opensky-network': async () => {
    // Flights currently over India (bbox), keyless.
    const url = 'https://opensky-network.org/api/states/all?lamin=6&lomin=68&lamax=37&lomax=97';
    const r = (await safeGet(url)) as { states: (string | number | null)[][] | null };
    const states = r.states ?? [];
    const callsigns = states.map((s) => String(s[1] ?? '').trim()).filter(Boolean).slice(0, 8);
    return { summary: `${states.length} aircraft currently tracked over India. Sample: ${callsigns.join(', ')}.`, data: { count: states.length, sample: callsigns }, sourceUrl: 'https://opensky-network.org' };
  },
  'internet-archive-wayback-cdx': async (query) => {
    const url = `http://web.archive.org/cdx/search/cdx?url=${q(query)}&output=json&limit=6`;
    const r = (await safeGet(url)) as string[][];
    const rows = r.slice(1);
    return { summary: `${rows.length} archived snapshots of "${query}" in the Wayback Machine.`, data: rows.map((row) => ({ timestamp: row[1], status: row[4], url: `http://web.archive.org/web/${row[1]}/${row[2]}` })), sourceUrl: `https://web.archive.org/web/*/${query}` };
  },
  'wikipedia-pageviews': async (query) => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const end = new Date(Date.now() - 2 * 86_400_000);
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const article = query.trim().replace(/\s+/g, '_') || 'India';
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${q(article)}/daily/${fmt(start)}/${fmt(end)}`;
    const r = (await safeGet(url)) as { items?: { views: number }[] };
    const total = (r.items ?? []).reduce((a, b) => a + b.views, 0);
    return { summary: `"${article}" was viewed ${total.toLocaleString()} times on Wikipedia in the last week.`, data: r.items ?? [], sourceUrl: `https://en.wikipedia.org/wiki/${q(article)}` };
  },
  'unhcr-data': async () => {
    const url = 'https://api.unhcr.org/population/v1/population/?limit=5&yearFrom=2023&yearTo=2023';
    const r = (await safeGet(url)) as { items?: { coo_name?: string; coa_name?: string; refugees?: string }[] };
    const items = r.items ?? [];
    return { summary: `${items.length} refugee-population records (2023). e.g. ${items[0]?.coo_name ?? '?'} → ${items[0]?.coa_name ?? '?'}: ${items[0]?.refugees ?? '?'} refugees.`, data: items, sourceUrl: 'https://www.unhcr.org/refugee-statistics' };
  },

  // ---- Keyed sources (keys read from env; add them in Render → Environment) ----
  'data-gov-in': dataGovAgmarknet,
  agmarknet: dataGovAgmarknet,
  'fred-alfred': async (query) => {
    const k = keyEnv('FRED_API_KEY');
    const url = `https://api.stlouisfed.org/fred/series/search?search_text=${q(query || 'GDP')}&api_key=${k}&file_type=json&limit=5`;
    const r = (await safeGet(url)) as { seriess?: { id: string; title: string; units?: string; frequency?: string }[] };
    const s = r.seriess ?? [];
    return { summary: `${s.length} FRED economic series matching "${query}". Top: ${s[0]?.title ?? 'none'} (${s[0]?.id ?? ''}).`, data: s.map((x) => ({ id: x.id, title: x.title, units: x.units, frequency: x.frequency })), sourceUrl: 'https://fred.stlouisfed.org' };
  },
  aqicn: async (query) => {
    const k = keyEnv('AQICN_API_TOKEN');
    const city = query.trim() || 'hyderabad';
    const r = (await safeGet(`https://api.waqi.info/feed/${q(city)}/?token=${k}`)) as { status: string; data?: { aqi: number; city?: { name: string }; dominentpol?: string; iaqi?: Record<string, { v: number }> } | string };
    if (r.status !== 'ok' || !r.data || typeof r.data === 'string' || typeof r.data.aqi !== 'number') {
      throw new Error(typeof r.data === 'string' ? `AQICN: ${r.data} (check your AQICN_API_TOKEN).` : `No air-quality data for "${city}".`);
    }
    return { summary: `${r.data.city?.name ?? city}: AQI ${r.data.aqi} — ${aqiLabel(r.data.aqi)}. Main pollutant: ${r.data.dominentpol ?? '?'}.`, data: { aqi: r.data.aqi, city: r.data.city?.name, dominant: r.data.dominentpol, pm25: r.data.iaqi?.pm25?.v, pm10: r.data.iaqi?.pm10?.v }, sourceUrl: `https://aqicn.org/city/${encodeURIComponent(city)}` };
  },
  nasa: async () => {
    const k = keyEnv('NASA_API_KEY');
    const today = new Date().toISOString().slice(0, 10);
    const r = (await safeGet(`https://api.nasa.gov/neo/rest/v1/feed?start_date=${today}&end_date=${today}&api_key=${k}`)) as {
      element_count: number;
      near_earth_objects: Record<string, { name: string; is_potentially_hazardous_asteroid: boolean; estimated_diameter: { meters: { estimated_diameter_max: number } } }[]>;
    };
    const list = r.near_earth_objects[today] ?? [];
    const hazardous = list.filter((a) => a.is_potentially_hazardous_asteroid).length;
    return { summary: `${r.element_count} near-Earth asteroids pass today; ${hazardous} flagged potentially hazardous.`, data: list.slice(0, 6).map((a) => ({ name: a.name, hazardous: a.is_potentially_hazardous_asteroid, diameterMeters: Math.round(a.estimated_diameter.meters.estimated_diameter_max) })), sourceUrl: 'https://api.nasa.gov' };
  },
  noaa: async () => {
    const k = keyEnv('NOAA_API_TOKEN');
    const r = (await safeGetH('https://www.ncei.noaa.gov/cdo-web/api/v2/datasets?limit=10', { token: k })) as { results?: { id: string; name: string }[] };
    const d = r.results ?? [];
    return { summary: `NOAA token valid — ${d.length} climate datasets available: ${d.slice(0, 5).map((x) => x.id).join(', ')}.`, data: d.map((x) => ({ id: x.id, name: x.name })), sourceUrl: 'https://www.ncdc.noaa.gov/cdo-web/' };
  },
  'news-apis': async (query) => {
    const k = keyEnv('NEWS_API_KEY');
    const r = (await safeGet(`https://newsapi.org/v2/everything?q=${q(query || 'technology')}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${k}`)) as { status: string; message?: string; articles?: { title: string; source: { name: string }; url: string }[] };
    if (r.status !== 'ok') throw new Error(r.message || 'News API error (its free plan blocks server use — GDELT is the free alternative, already live).');
    const a = r.articles ?? [];
    return { summary: `${a.length} recent news articles on "${query}".`, data: a.map((x) => ({ title: x.title, source: x.source.name, url: x.url })), sourceUrl: 'https://newsapi.org' };
  },
  'hugging-face-hub': async (query) => {
    const tok = process.env.HF_TOKEN?.trim();
    const url = `https://huggingface.co/api/models?search=${q(query || 'llama')}&limit=5&sort=downloads&direction=-1`;
    const r = (await safeGetH(url, tok ? { authorization: `Bearer ${tok}` } : {})) as { id: string; downloads?: number; likes?: number }[];
    return { summary: `Top Hugging Face models for "${query}": ${r.slice(0, 3).map((m) => m.id).join(', ')}.`, data: r.map((m) => ({ model: m.id, downloads: m.downloads, likes: m.likes })), sourceUrl: url };
  },
  kaggle: async (query) => {
    const auth = Buffer.from(`${keyEnv('KAGGLE_USERNAME')}:${keyEnv('KAGGLE_KEY')}`).toString('base64');
    const url = `https://www.kaggle.com/api/v1/datasets/list?search=${q(query || 'india')}`;
    const r = (await safeGetH(url, { authorization: `Basic ${auth}` })) as { ref: string; title: string; totalBytes?: number; downloadCount?: number }[];
    return { summary: `${r.length} Kaggle datasets for "${query}". Top: ${r[0]?.title ?? 'none'}.`, data: r.slice(0, 5).map((d) => ({ ref: d.ref, title: d.title, downloads: d.downloadCount })), sourceUrl: url };
  },

  // ---- Weather & air (KEYLESS — no token, unlike AQICN) 🌦️ ----
  'open-meteo': async (query) => {
    const g = await geocodeCity(query || 'Hyderabad');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`;
    const r = (await safeGet(url)) as { current?: { temperature_2m: number; relative_humidity_2m: number; wind_speed_10m: number } };
    const c = r.current;
    return { summary: c ? `${g.name}: ${c.temperature_2m}°C, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h.` : `No weather for "${query}".`, data: { place: g.name, ...c }, sourceUrl: 'https://open-meteo.com' };
  },
  'open-meteo-air-quality': async (query) => {
    const g = await geocodeCity(query || 'Delhi');
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${g.lat}&longitude=${g.lon}&current=pm2_5,pm10,us_aqi`;
    const r = (await safeGet(url)) as { current?: { pm2_5: number; pm10: number; us_aqi: number } };
    const c = r.current;
    return { summary: c ? `${g.name}: US AQI ${c.us_aqi} — ${aqiLabel(c.us_aqi)}. PM2.5 ${c.pm2_5}, PM10 ${c.pm10}.` : `No air-quality for "${query}".`, data: { place: g.name, ...c }, sourceUrl: 'https://open-meteo.com/en/docs/air-quality-api' };
  },

  // ---- Space & satellite eyes 🛰️ ----
  'nasa-eonet': async (query) => {
    const r = (await safeGet('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=20')) as { events: { title: string; categories: { title: string }[] }[] };
    const ql = query.trim().toLowerCase();
    const evs = (ql ? r.events.filter((e) => `${e.title} ${e.categories.map((c) => c.title).join(' ')}`.toLowerCase().includes(ql) ) : r.events).slice(0, 10);
    return { summary: `${evs.length} live natural events seen from space${ql ? ` matching "${query}"` : ''} (wildfires, storms, volcanoes…). e.g. ${evs[0]?.title ?? 'none'}.`, data: evs.map((e) => ({ title: e.title, type: e.categories[0]?.title })), sourceUrl: 'https://eonet.gsfc.nasa.gov' };
  },
  'launch-library': async () => {
    const r = (await safeGet('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5&mode=list')) as { results: { name: string; net: string; launch_service_provider?: { name: string } }[] };
    return { summary: `${r.results.length} upcoming rocket launches. Next: ${r.results[0]?.name ?? 'none'} (${r.results[0]?.net?.slice(0, 10) ?? '?'}).`, data: r.results.map((l) => ({ name: l.name, date: l.net, provider: l.launch_service_provider?.name })), sourceUrl: 'https://thespacedevs.com' };
  },
  'sunrise-sunset': async (query) => {
    const g = await geocodeCity(query || 'Hyderabad');
    const r = (await safeGet(`https://api.sunrise-sunset.org/json?lat=${g.lat}&lng=${g.lon}&formatted=0`)) as { status: string; results?: { sunrise: string; sunset: string; day_length: number } };
    const s = r.results;
    return { summary: s ? `${g.name}: sunrise ${s.sunrise} UTC, sunset ${s.sunset} UTC.` : `No sun times for "${query}".`, data: { place: g.name, ...s }, sourceUrl: 'https://sunrise-sunset.org' };
  },

  // ---- Geography, places & time 🌍 ----
  zippopotam: async (query) => {
    const parts = query.trim().split(/\s+/).filter(Boolean);
    const cc = parts.length >= 2 && parts[0]!.length === 2 ? parts[0]!.toLowerCase() : 'in';
    const code = parts.length >= 2 && parts[0]!.length === 2 ? parts[1]! : parts[0] || '500001';
    const url = `https://api.zippopotam.us/${q(cc)}/${q(code)}`;
    const r = (await safeGet(url)) as { 'post code'?: string; country?: string; places?: { 'place name': string; state: string }[] };
    const p = r.places?.[0];
    return { summary: p ? `${r['post code']} (${r.country}): ${p['place name']}, ${p.state}.` : `No postal code "${query}".`, data: r.places ?? null, sourceUrl: url };
  },
  'ip-geolocation': async (query) => {
    const ip = query.trim() || '8.8.8.8';
    const r = (await safeGet(`http://ip-api.com/json/${q(ip)}`)) as { status: string; country?: string; city?: string; isp?: string; query?: string };
    return { summary: r.status === 'success' ? `${r.query}: ${r.city}, ${r.country} (ISP: ${r.isp}).` : `Could not locate "${ip}".`, data: r, sourceUrl: 'https://ip-api.com' };
  },
  'osm-nominatim': async (query) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${q(query || 'Hyderabad')}&format=json&limit=3`;
    const r = (await safeGet(url)) as { display_name: string; lat: string; lon: string; type: string }[];
    return { summary: r.length ? `${r.length} places for "${query}". Top: ${r[0]?.display_name}.` : `No place "${query}".`, data: r.map((p) => ({ name: p.display_name, lat: p.lat, lon: p.lon, type: p.type })), sourceUrl: 'https://www.openstreetmap.org' };
  },
  'world-time': async (query) => {
    const tz = query.trim() || 'Asia/Kolkata';
    const r = (await safeGet(`https://timeapi.io/api/Time/current/zone?timeZone=${q(tz)}`)) as { dateTime?: string; timeZone?: string; dayOfWeek?: string };
    return { summary: r.dateTime ? `${r.timeZone}: ${r.dateTime.slice(0, 19).replace('T', ' ')} (${r.dayOfWeek}).` : `No timezone "${tz}" (try Asia/Kolkata).`, data: r, sourceUrl: 'https://timeapi.io' };
  },
  'nager-holidays': async (query) => {
    const parts = query.trim().split(/\s+/).filter(Boolean);
    const cc = (parts[0] || 'US').toUpperCase().slice(0, 2);
    const year = /^\d{4}$/.test(parts[1] ?? '') ? parts[1]! : String(new Date().getFullYear());
    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${q(cc)}`;
    const r = (await safeGet(url)) as { date: string; localName: string; name: string }[];
    return { summary: `${r.length} public holidays in ${cc} for ${year}. e.g. ${r.slice(0, 3).map((h) => `${h.name} (${h.date})`).join(', ')}.`, data: r.map((h) => ({ date: h.date, name: h.name, localName: h.localName })), sourceUrl: 'https://date.nager.at' };
  },

  // ---- Money & exchange rates 💱 ----
  frankfurter: async (query) => {
    const parts = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
    const base = parts[0] || 'USD';
    const symbols = parts.slice(1).join(',') || 'INR,EUR,GBP';
    const r = (await safeGet(`https://api.frankfurter.app/latest?from=${q(base)}&to=${q(symbols)}`)) as { base: string; date: string; rates: Record<string, number> };
    return { summary: `1 ${r.base} = ${Object.entries(r.rates).map(([k, v]) => `${v} ${k}`).join(', ')} (${r.date}).`, data: r, sourceUrl: 'https://www.frankfurter.app' };
  },
  'blockchain-info': async () => {
    const r = (await safeGet('https://blockchain.info/ticker')) as Record<string, { last: number }>;
    return { summary: `Bitcoin: $${r.USD?.last?.toLocaleString() ?? '?'} (USD), ₹${r.INR?.last?.toLocaleString() ?? '?'} (INR).`, data: { usd: r.USD?.last, inr: r.INR?.last, eur: r.EUR?.last, gbp: r.GBP?.last }, sourceUrl: 'https://www.blockchain.com/explorer' };
  },
  'us-treasury': async () => {
    const url = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=1';
    const r = (await safeGet(url)) as { data: { record_date: string; tot_pub_debt_out_amt: string }[] };
    const d = r.data[0];
    return { summary: d ? `US national debt: $${Number(d.tot_pub_debt_out_amt).toLocaleString()} (as of ${d.record_date}).` : 'No treasury data.', data: d ?? null, sourceUrl: 'https://fiscaldata.treasury.gov' };
  },

  // ---- Words & language 📖 ----
  'free-dictionary': async (query) => {
    const word = query.trim() || 'serendipity';
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${q(word)}`;
    const r = (await safeGet(url)) as { word: string; meanings: { partOfSpeech: string; definitions: { definition: string }[] }[] }[];
    const m = r[0]?.meanings?.[0];
    return { summary: m ? `${r[0]!.word} (${m.partOfSpeech}): ${m.definitions[0]?.definition}` : `No definition for "${word}".`, data: r[0]?.meanings?.map((x) => ({ part: x.partOfSpeech, definition: x.definitions[0]?.definition })) ?? null, sourceUrl: url };
  },
  datamuse: async (query) => {
    const r = (await safeGet(`https://api.datamuse.com/words?ml=${q(query || 'ocean')}&max=10`)) as { word: string }[];
    return { summary: `Words related to "${query || 'ocean'}": ${r.slice(0, 8).map((w) => w.word).join(', ')}.`, data: r.map((w) => w.word), sourceUrl: 'https://www.datamuse.com/api/' };
  },

  // ---- Culture, media & fun 🎨 ----
  'art-institute-chicago': async (query) => {
    const url = `https://api.artic.edu/api/v1/artworks/search?q=${q(query || 'Monet')}&limit=5&fields=title,artist_title,date_display`;
    const r = (await safeGetH(url, { 'AIC-User-Agent': 'CodeConClave AgentSai (founder@codeconclave.app)' })) as { data: { title: string; artist_title?: string; date_display?: string }[] };
    return { summary: `${r.data.length} artworks matching "${query}". Top: ${r.data[0]?.title ?? 'none'} by ${r.data[0]?.artist_title ?? '?'}.`, data: r.data.map((a) => ({ title: a.title, artist: a.artist_title, date: a.date_display })), sourceUrl: 'https://www.artic.edu' };
  },
  tvmaze: async (query) => {
    const r = (await safeGet(`https://api.tvmaze.com/search/shows?q=${q(query || 'breaking bad')}`)) as { show: { name: string; premiered?: string; rating?: { average?: number }; genres?: string[] } }[];
    const s = r[0]?.show;
    return { summary: s ? `${s.name} (${s.premiered?.slice(0, 4) ?? '?'}) — rating ${s.rating?.average ?? 'n/a'}, ${s.genres?.join('/') ?? ''}.` : `No TV show "${query}".`, data: r.slice(0, 5).map((x) => ({ name: x.show.name, year: x.show.premiered?.slice(0, 4), rating: x.show.rating?.average })), sourceUrl: 'https://www.tvmaze.com' };
  },
  poetrydb: async (query) => {
    const r = (await safeGet(`https://poetrydb.org/author/${q(query || 'Shakespeare')}/title`)) as { title: string }[] | { status: number };
    const list = Array.isArray(r) ? r : [];
    return { summary: list.length ? `${list.length} poems by "${query || 'Shakespeare'}". e.g. ${list.slice(0, 3).map((p) => p.title).join(', ')}.` : `No poems for author "${query}".`, data: list.slice(0, 10).map((p) => p.title), sourceUrl: 'https://poetrydb.org' };
  },
  quran: async (query) => {
    const ref = query.trim() || '1:1';
    const r = (await safeGet(`https://api.alquran.cloud/v1/ayah/${q(ref)}/en.asad`)) as { status: string; data?: { text: string; surah?: { englishName: string } } };
    const d = r.data;
    return { summary: d ? `Quran ${ref} (${d.surah?.englishName ?? ''}): "${d.text}"` : `No verse "${ref}" (try like 2:255).`, data: d ?? null, sourceUrl: 'https://alquran.cloud' };
  },
  'trivia-opentdb': async () => {
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
    const r = (await safeGet('https://opentdb.com/api.php?amount=5&type=multiple')) as { results: { category: string; question: string; correct_answer: string }[] };
    return { summary: `${r.results.length} trivia questions. e.g. ${decode(r.results[0]?.question ?? '')}`, data: r.results.map((x) => ({ category: x.category, question: decode(x.question), answer: decode(x.correct_answer) })), sourceUrl: 'https://opentdb.com' };
  },
  xkcd: async () => {
    const r = (await safeGet('https://xkcd.com/info.0.json')) as { num: number; title: string; alt?: string; img?: string };
    return { summary: `Latest xkcd #${r.num}: "${r.title}".`, data: { num: r.num, title: r.title, alt: r.alt, img: r.img }, sourceUrl: `https://xkcd.com/${r.num}/` };
  },

  // ---- More package ecosystems 📦 ----
  packagist: async (query) => {
    const r = (await safeGet(`https://packagist.org/search.json?q=${q(query || 'laravel')}&per_page=5`)) as { results: { name: string; downloads?: number; description?: string }[] };
    return { summary: `${r.results.length} PHP/Composer packages for "${query}". Top: ${r.results[0]?.name ?? 'none'}.`, data: r.results.map((p) => ({ name: p.name, downloads: p.downloads, description: p.description })), sourceUrl: 'https://packagist.org' };
  },
  'pub-dev': async (query) => {
    const r = (await safeGet(`https://pub.dev/api/search?q=${q(query || 'http')}`)) as { packages?: { package: string }[] };
    const pkgs = (r.packages ?? []).slice(0, 8).map((p) => p.package);
    return { summary: `${pkgs.length} Dart/Flutter packages for "${query || 'http'}": ${pkgs.slice(0, 5).join(', ')}.`, data: pkgs, sourceUrl: 'https://pub.dev' };
  },
  pypi: async (query) => {
    const pkg = (query.trim() || 'requests').toLowerCase();
    const url = `https://pypi.org/pypi/${q(pkg)}/json`;
    const r = (await safeGet(url)) as { info?: { name: string; version: string; summary?: string; author?: string } };
    const i = r.info;
    return { summary: i ? `PyPI ${i.name} ${i.version}: ${i.summary ?? ''}` : `No PyPI package "${pkg}".`, data: i ? { name: i.name, version: i.version, summary: i.summary, author: i.author } : null, sourceUrl: `https://pypi.org/project/${pkg}/` };
  },
  homebrew: async (query) => {
    const name = (query.trim() || 'wget').toLowerCase();
    const r = (await safeGet(`https://formulae.brew.sh/api/formula/${q(name)}.json`)) as { name: string; desc?: string; versions?: { stable?: string } };
    return { summary: r.name ? `Homebrew ${r.name} ${r.versions?.stable ?? ''}: ${r.desc ?? ''}` : `No Homebrew formula "${name}".`, data: { name: r.name, version: r.versions?.stable, desc: r.desc }, sourceUrl: `https://formulae.brew.sh/formula/${name}` };
  },
  nuget: async (query) => {
    const r = (await safeGet(`https://azuresearch-usnc.nuget.org/query?q=${q(query || 'newtonsoft')}&take=5`)) as { data: { id: string; version: string; totalDownloads?: number }[] };
    return { summary: `${r.data.length} NuGet (.NET) packages for "${query}". Top: ${r.data[0]?.id ?? 'none'} (${(r.data[0]?.totalDownloads ?? 0).toLocaleString()} downloads).`, data: r.data.map((p) => ({ id: p.id, version: p.version, downloads: p.totalDownloads })), sourceUrl: 'https://www.nuget.org' };
  },
  'go-modules': async (query) => {
    const mod = (query.trim() || 'github.com/gin-gonic/gin').toLowerCase();
    const r = (await safeGet(`https://proxy.golang.org/${encodeURI(mod)}/@latest`)) as { Version?: string; Time?: string };
    return { summary: r.Version ? `Go module ${mod}: latest ${r.Version} (${r.Time?.slice(0, 10) ?? ''}).` : `No Go module "${mod}".`, data: r, sourceUrl: `https://pkg.go.dev/${mod}` };
  },

  // ---- Health (more) 💊 ----
  rxnorm: async (query) => {
    const r = (await safeGet(`https://rxnav.nlm.nih.gov/REST/drugs.json?name=${q(query || 'aspirin')}`)) as { drugGroup?: { conceptGroup?: { conceptProperties?: { name: string; rxcui: string }[] }[] } };
    const props = (r.drugGroup?.conceptGroup ?? []).flatMap((g) => g.conceptProperties ?? []);
    return { summary: props.length ? `${props.length} drug entries for "${query || 'aspirin'}". e.g. ${props.slice(0, 3).map((p) => p.name).join(', ')}.` : `No drug "${query}".`, data: props.slice(0, 8).map((p) => ({ name: p.name, rxcui: p.rxcui })), sourceUrl: 'https://rxnav.nlm.nih.gov' };
  },

  // ---- Batch 3: articles, books, India, images, voice, more 📰📚🖼️🔊 ----
  // Articles & knowledge
  'dev-to': async (query) => {
    const url = `https://dev.to/api/articles?per_page=5${query.trim() ? `&tag=${q(query.trim().toLowerCase())}` : ''}`;
    const r = (await safeGet(url)) as { title: string; url: string; user?: { name: string }; positive_reactions_count?: number }[];
    return { summary: `${r.length} DEV articles${query ? ` tagged "${query}"` : ''}. Top: ${r[0]?.title ?? 'none'}.`, data: r.map((a) => ({ title: a.title, by: a.user?.name, reactions: a.positive_reactions_count, url: a.url })), sourceUrl: 'https://dev.to' };
  },
  lobsters: async () => {
    const r = (await safeGet('https://lobste.rs/hottest.json')) as { title: string; url: string; score: number; comment_count: number }[];
    return { summary: `Hottest on Lobsters: ${r.slice(0, 3).map((s) => s.title).join(' | ')}`, data: r.slice(0, 6).map((s) => ({ title: s.title, score: s.score, comments: s.comment_count, url: s.url })), sourceUrl: 'https://lobste.rs' };
  },
  'wikipedia-on-this-day': async () => {
    const d = new Date();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const r = (await safeGet(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`)) as { events?: { text: string; year: number }[] };
    const evs = (r.events ?? []).slice(0, 6);
    return { summary: `On this day (${mm}/${dd}): ${evs.slice(0, 2).map((e) => `${e.year} — ${e.text}`).join(' · ')}`, data: evs.map((e) => ({ year: e.year, text: e.text })), sourceUrl: 'https://en.wikipedia.org' };
  },
  'spaceflight-news': async (query) => {
    const url = `https://api.spaceflightnewsapi.net/v4/articles/?limit=5${query.trim() ? `&search=${q(query.trim())}` : ''}`;
    const r = (await safeGet(url)) as { results: { title: string; news_site: string; url: string }[] };
    return { summary: `${r.results.length} space-news articles${query ? ` on "${query}"` : ''}. Top: ${r.results[0]?.title ?? 'none'}.`, data: r.results.map((a) => ({ title: a.title, site: a.news_site, url: a.url })), sourceUrl: 'https://spaceflightnewsapi.net' };
  },
  'wikidata-search': async (query) => {
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q(query || 'India')}&language=en&format=json&limit=5&origin=*`;
    const r = (await safeGet(url)) as { search: { label: string; description?: string; id: string }[] };
    return { summary: `${r.search.length} Wikidata entities for "${query}". Top: ${r.search[0]?.label ?? 'none'} — ${r.search[0]?.description ?? ''}.`, data: r.search.map((s) => ({ id: s.id, label: s.label, description: s.description })), sourceUrl: 'https://www.wikidata.org' };
  },

  // Books (incl. Indian)
  'internet-archive-books': async (query) => {
    const url = `https://archive.org/advancedsearch.php?q=${q(query || 'India')}+AND+mediatype:texts&fl[]=title&fl[]=creator&fl[]=year&rows=5&output=json`;
    const r = (await safeGet(url)) as { response?: { docs: { title?: string; creator?: string; year?: string }[] } };
    const docs = r.response?.docs ?? [];
    return { summary: `${docs.length} archived texts/books for "${query}". Top: ${docs[0]?.title ?? 'none'}.`, data: docs.map((d) => ({ title: d.title, creator: d.creator, year: d.year })), sourceUrl: 'https://archive.org' };
  },

  // India datasets
  'ifsc-razorpay': async (query) => {
    const code = (query.trim() || 'SBIN0000001').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = (await safeGet(`https://ifsc.razorpay.com/${q(code)}`)) as { BANK?: string; BRANCH?: string; CITY?: string; STATE?: string; ADDRESS?: string };
    return { summary: r.BANK ? `${code}: ${r.BANK}, ${r.BRANCH} branch, ${r.CITY}, ${r.STATE}.` : `No Indian bank branch for IFSC "${code}".`, data: r, sourceUrl: 'https://razorpay.com/ifsc' };
  },
  universities: async (query) => {
    const hasCountry = !query.trim();
    const url = `http://universities.hipolabs.com/search?${hasCountry ? 'country=India' : `name=${q(query.trim())}`}`;
    const r = (await safeGet(url)) as { name: string; country: string; web_pages: string[] }[];
    return { summary: `${r.length} universities${hasCountry ? ' in India' : ` matching "${query}"`}. e.g. ${r.slice(0, 3).map((u) => u.name).join(', ')}.`, data: r.slice(0, 8).map((u) => ({ name: u.name, country: u.country, web: u.web_pages?.[0] })), sourceUrl: 'https://github.com/Hipo/university-domains-list' };
  },
  themealdb: async (query) => {
    const url = `https://www.themealdb.com/api/json/v1/1/search.php?s=${q(query || 'biryani')}`;
    const r = (await safeGet(url)) as { meals: { strMeal: string; strArea?: string; strCategory?: string }[] | null };
    const meals = r.meals ?? [];
    return { summary: meals.length ? `${meals.length} recipes for "${query}". Top: ${meals[0]?.strMeal} (${meals[0]?.strArea} ${meals[0]?.strCategory}).` : `No recipe "${query}".`, data: meals.slice(0, 5).map((m) => ({ meal: m.strMeal, area: m.strArea, category: m.strCategory })), sourceUrl: 'https://www.themealdb.com' };
  },

  // Images 🖼️
  'nasa-images': async (query) => {
    const url = `https://images-api.nasa.gov/search?q=${q(query || 'earth')}&media_type=image`;
    const r = (await safeGet(url)) as { collection?: { items: { data: { title: string }[]; links?: { href: string }[] }[] } };
    const items = r.collection?.items ?? [];
    return { summary: `${items.length} NASA images for "${query}". Top: ${items[0]?.data[0]?.title ?? 'none'}.`, data: items.slice(0, 5).map((i) => ({ title: i.data[0]?.title, image: i.links?.[0]?.href })), sourceUrl: 'https://images.nasa.gov' };
  },
  'wikimedia-commons': async (query) => {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${q(query || 'India')}&srnamespace=6&srlimit=6&format=json&origin=*`;
    const r = (await safeGet(url)) as { query?: { search: { title: string }[] } };
    const hits = r.query?.search ?? [];
    return { summary: `${hits.length} Wikimedia Commons media files for "${query}".`, data: hits.map((h) => ({ title: h.title, page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(h.title)}` })), sourceUrl: 'https://commons.wikimedia.org' };
  },
  'dog-images': async (query) => {
    const breed = query.trim().toLowerCase().replace(/[^a-z]/g, '');
    const url = breed ? `https://dog.ceo/api/breed/${q(breed)}/images/random` : 'https://dog.ceo/api/breeds/image/random';
    const r = (await safeGet(url)) as { message: string; status: string };
    return { summary: r.status === 'success' ? `A random ${breed || 'dog'} image.` : `No images for breed "${breed}".`, data: { image: r.message }, sourceUrl: 'https://dog.ceo' };
  },

  // Voice & audio 🔊
  'itunes-search': async (query) => {
    const url = `https://itunes.apple.com/search?term=${q(query || 'lo-fi')}&limit=5`;
    const r = (await safeGet(url)) as { results: { trackName?: string; artistName?: string; previewUrl?: string; kind?: string }[] };
    return { summary: `${r.results.length} audio tracks for "${query}". Top: ${r.results[0]?.trackName ?? 'none'} by ${r.results[0]?.artistName ?? '?'}.`, data: r.results.map((t) => ({ track: t.trackName, artist: t.artistName, preview: t.previewUrl, kind: t.kind })), sourceUrl: 'https://music.apple.com' };
  },
  'radio-browser': async (query) => {
    const url = `https://de1.api.radio-browser.info/json/stations/search?name=${q(query || 'radio')}&limit=5&hidebroken=true`;
    const r = (await safeGet(url)) as { name: string; country: string; url_resolved: string; tags: string }[];
    return { summary: `${r.length} live radio stations for "${query}". Top: ${r[0]?.name ?? 'none'} (${r[0]?.country ?? ''}).`, data: r.map((s) => ({ name: s.name, country: s.country, stream: s.url_resolved, tags: s.tags })), sourceUrl: 'https://www.radio-browser.info' };
  },
  librivox: async (query) => {
    const url = `https://librivox.org/api/feed/audiobooks?title=${q('^' + (query.trim() || 'India'))}&format=json&limit=5`;
    const r = (await safeGet(url)) as { books?: { title: string; authors?: { first_name: string; last_name: string }[]; url_librivox?: string }[] };
    const books = r.books ?? [];
    return { summary: `${books.length} free audiobooks for "${query}". Top: ${books[0]?.title ?? 'none'}.`, data: books.map((b) => ({ title: b.title, author: b.authors?.[0] ? `${b.authors[0].first_name} ${b.authors[0].last_name}` : '?', url: b.url_librivox })), sourceUrl: 'https://librivox.org' };
  },
  // Weather extras & facts
  'open-meteo-marine': async (query) => {
    const g = await geocodeCity(query || 'Chennai');
    const r = (await safeGet(`https://marine-api.open-meteo.com/v1/marine?latitude=${g.lat}&longitude=${g.lon}&current=wave_height,wave_period`)) as { current?: { wave_height?: number; wave_period?: number } };
    const c = r.current;
    return { summary: c?.wave_height != null ? `${g.name}: wave height ${c.wave_height} m, period ${c.wave_period ?? '?'} s.` : `No marine/wave data near "${query}" (try a coastal city).`, data: { place: g.name, ...c }, sourceUrl: 'https://open-meteo.com/en/docs/marine-weather-api' };
  },
  'open-meteo-flood': async (query) => {
    const g = await geocodeCity(query || 'Patna');
    const r = (await safeGet(`https://flood-api.open-meteo.com/v1/flood?latitude=${g.lat}&longitude=${g.lon}&daily=river_discharge&forecast_days=1`)) as { daily?: { river_discharge?: (number | null)[] } };
    const d = r.daily?.river_discharge?.[0];
    return { summary: d != null ? `${g.name}: river discharge ${d} m³/s today.` : `No river/flood data near "${query}".`, data: { place: g.name, riverDischarge: d }, sourceUrl: 'https://open-meteo.com/en/docs/flood-api' };
  },
  'country-info': async (query) => {
    const r = (await safeGet('https://api.first.org/data/v1/countries?limit=400')) as { data: Record<string, { country: string; region?: string }> };
    const ql = (query.trim() || 'India').toLowerCase();
    const hits = Object.entries(r.data).filter(([code, v]) => v.country.toLowerCase().includes(ql) || code.toLowerCase() === ql).slice(0, 5);
    return { summary: hits.length ? `${hits.length} countries matching "${query}": ${hits.map(([c, v]) => `${v.country} (${c}, ${v.region})`).join(', ')}.` : `No country "${query}".`, data: hits.map(([code, v]) => ({ code, country: v.country, region: v.region })), sourceUrl: 'https://api.first.org' };
  },
  'name-predict': async (query) => {
    const name = query.trim() || 'Raj';
    const [g, a, n] = (await Promise.all([
      safeGet(`https://api.genderize.io?name=${q(name)}`),
      safeGet(`https://api.agify.io?name=${q(name)}`),
      safeGet(`https://api.nationalize.io?name=${q(name)}`),
    ])) as [{ gender?: string; probability?: number }, { age?: number }, { country?: { country_id: string; probability: number }[] }];
    const topCountry = n.country?.[0]?.country_id;
    return { summary: `"${name}" → likely ${g.gender ?? '?'}, around age ${a.age ?? '?'}, most likely from ${topCountry ?? '?'}.`, data: { gender: g.gender, age: a.age, topCountry }, sourceUrl: 'https://genderize.io' };
  },
  zenquotes: async () => {
    const r = (await safeGet('https://zenquotes.io/api/random')) as { q: string; a: string }[];
    const quote = r[0];
    return { summary: quote ? `"${quote.q}" — ${quote.a}` : 'No quote right now.', data: quote ?? null, sourceUrl: 'https://zenquotes.io' };
  },
  'disease-sh': async (query) => {
    const country = query.trim() || 'India';
    const r = (await safeGet(`https://disease.sh/v3/covid-19/countries/${q(country)}`)) as { country?: string; cases?: number; deaths?: number; recovered?: number; population?: number };
    return { summary: r.country ? `${r.country}: ${r.cases?.toLocaleString()} total COVID cases, ${r.deaths?.toLocaleString()} deaths.` : `No health data for "${country}".`, data: r, sourceUrl: 'https://disease.sh' };
  },
  'iss-location': async () => {
    const r = (await safeGet('http://api.open-notify.org/iss-now.json')) as { iss_position?: { latitude: string; longitude: string }; timestamp?: number };
    const p = r.iss_position;
    return { summary: p ? `The ISS is right now over latitude ${p.latitude}, longitude ${p.longitude}.` : 'No ISS position.', data: p ?? null, sourceUrl: 'https://open-notify.org' };
  },
  kitsu: async (query) => {
    const r = (await safeGetH(`https://kitsu.io/api/edge/anime?filter[text]=${q(query || 'naruto')}&page[limit]=5`, { Accept: 'application/vnd.api+json' })) as { data: { attributes: { canonicalTitle: string; averageRating?: string; startDate?: string } }[] };
    return { summary: `${r.data.length} anime for "${query}". Top: ${r.data[0]?.attributes.canonicalTitle ?? 'none'} (rating ${r.data[0]?.attributes.averageRating ?? 'n/a'}).`, data: r.data.map((a) => ({ title: a.attributes.canonicalTitle, rating: a.attributes.averageRating, start: a.attributes.startDate })), sourceUrl: 'https://kitsu.io' };
  },
  'cat-facts': async () => {
    const r = (await safeGet('https://catfact.ninja/fact')) as { fact: string };
    return { summary: r.fact, data: r, sourceUrl: 'https://catfact.ninja' };
  },
  'advice-slip': async () => {
    const r = (await safeGet('https://api.adviceslip.com/advice')) as { slip?: { advice: string } };
    return { summary: r.slip?.advice ?? 'No advice right now.', data: r.slip ?? null, sourceUrl: 'https://api.adviceslip.com' };
  },

  // ---- Batch 3b: a few more reliable keyless ----
  'wikipedia-featured': async () => {
    const d = new Date(Date.now() - 86_400_000);
    const url = `https://en.wikipedia.org/api/rest_v1/feed/featured/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    const r = (await safeGet(url)) as { tfa?: { normalizedtitle?: string }; mostread?: { articles: { normalizedtitle: string; views: number }[] } };
    const most = r.mostread?.articles ?? [];
    return { summary: `Wikipedia today — featured: ${r.tfa?.normalizedtitle ?? '?'}. Most read: ${most.slice(0, 3).map((a) => a.normalizedtitle).join(', ')}.`, data: { featured: r.tfa?.normalizedtitle, mostRead: most.slice(0, 8).map((a) => ({ title: a.normalizedtitle, views: a.views })) }, sourceUrl: 'https://en.wikipedia.org' };
  },
  thecocktaildb: async (query) => {
    const r = (await safeGet(`https://www.thecocktaildb.com/api/json/v1/1/search.php?s=${q(query || 'margarita')}`)) as { drinks: { strDrink: string; strCategory?: string; strAlcoholic?: string }[] | null };
    const drinks = r.drinks ?? [];
    return { summary: drinks.length ? `${drinks.length} drinks for "${query}". Top: ${drinks[0]?.strDrink} (${drinks[0]?.strAlcoholic}).` : `No drink "${query}".`, data: drinks.slice(0, 5).map((d) => ({ drink: d.strDrink, category: d.strCategory, alcoholic: d.strAlcoholic })), sourceUrl: 'https://www.thecocktaildb.com' };
  },
  pokeapi: async (query) => {
    const name = (query.trim() || 'pikachu').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const r = (await safeGet(`https://pokeapi.co/api/v2/pokemon/${q(name)}`)) as { name: string; height: number; weight: number; types: { type: { name: string } }[] };
    return { summary: `${r.name}: type ${r.types.map((t) => t.type.name).join('/')}, height ${r.height / 10} m, weight ${r.weight / 10} kg.`, data: { name: r.name, types: r.types.map((t) => t.type.name), height: r.height, weight: r.weight }, sourceUrl: `https://pokeapi.co` };
  },
  'people-in-space': async () => {
    const r = (await safeGet('http://api.open-notify.org/astros.json')) as { number: number; people: { name: string; craft: string }[] };
    return { summary: `${r.number} people are in space right now: ${r.people.map((p) => `${p.name} (${p.craft})`).join(', ')}.`, data: r.people, sourceUrl: 'https://open-notify.org' };
  },
  'us-weather-alerts': async (query) => {
    const area = (query.trim() || 'CA').toUpperCase().slice(0, 2);
    const r = (await safeGet(`https://api.weather.gov/alerts/active?area=${q(area)}`)) as { features: { properties: { event: string; headline?: string } }[] };
    return { summary: `${r.features.length} active US weather alerts for ${area}. e.g. ${r.features[0]?.properties.event ?? 'none'}.`, data: r.features.slice(0, 6).map((f) => ({ event: f.properties.event, headline: f.properties.headline })), sourceUrl: 'https://www.weather.gov' };
  },
  fruityvice: async (query) => {
    const name = (query.trim() || 'banana').toLowerCase().replace(/[^a-z]/g, '');
    const r = (await safeGet(`https://www.fruityvice.com/api/fruit/${q(name)}`)) as { name?: string; family?: string; nutritions?: { calories: number; sugar: number; carbohydrates: number } };
    return { summary: r.name ? `${r.name} (${r.family}): ${r.nutritions?.calories} kcal, ${r.nutritions?.sugar}g sugar per 100g.` : `No fruit "${name}".`, data: r, sourceUrl: 'https://www.fruityvice.com' };
  },
  'carbon-intensity': async () => {
    const r = (await safeGet('https://api.carbonintensity.org.uk/intensity')) as { data: { intensity: { actual?: number; forecast?: number; index: string } }[] };
    const i = r.data[0]?.intensity;
    return { summary: i ? `UK grid carbon intensity: ${i.actual ?? i.forecast} gCO₂/kWh — "${i.index}".` : 'No carbon data.', data: i ?? null, sourceUrl: 'https://carbonintensity.org.uk' };
  },

  // ---- Satellite tracking (free, keyless — eyes in the sky) 🛰️ ----
  'satellite-position': async (query) => {
    // Live position of a satellite by its NORAD id (default 25544 = the ISS).
    const id = /^\d+$/.test(query.trim()) ? query.trim() : '25544';
    const r = (await safeGet(`https://api.wheretheiss.at/v1/satellites/${q(id)}`)) as { name: string; latitude: number; longitude: number; altitude: number; velocity: number; visibility?: string };
    return { summary: `Satellite ${r.name} (#${id}) is right now at lat ${r.latitude.toFixed(2)}, lon ${r.longitude.toFixed(2)}, altitude ${Math.round(r.altitude)} km, speed ${Math.round(r.velocity).toLocaleString()} km/h${r.visibility ? ` (${r.visibility})` : ''}.`, data: { name: r.name, lat: r.latitude, lon: r.longitude, altitudeKm: r.altitude, velocityKmh: r.velocity, visibility: r.visibility }, sourceUrl: 'https://wheretheiss.at' };
  },
  'satellite-catalog': async (query) => {
    // Which satellites are up there, by group (CelesTrak orbital data).
    // Only groups small enough to fit the response cap (Starlink/active are huge).
    const GROUPS = ['visual', 'stations', 'weather', 'noaa', 'goes', 'gps-ops', 'galileo', 'science', 'geo', 'last-30-days'];
    const ALIAS: Record<string, string> = { iss: 'stations', 'space-station': 'stations', 'space station': 'stations', new: 'last-30-days', recent: 'last-30-days', bright: 'visual', gps: 'gps-ops' };
    const raw = query.trim().toLowerCase();
    const ql = ALIAS[raw] ?? raw.replace(/\s+/g, '-');
    const group = GROUPS.find((g) => g === ql || g.includes(ql) || (ql && ql.includes(g))) || 'visual';
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${q(group)}&FORMAT=json`;
    const r = (await safeGet(url)) as { OBJECT_NAME: string; NORAD_CAT_ID?: number; MEAN_MOTION?: number }[];
    if (!Array.isArray(r) || !r.length) throw new Error(`No satellites for group "${group}". Try: visual, stations, starlink, weather, gps, science.`);
    return { summary: `${r.length} satellites currently tracked in the "${group}" group. e.g. ${r.slice(0, 4).map((s) => s.OBJECT_NAME).join(', ')}.`, data: r.slice(0, 12).map((s) => ({ name: s.OBJECT_NAME, noradId: s.NORAD_CAT_ID, orbitsPerDay: s.MEAN_MOTION })), sourceUrl: `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}` };
  },
};

/** IDs of sources Agent Sai can actually pull right now. */
export function liveSourceIds(): string[] {
  return Object.keys(CONNECTORS);
}

// ---- Agent Sai's warm cache (speed) -------------------------------------
// Instant repeat answers: the 2nd person asking the same thing gets it from
// memory, no re-fetch. Honest — every cached answer still carries its real
// fetch time and age, and the UI shows when it was last refreshed.
interface CacheEntry {
  evidence: SaiEvidence;
  storedAt: number;
  expires: number;
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX = 3000;

/** Freshness window per source (how long a cached answer stays "good"). */
function ttlMsFor(sourceId: string, category: string): number {
  const MIN = 60_000;
  const byId: Record<string, number> = {
    'opensky-network': 2 * MIN,
    coingecko: 5 * MIN,
    'usgs-earthquakes': 10 * MIN,
    aqicn: 20 * MIN,
    'data-gov-in': 60 * MIN,
    agmarknet: 60 * MIN,
  };
  if (byId[sourceId]) return byId[sourceId]!;
  const byCat: Record<string, number> = {
    'Web & Knowledge': 15 * MIN,
    'Dev & Security': 60 * MIN,
    'Finance & Business': 10 * MIN,
    'India Public Data': 30 * MIN,
    'Science & Research': 360 * MIN,
    'Health & Medicine': 360 * MIN,
    'Earth & Environment': 30 * MIN,
    'Disasters & Humanitarian': 10 * MIN,
    'Culture & Media': 720 * MIN,
    'Daily Life & Mobility': 30 * MIN,
    Sports: 10 * MIN,
  };
  return byCat[category] ?? 30 * MIN;
}

export function saiCacheStats(): { entries: number } {
  return { entries: CACHE.size };
}

/**
 * Run one connector. Two layers of warm cache before any real fetch:
 *   L1 — this process's in-memory cache (instant, per-server).
 *   L2 — the SHARED case file (the sai_cache table): what any OTHER regional
 *        detective already caught. So a pull by US Sai is instantly reusable by
 *        India Sai without re-hitting the public API.
 * A miss on both does a real fetch and writes through to L1 + the shared file.
 * `force` always fetches fresh (used by the 24/7 refresh). Throws an honest
 * Error on failure — never fakes data. The shared file is best-effort: if the
 * database is down it is skipped quietly and the answer still comes back real.
 */
export async function runConnector(sourceId: string, query: string, force = false): Promise<SaiEvidence> {
  const src = sourceById(sourceId);
  const conn = CONNECTORS[sourceId];
  if (!src) throw new Error(`Unknown source "${sourceId}"`);
  if (!conn) throw new Error(`Agent Sai Srinivasa Athreya has catalogued "${src.n}" but it is not live yet.`);

  const key = `${sourceId}\n${query}`;
  const now = Date.now();
  if (!force) {
    // L1: this server's own memory.
    const hit = CACHE.get(key);
    if (hit && now < hit.expires) {
      return { ...hit.evidence, cached: true, ageSeconds: Math.round((now - hit.storedAt) / 1000) };
    }
    // L2: the shared case file — maybe another region already caught it.
    const shared = await readCaseFile(key);
    if (shared) {
      rememberL1(key, shared.evidence, shared.storedAt, shared.expires);
      return { ...shared.evidence, cached: true, ageSeconds: Math.round((now - shared.storedAt) / 1000) };
    }
  }

  const { summary, data, sourceUrl } = await conn(query);
  const evidence: SaiEvidence = { sourceId, source: src.n, query, summary, data, sourceUrl, fetchedAt: new Date(now).toISOString(), cached: false, ageSeconds: 0 };
  const expires = now + ttlMsFor(sourceId, src.category);
  rememberL1(key, evidence, now, expires);
  // Share the catch with every other region (fire-and-forget, never blocks).
  void writeCaseFile(key, sourceId, query, evidence, now, expires);
  return evidence;
}

/** Store one entry in the in-memory L1 cache, evicting the oldest if full. */
function rememberL1(key: string, evidence: SaiEvidence, storedAt: number, expires: number): void {
  if (CACHE.size >= CACHE_MAX && !CACHE.has(key)) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of CACHE) if (v.storedAt < oldest) ((oldest = v.storedAt), (oldestKey = k));
    if (oldestKey) CACHE.delete(oldestKey);
  }
  CACHE.set(key, { evidence, storedAt, expires });
}

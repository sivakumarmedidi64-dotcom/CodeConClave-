/**
 * CodeConClave — Network Resilience Checker (#23, PKG-15).
 * Deterministic static assessment of a workspace's network resilience facets:
 * circuit breaking, retry/backoff, timeouts, health checks, and dependency
 * resilience. Source is scanned as untrusted text (see security.ts); the
 * report is advisory and never executes or changes anything.
 */
import { newId, PREFIX } from '../../shared/ids.js';
import { listScanFiles } from './security.js';
import type {
  FacetResult,
  NetworkResilienceReport,
  NetworkResilienceRequest,
  ResilienceFacet,
  ResilienceFinding,
  TruthfulnessState,
} from './types.js';

interface FacetRule {
  facet: ResilienceFacet;
  title: string;
  pass: RegExp[];
  warn: RegExp[];
  recommendation: string;
}

const RULES: FacetRule[] = [
  {
    facet: 'CIRCUIT_BREAKER',
    title: 'Circuit braking is configured',
    pass: [
      /\bcircuit\s*Breaker\b/i,
      /\bbreaker\s*\.\s*OPEN\b/i,
      /@opossum\b/i,
      /circuit[\s_-]?breaker/i,
      /\bopossum/i,
    ],
    warn: [/coffeehouse/i],
    recommendation: 'Add a circuit breaker (e.g. opossum) around external calls so a failing dependency does not cascade.',
  },
  {
    facet: 'RETRY_BACKOFF',
    title: 'Retries with backoff are used',
    pass: [
      /\bexponential\s*backoff\b/i,
      /\bmaxRetries\b/i,
      /\bmax_retries\b/i,
      /\bretries\s*:\s*\d+/i,
      /\bretry\b[\s\S]{0,120}\bbackoff\b/i,
      /\bbackoff\b[\s\S]{0,120}\bretry\b/i,
      /\bretryable\b/i,
    ],
    warn: [/\bretry\s*\(\s*(\d)\s*\)/i, /\bretry:\s*true\b/i],
    recommendation: 'Use retries with exponential backoff and jitter rather than fixed/no retry.',
  },
  {
    facet: 'TIMEOUTS',
    title: 'Outbound requests have timeouts',
    pass: [
      /\bconnectTimeout\b/i,
      /\bfetchTimeout\b/i,
      /\brequestTimeout\b/i,
      /\bAbortController\b/i,
      /\babortSignal\b/i,
      /\bperTestTimeout\b/i,
      /\btimeout\s*:\s*[1-9]\d*/i,
      /\btimeout\s*=\s*[1-9]\d*/i,
    ],
    warn: [/\bfetch\s*\(/i],
    recommendation: 'Set explicit timeouts on every outbound HTTP/network call to avoid hangs.',
  },
  {
    facet: 'HEALTH_CHECKS',
    title: 'Health/readiness endpoints are defined',
    pass: [
      /['"`]\/health\b/i,
      /healthz/i,
      /readinessProbe/i,
      /livenessProbe/i,
      /health[\s_-]?check/i,
      /\bping\s*\(\s*\)/i,
    ],
    warn: [],
    recommendation: 'Expose /health and /ready endpoints so orchestrators can route and drain traffic safely.',
  },
  {
    facet: 'DEPENDENCY_RESILIENCE',
    title: 'External-dependent calls degrade gracefully',
    pass: [
      /\bdegrade\w*\b/i,
      /\bcatch\s*\([\s\S]{0,200}fallback\b/i,
      /\bfallback\b/i,
      /\bcircuitFallback\b/i,
      /\bdefaultValue\b/i,
      /\bdependencyFallback\b/i,
    ],
    warn: [/\bfetch\s*\(/i, /\baxios\b/i, /\bfetch_\w*\b/i],
    recommendation: 'Provide fallbacks/defaults when a dependency fails so the workspace degrades rather than fails hard.',
  },
];

const FACETS: ResilienceFacet[] = RULES.map((r) => r.facet);

function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const p of patterns) {
    p.lastIndex = 0;
    const m = text.match(new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`));
    if (m) n += m.length;
  }
  return n;
}

export async function checkNetworkResilience(
  userId: string,
  input: NetworkResilienceRequest,
): Promise<NetworkResilienceReport> {
  const { analyzable, skipped } = await listScanFiles(userId, input.projectId, input.fileIds);
  const source = analyzable.map((f) => f.text).join('\n');

  const findings: ResilienceFinding[] = [];
  const byFacet = {} as NetworkResilienceReport['byFacet'];

  for (const rule of RULES) {
    const passHits = countMatches(source, rule.pass);
    const warnHits = countMatches(source, rule.warn);
    let status: FacetResult = 'FAIL';
    let state: TruthfulnessState = 'HEURISTIC';
    if (passHits > 0) {
      status = 'PASS';
      state = 'VERIFIED';
    } else if (warnHits > 0) {
      status = 'WARN';
      state = 'HEURISTIC';
    } else if (analyzable.length === 0) {
      status = 'SKIP';
      state = 'UNAVAILABLE';
    }
    const evidence =
      status === 'SKIP'
        ? 'no scannable text files'
        : passHits > 0
          ? `${rule.title.toLowerCase()} matched in ${analyzable.length} scanned file(s)`
          : warnHits > 0
            ? 'partial markers found; may be insufficient'
            : 'no markers found across scanned files';
    findings.push({
      facet: rule.facet,
      status,
      state,
      confidence: status === 'PASS' || status === 'FAIL' ? 0.9 : 0.5,
      title: rule.title,
      evidence,
      recommendation: rule.recommendation,
    });
    byFacet[rule.facet] = { status, evidence };
  }

  const scoreMap: Record<FacetResult, number> = { PASS: 100, WARN: 60, FAIL: 30, SKIP: 0 };
  const present = findings.filter((f) => f.status !== 'SKIP');
  const score =
    present.length === 0
      ? 0
      : Math.round(present.reduce((acc, f) => acc + scoreMap[f.status], 0) / present.length);

  return {
    id: newId(PREFIX.SECOPS_NETWORK),
    projectId: input.projectId,
    generatedAt: new Date().toISOString(),
    filesScanned: analyzable.length,
    filesSkipped: skipped.length,
    score,
    findings,
    byFacet,
  };
}

export { FACETS };

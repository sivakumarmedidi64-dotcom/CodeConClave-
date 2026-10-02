/**
 * SecretGuard — pattern table and pure matching helpers.
 *
 * This module is deliberately dependency-free. It contains only regexes and
 * pure string functions so that offline tooling can use it without booting the
 * application graph.
 *
 * Why it is split out of ./service.ts
 * -----------------------------------
 * `npm run secret:scan` is a repository scanner: it walks the working tree and
 * reports path + kind + count. It never talks to a database, never resolves a
 * tenant and never needs a session. But it originally imported the pattern
 * table from ./service.js, which transitively imports ../../shared/db.js ->
 * ../../config/env.js. `env.ts` validates its schema at import time and throws
 * when DATABASE_URL is absent, so running the scanner required a valid
 * DATABASE_URL even though nothing in the scan path ever used it.
 *
 * That forced every CI environment — and every local `npm run lint` — to
 * fabricate a connection string just to typecheck the repo. Fabricated
 * connection strings then had to be allowlisted in .secret-scan-allowlist.json,
 * which is exactly the wrong shape for a secret-scanning control: the tool that
 * guards the secret surface was itself keeping a fake credential on record.
 *
 * Importing from this module instead lets `secret:scan` run with an empty
 * environment, so CI needs no DATABASE_URL, no allowlist entry, and no
 * placeholder secret of any kind.
 *
 * Matching semantics are unchanged: same patterns, same order, same 50-finding
 * cap, same redaction output. ./service.ts re-exports every symbol here, so all
 * existing importers keep working untouched.
 */

export interface SecretPattern {
  kind: string;
  label: string;
  re: RegExp;
  confidence: number;
}

export interface SecretFinding {
  kind: string;
  label: string;
  /** Character offset of the match. Findings never carry the matched value. */
  location: number;
  confidence: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { kind: 'aws_access_key_id', label: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, confidence: 0.95 },
  { kind: 'aws_secret_access_key', label: 'AWS secret access key', re: /\b(?<![A-Za-z0-9])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, confidence: 0.7 },
  { kind: 'github_pat', label: 'GitHub personal access token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, confidence: 0.95 },
  { kind: 'github_oauth', label: 'GitHub OAuth token', re: /\bgho_[A-Za-z0-9]{36,}\b/g, confidence: 0.95 },
  { kind: 'slack_token', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, confidence: 0.95 },
  { kind: 'private_key', label: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, confidence: 1 },
  { kind: 'google_api_key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, confidence: 0.95 },
  { kind: 'stripe_secret', label: 'Stripe secret key', re: /\bsk_live_[0-9A-Za-z]{24,}\b/g, confidence: 0.95 },
  { kind: 'openrouter_api_key', label: 'OpenRouter API key', re: /\bsk-or-v1-[0-9A-Za-z_-]{32,}\b/g, confidence: 0.95 },
  { kind: 'generic_api_key', label: 'API key', re: /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/gi, confidence: 0.6 },
  { kind: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, confidence: 0.9 },
  { kind: 'connection_string', label: 'Connection string', re: /\b(?:postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/[^\s"'<>]{6,}\b/gi, confidence: 0.9 },
];

/**
 * Find secret-shaped substrings. Results carry kind/label/offset/confidence
 * only — never the matched text, so a finding is always safe to log.
 */
export function scanContentForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const text = String(content ?? '');
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        kind: pattern.kind,
        label: pattern.label,
        location: m.index,
        confidence: pattern.confidence,
      });
      if (re.lastIndex === m.index) re.lastIndex++;
      if (findings.length >= 50) break;
    }
    if (findings.length >= 50) break;
  }
  findings.sort((a, b) => a.location - b.location);
  return findings;
}

/** Replace secret matches with placeholders so secrets are never logged. */
export function redactSecrets(content: string): string {
  let out = String(content ?? '');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.re, (m) => {
      const n = pattern.label;
      return m.length > 8 ? `[REDACTED:${n}]` : m;
    });
  }
  return out;
}

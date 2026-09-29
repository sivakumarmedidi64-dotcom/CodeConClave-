/**
 * CodeConClave — explicit reverse-proxy trust model.
 *
 * `TRUST_PROXY` is parsed into one of three unambiguous models instead of being
 * coerced with `=== 'true'`:
 *
 *   false                       no proxy in front; X-Forwarded-For is ignored
 *   <integer 1..10>             trust exactly N proxy hops from the socket
 *   <ip|cidr>[,<ip|cidr>...]    trust ONLY these proxy addresses/subnets
 *
 * The bare literal `true` is rejected in production: it makes Express trust the
 * entire X-Forwarded-For chain, so any client can spoof its own source address,
 * defeating per-IP rate limits and poisoning security audit records. Blind
 * boolean trust is a footgun, not a configuration.
 */
import { isIP, isIPv4 } from 'node:net';

export type TrustProxyModel =
  | { kind: 'none' }
  | { kind: 'hops'; hops: number }
  | { kind: 'addresses'; addresses: string[] };

export class TrustProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustProxyConfigError';
  }
}

function toCidr(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('/')) return trimmed;
  // A bare IPv4 address is widened to a single-host CIDR so Express's
  // proxy-addr treats it as a network rather than a fuzzy match.
  return isIPv4(trimmed) ? `${trimmed}/32` : trimmed;
}

/**
 * Parse TRUST_PROXY into a concrete model. Throws TrustProxyConfigError for any
 * value that is not one of the three supported forms — a malformed value must
 * fail loudly at boot rather than silently degrading to "trust nothing" (which
 * collapses every anonymous request into one shared rate-limit bucket) or
 * "trust everything" (which lets clients spoof their IP).
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyModel {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false' || value === '0') return { kind: 'none' };

  if (value.toLowerCase() === 'true' || value === '*') {
    throw new TrustProxyConfigError(
      'TRUST_PROXY=true is not a permitted proxy model: it trusts the entire X-Forwarded-For chain and lets clients spoof their own IP. ' +
        'Use TRUST_PROXY=<hop count 1-10> or TRUST_PROXY=<proxy ip/cidr list>.',
    );
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) {
      throw new TrustProxyConfigError(`TRUST_PROXY hop count must be between 1 and 10 (received ${value}).`);
    }
    return { kind: 'hops', hops };
  }

  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new TrustProxyConfigError('TRUST_PROXY is set but contains no proxy addresses.');
  }
  for (const part of parts) {
    const address = part.includes('/') ? part.slice(0, part.indexOf('/')) : part;
    if (isIP(address) === 0) {
      throw new TrustProxyConfigError(`TRUST_PROXY entry "${part}" is not a valid IP address or CIDR range.`);
    }
  }
  return { kind: 'addresses', addresses: parts.map(toCidr) };
}

/** Human-readable one-liner for boot logs. Never contains a secret. */
export function describeTrustProxy(model: TrustProxyModel): string {
  switch (model.kind) {
    case 'none':
      return 'none (direct, X-Forwarded-For ignored)';
    case 'hops':
      return `${model.hops} proxy hop(s)`;
    case 'addresses':
      return `trusted proxy ranges: ${model.addresses.length}`;
  }
}

/**
 * Convert the model into the value Express expects for `app.set('trust proxy')`.
 * The `addresses` model maps directly to Express's comma-separated allowlist.
 */
export function toExpressTrustProxy(model: TrustProxyModel): boolean | number | string {
  switch (model.kind) {
    case 'none':
      return false;
    case 'hops':
      return model.hops;
    case 'addresses':
      return model.addresses.join(', ');
  }
}

/**
 * Boot-time validation. In production an operator who deployed behind a load
 * balancer and left TRUST_PROXY unset gets every anonymous request attributed
 * to the proxy, so all logins share a single rate-limit bucket and the audit
 * trail loses the real client address. That is a launch-blocking misconfiguration
 * and must be a refusal, not a warning.
 */
export function assertTrustProxyUsable(model: TrustProxyModel, isProduction: boolean): void {
  if (!isProduction) return;
  if (model.kind === 'none') {
    throw new TrustProxyConfigError(
      'Missing production requirement: TRUST_PROXY. This deployment is configured to trust no proxy, so if the app runs behind a load balancer every client shares one IP and login rate limits/audit IPs become wrong. Set TRUST_PROXY to the proxy hop count or the proxy IP/CIDR list, or explicitly set TRUST_PROXY=0 only for a directly-exposed instance.',
    );
  }
}

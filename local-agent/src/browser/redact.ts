/**
 * CodeConClave Local Agent — lightweight secret redaction for browser-derived
 * text. Web page content is untrusted; anything we surface in progress events,
 * results or artifacts must never carry credentials. This mirrors the backend
 * secretGuard surface without importing it.
 */

const REDACTION_PATTERNS: Array<[RegExp, (m: string) => string]> = [
  [/authorization:\s+(basic|bearer)\s+\S+/gi, (m) => m.replace(/\S+$/, '***REDACTED***')],
  [/\b(bearer|token|sessionid|session|apikey|api_key|access_token|refresh_token)\s*[=:]\s*\S+/gi, (m) => m.replace(/\S+$/, '***REDACTED***')],
  [/(password|passwd|pwd|secret)\s*[=:]/gi, (m) => m + ' ***REDACTED***'],
  [/\b(ai_api_key|openai_api_key|claude_api_key)\b[^]\S*/gi, (m) => '***REDACTED***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => '***REDACTED***'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, () => '***REDACTED***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, () => '***REDACTED***'],
  [/\b(cookie|set-cookie)\s*[=:]\s*(?!\s*$)/gi, (m) => m.replace(/=\s*/gi, '=').replace(/[^=;]+$/, '***REDACTED***')],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacer] of REDACTION_PATTERNS) {
    out = out.replace(re, replacer);
  }
  return out;
}

/** Never read the value of sensitive form fields back out of a page. */
export function isPasswordField(field: { type?: unknown; autocomplete?: unknown }): boolean {
  const t = typeof field.type === 'string' ? field.type.toLowerCase() : '';
  const a = typeof field.autocomplete === 'string' ? field.autocomplete.toLowerCase() : '';
  return t === 'password' || a.includes('current-password') || a.includes('new-password');
}
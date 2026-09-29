/**
 * CodeConClave — handle + keyword POLICY (pure, no I/O).
 *
 * Split out of identity.ts so that auth/service.ts (registration) and
 * identity.ts (enrolment + login) share one source of truth without an
 * import cycle: identity.ts already imports from service.ts, so the reverse
 * edge has to go through a leaf module like this one.
 */
import { AppError } from '../../shared/errors.js';

const KEYWORD_MIN = 12;
const KEYWORD_MAX = 128;
const HANDLE_MIN = 3;
const HANDLE_MAX = 20;

/**
 * Handles that would let an account impersonate the product itself or a
 * system endpoint. Reserved names can never be registered, so support and
 * security addresses are unambiguous.
 */
const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'api', 'billing', 'codeconclave', 'contact',
  'dev', 'developer', 'docs', 'email', 'founder', 'ftp', 'help', 'host',
  'info', 'login', 'mail', 'marketing', 'news', 'null', 'official',
  'payment', 'payments', 'pricing', 'privacy', 'root', 'sales', 'security',
  'signup', 'ssl', 'static', 'status', 'support', 'system', 'team', 'test',
  'terms', 'undefined', 'user', 'users', 'www',
]);

/**
 * Normalize a handle to its canonical form. Login, registration and enrolment
 * must agree exactly, and uniqueness is enforced on lower(handle) in the
 * database.
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateHandle(raw: string): string {
  const handle = normalizeHandle(raw);
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    throw AppError.badRequest('invalid_handle', `Handle must be ${HANDLE_MIN}-${HANDLE_MAX} characters`);
  }
  if (!/^[a-z0-9][a-z0-9_]*$/.test(handle)) {
    throw AppError.badRequest(
      'invalid_handle',
      'Handle may use lowercase letters, numbers, and underscores, and must start with a letter or number',
    );
  }
  if (handle.endsWith('_')) {
    throw AppError.badRequest('invalid_handle', 'Handle cannot end with an underscore');
  }
  if (RESERVED_HANDLES.has(handle)) {
    throw AppError.badRequest('invalid_handle', 'That handle is reserved');
  }
  return handle;
}

/**
 * Validate a keyword. A keyword is a high-entropy secret chosen by the user,
 * so it is held to a stricter standard than the legacy password policy: 12+
 * characters with mixed case and a digit.
 */
export function validateKeyword(raw: string): string {
  const keyword = raw.trim();
  if (keyword.length < KEYWORD_MIN) {
    throw AppError.badRequest('invalid_keyword', `Keyword must be at least ${KEYWORD_MIN} characters`);
  }
  if (keyword.length > KEYWORD_MAX) {
    throw AppError.badRequest('invalid_keyword', `Keyword must be at most ${KEYWORD_MAX} characters`);
  }
  if (!/[a-z]/.test(keyword) || !/[A-Z]/.test(keyword) || !/[0-9]/.test(keyword)) {
    throw AppError.badRequest(
      'invalid_keyword',
      'Keyword must include a lowercase letter, an uppercase letter, and a number',
    );
  }
  return keyword;
}

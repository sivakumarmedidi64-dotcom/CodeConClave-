/**
 * CodeConClave — inbound webhooks (Stage 26D).
 * Authenticates third-party webhooks (GitHub HMAC-SHA256, Sentry HMAC,
 * generic bearer tokens), resolves the owning tenant from a webhook secret
 * record, deduplicates delivery IDs, and hands the event to the automation
 * executor. Secrets are hashed for bearer auth and the HMAC key is encrypted
 * at rest. Replays are rejected via the event_log UNIQUE(source, event_id).
 */
import * as crypto from 'node:crypto';
import { pool, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { randomToken, sha256Hex, encryptAtRest, decryptAtRest } from '../../shared/crypto.js';
import { ingestEvent, type IngestResult } from './executor.js';

export type WebhookSource = 'github' | 'sentry' | 'plugin' | 'deployment' | 'webhook';

export interface WebhookSecretRow {
  id: string;
  owner_id: string;
  name: string;
  source: WebhookSource;
  repo: string | null;
  secret_hash: string;
  hmac_key: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapSecret(row: Record<string, unknown>): WebhookSecretRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    name: String(row.name),
    source: String(row.source) as WebhookSource,
    repo: row.repo ? String(row.repo) : null,
    secret_hash: String(row.secret_hash),
    hmac_key: row.hmac_key ? String(row.hmac_key) : null,
    enabled: Boolean(row.enabled),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

function publicSecret(row: WebhookSecretRow): Omit<WebhookSecretRow, 'secret_hash' | 'hmac_key'> {
  const { secret_hash: _s, hmac_key: _h, ...rest } = row;
  return rest;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  const al = Buffer.byteLength(a);
  const bl = Buffer.byteLength(b);
  if (al !== bl) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function createWebhookSecret(
  userId: string,
  input: { source: WebhookSource; name: string; repo?: string },
): Promise<{ secret: Omit<WebhookSecretRow, 'secret_hash' | 'hmac_key'>; plaintextSecret: string }> {
  if (!['github', 'sentry', 'plugin', 'deployment', 'webhook'].includes(input.source)) {
    throw AppError.badRequest('invalid_webhook_source', 'Invalid webhook source');
  }
  if (!input.name.trim()) throw AppError.badRequest('name_required', 'Name is required');
  const plaintext = randomToken(32);
  const id = newId(PREFIX.WEBHOOK_SECRET);
  const hmacKey = input.source === 'github' || input.source === 'sentry' ? encryptAtRest(plaintext) : null;
  await pool.query(
    `INSERT INTO webhook_secrets (id, owner_id, name, source, repo, secret_hash, hmac_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, userId, input.name.trim(), input.source, input.repo ?? null, sha256Hex(plaintext), hmacKey],
  );
  const row = await getSecretInternal(id);
  await recordAudit({
    action: AuditAction.WEBHOOK_SECRET_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'webhook_secret',
    resourceId: id,
    detail: { source: input.source, repo: input.repo ?? null },
  });
  return { secret: publicSecret(row), plaintextSecret: plaintext };
}

export async function getSecretInternal(id: string): Promise<WebhookSecretRow> {
  const rows = await queryMany<Record<string, unknown>>('SELECT * FROM webhook_secrets WHERE id = $1', [id]);
  if (!rows[0]) throw AppError.notFound('Webhook secret');
  return mapSecret(rows[0]);
}

export async function listWebhookSecrets(userId: string): Promise<Array<Omit<WebhookSecretRow, 'secret_hash' | 'hmac_key'>>> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM webhook_secrets WHERE owner_id = $1 ORDER BY created_at DESC', [userId],
  );
  return rows.map(mapSecret).map(publicSecret);
}

export async function deleteWebhookSecret(userId: string, id: string): Promise<void> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM webhook_secrets WHERE id = $1 AND owner_id = $2', [id, userId],
  );
  if (!rows[0]) throw AppError.notFound('Webhook secret');
  await pool.query('DELETE FROM webhook_secrets WHERE id = $1', [id]);
  await recordAudit({
    action: AuditAction.WEBHOOK_SECRET_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'webhook_secret',
    resourceId: id,
    detail: { name: String(rows[0].name), source: String(rows[0].source) },
  });
}

export async function setWebhookSecretEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
  const res = await pool.query(
    'UPDATE webhook_secrets SET enabled = $3 WHERE id = $1 AND owner_id = $2', [id, userId, enabled],
  );
  if (res.rowCount === 0) throw AppError.notFound('Webhook secret');
}

export interface WebhookDelivery {
  source: WebhookSource;
  eventId: string;
  eventType: string;
  ownerId: string;
  payload: Record<string, unknown>;
}

function hmacHex(secret: string, body: Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Map a raw GitHub event name + action to a canonical automation event type. */
export function githubEventType(headerEvent: string, action: string | undefined): string {
  switch (headerEvent) {
    case 'issues':
      return action === 'opened' ? 'issue.opened' : `issue.${action ?? 'updated'}`;
    case 'pull_request':
      return `pull_request.${action ?? 'opened'}`;
    case 'push':
      return 'push';
    case 'pull_request_review':
      return `pull_request_review.${action ?? 'submitted'}`;
    default:
      return headerEvent;
  }
}

/** Authenticate a GitHub webhook. Returns null when the repo is unregistered. */
async function authenticateGithub(
  rawBody: Buffer,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<WebhookDelivery | null> {
  const signature = headers['x-hub-signature-256'];
  const eventId = headers['x-github-delivery'];
  const headerEvent = headers['x-github-event'] ?? 'push';
  if (!signature || !eventId) throw AppError.unauthorized('webhook_auth_required', 'Missing GitHub signature or delivery id');
  const repoName = (body as { repository?: { full_name?: string } }).repository?.full_name;
  if (!repoName) throw AppError.badRequest('missing_repo', 'Payload is missing repository.full_name');
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM webhook_secrets WHERE source = 'github' AND repo = $1 AND enabled = true LIMIT 10`,
    [repoName],
  );
  if (!rows[0]) return null;
  const secret = mapSecret(rows[0]);
  const expected = hmacHex(decryptAtRest(secret.hmac_key as string), rawBody);
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!safeEqual(Buffer.from(expected), Buffer.from(provided))) {
    await recordAudit({
      action: AuditAction.WEBHOOK_SIGNATURE_INVALID,
      actorUserId: secret.owner_id,
      scope: 'USER',
      tenantId: secret.owner_id,
      resourceType: 'webhook_secret',
      resourceId: secret.id,
      detail: { source: 'github', eventId, repo: repoName },
    });
    throw AppError.unauthorized('invalid_signature', 'Invalid GitHub webhook signature');
  }
  const action = typeof body.action === 'string' ? body.action : undefined;
  return {
    source: 'github',
    eventId,
    eventType: githubEventType(headerEvent, action),
    ownerId: secret.owner_id,
    payload: body,
  };
}

/** Authenticate a Sentry webhook (X-Sentry-Signature HMAC over raw body). */
async function authenticateSentry(
  rawBody: Buffer,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<WebhookDelivery> {
  const signature = headers['x-sentry-signature'];
  if (!signature) throw AppError.unauthorized('webhook_auth_required', 'Missing Sentry signature');
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM webhook_secrets WHERE source = 'sentry' AND enabled = true LIMIT 20`,
    [],
  );
  if (!rows[0]) throw AppError.notFound('sentry_secret_missing', 'No Sentry webhook secret configured');
  let matched: WebhookSecretRow | null = null;
  for (const r of rows) {
    const cand = mapSecret(r);
    const expected = hmacHex(decryptAtRest(cand.hmac_key as string), rawBody);
    if (safeEqual(Buffer.from(expected), Buffer.from(signature))) {
      matched = cand;
      break;
    }
  }
  if (!matched) {
    await recordAudit({
      action: AuditAction.WEBHOOK_SIGNATURE_INVALID,
      actorUserId: 'system',
      scope: 'USER',
      tenantId: 'system',
      resourceType: 'webhook_secret',
      resourceId: '',
      detail: { source: 'sentry' },
    });
    throw AppError.unauthorized('invalid_signature', 'Invalid Sentry webhook signature');
  }
  const event = (body as { event?: { event_id?: string } }).event;
  const eventId = String(event?.event_id ?? body.id ?? '') || sha256Hex(rawBody.toString()).slice(0, 32);
  return {
    source: 'sentry',
    eventId,
    eventType: 'sentry.error',
    ownerId: matched.owner_id,
    payload: body,
  };
}

/** Authenticate generic bearer-token webhooks (plugin / deployment / webhook). */
async function authenticateBearer(
  source: WebhookSource,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<WebhookDelivery> {
  const auth = headers['authorization'] ?? headers['x-webhook-token'];
  if (!auth?.startsWith('Bearer ')) throw AppError.unauthorized('webhook_auth_required', 'Missing bearer token');
  const token = auth.slice(7).trim();
  const tokenHash = sha256Hex(token);
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM webhook_secrets WHERE source = $1 AND secret_hash = $2 AND enabled = true LIMIT 5`,
    [source, tokenHash],
  );
  if (!rows[0]) throw AppError.unauthorized('invalid_token', 'Invalid webhook token');
  const secret = mapSecret(rows[0]);
  const eventId = headers['x-event-id'] ?? (typeof body.event_id === 'string' ? body.event_id : undefined);
  if (!eventId) throw AppError.badRequest('missing_event_id', 'Missing event id (X-Event-Id header or event_id field)');
  const eventType = headers['x-event-type'] ?? (typeof body.event_type === 'string' ? body.event_type : undefined);
  if (!eventType) throw AppError.badRequest('missing_event_type', 'Missing event type (X-Event-Type header or event_type field)');
  return { source, eventId, eventType, ownerId: secret.owner_id, payload: body };
}

/**
 * Entry point used by the webhook router. Verifies auth, deduplicates and
 * executes. A GitHub payload for an unregistered repo returns null so the
 * caller can respond 404 without leaking tenant existence.
 */
export async function handleWebhook(input: {
  source: WebhookSource;
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
}): Promise<IngestResult | null> {
  const { source, rawBody, headers } = input;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw AppError.badRequest('invalid_json', 'Webhook body must be valid JSON');
  }
  let delivery: WebhookDelivery;
  if (source === 'github') {
    const gh = await authenticateGithub(rawBody, parsed, headers);
    if (gh === null) return null;
    delivery = gh;
  } else if (source === 'sentry') {
    delivery = await authenticateSentry(rawBody, parsed, headers);
  } else {
    delivery = await authenticateBearer(source, parsed, headers);
  }
  await recordAudit({
    action: AuditAction.WEBHOOK_VERIFIED,
    actorUserId: delivery.ownerId,
    scope: 'USER',
    tenantId: delivery.ownerId,
    resourceType: 'webhook_secret',
    resourceId: '',
    detail: { source: delivery.source, eventId: delivery.eventId, eventType: delivery.eventType },
  });
  return ingestEvent({
    source: delivery.source === 'sentry' ? 'plugin' : delivery.source,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    ownerId: delivery.ownerId,
    payload: delivery.payload,
  });
}
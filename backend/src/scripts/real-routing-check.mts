/**
 * Part 18 — REAL routed provider verification (Model Routing 2026).
 * Uses the existing configured credentials only (nemotron default). Proves the
 * full routing layer end-to-end: planRoute → gateway completeWithFallback,
 * and that task_type/routing_preference land in model_usage_logs.
 */
import { planRoute } from '../modules/ai/router.js';
import { completeWithFallback } from '../modules/ai/gateway.js';
import { pool } from '../shared/db.js';
import { getUserById } from '../modules/auth/service.js';

async function main() {
  // Use the FIRST real seeded user (never invented). Not the probe user.
  const users = await pool.query(`SELECT id FROM users WHERE id NOT LIKE 'probe%' ORDER BY created_at LIMIT 1`);
  const userId = users.rows[0]?.id as string | undefined;
  if (!userId) {
    console.log('SKIP: no seeded user available.');
    return;
  }

  const decision = await planRoute({
    userId,
    text: 'Summarize what CodeConClave is in two sentences.',
    routingPreference: 'AUTO',
    minContextTokens: 0,
    opts: { privacyClass: 'STANDARD' },
  });
  console.log('DECISION', JSON.stringify({
    taskType: decision.taskType,
    selectedProvider: decision.selectedProvider,
    selectedModel: decision.selectedModel,
    reason: decision.reason,
    confidence: decision.confidence,
    healthState: decision.healthState,
  }, null, 2));
  if (!decision.selectedModel) {
    console.log('SKIP: no eligible routed model.');
    return;
  }

  const summary = await completeWithFallback({
    ctx: { userId, sessionId: 'routing-real-verify', conversationId: null, planId: 'free' },
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Summarize what CodeConClave is in two sentences.' },
    ],
    maxTokens: 128,
    opts: {
      requestedModelId: decision.selectedModel,
      taskType: decision.taskType,
      routingPreference: decision.routingPreference,
      computeClass: 'A',
    },
  });
  console.log('COMPLETED', JSON.stringify({
    modelId: summary.modelId,
    providerId: summary.providerId,
    usedFallback: summary.usedFallback,
    fallbackReason: summary.fallbackReason,
    text: summary.text.slice(0, 160),
  }, null, 2));

  const audit = await pool.query(
    `SELECT task_type, routing_preference FROM model_usage_logs
     WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
    ['routing-real-verify'],
  );
  console.log('AUDIT', JSON.stringify(audit.rows[0] ?? null));
  await pool.end();
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
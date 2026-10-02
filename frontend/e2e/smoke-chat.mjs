/**
 * Stage 21 BLOCKER smoke test (ONE browser run): chat failure must terminate
 * the SSE stream cleanly — an error event arrives, the stream closes, the
 * Thinking Moon disappears, generation state resets, and the failure is
 * persisted honestly (assistant message FAILED). Also verifies Escape-cancel
 * surfaces no raw AbortError text. Timing is bounded: the error must arrive
 * well under the old worst-case chain (3 x 120s).
 */
import { spawnStack, launchBrowser, newPage, goto, waitText, hasText, clickText, type, check, dbClient, cleanupStack, summary, wait, BASE } from './lib.mjs';

const stack = await spawnStack();
const browser = await launchBrowser();
const db = await dbClient();
const page = await newPage(browser);

const EMAIL = 'smoke' + Date.now().toString(36) + '@example.com';
const PW = 'AlphaPass1234';
let uid = null;

try {
  console.log('>> step: register + verify (smoke fixture)');
  await goto(page, '/register');
  await type(page, '#email', EMAIL);
  await type(page, '#displayName', 'Smoke Runner');
  await type(page, '#password', PW);
  await clickText(page, 'Create account');
  await waitText(page, 'Home', 20000);

  const me = await db.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  uid = me.rows[0]?.id;
  check('smoke: fixture user registered', !!uid);

  let outbox = null;
  for (let i = 0; i < 8 && !outbox; i++) {
    await wait(1000);
    const r = await db.query(
      `SELECT payload FROM outbox_events WHERE topic = 'auth.email_verification' AND payload->'data'->>'userId' = $1 ORDER BY created_at DESC LIMIT 1`,
      [uid],
    );
    if (r.rows[0]) outbox = r.rows[0];
  }
  const m = (outbox?.payload?.html ?? '').match(/token=([^"&<]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  check('smoke: server-issued verification token available', !!token);
  if (token) {
    await page.goto(BASE + '/verify-email?token=' + encodeURIComponent(token), { waitUntil: 'networkidle0', timeout: 45000 });
    await waitText(page, 'Email verified', 20000);
  }

  console.log('>> step: chat failure -> stream terminates cleanly');
  await goto(page, '/chat');
  await page.waitForSelector('.cc-textarea', { timeout: 15000 });
  const t0 = Date.now();
  await type(page, '.cc-textarea', 'What is the meaning of life?');
  await page.keyboard.press('Enter');

  // The honest error must arrive within the deterministic chain deadline
  // (180s) — never the old unbounded 3 x 120s.
  const arrived = await page
    .waitForFunction(
      () =>
        document.body.textContent?.includes('All configured models failed') ||
        document.body.textContent?.includes('No model currently satisfies') ||
        document.body.textContent?.includes('no AI provider is configured') ||
        document.body.textContent?.includes('Premium compute'),
      { timeout: 200000 },
    )
    .then(() => true)
    .catch(() => false);
  const elapsedMs = Date.now() - t0;
  check('chat: honest error event arrives (model_unavailable family)', arrived);
  check('chat: error arrives within chain deadline (stream did not hang)', arrived && elapsedMs < 200000, `elapsed=${Math.round(elapsedMs / 1000)}s`);

  await wait(500);
  check('chat: Thinking Moon gone after error', !(await page.evaluate(() => !!document.querySelector('.cc-thinking'))));
  check('chat: composer reset (not "Streaming…")', await hasText(page, 'Send'));
  check('chat: no raw connection-interrupted text', !(await hasText(page, 'Connection interrupted')));

  const msg = await db.query(
    `SELECT m.status, m.error_code, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.owner_id = $1 AND m.sender = 'AI' AND m.role = 'assistant' ORDER BY m.created_at DESC LIMIT 1`,
    [uid],
  );
  check('chat: assistant message persisted FAILED server-side', msg.rows[0]?.status === 'FAILED', 'error_code=' + msg.rows[0]?.error_code);
  check('chat: persisted failure text is honest', (msg.rows[0]?.content ?? '').includes('Request failed'));

  console.log('>> step: Escape cancel -> no raw abort text');
  await type(page, '.cc-textarea', 'cancel me please');
  await page.keyboard.press('Enter');
  await wait(800);
  await page.keyboard.press('Escape');
  await wait(1200);
  check('cancel: toast shows "Generation cancelled"', await hasText(page, 'Generation cancelled'));
  check('cancel: no raw "This operation was aborted" text', !(await hasText(page, 'This operation was aborted')));
  check('cancel: Thinking Moon gone after cancel', !(await page.evaluate(() => !!document.querySelector('.cc-thinking'))));
  check('cancel: composer reset after cancel', await hasText(page, 'Send'));

  await summary('SMOKE (chat failure + cancel: stream terminates cleanly)');
} catch (e) {
  console.log('SMOKE ERROR:', e.message, '| url=', page.url());
  const fs = await import('node:fs');
  fs.mkdirSync('C:/Users/sride/CodeConClave-/frontend/e2e/shots', { recursive: true });
  await page.screenshot({ path: 'C:/Users/sride/CodeConClave-/frontend/e2e/shots/smoke-chat-error.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    if (uid) {
      await db.query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id = $1)`, [uid]).catch(() => {});
      await db.query(`DELETE FROM conversations WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM model_usage_logs WHERE user_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM audit_logs WHERE actor_user_id = $1 OR tenant_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM email_verifications WHERE user_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM outbox_events WHERE payload->'data'->>'userId' = $1 OR payload->>'userId' = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM user_preferences WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM entitlements WHERE user_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM usage_counters WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
    }
    console.log('cleanup: smoke rows removed');
  } catch (ce) {
    console.log('cleanup warning:', ce.message);
  }
  await cleanupStack(stack, browser);
  await db.end().catch(() => {});
}
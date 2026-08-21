import { spawnStack, launchBrowser, newPage, goto, waitText, hasText, clickText, type, check, dbClient, cleanupStack, summary, wait, BASE } from './lib.mjs';

const stack = await spawnStack();
const browser = await launchBrowser();
const db = await dbClient();
const page = await newPage(browser);

const EMAIL = 's21a' + Date.now().toString(36) + '@example.com';
const PW = 'AlphaPass1234';
const BLOCKED = [];

async function logoutViaUi() {
  await goto(page, '/home');
  await page.waitForSelector('[aria-label="Account menu"]', { timeout: 15000 });
  await clickText(page, 'Account menu');
  await clickText(page, 'Sign out');
  await waitText(page, 'Sign in', 20000);
  check('auth: logout returns to login page', page.url().includes('/login'));
}

try {
  console.log('>> step: register');
  // ============ AUTH: REGISTER (real browser UI) ============
  await goto(page, '/register');
  await type(page, '#email', EMAIL);
  await type(page, '#displayName', 'S21 Alpha');
  await type(page, '#password', PW);
  await clickText(page, 'Create account');
  await waitText(page, 'Home', 20000);
  check('auth: register navigates to authenticated workspace', page.url().includes('/home'));
  check('auth: workspace shell renders (sidebar)', await hasText(page, 'Workspace navigation'));

  const me = await db.query(`SELECT id, email_verified FROM users WHERE email = $1`, [EMAIL]);
  const uid = me.rows[0]?.id;
  check('auth: user row persisted with id', !!uid);
  check('auth: email_verified=false initially', me.rows[0]?.email_verified === false);

  console.log('>> step: verification');
  // ============ VERIFICATION: real server-issued token from outbox ============
  let outbox = null;
  for (let i = 0; i < 8 && !outbox; i++) {
    await wait(1000);
    const r = await db.query(
      `SELECT status, payload FROM outbox_events WHERE topic = 'auth.email_verification' AND payload->'data'->>'userId' = $1 ORDER BY created_at DESC LIMIT 1`,
      [uid],
    );
    if (r.rows[0]) outbox = r.rows[0];
  }
  const m = (outbox?.payload?.html ?? '').match(/token=([^"&<]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  check('verify: server-issued token persisted (email pipeline wrote outbox row)', !!token, 'outbox status=' + (outbox?.status ?? 'none'));
  BLOCKED.push('live email delivery (Resend not configured; outbox event stays PENDING; token read from server payload - not faked)');

  if (token) {
    await page.goto(BASE + '/verify-email?token=' + encodeURIComponent(token), { waitUntil: 'networkidle0', timeout: 45000 });
    await waitText(page, 'Email verified', 20000);
    const me2 = await db.query(`SELECT email_verified FROM users WHERE id = $1`, [uid]);
    check('verify: server marks email_verified=true', me2.rows[0]?.email_verified === true);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id = $1 AND action = 'auth.email_verified'`, [uid]);
    check('verify: audit AUTH_EMAIL_VERIFIED recorded', audit.rows[0].n === 1);

    await page.goto(BASE + '/verify-email?token=' + encodeURIComponent(token), { waitUntil: 'networkidle0', timeout: 45000 });
    await waitText(page, 'already been used', 20000);
    check('verify: single-use token rejected on reuse (no fake re-verify)', true);
  }

  console.log('>> step: logout');
  // ============ AUTH: LOGOUT + PROTECTED ROUTE ============
  await logoutViaUi();
  await goto(page, '/projects');
  await waitText(page, 'Sign in', 20000);
  check('security: protected /projects redirects to login after logout', page.url().includes('/login'));

  console.log('>> step: login-again');
  // ============ AUTH: LOGIN AGAIN ============
  await type(page, '#email', EMAIL);
  await type(page, '#password', PW);
  await clickText(page, 'Sign in');
  await waitText(page, 'Home', 20000);
  check('auth: login returns to workspace', page.url().startsWith(BASE) && !page.url().includes('/login'));

  console.log('>> step: projects');
  // ============ PROJECTS JOURNEY ============
  await goto(page, '/projects');
  await waitText(page, 'New project', 20000);
  await clickText(page, 'New project');
  await type(page, '#project-name', 'E2E Alpha Project');
  await clickText(page, 'Create');
  await waitText(page, 'E2E Alpha Project', 20000);
  const proj = await db.query(`SELECT id, owner_id, status FROM projects WHERE name = 'E2E Alpha Project'`);
  const pid = proj.rows[0]?.id;
  check('project: created via UI and persisted in DB', proj.rows.length === 1);
  check('project: correct owner (session user)', proj.rows[0]?.owner_id === uid);
  check('project: status ACTIVE', proj.rows[0]?.status === 'ACTIVE');

  console.log('>> step: project-edit');
  // edit -> save -> reload -> persistence
  await clickText(page, 'Details');
  await waitText(page, 'Members', 20000);
  await clickText(page, 'Add to favorites');
  await waitText(page, 'Favorite', 20000, true);
  await goto(page, '/projects');
  await waitText(page, 'E2E Alpha Project', 20000);
  const fav = await db.query(`SELECT is_favorite FROM projects WHERE id = $1`, [pid]);
  check('project: favorite persisted after reload (edit/save/reload)', fav.rows[0]?.is_favorite === true);

  await clickText(page, 'On hold');
  await waitText(page, 'Resume', 20000);
  const hold = await db.query(`SELECT status FROM projects WHERE id = $1`, [pid]);
  check('project: status transition ON_HOLD persists', hold.rows[0]?.status === 'ON_HOLD');

  console.log('>> step: billing');
  // ============ BILLING (no real payment) ============
  await goto(page, '/settings?tab=billing');
  await waitText(page, 'Payments & plan', 20000);
  check('billing: page loads', true);
  await waitText(page, 'Upgrade to PRO', 20000);
  check('billing: Pro upgrade (payment link) offered, no auto-charge', true);
  BLOCKED.push('payment: real payment NOT made (payment-link mode; session would be created server-side on click - not clicked)');

  console.log('\n--- BLOCKED ---');
  for (const b of BLOCKED) console.log('  -', b);

  await summary('PART 1 (auth + projects + billing + security)');
} catch (e) {
  console.log('PART1 ERROR:', e.message, '| url=', page.url());
  const fs = await import('node:fs');
  fs.mkdirSync('C:/Users/sride/CodeConClave-/frontend/e2e/shots', { recursive: true });
  await page.screenshot({ path: 'C:/Users/sride/CodeConClave-/frontend/e2e/shots/part1-error.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  // ---- cleanup created rows (runs even on failure) ----
  try {
    const projRows = await db.query(`SELECT id FROM projects WHERE name = 'E2E Alpha Project'`);
    for (const p of projRows.rows) {
      await db.query(`DELETE FROM project_members WHERE project_id = $1`, [p.id]);
      await db.query(`DELETE FROM conversations WHERE project_id = $1`, [p.id]);
      await db.query(`DELETE FROM memories WHERE project_id = $1`, [p.id]);
      await db.query(`DELETE FROM tasks WHERE project_id = $1`, [p.id]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [p.id]);
    }
    const uRows = await db.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
    for (const u of uRows.rows) {
      await db.query(`DELETE FROM audit_logs WHERE actor_user_id = $1 OR tenant_id = $1`, [u.id]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]).catch(() => {});
      await db.query(`DELETE FROM email_verifications WHERE user_id = $1`, [u.id]).catch(() => {});
      await db.query(`DELETE FROM outbox_events WHERE payload->'data'->>'userId' = $1 OR payload->>'userId' = $1`, [u.id]).catch(() => {});
      await db.query(`DELETE FROM user_preferences WHERE owner_id = $1`, [u.id]).catch(() => {});
      await db.query(`DELETE FROM entitlements WHERE user_id = $1`, [u.id]).catch(() => {});
      await db.query(`DELETE FROM usage_counters WHERE owner_id = $1`, [u.id]).catch(() => {});
      await db.query(`DELETE FROM users WHERE id = $1`, [u.id]).catch(() => {});
    }
    console.log('cleanup: E2E rows removed');
  } catch (ce) {
    console.log('cleanup warning:', ce.message);
  }
  await cleanupStack(stack, browser);
  await db.end().catch(() => {});
}
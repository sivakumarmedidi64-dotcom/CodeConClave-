import { spawn } from 'node:child_process';
import { spawnStack, launchBrowser, newPage, goto, type, clickText, waitText, waitTextRetry, hasText, wait, cleanupStack, dbClient, BASE, check, results, summary } from './lib.mjs';

const ROOT = 'C:/Users/sride/CodeConClave-/';
const stack = await spawnStack();
const worker = spawn(process.execPath, ['dist/workers/run.js'], { cwd: ROOT + 'backend', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
worker.stderr.on('data', (d) => process.stderr.write('[worker] ' + d));
const browser = await launchBrowser();
const db = await dbClient();
const page = await newPage(browser);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) console.log(`[http ${r.status()}] ${r.url()}`); });
const EMAIL = 'e2e2' + Date.now().toString(36) + '@example.com';
const PW = 'AlphaPass1234';
const BLOCKED = [];

let uid = null;
let pid = null;

try {
  // ============ AUTH BOOTSTRAP (register + project) ============
  console.log('>> step: bootstrap');
  await goto(page, '/register');
  await type(page, '#email', EMAIL);
  await type(page, '#displayName', 'E2E User');
  await type(page, '#password', PW);
  await clickText(page, 'Create account');
  await waitText(page, 'Welcome back', 25000);
  uid = (await db.query(`SELECT id FROM users WHERE email = $1`, [EMAIL])).rows[0].id;
  await goto(page, '/projects');
  await waitTextRetry(page, 'New project', 20000);
  await clickText(page, 'New project');
  await type(page, '#project-name', 'E2E Journey Project');
  await clickText(page, 'Create');
  await waitTextRetry(page, 'E2E Journey Project', 20000);
  pid = (await db.query(`SELECT id FROM projects WHERE name = 'E2E Journey Project' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  check('bootstrap: user + project ready', !!uid && !!pid);

  // ============ CHAT: honest provider-unavailable journey ============
  console.log('>> step: chat (provider-unavailable)');
  await goto(page, '/chat');
  await waitTextRetry(page, 'Start a conversation', 20000);
  await page.type('.cc-textarea', 'Hello CodeConClave, are you online?', { delay: 10 });
  await page.keyboard.press('Enter');
  await waitText(page, 'Hello CodeConClave, are you online?', 15000);
  const moonSeen = await page.waitForFunction(
      () => {
        const think = [...document.querySelectorAll('.cc-think')].some((e) => (e.textContent ?? '').includes('thinking'));
        const moon = document.querySelector('.cc-moon--think') !== null;
        return think || moon;
      },
      { timeout: 20000 },
    ).then(() => true).catch(() => false);
  check('chat: request submitted + Thinking Moon / thinking state shown during real request', moonSeen);
  const chatResp = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 240000);
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/conversations/chat')) { clearTimeout(t); resolve({ status: r.status() }); }
    });
  });
  console.log('chat SSE response:', JSON.stringify(chatResp));
  const chatErrorOk = await page
    .waitForFunction(
      () =>
        document.body.textContent?.includes('All configured models failed') ||
        document.body.textContent?.includes('No model currently satisfies') ||
        document.body.textContent?.includes('no AI provider is configured') ||
        document.body.textContent?.includes('Generation timed out and the stream was closed') ||
        document.body.textContent?.includes('Premium compute'),
      { timeout: 120000 },
    )
    .then(() => true)
    .catch(() => false);
  check('chat: honest failure event arrives (stream terminates)', chatErrorOk);
  const conv = await db.query(`SELECT id, mode FROM conversations WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1`, [uid]);
  check('chat: conversation persisted server-side', conv.rows.length === 1);
  const msgs = await db.query(
    `SELECT sender, role, status, content, error_code FROM messages WHERE conversation_id = $1 ORDER BY created_at`,
    [conv.rows[0]?.id],
  );
  const userMsg = msgs.rows.find((m) => m.sender === 'USER');
  const aiMsg = msgs.rows.find((m) => m.sender === 'AI');
  check('chat: user message persisted (COMPLETED)', userMsg?.status === 'COMPLETED' && (userMsg.content ?? '').includes('are you online'));
  check('chat: assistant message honestly FAILED (no fake success)', aiMsg?.status === 'FAILED' && !!aiMsg.error_code);
  const chatAudit = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id = $1 AND action = 'chat.failed'`, [uid]);
  check('chat: failure audited (chat.failed)', chatAudit.rows[0].n >= 1);
  const usage = await db.query(`SELECT value FROM usage_counters WHERE owner_id = $1 AND name = 'daily_messages'`, [uid]);
  check('chat: usage counter incremented', Number(usage.rows[0]?.value ?? 0) >= 1);
  BLOCKED.push('chat: live AI reply NOT produced (all providers down: openai 429, anthropic 400, gemini quota, mistral unconfigured) â€” verified the real failure path + persistence instead');

  // ============ MEMORY + IDEAS: /idea slash (AI-independent) ============
  console.log('>> step: memory (/idea)');
  await page.type('.cc-textarea', '/idea Capture the golden logo idea');
  await page.keyboard.press('Enter');
  await wait(3500);
  const mems = await db.query(`SELECT id, type, source, content, structured FROM memories WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 3`, [uid]);
  const ideaMem = mems.rows.find((m) => (m.structured?.idea === true) || (m.content ?? '').includes('golden logo'));
  check('memory: /idea captured a memory row', !!ideaMem);
  check('memory: memory type accepted by server contract', !!ideaMem && ['EPISODIC','SEMANTIC','PROCEDURAL','PROJECT','TEAM'].includes(ideaMem.type));
  if (!ideaMem) {
    const last = mems.rows[0];
    check('memory: (recorded) last memory row exists â€” defect evidence', !!last);
    console.log('  defect: no memory created via /idea â€” rows:', JSON.stringify(mems.rows.map((r) => ({ type: r.type, content: (r.content ?? '').slice(0, 40) }))));
  }
  await goto(page, '/memory');
  await waitText(page, 'Memory', 15000, true);
  const memListStatus = await page.evaluate(async () => (await fetch('/api/v1/memory')).status);
  check('memory: list endpoint returns 200 (Stage 21 regression: bind-count 500)', memListStatus === 200);
  let goldenVisible = false;
  for (let i = 0; i < 4 && !goldenVisible; i++) {
    goldenVisible = await page.evaluate(() => document.body.innerText.includes('golden logo'));
    if (!goldenVisible) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await wait(4000);
    }
  }
  check('memory: /memory page renders the captured memory', goldenVisible);
  await goto(page, '/dna');
  await waitText(page, 'DNA', 15000, true);
  check('dna: /dna page renders', true);

  // ============ TASKS + APPROVALS: cowork brief â†’ approve â†’ honest execution ============
  console.log('>> step: cowork task + approvals');
  await goto(page, '/chat');
  await waitTextRetry(page, 'Start a conversation', 20000);
  const toggled = await page.evaluate(() => {
    const tabs = document.querySelector('[aria-label="Chat mode"]');
    const btn = tabs ? [...tabs.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Cowork') : null;
    if (btn) { btn.click(); return true; }
    return false;
  });
  check('task: cowork mode toggle clicked (not the sidebar link)', toggled);
  page.on('request', (r) => { if (r.url().endsWith('/chat')) console.log('COWORK-REQ', r.postData() ? r.postData().slice(0, 200) : ''); });
  page.on('response', async (r) => { if (r.url().endsWith('/chat')) { const t = await r.text().catch(() => '<n/a>'); console.log('COWORK-SSE:', JSON.stringify(t.slice(0, 400))); } });
  try {
    await page.waitForFunction(
      (pid) => {
        const sel = document.querySelector('[aria-label="Project"]');
        return sel && [...sel.options].some((o) => o.value === pid);
      },
      { timeout: 20000 },
      pid,
    );
    await page.select('[aria-label="Project"]', pid);
  } catch {
    await wait(1500);
    await page.select('[aria-label="Project"]', pid);
  }
  const selState = await page.evaluate((pid) => {
    const sel = document.querySelector('[aria-label="Project"]');
    return { found: !!sel, opts: sel ? [...sel.options].map((o) => o.value) : null, pid };
  }, pid);
  const projRes = await page.evaluate(async () => {
    const r = await fetch('/api/v1/projects', { credentials: 'same-origin' });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  });
  console.log('COWORK-SELECT-STATE', JSON.stringify(selState), 'PROJECTS', JSON.stringify(projRes));
  if (!selState.opts?.includes(pid)) {
    const fallback = selState.opts?.find((o) => o !== '');
    if (fallback) await page.select('[aria-label="Project"]', fallback);
  }
  let taskRow = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.type('.cc-textarea', 'Refactor the project status file into a shared module', { delay: 8 });
    await page.keyboard.press('Enter');
    const note = await page
      .waitForFunction(
        () =>
          document.body.textContent?.includes('awaiting your approval') ||
          document.body.textContent?.includes('queued for execution') ||
          document.body.textContent?.includes('in progress'),
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    if (note) break;
    const errNote = await page
      .waitForFunction(
        () => document.body.textContent?.includes('Internal server error') || document.body.textContent?.includes('Request failed') || document.body.textContent?.includes('Deep work needs a project'),
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!errNote) break;
    const t2 = await db.query(`SELECT id FROM tasks WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1`, [uid]);
    console.log('COWORK-ATTEMPT', attempt, 'note?', note, 'errNote?', errNote, 'task?', t2.rows.length);
    if (t2.rows.length) break;
    await wait(2000);
  }
  const task = await db.query(`SELECT id, status, required_approval, approval_id FROM tasks WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1`, [uid]);
  taskRow = task.rows[0];
  check('task: cowork brief created task server-side', !!taskRow);
  const ap = taskRow?.approval_id ? await db.query(`SELECT status FROM approvals WHERE id = $1`, [taskRow.approval_id]) : null;
  if (taskRow?.approval_id && ap?.rows[0]?.status === 'PENDING') {
    check('task: pending approval (deep work gate)', true);
    await goto(page, '/approvals');
    await waitText(page, 'Approve', 25000);
    check('approvals: approval center lists the task', true);
    await clickText(page, 'Approve');
    await wait(6000);
    const afterApprove = await db.query(`SELECT status FROM approvals WHERE id = $1`, [taskRow.approval_id]);
    check('approval: server-side transition recorded (APPROVED)', afterApprove.rows[0]?.status === 'APPROVED');
  } else {
    check('approval: approval gate reachable (requires AI planning)', false);
    BLOCKED.push('approval: approval gate not reachable â€” worker planning needs an AI model (all providers down); task failed honestly instead');
  }
  const fin = taskRow
    ? await db.query(
        `SELECT status FROM tasks WHERE id = $1 AND status IN ('FAILED','COMPLETED','BLOCKED','DEAD_LETTERED','WAITING_FOR_LOCAL_AGENT')`,
        [taskRow.id],
      )
    : { rows: [] };
  if (fin.rows.length === 0 && taskRow) {
    let t = await db.query(`SELECT status FROM tasks WHERE id = $1`, [taskRow.id]);
    for (
      let i = 0;
      i < 60 &&
      !['FAILED', 'COMPLETED', 'BLOCKED', 'DEAD_LETTERED', 'WAITING_FOR_LOCAL_AGENT'].includes(t.rows[0]?.status);
      i++
    ) {
      await wait(5000);
      t = await db.query(`SELECT status FROM tasks WHERE id = $1`, [taskRow.id]);
    }
  }
  const taskEnd = taskRow ? await db.query(`SELECT status, error_code FROM tasks WHERE id = $1`, [taskRow.id]) : null;
  check(
    'task: worker executed it to a terminal state',
    ['FAILED', 'COMPLETED', 'BLOCKED', 'DEAD_LETTERED', 'WAITING_FOR_LOCAL_AGENT'].includes(taskEnd?.rows[0]?.status),
  );
  if (taskEnd?.rows[0]?.status === 'FAILED' || taskEnd?.rows[0]?.status === 'BLOCKED' || taskEnd?.rows[0]?.status === 'DEAD_LETTERED') {
    check('task: honest failure state with error code (providers/premium blocked)', !!taskEnd.rows[0].error_code);
    BLOCKED.push(`task: execution COMPLETED path not achievable â€” all AI providers down; verified honest ${taskEnd.rows[0].status} (${taskEnd.rows[0].error_code})`);
  }
  const notif = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1`, [uid]);
  for (let i = 0; i < 20 && notif.rows[0].n < 1; i++) {
    await wait(1000);
    const again = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1`, [uid]);
    notif.rows[0].n = again.rows[0].n;
  }
  check('notifications: server notification row created by task lifecycle', notif.rows[0].n >= 1);

  // ============ FILES: upload â†’ trash â†’ restore (local storage; production object storage BLOCKED) ============
  console.log('>> step: files');
  const fs = await import('node:fs');
  fs.writeFileSync(ROOT + 'frontend/e2e/fixture-e2e.txt', 'E2E fixture content 42');
  await goto(page, '/files');
  await waitTextRetry(page, 'Folder tree', 20000);
await page.waitForSelector('select.cc-select', { timeout: 15000 });
    await page.select('select.cc-select', pid);
    await wait(1200);
  let fileInput = null;
  for (let i = 0; i < 3 && !fileInput; i++) {
    try {
      fileInput = await page.waitForSelector('input[type=file]', { timeout: 15000 });
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForSelector('select.cc-select', { timeout: 15000 });
      await page.select('select.cc-select', pid).catch(() => {});
      await wait(1500);
    }
  }
  if (!fileInput) throw new Error('file input never appeared after retries');
  await fileInput.uploadFile(ROOT + 'frontend/e2e/fixture-e2e.txt');
  await waitTextRetry(page, 'fixture-e2e.txt', 25000);
  await page.waitForFunction(
    () => [...document.querySelectorAll('div.cc-card')].some(
      (el) => el.textContent?.includes('fixture-e2e.txt') &&
        [...el.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === 'Trash'),
    ),
    { timeout: 20000 },
  ).catch(() => undefined);
  await wait(1000);
  const file = await db.query(`SELECT id, size_bytes, deleted_at FROM files WHERE owner_id = $1 AND path ILIKE '%fixture-e2e.txt' LIMIT 1`, [uid]);
  check('files: upload persisted server-side (local storage backend)', file.rows.length === 1 && file.rows[0].deleted_at === null && file.rows[0].size_bytes > 0);
  BLOCKED.push('files: production object storage (R2/S3) NOT configured â€” upload verified against the configured local storage backend');
  const trashRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll('div.cc-card')].find(
      (el) =>
        el.textContent?.includes('fixture-e2e.txt') &&
        [...el.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === 'Trash'),
    );
    const btn = row ? [...row.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Trash') : null;
    if (btn) { btn.click(); return true; }
    return false;
  });
  check('files: trash row button clicked', trashRow);
  await wait(2500);
  const trashed = await db.query(`SELECT deleted_at FROM files WHERE id = $1`, [file.rows[0]?.id]);
  check('files: trash moves file to TRASHED (server-side)', trashed.rows[0]?.deleted_at !== null);
  await goto(page, '/trash');
  await waitTextRetry(page, 'fixture-e2e.txt', 20000);
  await page.waitForFunction(
    () => [...document.querySelectorAll('div.cc-card')].some(
      (el) => el.textContent?.includes('fixture-e2e.txt') &&
        [...el.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === 'Restore'),
    ),
    { timeout: 20000 },
  ).catch(() => undefined);
  await wait(1000);
  const restoreRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll('div.cc-card')].find(
      (el) =>
        el.textContent?.includes('fixture-e2e.txt') &&
        [...el.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === 'Restore'),
    );
    const btn = row ? [...row.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Restore') : null;
    if (btn) { btn.click(); return true; }
    return false;
  });
  check('files: restore row button clicked', restoreRow);
  await wait(2500);
  const restored = await db.query(`SELECT deleted_at FROM files WHERE id = $1`, [file.rows[0]?.id]);
  check('files: restore returns file to ACTIVE', restored.rows[0]?.deleted_at === null);
  fs.unlinkSync(ROOT + 'frontend/e2e/fixture-e2e.txt');

  // ============ TEAMS ============
  console.log('>> step: teams');
  await goto(page, '/teams');
  // First visit in a fresh vite process cold-compiles the TeamsPage subtree;
  // under CPU contention that can exceed the usual 20s. Bounded at 45s.
  try {
    await waitText(page, 'Create team', 45000);
    console.log('teams: form rendered');
    await page.type('input[placeholder="Team name"]', 'E2E Squad');
    const inputVal = await page.evaluate(() => (document.querySelector('input[placeholder="Team name"]')?.value ?? '').slice(0, 40));
    console.log('teams: input value =', JSON.stringify(inputVal));
    await clickText(page, 'Create team');
    await wait(3000);
    const created = await db.query(`SELECT id, name FROM teams WHERE owner_id = $1 AND name = 'E2E Squad' LIMIT 1`, [uid]);
    console.log('teams: server-side rows =', created.rows.length);
    const teamList = await page.evaluate(() => document.body.innerText.includes('E2E Squad'));
    console.log('teams: page shows E2E Squad =', teamList);
    await waitText(page, 'E2E Squad', 20000);
    const team = await db.query(`SELECT id, name FROM teams WHERE owner_id = $1 AND name = 'E2E Squad' LIMIT 1`, [uid]);
    check('teams: team created and persisted', team.rows.length === 1);
    const tm = await db.query(`SELECT role, status FROM team_members WHERE team_id = $1`, [team.rows[0]?.id]);
    check('teams: creator is owner member', tm.rows[0]?.role === 'owner' && tm.rows[0]?.status === 'ACTIVE');
  } catch (te) {
    console.log('TEAMS STEP ERROR:', te.message);
    const dump = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter(Boolean);
      return { body: document.body.innerText.slice(0, 500).replace(/\n+/g, ' | '), buttons: buttons.slice(0, 15) };
    }).catch(() => ({ body: '(evaluate failed)' }));
    console.log('TEAMS STATE:', JSON.stringify(dump));
    throw te;
  }

  // ============ CONTINUITY: reload keeps session + data ============
  console.log('>> step: continuity');
  await goto(page, '/chat');
  await page.waitForSelector('.cc-textarea', { timeout: 25000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cc-textarea', { timeout: 25000 });
  const meAfter = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/me');
    return r.status;
  });
  check('continuity: session survives reload (cookie) and chat UI reloads', meAfter === 200);

  // ============ WHILE YOU WERE AWAY ============
  console.log('>> step: while-you-were-away');
  await goto(page, '/home');
  await waitTextRetry(page, 'While you were away', 20000);
  check('home: while-you-were-away section renders (honest state)', true);

  // ============ NOTIFICATIONS POPOVER ============
  console.log('>> step: notifications');
  const unread = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL`, [uid]);
  check('notifications: unread notifications exist (task lifecycle)', unread.rows[0].n >= 1);
  await page.waitForSelector('[aria-label="Notifications"]', { timeout: 15000 });
  let notifItems = '';
  for (let i = 0; i < 3 && notifItems.trim().length === 0; i++) {
    await page.click('[aria-label="Notifications"]');
    await wait(1800);
    notifItems = await page.evaluate(() => [...document.querySelectorAll('.cc-popover__item')].map((el) => el.textContent ?? '').join(' | '));
    if (notifItems.trim().length === 0) await page.click('[aria-label="Notifications"]');
  }
  const pop = notifItems.trim().length > 0;
  check('notifications: popover opens with real items', pop);
  if (!pop) BLOCKED.push('notifications: popover did not render items on click');

  // ============ THINKING MOON (already asserted during chat) ============
  console.log('>> step: thinking-moon');
  // moon during real request asserted above; also assert no moon on idle page
  const idleMoon = await page.evaluate(() => document.querySelector('.cc-moon--think') !== null);
  check('thinking-moon: no moon when idle (only during real generation)', !idleMoon);

  // ============ RESPONSIVE ============
  console.log('>> step: responsive');
  const small = await newPage(browser, { width: 375, height: 667 });
  await small.goto(BASE + '/projects', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await small.waitForSelector('button[aria-label="Toggle navigation"]', { timeout: 20000 });
  check('responsive: mobile viewport shows nav toggle', true);
  const overflow = await small.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('responsive: no horizontal overflow at 375px', overflow <= 1, `overflow=${overflow}px`);
  await small.close();

  // ============ A11Y smoke ============
  console.log('>> step: a11y');
  const a11y = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Workspace navigation"]');
    const main = document.querySelector('main');
    const acc = document.querySelector('button[aria-label="Account menu"]');
    const noName = [...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || '').trim() && !(b.textContent || '').trim() && !b.getAttribute('title')).length;
    return { nav: !!nav, main: !!main, accountMenu: !!acc, unnamedIconButtons: noName };
  });
  check('a11y: landmarks (nav/main) + key controls named', a11y.nav && a11y.main && a11y.accountMenu);
  check('a11y: no unnamed icon-only buttons on current view', a11y.unnamedIconButtons === 0, `unnamed=${a11y.unnamedIconButtons}`);

  // ============ OFFLINE (CDP network emulation) ============
  console.log('>> step: offline');
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await wait(1500);
  const offlineShown = await page.evaluate(() => document.body.innerText.includes('Offline') || document.body.innerText.includes('offline'));
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await wait(1500);
  check('offline: app surfaces offline state honestly', offlineShown);
  if (!offlineShown) BLOCKED.push('offline: app has no visible offline indicator under emulated network loss (checked DOM only)');
  await cdp.detach();

  // ============ SECURITY SMOKE ============
  console.log('>> step: security');
  const csrfMissing = await page.evaluate(async () => {
    const r = await fetch('/api/v1/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return r.status;
  });
  check('security: state-changing request without CSRF token rejected', csrfMissing === 403);
  const anonMe = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/me');
    return r.status;
  });
  check('security: /me authenticated after session (baseline)', anonMe === 200);

  // ============ SUMMARY ============
  console.log('\n--- BLOCKED ---');
  for (const b of BLOCKED) console.log('  -', b);
  await summary('PART 2 (chat/memory/tasks/files/teams/continuity/notifications/responsive/a11y/offline/security)');
} catch (e) {
  console.log('PART2 ERROR:', e.message, '| url=', page.url());
  const bodyTxt = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '(evaluate failed)');
  console.log('PAGE BODY:', bodyTxt.replace(/\n+/g, ' | '));
  const blog = stack.blog();
  const chatLines = blog.split('\n').filter((l) => l.includes('chat') || l.includes('conversations')).slice(-10);
  console.log('SERVER LOG (chat/conversations tail):\n' + (chatLines.join('\n') || '(none)'));
  const fs = await import('node:fs');
  fs.mkdirSync(ROOT + 'frontend/e2e/shots', { recursive: true });
  await page.screenshot({ path: ROOT + 'frontend/e2e/shots/part2-error.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  // ---- cleanup (FK-safe) ----
  try {
    if (uid) {
      const tasks = await db.query(`SELECT id FROM tasks WHERE owner_id = $1`, [uid]);
      for (const t of tasks.rows) {
        await db.query(
          `DELETE FROM coworker_handoffs WHERE from_run_id IN (SELECT id FROM coworker_runs WHERE task_id = $1) OR to_run_id IN (SELECT id FROM coworker_runs WHERE task_id = $1)`,
          [t.id],
        ).catch(() => {});
        await db.query(`DELETE FROM coworker_artifacts WHERE run_id IN (SELECT id FROM coworker_runs WHERE task_id = $1)`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM coworker_runs WHERE task_id = $1`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM plan_entries WHERE plan_id IN (SELECT id FROM plans WHERE task_id = $1)`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM plans WHERE task_id = $1`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM tool_calls WHERE task_id = $1`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM task_steps WHERE task_id = $1`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM task_attempts WHERE task_id = $1`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM task_dlq WHERE task_id = $1`, [t.id]).catch(() => {});
        await db.query(`DELETE FROM approvals WHERE task_id = $1`, [t.id]).catch(() => {});
      }
      const teams = await db.query(`SELECT id FROM teams WHERE owner_id = $1`, [uid]);
      for (const tm2 of teams.rows) {
        await db.query(`DELETE FROM team_members WHERE team_id = $1`, [tm2.id]);
      }
      const convs = await db.query(`SELECT id FROM conversations WHERE owner_id = $1`, [uid]);
      for (const c of convs.rows) {
        await db.query(`DELETE FROM messages WHERE conversation_id = $1`, [c.id]);
        await db.query(`DELETE FROM plan_entries WHERE conversation_id = $1`, [c.id]).catch(() => {});
      }
      await db.query(`DELETE FROM memories WHERE owner_id = $1`, [uid]);
      await db.query(`DELETE FROM dna_versions WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM dna WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM file_versions WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM files WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE owner_id = $1)`, [uid]);
      await db.query(`DELETE FROM tasks WHERE owner_id = $1`, [uid]);
      await db.query(`DELETE FROM conversations WHERE owner_id = $1`, [uid]);
      await db.query(`DELETE FROM teams WHERE owner_id = $1`, [uid]);
      await db.query(`DELETE FROM notifications WHERE recipient_id = $1`, [uid]);
      await db.query(`DELETE FROM audit_logs WHERE actor_user_id = $1 OR tenant_id = $1`, [uid]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM email_verifications WHERE user_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM outbox_events WHERE payload->'data'->>'userId' = $1 OR payload->>'userId' = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM user_preferences WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM entitlements WHERE user_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM usage_counters WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM workspace_state WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM projects WHERE owner_id = $1`, [uid]).catch(() => {});
      await db.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
      console.log('cleanup: part2 rows removed');
    }
  } catch (ce) {
    console.log('cleanup warning:', ce.message);
  }
  try { worker.kill(); } catch {}
  await cleanupStack(stack, browser);
  await db.end().catch(() => {});
}
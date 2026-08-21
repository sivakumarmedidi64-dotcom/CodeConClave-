import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
import 'dotenv/config';
const { default: pg } = await import('pg');

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const ROOT = 'C:/Users/sride/CodeConClave-/';
export const BASE = 'http://127.0.0.1:5173';

export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function spawnStack() {
  const backend = spawn(process.execPath, ['dist/server.js'], { cwd: ROOT + 'backend', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const vite = spawn(process.execPath, [ROOT + 'node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT + 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let blog = '', vlog = '';
  backend.stdout.on('data', (d) => { blog += d; });
  backend.stderr.on('data', (d) => { blog += d; });
  vite.stdout.on('data', (d) => { vlog += d; });
  vite.stderr.on('data', (d) => { vlog += d; });

  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const z = await fetch('http://127.0.0.1:4000/healthz', { signal: AbortSignal.timeout(3000) });
        if (z.ok) {
          let f;
          try { f = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(3000) }); }
          catch { f = await fetch('http://localhost:5173/', { signal: AbortSignal.timeout(3000) }); }
          if (f.status === 200) return true;
        }
      } catch {}
      await wait(1500);
    }
    return false;
  };
  const ok = await ready();
  if (!ok) {
    console.log('STACK FAILED TO START');
    console.log('backend log tail:', blog.split('\n').slice(-10).join('\n'));
    console.log('vite log tail:', vlog.split('\n').slice(-10).join('\n'));
    backend.kill(); vite.kill();
    process.exit(1);
  }
  return { backend, vite, blog: () => blog, vlog: () => vlog };
}

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--disable-gpu', '--no-first-run', '--disable-extensions'],
  });
}

export async function newPage(browser, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  return page;
}

export async function goto(page, path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
}

export async function waitText(page, text, timeout = 20000, partial = true) {
    await page.waitForFunction(
      (t, p) => {
        const els = [...document.querySelectorAll('body *')].filter((e) => {
          const label = e.getAttribute && e.getAttribute('aria-label');
          if (label && (p ? label.includes(t) : label === t)) return true;
          return e.textContent && (p ? e.textContent.includes(t) : e.textContent.trim() === t);
        });
        return els.some((e) => !els.some((f) => f !== e && e.contains(f)));
      },
      { timeout },
      text,
      partial,
    );
  }

  // Retry-with-reload: rides out transient pooler/DB degradation windows
  // (observed 503/500 bursts across unrelated endpoints) by reloading the
  // page between attempts. Fails honestly if the text never appears.
  export async function waitTextRetry(page, text, timeout = 20000, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        await waitText(page, text, timeout);
        return;
      } catch {
        if (i === attempts - 1) throw new Error(`waitText(${text}) failed after ${attempts} attempts`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await wait(3000);
      }
    }
  }

export async function hasText(page, text, partial = true) {
  return page.evaluate((t, p) => {
    const els = [...document.querySelectorAll('body *')].filter((e) => {
      const label = e.getAttribute && e.getAttribute('aria-label');
      if (label && (p ? label.includes(t) : label === t)) return true;
      return e.textContent && (p ? e.textContent.includes(t) : e.textContent.trim() === t);
    });
    return els.some((e) => !els.some((f) => f !== e && e.contains(f)));
  }, text, partial);
}

export async function clickText(page, text, partial = true) {
  const ok = await page.evaluate((t, p) => {
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], label')];
    const el = els.find((e) => {
      const label = e.getAttribute('aria-label');
      if (label && (p ? label.includes(t) : label === t)) return true;
      const txt = (e.textContent ?? '').trim();
      return p ? txt.includes(t) : txt === t;
    });
    if (el) { el.click(); return true; }
    return false;
  }, text, partial);
  if (!ok) throw new Error('clickText not found: ' + text);
}

export async function type(page, sel, value) {
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.click(sel, { clickCount: 3 });
  await page.type(sel, value, { delay: 15 });
}

export async function shot(page, name) {
  const fs = await import('node:fs');
  fs.mkdirSync(ROOT + 'frontend/e2e/shots', { recursive: true });
  await page.screenshot({ path: ROOT + `frontend/e2e/shots/${name}.png`, fullPage: false });
}

export async function dbClient() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

export async function cleanupStack(stack, browser) {
  try { await browser?.close(); } catch {}
  try { stack?.backend?.kill(); } catch {}
  try { stack?.vite?.kill(); } catch {}
}

export function summary(stage) {
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${stage}: ${results.length - fails.length}/${results.length} PASS`);
  if (fails.length) console.log('FAILED:', fails.map((f) => f.name).join(' | '));
  process.exit(fails.length ? 1 : 0);
}
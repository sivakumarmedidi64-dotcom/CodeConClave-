/**
 * CodeConClave Local Agent — browser controller.
 *
 * Drives one managed page target over CDP. Every operation:
 *   - uses only fixed JS templates (selectors/values are JSON-string-literal
 *     injected, never concatenated into executable syntax);
 *   - REQUIRES having passed assertBrowserAction (contract.ts) first;
 *   - reads page bytes/text through a cap; never reads input values, cookies,
 *     localStorage or passwords;
 *   - reports REAL completion or a structured honest failure.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CdpSession } from './cdp.js';
import { setCurrentPageUrlProvider, resolveDownloadPath } from './contract.js';
import { redactSecrets, isPasswordField } from './redact.js';

const DEFAULT_PAGE_WAIT_MS = 15_000;
const DEFAULT_ELEMENT_WAIT_MS = 1500;
const READ_MAX_BYTES = 64 * 1024;
const INSPECT_TEXT_MAX = 24 * 1024;

export interface ControllerOptions {
  pageWaitMs?: number;
  elementWaitMs?: number;
  screenshotMaxBytes?: number;
}

export type OpResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

export class BrowserController {
  private currentUrl: URL | null = null;
  private screenshotMaxBytes: number;

  constructor(
    private session: CdpSession,
    options: ControllerOptions = {},
  ) {
    this.screenshotMaxBytes = options.screenshotMaxBytes ?? 8 * 1024 * 1024;
    setCurrentPageUrlProvider(() => this.currentUrl);
  }

  // ------------------------------------------------------------ primitives

  private async evaluate(expression: string): Promise<OpResult> {
    let result: Record<string, unknown>;
    try {
      result = await this.session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? redactSecrets(err.message) : 'evaluate_failed' };
    }
    if (result.exceptionDetails) {
      const text = extractException(result.exceptionDetails);
      return { ok: false, error: redactSecrets(text) };
    }
    const value = result.result as { value?: unknown } | undefined;
    const data = value?.value as { ok: boolean; [k: string]: unknown } | undefined;
    if (!data) return { ok: false, error: 'evaluate_returned_no_value' };
    return data.ok ? { ok: true, data } : { ok: false, error: typeof data.reason === 'string' ? data.reason : 'action_denied_by_page' };
  }

  async pageState(): Promise<{ url: string; title: string; ready: boolean }> {
    const r = await this.evaluate(`(() => ({ ok: true, url: location.href, title: document.title, ready: document.readyState === 'complete' }))()`);
    const url = r.ok ? String(r.data.url ?? '') : '';
    try {
      this.currentUrl = url ? new URL(url) : this.currentUrl;
    } catch {
      this.currentUrl = null;
    }
    return {
      url,
      title: r.ok ? String(r.data.title ?? '') : '',
      ready: r.ok ? Boolean(r.data.ready) : false,
    };
  }

  private async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.pageState();
      if (s.ready) return true;
      await sleep(100);
    }
    return false;
  }

  private waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return poll(() => this.evaluate(`(() => ({ ok: true, found: Boolean(document.querySelector(${JSON.stringify(selector)})) }))()`), (r) => r.ok && r.data.found === true, deadline);
  }

  // ------------------------------------------------------------ navigation

  async open(url: string, opts: { pageWaitMs?: number } = {}): Promise<OpResult> {
    try {
      await this.session.send('Page.navigate', { url });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? redactSecrets(err.message) : 'navigate_failed' };
    }
    await this.waitReady(opts.pageWaitMs ?? DEFAULT_PAGE_WAIT_MS);
    const s = await this.pageState();
    return { ok: true, data: { url: s.url, title: s.title } };
  }

  async back(): Promise<OpResult> {
    const r = await this.evaluate(`(() => { history.back(); return { ok: true }; })()`);
    if (!r.ok) return r;
    await this.waitReady(DEFAULT_PAGE_WAIT_MS);
    return { ok: true, data: { restored: true } };
  }

  async forward(): Promise<OpResult> {
    const r = await this.evaluate(`(() => { history.forward(); return { ok: true }; })()`);
    if (!r.ok) return r;
    await this.waitReady(DEFAULT_PAGE_WAIT_MS);
    return { ok: true, data: { restored: true } };
  }

  async reload(): Promise<OpResult> {
    try {
      await this.session.send('Page.reload', { ignoreCache: false });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? redactSecrets(err.message) : 'reload_failed' };
    }
    await this.waitReady(DEFAULT_PAGE_WAIT_MS);
    return { ok: true, data: { reloaded: true } };
  }

  // ------------------------------------------------------------ observation

  async read(selector: string | undefined, maxBytes = READ_MAX_BYTES): Promise<OpResult> {
    const sel = selector ?? '';
    const expr = `(() => {
      const root = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document.body'};
      if (!root) return { ok: false, reason: 'element_not_found' };
      const text = (root.innerText || root.textContent || '').trim();
      const capped = text.length > ${maxBytes};
      return { ok: true, text: text.slice(0, ${maxBytes}), truncated: capped, bytes: text.length };
    })()`;
    const r = await this.evaluate(expr);
    if (!r.ok) return r;
    r.data.text = redactSecrets(String(r.data.text ?? ''));
    return r;
  }

  async inspect(selector: string | undefined): Promise<OpResult> {
    const sel = selector ?? '';
    const expr = `(() => {
      const scope = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document'};
      if (${sel ? '!scope' : 'false'}) return { ok: false, reason: 'element_not_found' };
      const text = (scope.body ? scope.body.innerText : scope.innerText || scope.textContent || '').trim();
      const inputs = [];
      for (const i of scope.querySelectorAll ? scope.querySelectorAll('input, select, textarea') : []) {
        if (i.getAttribute && i.getAttribute('aria-hidden') === 'true') continue;
        inputs.push({ tag: i.tagName, id: i.id || null, name: i.getAttribute('name'), type: i.getAttribute('type') });
      }
      const buttons = [];
      for (const b of scope.querySelectorAll ? scope.querySelectorAll('button, input[type=submit], input[type=button]') : []) {
        buttons.push({ id: b.id || null, text: (b.innerText || b.value || '').trim().slice(0, 80) });
      }
      const links = [];
      for (const a of scope.querySelectorAll ? scope.querySelectorAll('a[href]') : []) {
        links.push({ text: (a.innerText || '').trim().slice(0, 80), href: a.getAttribute('href'), id: a.id || null });
        if (links.length >= 200) break;
      }
      const forms = [];
      for (const f of scope.querySelectorAll ? scope.querySelectorAll('form') : []) {
        forms.push({ id: f.id || null, action: f.getAttribute('action'), method: f.getAttribute('method') });
        if (forms.length >= 50) break;
      }
      return { ok: true, url: location.href, title: document.title,
        text: text.slice(0, ${INSPECT_TEXT_MAX}), truncated: text.length > ${INSPECT_TEXT_MAX},
        inputs: inputs.slice(0, 200), buttons: buttons.slice(0, 200), links, forms };
    })()`;
    const r = await this.evaluate(expr);
    if (!r.ok) return r;
    r.data.text = redactSecrets(String(r.data.text ?? ''));
    // Never leak input VALUES — scrub any accidental value key the page returns.
    for (const field of Array.isArray(r.data.inputs) ? (r.data.inputs as Record<string, unknown>[]) : []) {
      delete field.value;
    }
    for (const field of Array.isArray(r.data.inputs) ? (r.data.inputs as Record<string, unknown>[]) : []) {
      if (isPasswordField(field)) field.sensitive = true;
    }
    return r;
  }

  async search(query: string, maxMatches = 20): Promise<OpResult> {
    const expr = `(() => {
      const q = ${JSON.stringify(query)}.toLowerCase();
      if (!q) return { ok: false, reason: 'empty_query' };
      const lines = (document.body.innerText || '').split(/\\n+/).map((s) => s.trim()).filter(Boolean);
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < ${maxMatches}; i++) {
        if (lines[i].toLowerCase().includes(q)) matches.push({ index: i, snippet: lines[i].slice(0, 300) });
      }
      return { ok: true, query: ${JSON.stringify(query)}, count: matches.length, matches };
    })()`;
    const r = await this.evaluate(expr);
    if (r.ok) r.data = { ...r.data, matches: (Array.isArray(r.data.matches) ? r.data.matches : []).map((m) => ({ ...(m as Record<string, unknown>), snippet: redactSecrets(String((m as { snippet?: string }).snippet ?? '')) })) };
    return r;
  }

  async extract(selectors: string[]): Promise<OpResult> {
    const cap = Math.min(selectors.length, 32);
    const parts = selectors.slice(0, cap).map((sel) => JSON.stringify(sel));
    const expr = `(() => {
      const out = [];
      for (const sel of [${parts.join(',')}]) {
        const el = document.querySelector(sel);
        out.push({ selector: sel, text: el ? (el.innerText || el.textContent || '').trim().slice(0, 5000) : null });
      }
      return { ok: true, extracted: out };
    })()`;
    const r = await this.evaluate(expr);
    if (r.ok && Array.isArray(r.data.extracted)) {
      r.data.extracted = (r.data.extracted as Record<string, unknown>[]).map((e) => ({ ...e, text: e.text == null ? null : redactSecrets(String(e.text)) }));
    }
    return r;
  }

  async scroll(direction: 'up' | 'down' | 'top' | 'bottom', amount?: number): Promise<OpResult> {
    const amt = typeof amount === 'number' && amount > 0 ? Math.round(amount) : 600;
    const expr = `(() => {
      const d = ${JSON.stringify(direction)};
      if (d === 'top') window.scrollTo(0, 0);
      else if (d === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else window.scrollBy(0, d === 'down' ? ${amt} : -${amt});
      return { ok: true, y: Math.round(window.scrollY) };
    })()`;
    return this.evaluate(expr);
  }

  // ------------------------------------------------------------ interaction

  async click(selector: string): Promise<OpResult> {
    if (!(await this.waitForSelector(selector, DEFAULT_ELEMENT_WAIT_MS))) {
      return { ok: false, error: 'element_not_found' };
    }
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'element_not_found' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true };
    })()`);
    if (!r.ok) return r;
    await this.waitReady(DEFAULT_PAGE_WAIT_MS);
    return r;
  }

  async type(selector: string, text: string): Promise<OpResult> {
    if (!(await this.waitForSelector(selector, DEFAULT_ELEMENT_WAIT_MS))) {
      return { ok: false, error: 'element_not_found' };
    }
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'element_not_found' };
      const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
      const auto = (el.getAttribute && (el.getAttribute('autocomplete') || '')).toLowerCase();
      if (el instanceof HTMLInputElement && (type === 'password' || auto.includes('current-password') || auto.includes('new-password'))) {
        return { ok: false, reason: 'password_field_denied' };
      }
      const settable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (!settable && !(el instanceof HTMLElement && el.isContentEditable)) return { ok: false, reason: 'not_a_field' };
      const value = ${JSON.stringify(text)};
      if (settable) el.value = value; else el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, set: settable ? 'value' : 'textContent' };
    })()`);
    if (r.ok) delete r.data.context;
    return r;
  }

  async select(selector: string, value: string): Promise<OpResult> {
    if (!(await this.waitForSelector(selector, DEFAULT_ELEMENT_WAIT_MS))) {
      return { ok: false, error: 'element_not_found' };
    }
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || !(el instanceof HTMLSelectElement)) return { ok: false, reason: 'select_not_found' };
      const want = ${JSON.stringify(value)};
      const opt = Array.from(el.options).find((o) => o.value === want || o.text === want);
      if (!opt) return { ok: false, reason: 'option_not_found' };
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: opt.value };
    })()`);
  }

  async submit(selector: string): Promise<OpResult> {
    if (!(await this.waitForSelector(selector, DEFAULT_ELEMENT_WAIT_MS))) {
      return { ok: false, error: 'element_not_found' };
    }
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'element_not_found' };
      const f = el.tagName === 'FORM' ? el : el.closest('form');
      if (!f) return { ok: false, reason: 'no_form_found' };
      if (f.querySelector('input[type=password]')) return { ok: false, reason: 'password_form_submit_denied' };
      try { f.requestSubmit(); } catch { f.submit(); }
      return { ok: true };
    })()`);
    if (!r.ok) return r;
    await this.waitReady(DEFAULT_PAGE_WAIT_MS);
    return r;
  }

  // ------------------------------------------------------------ evidence / files

  async screenshot(absPath: string): Promise<OpResult> {
    mkdirSync(dirname(absPath), { recursive: true });
    let result: Record<string, unknown>;
    try {
      result = await this.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? redactSecrets(err.message) : 'screenshot_failed' };
    }
    const b64 = typeof result.data === 'string' ? result.data : '';
    if (!b64) return { ok: false, error: 'screenshot_no_data' };
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > this.screenshotMaxBytes) return { ok: false, error: `screenshot_exceeds_${this.screenshotMaxBytes}_bytes` };
    writeFileSync(absPath, buf);
    return { ok: true, data: { path: basename(absPath), absPath, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') } };
  }

  async download(url: string | undefined, downloadDir: string, timeoutMs = 20_000): Promise<OpResult> {
    mkdirSync(downloadDir, { recursive: true });
    const pending: Record<string, unknown>[] = [];
    let suggested = '';
    const un1 = this.session.on('Page.downloadWillBegin', (p) => {
      suggested = String(p.suggestedFilename ?? '');
    });
    const un2 = this.session.on('Page.downloadProgress', (p) => {
      pending.push(p);
    });
    try {
      await this.session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
      if (url) await this.session.send('Page.navigate', { url });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const done = pending.some((p) => String(p.state) === 'completed' && Number(p.totalBytes) > 0);
        if (done) break;
        await sleep(100);
      }
      if (!pending.some((p) => String(p.state) === 'completed')) {
        return { ok: false, error: typeof url === 'string' ? 'download_did_not_complete' : 'no_download_observed' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? redactSecrets(err.message) : 'download_failed' };
    } finally {
      un1();
      un2();
    }
    const path = resolveDownloadPath(downloadDir, suggested);
    if (!existsSync(path)) {
      // The browser may have used a slightly different name: pick the newest file.
      const newest = newestFile(downloadDir);
      if (!newest) return { ok: false, error: 'download_file_missing' };
      const s = statSync(newest);
      return { ok: true, data: { path: basename(newest), absPath: newest, bytes: s.size, sha256: createHash('sha256').update(readFileSync(newest)).digest('hex') } };
    }
    const s = statSync(path);
    return { ok: true, data: { path: basename(path), absPath: path, bytes: s.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } };
  }

  async upload(selector: string, absPath: string): Promise<OpResult> {
    if (!existsSync(absPath)) return { ok: false, error: 'upload_source_missing' };
    try {
      const doc = await this.session.send('DOM.getDocument', { depth: -1, pierce: true });
      const rootId = Number((doc.root as { nodeId?: unknown } | undefined)?.nodeId ?? 0);
      if (!rootId) return { ok: false, error: 'dom_root_unavailable' };
      const q = await this.session.send('DOM.querySelector', { nodeId: rootId, selector });
      const nodeId = Number((q as { nodeId?: unknown }).nodeId ?? 0);
      if (!nodeId) return { ok: false, error: 'upload_input_not_found' };
      const attrs = await this.session.send('DOM.getAttributes', { nodeId });
      const list = attrs.attributes as unknown[] | undefined;
      const isFile = list?.some((v, i) => v === 'type' && String(list[i + 1]) === 'file');
      if (!isFile) return { ok: false, error: 'upload_target_not_file_input' };
      await this.session.send('DOM.setFileInputFiles', { files: [absPath], nodeId });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? redactSecrets(err.message) : 'upload_failed' };
    }
    return { ok: true, data: { selector, file: basename(absPath), bytes: statSync(absPath).size } };
  }

  dispose(): void {
    setCurrentPageUrlProvider(() => null);
  }
}

function extractException(details: unknown): string {
  const d = details as { text?: string; exception?: { description?: string; value?: unknown } };
  if (typeof d.text === 'string' && d.text) return d.text;
  if (d.exception) return String(d.exception.description ?? d.exception.value ?? 'page_script_error');
  return 'page_script_error';
}

function newestFile(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const s = statSync(p);
      if (!s.isFile()) continue;
      if (!best || s.mtimeMs > best.mtime) best = { path: p, mtime: s.mtimeMs };
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

async function poll(check: () => Promise<OpResult>, done: (r: OpResult) => boolean, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const r = await check();
    if (done(r)) return true;
    await sleep(80);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
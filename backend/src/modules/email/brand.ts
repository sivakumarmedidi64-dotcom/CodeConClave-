/**
 * CodeConClave — transactional email brand shell.
 *
 * Adds the canonical CodeConClave logo (assets/brand/logo-icon.svg, the
 * authoritative black + white radial symbol) to transactional emails as an
 * inline data URI — no external image host is required. The same visual
 * identity ships in every email builder (welcome/receipt, verification,
 * activation, claim). If the canonical asset is missing the shell degrades to
 * a text wordmark (never a broken image, never a fake logo).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOGO_REL = new URL('../../../../assets/brand/logo-icon.svg', import.meta.url);

function loadLogoSrc(): string | null {
  try {
    if (!fileURLToPath(LOGO_REL) || !existsSync(LOGO_REL)) return null;
    const svg = readFileSync(LOGO_REL, 'utf8');
    const b64 = Buffer.from(svg, 'utf8').toString('base64');
    return `data:image/svg+xml;base64,${b64}`;
  } catch {
    return null;
  }
}

const LOGO_SRC = loadLogoSrc();

const BRAND_YELLOW = '#ffd400';
const BRAND_BLACK = '#000000';

/**
 * Email header block: black bar with the white radial symbol + yellow wordmark.
 * Uses the canonical mark (data URI) so Gmail/Outlook/mobile render consistently.
 */
export function emailHeaderHtml(title: string): string {
  const mark = LOGO_SRC
    ? `<img src="${LOGO_SRC}" alt="CodeConClave" width="40" height="40" style="display:inline-block;border:0;border-radius:6px;vertical-align:middle;margin-right:10px"/>`
    : `<span style="font-weight:800;color:${BRAND_YELLOW};font-size:18px">CodeConClave</span>`;
  return [
    `<div style="background:${BRAND_BLACK};border-radius:10px 10px 0 0;padding:18px 24px">`,
    mark,
    `<span style="color:${BRAND_YELLOW};font-size:18px;font-weight:800;letter-spacing:1px">CodeConClave</span>`,
    `</div>`,
    `<div style="background:#f7f7f5;border:1px solid #e5e5e0;border-top:0;border-radius:0 0 10px 10px;padding:24px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">`,
    `<h1 style="font-size:18px;margin:0 0 14px;color:#111">${title}</h1>`,
  ].join('\n');
}

export function emailFooterHtml(): string {
  return [
    `</div>`,
    `<p style="margin-top:14px;font-size:11px;color:#7a7a78;text-align:center;font-family:Arial,Helvetica,sans-serif">`,
    `This is an automated message from CodeConClave. If you didn't expect this email, you can safely ignore it.`,
    `</p>`,
    `<p style="margin-top:8px;font-size:11px;color:#7a7a78;text-align:center;font-family:Arial,Helvetica,sans-serif">`,
    `THANK YOU &lt;&lt;&lt; MEDIDI SAHARSH (Founder of CodeConClave)`,
    `</p>`,
  ].join('\n');
}

/** Wrap arbitrary email body HTML in the canonical brand shell. */
export function wrapEmailHtml(title: string, body: string): string {
  return [emailHeaderHtml(title), body, emailFooterHtml()].join('\n');
}
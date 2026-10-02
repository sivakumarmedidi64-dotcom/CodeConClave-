/**
 * CodeConClave — IMAP auto-unlock: mailbox transport.
 *
 * Reads UNSEEN Razorpay notification mail from the MERCHANT's own mailbox
 * (the payment-account mailbox that receives "payment received" emails) over
 * IMAP using the app-password credentials the deployment ALREADY carries for
 * transactional email (GMAIL_USER + GMAIL_APP_PASSWORD). No Razorpay API key,
 * no webhook secret, no OAuth — the mailbox is read, never written except the
 * \Seen flag on processed messages.
 *
 * Injected as an interface so tests can supply a fake transport; the real
 * transport is constructed lazily only when enabled.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { env } from '../../../config/env.js';
import type { ParsedPaymentMail } from './parse.js';

export interface MailboxTransport {
  /** Fetch UNSEEN messages from the sender domain since `since`. */
  fetchUnseen(since: Date): Promise<ParsedPaymentMail[]>;
  /** Mark the given message UIDs as \Seen (processed). */
  markSeen(uids: number[]): Promise<void>;
}

export function imapCredentialsConfigured(): boolean {
  return Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD);
}

/** Real IMAP transport. Returns null when credentials are not configured. */
export function imapTransport(): MailboxTransport | null {
  if (!imapCredentialsConfigured()) return null;

  const connect = (): ImapFlow =>
    new ImapFlow({
      host: env.GMAIL_IMAP_HOST,
      port: 993,
      secure: true,
      auth: { user: env.GMAIL_USER!, pass: env.GMAIL_APP_PASSWORD! },
      logger: false,
    });

  return {
    async fetchUnseen(since: Date): Promise<ParsedPaymentMail[]> {
      const client = connect();
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        const mails: ParsedPaymentMail[] = [];
        try {
          const uids = await client.search({ seen: false, from: 'razorpay.com', since }, { uid: true });
          if (uids && uids.length > 0) {
            for await (const msg of client.fetch(uids, { uid: true, source: true, flags: true })) {
              try {
                if (!msg.source) continue;
                const parsed = await simpleParser(msg.source);
                const authHeaders = parsed.headerLines
                  ?.filter((h) => h.key.toLowerCase() === 'authentication-results')
                  .map((h) => h.line.replace(/^authentication-results:\s*/i, ''))
                  .join('\n');
                mails.push({
                  uid: msg.uid,
                  subject: parsed.subject ?? null,
                  from: parsed.from?.value[0]?.address ?? null,
                  date: parsed.date ?? null,
                  text: typeof parsed.text === 'string' ? parsed.text : null,
                  html: typeof parsed.html === 'string' ? parsed.html : null,
                  authResults: authHeaders || null,
                });
              } catch {
                // A single unparseable message never aborts the sweep.
              }
            }
          }
        } finally {
          lock.release();
        }
        return mails;
      } finally {
        try {
          await client.logout();
        } catch {
          // Connection teardown is best-effort.
        }
      }
    },

    async markSeen(uids: number[]): Promise<void> {
      if (uids.length === 0) return;
      const client = connect();
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          for (const uid of uids) {
            await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
          }
        } finally {
          lock.release();
        }
      } finally {
        try {
          await client.logout();
        } catch {
          // Connection teardown is best-effort.
        }
      }
    },
  };
}

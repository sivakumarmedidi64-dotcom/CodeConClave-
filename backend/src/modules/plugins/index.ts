/**
 * CodeConClave — plugin SDK bootstrap (Phase 10).
 * Registers every adapter and the plugin_action tool. Idempotent; called from
 * the server and worker entrypoints (like registerPaymentTools).
 */
import { registerAdapter } from './sdk.js';
import { githubAdapter } from './adapters/github.js';
import { googleAdapter } from './adapters/google.js';
import { resendAdapter } from './adapters/resend.js';
import { webhookAdapter } from './adapters/webhook.js';
import { slackAdapter } from './adapters/slack.js';
import { linearAdapter } from './adapters/linear.js';
import { discordAdapter } from './adapters/discord.js';
import { sentryAdapter } from './adapters/sentry.js';
import { vercelAdapter } from './adapters/vercel.js';
import { cloudflareAdapter } from './adapters/cloudflare.js';
import { registerPluginTools } from './pluginTool.js';

let registered = false;

export function registerPlugins(): void {
  if (registered) return;
  registered = true;
  registerAdapter(githubAdapter);
  registerAdapter(googleAdapter);
  registerAdapter(resendAdapter);
  registerAdapter(webhookAdapter);
  registerAdapter(slackAdapter);
  registerAdapter(linearAdapter);
  registerAdapter(discordAdapter);
  registerAdapter(sentryAdapter);
  registerAdapter(vercelAdapter);
  registerAdapter(cloudflareAdapter);
  registerPluginTools();
}
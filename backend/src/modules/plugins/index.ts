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
import { notionAdapter } from './adapters/notion.js';
import { stripeAdapter } from './adapters/stripe.js';
import { twilioAdapter } from './adapters/twilio.js';
import { pagerdutyAdapter } from './adapters/pagerduty.js';
import { asanaAdapter } from './adapters/asana.js';
import { gitlabAdapter } from './adapters/gitlab.js';
import { hubspotAdapter } from './adapters/hubspot.js';
import { pipedriveAdapter } from './adapters/pipedrive.js';
import { clickupAdapter } from './adapters/clickup.js';
import { mondayAdapter } from './adapters/monday.js';
import { codaAdapter } from './adapters/coda.js';
import { trelloAdapter } from './adapters/trello.js';
import { klaviyoAdapter } from './adapters/klaviyo.js';
import { databricksAdapter } from './adapters/databricks.js';
import { zendeskAdapter } from './adapters/zendesk.js';
import { datadogAdapter } from './adapters/datadog.js';
import { mailgunAdapter } from './adapters/mailgun.js';
import { confluenceAdapter } from './adapters/confluence.js';
import { servicenowAdapter } from './adapters/servicenow.js';
import { jiraAdapter } from './adapters/jira.js';
import { supabaseAdapter } from './adapters/supabase.js';
import { renderAdapter } from './adapters/render.js';
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
  registerAdapter(notionAdapter);
  registerAdapter(stripeAdapter);
  registerAdapter(twilioAdapter);
  registerAdapter(pagerdutyAdapter);
  registerAdapter(asanaAdapter);
  registerAdapter(gitlabAdapter);
  registerAdapter(hubspotAdapter);
  registerAdapter(pipedriveAdapter);
  registerAdapter(clickupAdapter);
  registerAdapter(mondayAdapter);
  registerAdapter(codaAdapter);
  registerAdapter(trelloAdapter);
  registerAdapter(klaviyoAdapter);
  registerAdapter(databricksAdapter);
  registerAdapter(zendeskAdapter);
  registerAdapter(datadogAdapter);
  registerAdapter(mailgunAdapter);
  registerAdapter(confluenceAdapter);
  registerAdapter(servicenowAdapter);
  registerAdapter(jiraAdapter);
  registerAdapter(supabaseAdapter);
  registerAdapter(renderAdapter);
  registerPluginTools();
}
-- 0067: plugin catalog expansion — more integrations with real brand marks
-- Adds additional catalogue entries (display-only unless an adapter is later
-- wired in) and widens the plugin_type/category CHECK constraints.

-- Widen the plugin_type CHECK to admit the new catalogue entries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugins_plugin_type_check') THEN
    ALTER TABLE plugins DROP CONSTRAINT plugins_plugin_type_check;
  END IF;
END $$;
ALTER TABLE plugins ADD CONSTRAINT plugins_plugin_type_check
  CHECK (plugin_type IN ('github','google','resend','slack','teams','discord',
    'notion','linear','jira','figma','sentry','cloudflare','supabase',
    'vercel','render','vscode','webhook',
    'stripe','twilio','datadog','trello','asana','hubspot','mailgun',
    'zoom','salesforce','pagerduty'));

-- Widen the category CHECK to admit new grouping labels.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugins_category_check') THEN
    ALTER TABLE plugins DROP CONSTRAINT plugins_category_check;
  END IF;
END $$;
ALTER TABLE plugins ADD CONSTRAINT plugins_category_check CHECK (category IN (
  'development','productivity','communication','project_management','design',
  'cloud','data','monitoring','finance','support','crm','commerce','workflow'));

INSERT INTO plugins (plugin_type, name, description, capabilities, category, popular, required_permissions) VALUES
  ('stripe', 'Stripe', 'Payments, invoices and subscription events (adapter required).', '["payments","invoices"]', 'finance', false, '["read","write"]'),
  ('twilio', 'Twilio', 'Send SMS and voice messages (adapter required).', '["sms","voice"]', 'communication', false, '["send"]'),
  ('datadog', 'Datadog', 'Monitors, dashboards and incident signals (adapter required).', '["monitoring","incidents"]', 'monitoring', false, '["read"]'),
  ('trello', 'Trello', 'Boards, cards and checklist automation (adapter required).', '["boards","cards"]', 'project_management', false, '["read","write"]'),
  ('asana', 'Asana', 'Tasks, projects and portfolio tracking (adapter required).', '["tasks","projects"]', 'project_management', false, '["read","write"]'),
  ('hubspot', 'HubSpot', 'CRM, contacts and pipelines (adapter required).', '["crm","contacts"]', 'crm', false, '["read","write"]'),
  ('mailgun', 'Mailgun', 'Transactional and marketing email (adapter required).', '["email"]', 'communication', false, '["send"]'),
  ('zoom', 'Zoom', 'Meetings and recordings (adapter required).', '["meetings"]', 'productivity', false, '["read","create"]'),
  ('salesforce', 'Salesforce', 'Accounts, opportunities and records (adapter required).', '["crm","records"]', 'crm', false, '["read","write"]'),
  ('pagerduty', 'PagerDuty', 'On-call schedules and incident response (adapter required).', '["incidents"]', 'monitoring', false, '["read","write"]')
ON CONFLICT (plugin_type) DO NOTHING;

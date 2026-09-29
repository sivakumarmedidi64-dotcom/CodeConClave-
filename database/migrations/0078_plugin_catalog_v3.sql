-- 0078: plugin catalog v3 — marketplace completeness
-- Adds adapter-backed catalogue entries for the new connectors and honest
-- display-only rows for OAuth/enterprise platforms (still UNSUPPORTED until an
-- adapter is wired in; the plugin center shows the true status).

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
    'zoom','salesforce','pagerduty',
    'gitlab','pipedrive','clickup','monday','coda','klaviyo','databricks','zendesk',
    'webex','onedrive','sharepoint','box','dropbox','egnyte','outlook',
    'outlook_calendar','confluence','guru','basecamp','apollo','outreach',
    'bitbucket','snowflake','bigquery','powerbi','amplitude','hex','workday',
    'servicenow','canva','ahrefs','similarweb','sap','docusign','quickbooks'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugins_category_check') THEN
    ALTER TABLE plugins DROP CONSTRAINT plugins_category_check;
  END IF;
END $$;
ALTER TABLE plugins ADD CONSTRAINT plugins_category_check CHECK (category IN (
  'development','productivity','communication','project_management','design',
  'cloud','data','monitoring','finance','support','crm','commerce','workflow',
  'storage','email','knowledge','analytics','hr_it','marketing'));

-- Adapter-backed entries (work with a user-supplied token in this build).
INSERT INTO plugins (plugin_type, name, description, capabilities, category, popular, required_permissions) VALUES
  ('gitlab', 'GitLab', 'Repositories, merge requests and issue tracking.', '["repositories","issues"]', 'development', true, '["read"]'),
  ('pipedrive', 'Pipedrive', 'Sales pipelines, deals and people.', '["crm","deals"]', 'crm', true, '["read"]'),
  ('clickup', 'ClickUp', 'Tasks, docs and project views.', '["tasks","projects"]', 'project_management', true, '["read"]'),
  ('monday', 'monday.com', 'Work OS boards, items and automations.', '["boards","projects"]', 'project_management', true, '["read"]'),
  ('coda', 'Coda', 'Docs, tables and packs.', '["documents","tables"]', 'knowledge', true, '["read"]'),
  ('klaviyo', 'Klaviyo', 'Email marketing, lists and campaigns.', '["email","marketing"]', 'marketing', true, '["read"]'),
  ('databricks', 'Databricks', 'Workspaces, clusters and jobs.', '["data","analytics"]', 'data', true, '["read"]'),
  ('zendesk', 'Zendesk', 'Support tickets and customer conversations.', '["support","tickets"]', 'support', true, '["read","create"]')
ON CONFLICT (plugin_type) DO NOTHING;

-- Display-only entries: OAuth-app or enterprise-credential platforms. They
-- stay honestly UNSUPPORTED in the plugin center until an adapter is wired in.
INSERT INTO plugins (plugin_type, name, description, capabilities, category, popular, required_permissions) VALUES
  ('webex', 'Webex', 'Meetings, messaging and calling (needs OAuth app).', '["meetings","messages"]', 'communication', false, '["read","create"]'),
  ('onedrive', 'OneDrive', 'Personal and work file storage (needs OAuth app).', '["files","storage"]', 'storage', false, '["read","write"]'),
  ('sharepoint', 'SharePoint', 'Team sites and document libraries (needs OAuth app).', '["files","sites"]', 'storage', false, '["read","write"]'),
  ('box', 'Box', 'Content management and file sharing (needs OAuth app).', '["files","storage"]', 'storage', false, '["read","write"]'),
  ('dropbox', 'Dropbox', 'File sync and sharing (needs OAuth app).', '["files","storage"]', 'storage', false, '["read","write"]'),
  ('egnyte', 'Egnyte', 'Hybrid work file governance (needs OAuth app).', '["files","governance"]', 'storage', false, '["read","write"]'),
  ('outlook', 'Outlook', 'Email and calendar (needs OAuth app).', '["email","calendar"]', 'email', true, '["read","send"]'),
  ('outlook_calendar', 'Outlook Calendar', 'Calendar meetings and availability (needs OAuth app).', '["calendar"]', 'productivity', false, '["read"]'),
  ('confluence', 'Confluence', 'Team knowledge spaces (needs site + OAuth app).', '["documents","spaces"]', 'knowledge', false, '["read","write"]'),
  ('guru', 'Guru', 'Company knowledge cards (needs OAuth app).', '["knowledge","cards"]', 'knowledge', false, '["read"]'),
  ('basecamp', 'Basecamp', 'Projects, to-dos and campfire (needs OAuth app).', '["projects","todos"]', 'project_management', false, '["read"]'),
  ('apollo', 'Apollo.io', 'Prospecting and contact enrichment (needs API scopes).', '["crm","contacts"]', 'crm', false, '["read"]'),
  ('outreach', 'Outreach', 'Sales engagement sequences (needs OAuth app).', '["crm","sequences"]', 'crm', false, '["read"]'),
  ('bitbucket', 'Bitbucket', 'Git repos and pipelines (needs OAuth2 app).', '["repositories","pipelines"]', 'development', false, '["read","write"]'),
  ('snowflake', 'Snowflake', 'Data warehouse (needs JDBC account credentials).', '["data","warehouse"]', 'data', false, '["read"]'),
  ('bigquery', 'BigQuery', 'Google data warehouse (needs service account).', '["data","analytics"]', 'data', false, '["read"]'),
  ('powerbi', 'Power BI', 'Dashboards and reports (needs OAuth app).', '["analytics","reports"]', 'analytics', false, '["read"]'),
  ('amplitude', 'Amplitude', 'Product analytics events (needs API key + secret).', '["analytics","events"]', 'analytics', false, '["read"]'),
  ('hex', 'Hex', 'Notebooks for data analysis (needs OAuth app).', '["analytics","notebooks"]', 'analytics', false, '["read"]'),
  ('workday', 'Workday', 'HR and finance (needs tenant + OAuth2 client).', '["hr","finance"]', 'hr_it', false, '["read"]'),
  ('servicenow', 'ServiceNow', 'ITSM and workflows (needs instance credentials).', '["itsm","workflows"]', 'hr_it', false, '["read"]'),
  ('canva', 'Canva', 'Design and brand kits (needs OAuth app).', '["design","brand"]', 'design', false, '["read","create"]'),
  ('ahrefs', 'Ahrefs', 'SEO keywords and backlinks (needs API token).', '["seo","keywords"]', 'marketing', false, '["read"]'),
  ('similarweb', 'Similarweb', 'Traffic and competitor insights (needs API key).', '["analytics","traffic"]', 'marketing', false, '["read"]'),
  ('sap', 'SAP ERP', 'Enterprise resource planning (needs enterprise access).', '["erp","finance"]', 'finance', false, '["read"]'),
  ('docusign', 'DocuSign', 'E-signature agreements (needs OAuth app).', '["signatures","agreements"]', 'finance', false, '["read","send"]'),
  ('quickbooks', 'QuickBooks', 'Accounting, invoices and expenses (needs OAuth app).', '["accounting","invoices"]', 'finance', false, '["read","write"]')
ON CONFLICT (plugin_type) DO NOTHING;
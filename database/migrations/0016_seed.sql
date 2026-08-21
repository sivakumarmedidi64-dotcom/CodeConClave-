-- 0016: seed — ai_model_registry, provider_health, plugins catalogue, feature_flags
-- Registry is CONFIGURATION: prices are public list rates (USD per 1M tokens) and
-- may be adjusted by operators. Health is tracked at runtime, never assumed.
-- STAGE 20.2: retired google models (gemini-2.5-pro / gemini-2.5-flash are no
-- longer served to this account — live 404) replaced with live-verified
-- gemini-3.7-flash (200, real completion). gemini-2.5-pro row disabled until an
-- operator registers a current Google Pro model (gemini-3.1-pro-preview is
-- quota-limited here, 429). Prices for gemini-3.7-flash retained pending
-- operator confirmation of current list rates.

INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled)
VALUES
  ('claude-opus-4-1',  'anthropic', 'Claude Opus',     'PREMIUM', 'C', 200000, true, true, true, 15.000000, 75.000000, 'PRO',  'STANDARD', 8000, 'UNKNOWN', 10, '["claude-sonnet-4-5","gpt-4o"]', true),
  ('gpt-4o',           'openai',    'GPT-4o',          'PREMIUM', 'C', 128000, true, true, true,  5.000000, 15.000000, 'PRO',  'STANDARD', 8000, 'UNKNOWN', 20, '["claude-sonnet-4-5","gemini-3.7-flash"]', true),
  ('gemini-2.5-pro',   'google',    'Gemini Pro',      'PREMIUM', 'C', 1000000, true, true, true, 2.500000, 15.000000, 'PRO',  'STANDARD', 9000, 'UNKNOWN', 30, '["claude-sonnet-4-5","gpt-4o"]', false),
  ('claude-sonnet-4-5','anthropic', 'Claude Sonnet',   'CAPABLE', 'B', 200000, true, true, true,  3.000000, 15.000000, 'FREE',  'STANDARD', 6000, 'UNKNOWN', 40, '["claude-haiku-4-5","gpt-4o-mini"]', true),
  ('mistral-large-2411','mistral',  'Mistral Large',   'CAPABLE', 'B', 128000, false, true, true, 2.000000, 6.000000, 'FREE',  'STANDARD', 7000, 'UNKNOWN', 50, '["claude-haiku-4-5","gemini-3.7-flash"]', true),
  ('claude-haiku-4-5', 'anthropic', 'Claude Haiku',    'EFFICIENT','A', 200000, true, true, true, 1.000000, 5.000000, 'FREE', 'STANDARD', 3000, 'UNKNOWN', 60, '["gpt-4o-mini","gemini-3.7-flash"]', true),
  ('gpt-4o-mini',      'openai',    'GPT-4o mini',     'EFFICIENT','A', 128000, true, true, true, 0.150000, 0.600000, 'FREE', 'STANDARD', 3000, 'UNKNOWN', 70, '["claude-haiku-4-5","gemini-3.7-flash"]', true),
  ('gemini-3.7-flash', 'google',    'Gemini Flash',    'EFFICIENT','A', 1000000, true, true, true, 0.300000, 2.500000, 'FREE', 'STANDARD', 3000, 'UNKNOWN', 80, '["claude-haiku-4-5","gpt-4o-mini"]', true)
ON CONFLICT (model_id) DO NOTHING;

INSERT INTO provider_health (provider_id, state)
VALUES
  ('anthropic', 'UNKNOWN'),
  ('openai',    'UNKNOWN'),
  ('google',    'UNKNOWN'),
  ('mistral',   'UNKNOWN')
ON CONFLICT (provider_id) DO NOTHING;

INSERT INTO plugins (plugin_type, name, description, capabilities)
VALUES
  ('github',  'GitHub',  'Repositories, issues, PRs, checks, deployments (CodeConClave Pro App)', '["repo:read","repo:write","issues","pull_requests","checks"]'),
  ('slack',   'Slack',   'Messages and notifications', '["chat:post","channels:read"]'),
  ('vercel',  'Vercel',  'Deployments and previews', '["deploy","previews"]'),
  ('vscode',  'VS Code', 'Editor integration and diffs', '["open","diff","terminal"]'),
  ('webhook', 'Webhook', 'Generic HTTP webhook / API endpoint', '["http:post","http:get"]')
ON CONFLICT (plugin_type) DO NOTHING;

INSERT INTO feature_flags (id, name, value)
VALUES
  ('ff_coworkers_enabled',    'coworkers.enabled',    '{"value": true}'),
  ('ff_remote_enabled',       'remote.enabled',       '{"value": true}'),
  ('ff_dna_restore',          'dna_restore',          '{"value": true}'),
  ('ff_plugins_enabled',      'plugins.enabled',      '{"value": true}'),
  ('ff_moons_enabled',        'moons.enabled',        '{"value": true}'),
  ('ff_24_7_work_enabled',    '24_7_work.enabled',    '{"value": true}'),
  ('ff_ideas_enabled',        'ideas.enabled',        '{"value": true}'),
  ('ff_gain_trash_enabled',   'gain_trash.enabled',   '{"value": true}'),
  ('ff_history_enabled',      'history.enabled',      '{"value": true}'),
  ('ff_data_centre_enabled',  'data_centre.enabled',  '{"value": true}'),
  ('ff_teams_enabled',        'teams.enabled',        '{"value": true}'),
  ('ff_approval_center_enabled', 'approval_center.enabled', '{"value": true}')
ON CONFLICT (name) DO NOTHING;
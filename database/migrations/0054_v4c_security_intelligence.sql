-- 0053: V4C Security Intelligence — vulnerability, supply chain, secret management, API security, posture

-- Security scans table
CREATE TABLE IF NOT EXISTS security_scans (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  started_at           timestamptz NOT NULL,
  completed_at         timestamptz NOT NULL,
  findings             jsonb NOT NULL DEFAULT '[]',
  summary              jsonb NOT NULL DEFAULT '{}',
  scanned_files        int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_scans_project ON security_scans (project_id);
CREATE INDEX idx_security_scans_completed ON security_scans (completed_at DESC);

-- Vulnerability findings table
CREATE TABLE IF NOT EXISTS vulnerability_findings (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  type                 text NOT NULL,
  severity             text NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW','INFO')),
  file_path            text NOT NULL,
  line                 int,
  "column"             int,
  evidence             text NOT NULL,
  description          text NOT NULL,
  remediation          text NOT NULL,
  confidence           numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  detected_at          timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','FIXED','FALSE_POSITIVE','WONT_FIX')),
  assigned_to          text REFERENCES users(id),
  cve                  text,
  "references"         jsonb NOT NULL DEFAULT '[]',
  regression_status    text NOT NULL DEFAULT 'UNKNOWN' CHECK (regression_status IN ('NOT_REGRESSED','REGRESSED','UNKNOWN')),
  fixed_at             timestamptz,
  fixed_by             text REFERENCES users(id),
  fix_commit           text,
  assigned_at          timestamptz,
  acknowledged_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_vuln_project ON vulnerability_findings (project_id);
CREATE INDEX idx_vuln_status ON vulnerability_findings (status);
CREATE INDEX idx_vuln_severity ON vulnerability_findings (severity);
CREATE INDEX idx_vuln_type ON vulnerability_findings (type);
CREATE INDEX idx_vuln_assigned ON vulnerability_findings (assigned_to);

CREATE TRIGGER trg_vuln_updated_at
  BEFORE UPDATE ON vulnerability_findings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Vulnerability history (audit trail for findings)
CREATE TABLE IF NOT EXISTS vulnerability_history (
  id                   text PRIMARY KEY,
  finding_id           text NOT NULL REFERENCES vulnerability_findings(id) ON DELETE CASCADE,
  field                text NOT NULL,
  old_value            text,
  new_value            text,
  changed_by           text NOT NULL REFERENCES users(id),
  changed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_vuln_history_finding ON vulnerability_history (finding_id);
CREATE INDEX idx_vuln_history_changed ON vulnerability_history (changed_at DESC);

-- Remediation plans
CREATE TABLE IF NOT EXISTS remediation_plans (
  id                   text PRIMARY KEY,
  finding_id           text NOT NULL REFERENCES vulnerability_findings(id) ON DELETE CASCADE,
  steps                jsonb NOT NULL DEFAULT '[]',
  estimated_effort     text,
  target_date          timestamptz,
  owner                text NOT NULL REFERENCES users(id),
  status               text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','BLOCKED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_remediation_finding ON remediation_plans (finding_id);
CREATE INDEX idx_remediation_owner ON remediation_plans (owner);

CREATE TRIGGER trg_remediation_updated
  BEFORE UPDATE ON remediation_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Supply chain scans
CREATE TABLE IF NOT EXISTS supply_chain_scans (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  started_at           timestamptz NOT NULL,
  completed_at         timestamptz NOT NULL,
  dependencies         jsonb NOT NULL DEFAULT '[]',
  vulnerabilities      jsonb NOT NULL DEFAULT '[]',
  summary              jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_supply_chain_project ON supply_chain_scans (project_id);
CREATE INDEX idx_supply_chain_completed ON supply_chain_scans (completed_at DESC);

-- Secret rotations (extended from secret_guard)
CREATE TABLE IF NOT EXISTS secret_rotations (
  id                   text PRIMARY KEY,
  kind                 text NOT NULL,
  new_kind             text NOT NULL,
  rotated_by           text NOT NULL REFERENCES users(id),
  trigger              text NOT NULL CHECK (trigger IN ('MANUAL','SCHEDULED','EXPOSURE','POLICY')),
  rotated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_secret_rotations_kind ON secret_rotations (kind);
CREATE INDEX idx_secret_rotations_rotated ON secret_rotations (rotated_at DESC);

-- Secret rotation policies
CREATE TABLE IF NOT EXISTS secret_rotation_policies (
  kind                 text PRIMARY KEY,
  max_age_days         int NOT NULL DEFAULT 90,
  warn_before_days     int NOT NULL DEFAULT 14,
  auto_rotate          boolean NOT NULL DEFAULT false,
  allowed_kinds        jsonb NOT NULL DEFAULT '[]',
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_secret_policy_updated
  BEFORE UPDATE ON secret_rotation_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Secret exposures (extended from secret_guard_scans)
CREATE TABLE IF NOT EXISTS secret_exposures (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  kind                 text NOT NULL,
  target_type          text NOT NULL,
  target_ref           text,
  detected_at          timestamptz NOT NULL,
  scanner_type         text NOT NULL CHECK (scanner_type IN ('secret_guard','manual','git_history')),
  was_redacted         boolean NOT NULL DEFAULT true,
  resolved             boolean NOT NULL DEFAULT false,
  resolved_at          timestamptz,
  resolved_by          text REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_secret_exposures_project ON secret_exposures (project_id);
CREATE INDEX idx_secret_exposures_kind ON secret_exposures (kind);
CREATE INDEX idx_secret_exposures_detected ON secret_exposures (detected_at DESC);

-- Secret rotation policies (extended)
ALTER TABLE secret_guard_scans ADD COLUMN IF NOT EXISTS was_redacted boolean NOT NULL DEFAULT true;

-- API Security scans
CREATE TABLE IF NOT EXISTS api_security_scans (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  started_at           timestamptz NOT NULL,
  completed_at         timestamptz NOT NULL,
  endpoints            jsonb NOT NULL DEFAULT '[]',
  summary              jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_security_project ON api_security_scans (project_id);
CREATE INDEX idx_api_security_completed ON api_security_scans (completed_at DESC);

-- API Security configuration
CREATE TABLE IF NOT EXISTS api_security_config (
  project_id           text NOT NULL REFERENCES projects(id),
  key                  text NOT NULL,
  value                jsonb NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key)
);

CREATE TRIGGER trg_api_security_config_updated
  BEFORE UPDATE ON api_security_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Security posture history
CREATE TABLE IF NOT EXISTS security_posture_history (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  overall_score        int NOT NULL,
  overall_level        text NOT NULL CHECK (overall_level IN ('EXCELLENT','GOOD','FAIR','POOR','CRITICAL')),
  categories           jsonb NOT NULL DEFAULT '[]',
  assessed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, assessed_at)
);

CREATE INDEX idx_posture_history_project ON security_posture_history (project_id);
CREATE INDEX idx_posture_history_assessed ON security_posture_history (assessed_at DESC);

-- Security posture cache (for fast reads)
CREATE TABLE IF NOT EXISTS security_posture_cache (
  project_id           text PRIMARY KEY REFERENCES projects(id),
  overall_score        int NOT NULL,
  overall_level        text NOT NULL CHECK (overall_level IN ('EXCELLENT','GOOD','FAIR','POOR','CRITICAL')),
  categories           jsonb NOT NULL DEFAULT '[]',
  expires_at           timestamptz NOT NULL
);

-- Secret rotation policies (extended columns)
ALTER TABLE secret_rotation_policies ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Secret exposure resolution tracking
ALTER TABLE secret_exposures ADD COLUMN IF NOT EXISTS resolved boolean NOT NULL DEFAULT false;
ALTER TABLE secret_exposures ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE secret_exposures ADD COLUMN IF NOT EXISTS resolved_by text REFERENCES users(id);

-- Add indexes for secret_exposures
CREATE INDEX IF NOT EXISTS idx_secret_exposures_project ON secret_exposures (project_id);
CREATE INDEX IF NOT EXISTS idx_secret_exposures_kind ON secret_exposures (kind);
CREATE INDEX IF NOT EXISTS idx_secret_exposures_detected ON secret_exposures (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_secret_exposures_resolved ON secret_exposures (resolved);
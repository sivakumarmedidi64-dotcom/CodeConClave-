-- 0060: PKG-15 Security Operations Intelligence — incidents + compliance reports

-- Security incidents (#21): project-scoped, owner-isolated lifecycle.
CREATE TABLE IF NOT EXISTS secops_incidents (
  id               text PRIMARY KEY,
  project_id       text NOT NULL REFERENCES projects(id),
  title            text NOT NULL,
  severity         text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','TRIAGING','IN_PROGRESS','CONTAINED','RESOLVED','CLOSED','FALSE_POSITIVE')),
  response_action  text NOT NULL DEFAULT 'REMEDIATE' CHECK (response_action IN ('CONTAIN','MITIGATE','REMEDIATE','ACCEPT')),
  description      text NOT NULL DEFAULT '',
  source           text,
  finding_ids      jsonb NOT NULL DEFAULT '[]',
  assignee_id      text REFERENCES users(id),
  summary          text,
  created_by       text NOT NULL REFERENCES users(id),
  timeline         jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_secops_incidents_project ON secops_incidents (project_id);
CREATE INDEX idx_secops_incidents_status ON secops_incidents (status);
CREATE INDEX idx_secops_incidents_severity ON secops_incidents (severity);
CREATE INDEX idx_secops_incidents_assignee ON secops_incidents (assignee_id);
CREATE INDEX idx_secops_incidents_created ON secops_incidents (created_at DESC);

CREATE TRIGGER trg_secops_incident_updated
  BEFORE UPDATE ON secops_incidents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Compliance reports (#24): persisted, bounded history per project.
CREATE TABLE IF NOT EXISTS secops_compliance_reports (
  id               text PRIMARY KEY,
  project_id       text NOT NULL REFERENCES projects(id),
  overall_score    int NOT NULL,
  overall_status   text NOT NULL CHECK (overall_status IN ('COMPLIANT','PARTIAL','NON_COMPLIANT','UNKNOWN')),
  posture_score    int NOT NULL DEFAULT 0,
  posture_level    text,
  categories       jsonb NOT NULL DEFAULT '[]',
  items            jsonb NOT NULL DEFAULT '[]',
  created_by       text NOT NULL REFERENCES users(id),
  generated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_secops_compliance_project ON secops_compliance_reports (project_id);
CREATE INDEX idx_secops_compliance_generated ON secops_compliance_reports (generated_at DESC);

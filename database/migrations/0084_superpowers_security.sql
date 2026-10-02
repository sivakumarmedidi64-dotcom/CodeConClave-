-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche F): security & correctness cluster.
--
--   DETERMINISM HAMMER  (feature 38): every flaky test is INVESTIGATED, not
--                         worked around. Classification is deterministic from
--                         the test source (time / random / order / network).
--   SUPPLY-CHAIN SENTINEL (feature 40): every package evaluated against age,
--                         maintainer count and install scripts — blockers get
--                         BLOCK/SANDBOX/APPROVE verdict, never silence.
--   DATA GUARDIAN        (feature 42): every PII sighting tracked by concrete
--                         type (email / phone / SSN / card) and location, and
--                         traced to remediation.
--   SECRET AUTOPSY       (feature 43): every secret exposure gets a full
--                         exposure timeline and a rotation status — PENDING
--                         until actually rotated.
--   PROMPT ARMOR         (feature 45): every untrusted surface scanned for
--                         injection methods; hits are neutralized, never
--                         silently passed along.
--
-- Owned rows + RLS identical to 0079..0083 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE flake_investigations (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target            text NOT NULL,
  source            text,
  category          text NOT NULL
                    CHECK (category IN ('TIME_DEPENDENCE','RANDOM_SEED','ORDER_DEPENDENCE','NETWORK_RELIANCE','UNKNOWN')),
  evidence          text,
  root_cause        text,
  fix               text,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','FIXED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_flake_investigations_owner ON flake_investigations (owner_id, status, created_at DESC);

ALTER TABLE flake_investigations ENABLE ROW LEVEL SECURITY;
CREATE POLICY flake_investigations_owner ON flake_investigations USING (owner_id = app.uid());

CREATE TABLE package_evaluations (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  name              text NOT NULL,
  published_days_ago integer NOT NULL DEFAULT 0,
  last_commit_days_ago integer NOT NULL DEFAULT 0,
  maintainer_count  integer NOT NULL DEFAULT 0,
  has_install_script boolean NOT NULL DEFAULT false,
  author_unknown    boolean NOT NULL DEFAULT false,
  verdict           text NOT NULL CHECK (verdict IN ('APPROVE','SANDBOX','BLOCK')),
  reasons           jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

ALTER TABLE package_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY package_evaluations_owner ON package_evaluations USING (owner_id = app.uid());

CREATE TABLE pii_findings (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target_path       text NOT NULL,
  location_type     text NOT NULL
                    CHECK (location_type IN ('STORAGE','LOG_SINK','API_RESPONSE','DATABASE')),
  pii_types         jsonb NOT NULL DEFAULT '[]',
  content_sample    text,
  status            text NOT NULL DEFAULT 'TRACKED'
                    CHECK (status IN ('TRACKED','REMEDIATED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pii_findings_owner ON pii_findings (owner_id, status);

ALTER TABLE pii_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY pii_findings_owner ON pii_findings USING (owner_id = app.uid());

CREATE TABLE secret_incidents (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  secret_name       text NOT NULL,
  detection_source  text NOT NULL
                    CHECK (detection_source IN ('COMMIT','LOG','TICKET','ENV','SCREENSHOT')),
  first_seen        timestamptz NOT NULL DEFAULT now(),
  systems_affected  jsonb NOT NULL DEFAULT '[]',
  exposure_notes    text,
  rotation_status   text NOT NULL DEFAULT 'PENDING'
                    CHECK (rotation_status IN ('PENDING','ROTATED')),
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','RESOLVED')),
  rotated_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_secret_incidents_owner ON secret_incidents (owner_id, status);

ALTER TABLE secret_incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY secret_incidents_owner ON secret_incidents USING (owner_id = app.uid());

CREATE TABLE injection_events (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  surface           text NOT NULL
                    CHECK (surface IN ('ISSUE','WEBPAGE','DEPENDENCY','PDF','LOG','COMMENT')),
  content_snapshot  text,
  methods           jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','NEUTRALIZED','IGNORED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_injection_events_owner ON injection_events (owner_id, status, created_at DESC);

ALTER TABLE injection_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY injection_events_owner ON injection_events USING (owner_id = app.uid());
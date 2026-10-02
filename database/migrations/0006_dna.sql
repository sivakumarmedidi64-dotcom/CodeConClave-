-- 0006: DNA — dna, dna_versions, dna_conflicts

CREATE TABLE dna (
  id                 text PRIMARY KEY,
  project_id         text NOT NULL REFERENCES projects(id),
  owner_id           text NOT NULL REFERENCES users(id),
  kind               text NOT NULL CHECK (kind IN (
                       'DECISION','UNRESOLVED_WORK','NEXT_ACTIONS','DISCOVERY','BLOCKER',
                       'PROJECT_CONTEXT','RELEVANT_FILES','ENVIRONMENT_STATE','VERIFICATION_RESULT')),
  scope              text NOT NULL DEFAULT 'MAIN' CHECK (scope IN ('MAIN','BRANCH')),
  title              text NOT NULL,
  content            text NOT NULL,
  version            int NOT NULL DEFAULT 1,
  parent_version_id  text REFERENCES dna(id),
  conflict_state     text NOT NULL DEFAULT 'NONE' CHECK (conflict_state IN ('NONE','CONFLICT','RESOLVED')),
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dna_project_scope_updated ON dna (project_id, scope, updated_at DESC);
CREATE INDEX idx_dna_project_kind ON dna (project_id, kind);

CREATE TRIGGER trg_dna_updated_at
  BEFORE UPDATE ON dna
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dna_versions (
  id                 text PRIMARY KEY,
  dna_id             text NOT NULL REFERENCES dna(id),
  version            int NOT NULL,
  content_snapshot   text NOT NULL,
  created_by         text REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_dna_versions UNIQUE (dna_id, version)
);

CREATE TABLE dna_conflicts (
  id               text PRIMARY KEY,
  branch_dna_id    text NOT NULL REFERENCES dna(id),
  base_dna_id      text NOT NULL REFERENCES dna(id),
  state            text NOT NULL DEFAULT 'CONFLICT' CHECK (state IN ('CONFLICT','RESOLVED')),
  resolution       text,
  resolved_at      timestamptz,
  resolved_by      text REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_dna_conflicts UNIQUE (branch_dna_id, base_dna_id)
);

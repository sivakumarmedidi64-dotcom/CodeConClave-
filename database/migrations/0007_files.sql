-- 0007: files — files, file_versions, file_permissions, file_references

CREATE TABLE files (
  id                text PRIMARY KEY,
  project_id        text NOT NULL REFERENCES projects(id),
  owner_id          text NOT NULL REFERENCES users(id),
  path              text NOT NULL,
  size_bytes        bigint NOT NULL DEFAULT 0,
  sha256            text NOT NULL,
  storage_key       text,
  storage_provider  text CHECK (storage_provider IN ('memory','s3','r2')),
  mime_type         text,
  is_directory      boolean NOT NULL DEFAULT false,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_files_project_path ON files (project_id, path) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_project ON files (project_id);

CREATE TRIGGER trg_files_updated_at
  BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE file_versions (
  id               text PRIMARY KEY,
  file_id          text NOT NULL REFERENCES files(id),
  version          int NOT NULL,
  content_sha256   text NOT NULL,
  size_bytes       bigint NOT NULL,
  storage_key      text,
  change_reason    text,
  created_by       text REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_file_versions UNIQUE (file_id, version)
);

CREATE INDEX idx_file_versions_file ON file_versions (file_id);

CREATE TABLE file_permissions (
  id                 text PRIMARY KEY,
  file_id            text NOT NULL REFERENCES files(id),
  grantee_user_id    text REFERENCES users(id),
  grantee_team_id    text REFERENCES teams(id),
  permission         text NOT NULL CHECK (permission IN ('read','write','delete')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_file_permission_grantee CHECK (grantee_user_id IS NOT NULL OR grantee_team_id IS NOT NULL)
);

CREATE TABLE file_references (
  id          text PRIMARY KEY,
  file_id     text NOT NULL REFERENCES files(id),
  project_id  text NOT NULL REFERENCES projects(id),
  ref_path    text,
  ref_type    text NOT NULL CHECK (ref_type IN ('memory','dna','message','task')),
  ref_id      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_file_references_file ON file_references (file_id);
CREATE INDEX idx_file_references_ref ON file_references (ref_type, ref_id);

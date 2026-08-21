-- 0030: PHASE 8 — files + storage + search + artifact center
-- Extends the Phase 1 files subsystem (0007) with metadata, preview,
-- version parentage, references, activity history, storage metadata and
-- artifact persistence. Static-only validation in this environment
-- (PostgreSQL runtime unavailable): never claim runtime success.
-- NOTE: PostgreSQL runtime is unavailable here; this file is validated
-- statically only and must not be claimed as applied.

-- ---------------------------------------------------------------------------
-- files: metadata (tags/category/favorite), preview + OCR (honest), retention
-- ---------------------------------------------------------------------------
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS tags           text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS category       text,
  ADD COLUMN IF NOT EXISTS description    text,
  ADD COLUMN IF NOT EXISTS is_favorite    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preview_kind   text
    CHECK (preview_kind IN ('TEXT','CODE','JSON','MARKDOWN','IMAGE','PDF','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS preview_status text NOT NULL DEFAULT 'UNAVAILABLE'
    CHECK (preview_status IN ('AVAILABLE','UNAVAILABLE')),
  ADD COLUMN IF NOT EXISTS ocr_status     text NOT NULL DEFAULT 'UNAVAILABLE'
    CHECK (ocr_status IN ('UNAVAILABLE')),
  ADD COLUMN IF NOT EXISTS encrypted      boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_files_tags ON files USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_files_owner_favorite ON files (owner_id, is_favorite) WHERE is_favorite;
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files (deleted_at) WHERE deleted_at IS NOT NULL;

-- ILIKE path search acceleration (pg_trgm; local/Supabase both ship it).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_files_path_trgm ON files USING gin (path gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- file_versions: parent version + rollback reference (Phase 8)
-- ---------------------------------------------------------------------------
ALTER TABLE file_versions
  ADD COLUMN IF NOT EXISTS parent_version   int,
  ADD COLUMN IF NOT EXISTS rollback_reference text;

CREATE INDEX IF NOT EXISTS idx_file_versions_parent ON file_versions (file_id, parent_version);

-- ---------------------------------------------------------------------------
-- file_references: artifact + conversation reference kinds, unique refs
-- ---------------------------------------------------------------------------
ALTER TABLE file_references DROP CONSTRAINT IF EXISTS file_references_ref_type_check;
ALTER TABLE file_references ADD CONSTRAINT file_references_ref_type_check
  CHECK (ref_type IN ('memory','dna','message','task','artifact','conversation'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_file_references_ref ON file_references (ref_type, ref_id, file_id);

-- ---------------------------------------------------------------------------
-- file_activity: per-file activity history (Phase 8)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_activity (
  id             text PRIMARY KEY,
  file_id        text NOT NULL REFERENCES files(id),
  project_id     text NOT NULL REFERENCES projects(id),
  actor_user_id  text REFERENCES users(id),
  action         text NOT NULL,
  detail         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_activity_file ON file_activity (file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_activity_actor ON file_activity (actor_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- storage_meta: per-tenant storage metadata (quota/retention/policy)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_meta (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_storage_meta_owner_key UNIQUE (owner_id, key)
);

CREATE INDEX IF NOT EXISTS idx_storage_meta_owner ON storage_meta (owner_id);

-- ---------------------------------------------------------------------------
-- artifacts: task-linkage columns for the Artifact Center (Phase 8)
-- ---------------------------------------------------------------------------
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS attempt_id     text REFERENCES task_attempts(id),
  ADD COLUMN IF NOT EXISTS created_by     text REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS content        text,
  ADD COLUMN IF NOT EXISTS verification   text
    CHECK (verification IN ('PASS','FAIL','SKIPPED'));

CREATE INDEX IF NOT EXISTS idx_artifacts_task_created ON artifacts (task_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS (mirrors 0015 patterns; tenant isolation for the new tables)
-- ---------------------------------------------------------------------------
ALTER TABLE file_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS file_activity_owner ON file_activity;
CREATE POLICY file_activity_owner ON file_activity
  USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = app.uid()
        OR id IN (SELECT project_id FROM project_members WHERE user_id = app.uid())
    )
  );

ALTER TABLE storage_meta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS storage_meta_owner ON storage_meta;
CREATE POLICY storage_meta_owner ON storage_meta
  USING (owner_id = app.uid());

-- ---------------------------------------------------------------------------
-- CodeConClave — PHASE 6: Memory + DNA + Real Retrieval + Provenance.
-- memories: tenant correlation, embedding status/model/dimensions, verification
-- state, scope, source bindings (message/file/task), HNSW + FTS indexes.
-- memory_corrections: immutable audit of every wrong/correct/edit/merge/delete.
-- dna / dna_versions: change_summary for provenance of every DNA mutation.
-- team_dna / team_dna_versions / team_dna_conflicts: team-scoped DNA.
--
-- NOTE: static-only migration. PostgreSQL runtime is NOT available in this
-- environment; this file is validated for SQL syntax only. Applied once.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- memories — Phase 6 columns.
-- ---------------------------------------------------------------------------
ALTER TABLE memories
  ADD COLUMN tenant_id text;

UPDATE memories SET tenant_id = app.uid() WHERE tenant_id IS NULL;

ALTER TABLE memories
  ALTER COLUMN tenant_id SET DEFAULT app.uid();

ALTER TABLE memories
  ADD COLUMN embedding_status text NOT NULL DEFAULT 'NONE'
    CHECK (embedding_status IN ('NONE','QUEUED','FAILED','READY'));

ALTER TABLE memories
  ADD COLUMN embedding_model text;

ALTER TABLE memories
  ADD COLUMN embedding_dimensions integer;

ALTER TABLE memories
  ADD COLUMN verification_state text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_state IN ('UNVERIFIED','VERIFIED','REJECTED'));

ALTER TABLE memories
  ADD COLUMN scope text NOT NULL DEFAULT 'PERSONAL'
    CHECK (scope IN ('PERSONAL','PROJECT','TEAM'));

ALTER TABLE memories
  ADD COLUMN source_message_id text;

ALTER TABLE memories
  ADD COLUMN source_file_id text;

ALTER TABLE memories
  ADD COLUMN task_id text;

UPDATE memories
  SET scope = CASE
    WHEN team_id IS NOT NULL THEN 'TEAM'
    WHEN project_id IS NOT NULL THEN 'PROJECT'
    ELSE 'PERSONAL'
  END
  WHERE scope = 'PERSONAL';

-- ---------------------------------------------------------------------------
-- memories — real retrieval indexes.
-- HNSW index over the pgvector column (only rows that actually have a vector).
-- GIN full-text index over content for the FULL_TEXT / HYBRID search paths.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_memories_embedding_hnsw ON memories
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX idx_memories_content_fts ON memories
  USING gin (to_tsvector('simple', content));

CREATE INDEX idx_memories_tenant_embedding ON memories (tenant_id, embedding_status);

-- ---------------------------------------------------------------------------
-- memory_corrections — immutable provenance trail for wrong/correct/edit/
-- merge/delete/restore actions. Never rewritten; rows are append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_corrections (
  id                  text PRIMARY KEY,
  memory_id           text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  correct_memory_id   text REFERENCES memories(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('FLAG_WRONG','EDIT','MERGE','DELETE','RESTORE')),
  reason              text,
  actor_user_id       text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_corrections_memory ON memory_corrections (memory_id, created_at);

-- ---------------------------------------------------------------------------
-- dna / dna_versions — change summary for provenance.
-- ---------------------------------------------------------------------------
ALTER TABLE dna
  ADD COLUMN change_summary text;

ALTER TABLE dna_versions
  ADD COLUMN change_summary text;

-- ---------------------------------------------------------------------------
-- team_dna — team-scoped DNA with MAIN/BRANCH/MERGE semantics, mirroring
-- the personal dna tables. RLS-scoped via team membership.
-- ---------------------------------------------------------------------------
CREATE TABLE team_dna (
  id                  text PRIMARY KEY,
  team_id             text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_by          text NOT NULL REFERENCES users(id),
  kind                text NOT NULL,
  scope               text NOT NULL DEFAULT 'MAIN' CHECK (scope IN ('MAIN','BRANCH')),
  title               text NOT NULL,
  content             text NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  parent_version_id   text,
  conflict_state      text NOT NULL DEFAULT 'NONE' CHECK (conflict_state IN ('NONE','CONFLICT','RESOLVED')),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MERGED','ARCHIVED')),
  change_summary      text,
  merged_into_id      text,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_dna_versions (
  id                  text PRIMARY KEY,
  dna_id              text NOT NULL REFERENCES team_dna(id) ON DELETE CASCADE,
  version             integer NOT NULL,
  content_snapshot    text NOT NULL,
  change_summary      text,
  created_by          text NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dna_id, version)
);

CREATE TABLE team_dna_conflicts (
  id                  text PRIMARY KEY,
  branch_dna_id       text NOT NULL REFERENCES team_dna(id) ON DELETE CASCADE,
  base_dna_id         text NOT NULL REFERENCES team_dna(id) ON DELETE CASCADE,
  state               text NOT NULL DEFAULT 'CONFLICT' CHECK (state IN ('CONFLICT','RESOLVED')),
  resolution          text,
  resolved_by         text REFERENCES users(id),
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_dna_id, base_dna_id)
);

CREATE INDEX idx_team_dna_team ON team_dna (team_id, deleted_at);
CREATE INDEX idx_team_dna_versions_dna ON team_dna_versions (dna_id, version DESC);

-- ---------------------------------------------------------------------------
-- RLS — team DNA is readable/writable by team members only.
-- ---------------------------------------------------------------------------
ALTER TABLE team_dna ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_dna_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_dna_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_dna_member_select ON team_dna
  USING (EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = team_dna.team_id AND tm.user_id = app.uid()
  ));

CREATE POLICY team_dna_member_insert ON team_dna
  WITH CHECK (EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = team_dna.team_id AND tm.user_id = app.uid()
  ));

CREATE POLICY team_dna_member_update ON team_dna
  USING (EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = team_dna.team_id AND tm.user_id = app.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = team_dna.team_id AND tm.user_id = app.uid()
  ));

CREATE POLICY team_dna_versions_member ON team_dna_versions
  USING (EXISTS (
    SELECT 1 FROM team_dna td
    JOIN team_members tm ON tm.team_id = td.team_id
    WHERE td.id = team_dna_versions.dna_id AND tm.user_id = app.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM team_dna td
    JOIN team_members tm ON tm.team_id = td.team_id
    WHERE td.id = team_dna_versions.dna_id AND tm.user_id = app.uid()
  ));

CREATE POLICY team_dna_conflicts_member ON team_dna_conflicts
  USING (EXISTS (
    SELECT 1 FROM team_dna td
    JOIN team_members tm ON tm.team_id = td.team_id
    WHERE (td.id = team_dna_conflicts.branch_dna_id OR td.id = team_dna_conflicts.base_dna_id)
      AND tm.user_id = app.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM team_dna td
    JOIN team_members tm ON tm.team_id = td.team_id
    WHERE (td.id = team_dna_conflicts.branch_dna_id OR td.id = team_dna_conflicts.base_dna_id)
      AND tm.user_id = app.uid()
  ));
-- 0005: memory — memories, memory_sources, memory_relationships

CREATE TABLE memories (
  id                   text PRIMARY KEY,
  project_id           text REFERENCES projects(id),
  team_id              text REFERENCES teams(id),
  owner_id             text NOT NULL REFERENCES users(id),
  type                 text NOT NULL CHECK (type IN ('EPISODIC','SEMANTIC','PROCEDURAL','PROJECT','TEAM')),
  source               text NOT NULL CHECK (source IN ('OBSERVED','USER_STATED','AI_INFERRED','RECOMMENDATION')),
  content              text NOT NULL,
  structured           jsonb,
  confidence           numeric(4,3) NOT NULL DEFAULT 0.5
                       CHECK (confidence >= 0 AND confidence <= 1),
  provenance           text,
  contradiction_state  text NOT NULL DEFAULT 'NONE'
                       CHECK (contradiction_state IN ('NONE','CANDIDATE','CONFIRMED','RESOLVED')),
  superseded_by_id     text REFERENCES memories(id),
  embedding            vector(1536),
  deleted_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_owner_project_type ON memories (owner_id, project_id, type);
CREATE INDEX idx_memories_project ON memories (project_id);

CREATE TRIGGER trg_memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memory_sources (
  id            text PRIMARY KEY,
  memory_id     text NOT NULL REFERENCES memories(id),
  source_label  text NOT NULL CHECK (source_label IN ('OBSERVED','USER_STATED','AI_INFERRED','RECOMMENDATION')),
  source_ref    text,
  captured_at   timestamptz NOT NULL,
  confidence    numeric(4,3),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_sources_memory ON memory_sources (memory_id);

CREATE TABLE memory_relationships (
  id                 text PRIMARY KEY,
  source_memory_id   text NOT NULL REFERENCES memories(id),
  target_memory_id   text NOT NULL REFERENCES memories(id),
  relation           text NOT NULL,
  weight             numeric(4,3) NOT NULL DEFAULT 0.5,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_memory_relationship_self CHECK (source_memory_id <> target_memory_id)
);

CREATE INDEX idx_memory_relationships_source ON memory_relationships (source_memory_id);

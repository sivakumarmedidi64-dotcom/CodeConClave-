-- CodeConClave — Stage 0094 SUPERPOWERS Tranche P (Institutional Transfer, Context Compressor, Concept Gap Detector, Negotiator, Org Memory Portability)

-- INSTITUTIONAL TRANSFER — a departing engineer's brain export
CREATE TABLE IF NOT EXISTS institutional_exports (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  engineer    TEXT NOT NULL,
  exports     JSONB NOT NULL DEFAULT '{}'::jsonb,
  highlights  JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DRAFTED' CHECK (status IN ('DRAFTED','PACKAGED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE institutional_exports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'institutional_exports_owner' AND tablename = 'institutional_exports') THEN CREATE POLICY institutional_exports_owner ON institutional_exports USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_institutional_exports_owner ON institutional_exports(owner_id);

-- CONTEXT COMPRESSOR — dense, accurate, cited summary
CREATE TABLE IF NOT EXISTS context_compressions (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  topic        TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  density      INTEGER NOT NULL DEFAULT 0,
  summary      TEXT NOT NULL,
  citations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE context_compressions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'context_compressions_owner' AND tablename = 'context_compressions') THEN CREATE POLICY context_compressions_owner ON context_compressions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_context_compressions_owner ON context_compressions(owner_id);

-- CONCEPT GAP DETECTOR — one concept, three names, three schemas
CREATE TABLE IF NOT EXISTS concept_gap_scans (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  concept        TEXT NOT NULL,
  aliases        JSONB NOT NULL DEFAULT '[]'::jsonb,
  locations      JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_count   INTEGER NOT NULL DEFAULT 0,
  unification    TEXT NOT NULL,
  migration_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'FOUND' CHECK (status IN ('FOUND','UNIFYING','RESOLVED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE concept_gap_scans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'concept_gap_scans_owner' AND tablename = 'concept_gap_scans') THEN CREATE POLICY concept_gap_scans_owner ON concept_gap_scans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_concept_gap_scans_owner ON concept_gap_scans(owner_id);

-- NEGOTIATOR — ambiguity handled like a senior engineer
CREATE TABLE IF NOT EXISTS negotiation_drafts (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  requirement    TEXT NOT NULL,
  conflict       TEXT NOT NULL DEFAULT '',
  interpretations JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended    TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED')),
  resolution     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE negotiation_drafts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'negotiation_drafts_owner' AND tablename = 'negotiation_drafts') THEN CREATE POLICY negotiation_drafts_owner ON negotiation_drafts USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_negotiation_drafts_owner ON negotiation_drafts(owner_id);

-- ORG MEMORY PORTABILITY — your knowledge graph, yours forever
CREATE TABLE IF NOT EXISTS memory_exports (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  components   JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats        JSONB NOT NULL DEFAULT '[]'::jsonb,
  archive_ref  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'EXPORTED' CHECK (status IN ('EXPORTED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE memory_exports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'memory_exports_owner' AND tablename = 'memory_exports') THEN CREATE POLICY memory_exports_owner ON memory_exports USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_memory_exports_owner ON memory_exports(owner_id);
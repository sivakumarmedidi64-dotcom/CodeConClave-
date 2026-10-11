-- 0147: Agent Sai Srinivasa Athreya — private + multimodal (text+image)
-- Private: agent rows stay project-scoped (no cross-project reads; enforced
-- in routes by INGEST_AGENT_OWNER_ID + getProject ownership).
-- Multimodal: every source carries text+image; image payloads land in
-- ingest_media with sha256, gated + verified before any Blob write.

ALTER TABLE ingest_sources
  ADD COLUMN IF NOT EXISTS modalities text[] NOT NULL DEFAULT '{text,image}';

UPDATE ingest_sources SET modalities = '{text,image}' WHERE modalities IS NULL OR array_length(modalities, 1) IS NULL;

CREATE TABLE IF NOT EXISTS ingest_media (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
  modality      text NOT NULL CHECK (modality IN ('text','image')),
  storage_key   text,
  url           text,
  sha256        text NOT NULL,
  verified      text NOT NULL DEFAULT 'PENDING' CHECK (verified IN ('PENDING','PASS','FAIL')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_media_readable CHECK (storage_key IS NOT NULL OR url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_ingest_media_run ON ingest_media (run_id);

-- 0033: PHASE 12 — continuity: return-to-work summaries + free-limit moon display tracking.
-- Extends the frozen schema; existing tables/columns are never dropped or renamed.

-- ---------------------------------------------------------------------------
-- While You Were Away: persisted, evidence-based return-to-work summaries.
-- Counts + evidence references are stored (never duplicated raw content);
-- read/dismissed state is server-authoritative so a refresh never replays.
-- ---------------------------------------------------------------------------

CREATE TABLE return_to_work_summaries (
  id                      text PRIMARY KEY,
  owner_id                text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generated_at            timestamptz NOT NULL DEFAULT now(),
  absence_start           timestamptz NOT NULL,
  absence_end             timestamptz NOT NULL,
  project_id              text REFERENCES projects(id) ON DELETE SET NULL,
  frequency               text NOT NULL DEFAULT 'daily',
  completed_count         integer NOT NULL DEFAULT 0,
  failed_count            integer NOT NULL DEFAULT 0,
  pending_approval_count  integer NOT NULL DEFAULT 0,
  modified_file_count     integer NOT NULL DEFAULT 0,
  discovery_count         integer NOT NULL DEFAULT 0,
  memory_update_count     integer NOT NULL DEFAULT 0,
  dna_update_count        integer NOT NULL DEFAULT 0,
  project_activity_count  integer NOT NULL DEFAULT 0,
  unread_notification_count integer NOT NULL DEFAULT 0,
  evidence                jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_text            text,
  ai_generated            boolean NOT NULL DEFAULT false,
  read                    boolean NOT NULL DEFAULT false,
  read_at                 timestamptz,
  dismissed               boolean NOT NULL DEFAULT false,
  dismissed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_return_to_work_owner_generated ON return_to_work_summaries (owner_id, generated_at DESC);

ALTER TABLE return_to_work_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY return_to_work_owner ON return_to_work_summaries
  USING (owner_id = app.uid());

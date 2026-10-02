-- CodeConClave — CONVERSATION CONTINUITY + DECISION MEMORY (exactly-once sync).
--
-- 1) messages.client_id
--    A client-generated stable id per USER message. The unique partial index
--    (conversation_id, client_id) makes a retried send idempotent: a client
--    that lost its ack can re-send the same message and the server returns the
--    SAME row — never a duplicate. This is the exactly-once core of the local
--    cache / sync engine. AI messages have no client_id (server-generated).
--
-- 2) agent_decisions status / source_message_ids / scope
--    The decision record gains a lifecycle (ACTIVE / TENTATIVE / SUPERSEDED /
--    REJECTED / ARCHIVED), the exact messages that caused it (so "show me the
--    source" is a real link, not a fabricated one), and a scope consistent
--    with the existing MemoryScope (PERSONAL/PROJECT/TEAM). The status index
--    serves the decision list and the exact-retrieval path for the AI.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS client_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_conversation_client
  ON messages (conversation_id, client_id) WHERE client_id IS NOT NULL;

ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'TENTATIVE', 'SUPERSEDED', 'REJECTED', 'ARCHIVED')),
  ADD COLUMN IF NOT EXISTS source_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'PERSONAL'
    CHECK (scope IN ('PERSONAL', 'PROJECT', 'TEAM'));

CREATE INDEX IF NOT EXISTS ix_agent_decisions_owner_status_created
  ON agent_decisions (owner_id, status, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_agent_decisions_project
  ON agent_decisions (project_id) WHERE project_id IS NOT NULL;
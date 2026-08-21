-- CodeConClave — PHASE 16: reliability (offline sync idempotency, task checkpoints).
-- 1. idempotency_keys: server-side dedupe for offline-synced state changes.
--    A client sends Idempotency-Key; the first request executes, later identical
--    requests replay the stored response instead of mutating state twice.
-- 2. task_attempts.checkpoint: durable long-running-task progress so a worker
--    restart can resume from the last completed pipeline stage (never RUNNING
--    forever, never silently restart from scratch).

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id            text PRIMARY KEY,
    key           text NOT NULL,
    user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    op            text NOT NULL,
    payload_hash  text NOT NULL,
    status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
    response      jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
    ON idempotency_keys (created_at);

ALTER TABLE task_attempts
    ADD COLUMN IF NOT EXISTS checkpoint jsonb,
    ADD COLUMN IF NOT EXISTS checkpointed_at timestamptz;
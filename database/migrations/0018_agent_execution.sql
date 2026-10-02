-- 0018: agent execution — device tokens, scoped capabilities, local edit audit
-- Section 6.4: capability model (scope/expiry/audit), Section 6.3: per-edit audit.

ALTER TABLE devices ADD COLUMN token_hash text;
ALTER TABLE devices ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE devices ADD COLUMN failed_pairing_attempts int NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN last_command_at timestamptz;

CREATE UNIQUE INDEX uq_devices_token_hash ON devices (token_hash) WHERE token_hash IS NOT NULL;

-- Local file edits are always auditable: before/after SHA-256, task linkage,
-- coworker attribution, command, test results, approval status (Sec 6.3 audit storage).
CREATE TABLE local_edits (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id),
  device_id       text NOT NULL REFERENCES devices(id),
  task_id         text,
  path            text NOT NULL,
  before_hash     text NOT NULL,
  after_hash      text,
  diff            text,
  command         text,
  test_results    text,
  coworker_name   text,
  approval_status text NOT NULL DEFAULT 'PENDING'
                  CHECK (approval_status IN ('PENDING','APPROVED','REJECTED','APPLIED','REVERTED')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_local_edits_user_created ON local_edits (user_id, created_at DESC);

ALTER TABLE local_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_edits_owner ON local_edits USING (user_id = app.uid());
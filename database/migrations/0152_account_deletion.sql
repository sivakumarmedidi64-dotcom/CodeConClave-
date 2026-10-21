-- 0152: Account deletion requests (spec Solo #36, Team #18).
-- A user requests deletion; it executes after a 30-day grace window during
-- which they can cancel. Execution de-identifies the account and scrubs
-- personal content (see backend/src/modules/account/service.ts); the receipt
-- records exactly what was erased and what was retained de-identified.

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id),
  state         text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','CANCELLED','COMPLETED')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  due_at        timestamptz NOT NULL,
  cancelled_at  timestamptz,
  completed_at  timestamptz,
  receipt       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- At most one pending request per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_deletion_pending
  ON account_deletion_requests (user_id) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_account_deletion_due
  ON account_deletion_requests (due_at) WHERE state = 'PENDING';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_account_deletion_requests_updated_at') THEN
    CREATE TRIGGER trg_account_deletion_requests_updated_at
      BEFORE UPDATE ON account_deletion_requests
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_deletion_requests_owner ON account_deletion_requests;
CREATE POLICY account_deletion_requests_owner ON account_deletion_requests USING (user_id = app.uid());

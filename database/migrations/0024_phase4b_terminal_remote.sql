-- 0024: phase 4b — terminal sessions, terminal history, remote-control sessions
-- Terminal sessions persist the REAL process state reported by the paired
-- local agent: status mirrors agent-reported transitions and RUNNING carries
-- the real pid (the cloud never invents execution state; an offline agent
-- never reports an active terminal). Remote sessions are explicit, expiring
-- (8h) authorizations for remote-control actions on a paired device; revoking
-- a device or remote session ends the authorization immediately.

CREATE TABLE terminal_sessions (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  device_id   text NOT NULL REFERENCES devices(id),
  tab_id      text NOT NULL,
  shell       text NOT NULL,
  cwd         text,
  status      text NOT NULL DEFAULT 'PLANNED'
              CHECK (status IN ('PLANNED','STARTING','RUNNING','COMPLETED','FAILED','KILLED','TIMED_OUT')),
  pid         bigint,
  exit_code   int,
  timeout_ms  bigint,
  started_at  timestamptz,
  ended_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_terminal_sessions_owner_created ON terminal_sessions (owner_id, created_at DESC);
CREATE UNIQUE INDEX uq_terminal_sessions_tab
  ON terminal_sessions (device_id, tab_id)
  WHERE status IN ('PLANNED','STARTING','RUNNING');

CREATE TABLE terminal_history (
  id          text PRIMARY KEY,
  session_id  text NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('stdout','stderr','input','status')),
  text        text NOT NULL,
  seq         bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_terminal_history_session_seq ON terminal_history (session_id, seq);
CREATE INDEX idx_terminal_history_text ON terminal_history
  USING gin (to_tsvector('simple', text));

CREATE TABLE remote_sessions (
  id                         text PRIMARY KEY,
  owner_id                   text NOT NULL REFERENCES users(id),
  device_id                  text NOT NULL REFERENCES devices(id),
  state                      text NOT NULL DEFAULT 'ACTIVE'
                             CHECK (state IN ('ACTIVE','EXPIRED','REVOKED')),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  expires_at                 timestamptz NOT NULL,
  last_active_at             timestamptz NOT NULL DEFAULT now(),
  screenshot_authorized      boolean NOT NULL DEFAULT false,
  screenshot_auth_expires_at timestamptz,
  revoked_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_remote_sessions_owner_active ON remote_sessions (owner_id, state, expires_at);

-- Expired remote sessions are surfaced as EXPIRED (never silently reused).
CREATE FUNCTION expire_remote_sessions()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  updated bigint;
BEGIN
  UPDATE remote_sessions
     SET state = 'EXPIRED', screenshot_authorized = false
   WHERE state = 'ACTIVE' AND expires_at < now();
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END $$;

ALTER TABLE terminal_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY terminal_sessions_owner_isolation ON terminal_sessions
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE terminal_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY terminal_history_owner_isolation ON terminal_history
  USING (session_id IN (SELECT id FROM terminal_sessions WHERE owner_id = app.uid()));

ALTER TABLE remote_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY remote_sessions_owner_isolation ON remote_sessions
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

-- 0014: audit/events — audit_logs, events, outbox_events

CREATE TABLE audit_logs (
  id               text PRIMARY KEY,
  actor_user_id    text REFERENCES users(id),
  tenant_scope     text NOT NULL CHECK (tenant_scope IN ('USER','TEAM','SYSTEM')),
  tenant_id        text,
  action           text NOT NULL,
  resource_type    text,
  resource_id      text,
  detail           jsonb,
  ip               text,
  user_agent       text,
  trace_id         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_tenant_created ON audit_logs (tenant_scope, tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_action_created ON audit_logs (action, created_at DESC);

CREATE TABLE events (
  id           text PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb,
  occurred_at  timestamptz NOT NULL
);

CREATE INDEX idx_events_topic_occurred ON events (topic, occurred_at);

CREATE TABLE outbox_events (
  id               text PRIMARY KEY,
  topic            text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED')),
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_status_next ON outbox_events (status, next_attempt_at);
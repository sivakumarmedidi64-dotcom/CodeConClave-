-- 0001: extensions + shared helpers
-- Requires pgvector (pgvector/pgvector image in docker-compose; Supabase has it built-in).

CREATE EXTENSION IF NOT EXISTS vector;

-- Schema must exist before any app.* object is created.
CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- app.uid(): tenant isolation resolver.
-- Backend sets app.current_user_id per request (SET LOCAL). Returns the
-- current user id, or NULL when unauthenticated. NEVER client-controlled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.uid()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$$;


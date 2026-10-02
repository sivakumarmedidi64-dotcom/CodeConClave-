-- ---------------------------------------------------------------------------
-- 0138_object_blobs.sql
-- Persistent server object storage on the existing PostgreSQL database
-- (Neon free tier, Rs 0, no new infrastructure). The `memory` storage
-- adapter is local disk, which is ephemeral on Render/Railway: every
-- redeploy wipes `data/storage` while the Postgres rows in `files`,
-- `file_versions` and `artifacts` survive, leaving an intact file tree
-- whose bytes fail to download/restore. This table gives the `postgres`
-- StorageAdapter a durable home for small blobs (server-generated storage
-- keys only; tenant scoping stays in the application `files`/`artifacts`
-- tables, exactly as with the S3 adapter). Large objects stay on S3/R2:
-- the adapter rejects writes over 10 MiB so the free-tier database can
-- never be bloated by a single upload. Additive only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS object_blobs (
  storage_key TEXT PRIMARY KEY,
  bytes BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_object_blobs_created
  ON object_blobs (created_at DESC);

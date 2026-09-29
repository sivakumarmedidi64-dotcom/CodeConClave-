-- ---------------------------------------------------------------------------
-- CodeConClave — B1 cowork safety review loop (cowork review data model).
--
-- Justification (explicitly documented per B1 directive): the review loop
-- MUST persist review state across restart for crash recovery and MUST store
-- base/proposed content so apply + undo can be performed deterministically by
-- hash. No existing table stores this (task_checkpoints/branches target the
-- local-agent git model, not review decisions), so this migration is REQUIRED
-- for B1. All other machinery is reused: diff engine (os/diff), file store +
-- versioning (modules/files), exec (os/sandbox), git (os/git), stop rules
-- (os/p2/stop-rules), resource governor (os/resource-governor), supervisor
-- (os/supervisor), audit (modules/audit), events (os/event-bus).
--
-- Three tables only:
--   cowork_reviews      — one review per AI-execution outcome
--   cowork_review_files — one row per file touched (+ base & proposed content)
--   cowork_review_hunks — one row per reviewable hunk (stable identity)
-- ---------------------------------------------------------------------------

CREATE TABLE cowork_reviews (
  id                  text PRIMARY KEY,
  task_id             text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id              text REFERENCES coworker_runs(id) ON DELETE SET NULL,
  project_id          text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               text NOT NULL DEFAULT 'Review',
  status              text NOT NULL DEFAULT 'DRAFT',
  test_status         text NOT NULL DEFAULT 'NOT_RUN',
  commit_status       text NOT NULL DEFAULT 'NOT_COMMITTED',
  diff_text           text NOT NULL DEFAULT '',
  files_changed       integer NOT NULL DEFAULT 0,
  additions           integer NOT NULL DEFAULT 0,
  deletions           integer NOT NULL DEFAULT 0,
  test_command        text,
  test_exit_code      integer,
  test_duration_ms    integer,
  test_output         text,
  test_correlation_id text,
  commit_message      text,
  commit_hash         text,
  branch              text,
  apply_error         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cowork_reviews_owner ON cowork_reviews (owner_id, created_at DESC);
CREATE INDEX idx_cowork_reviews_project ON cowork_reviews (project_id, created_at DESC);
CREATE INDEX idx_cowork_reviews_task ON cowork_reviews (task_id);
CREATE INDEX idx_cowork_reviews_status ON cowork_reviews (status);

-- One row per file touched by the reviewed change. base_content is the state
-- the review was produced against (used for staleness verification + undo);
-- proposed_content is what the accepted hunks will write (used for apply).
CREATE TABLE cowork_review_files (
  id                text PRIMARY KEY,
  review_id         text NOT NULL REFERENCES cowork_reviews(id) ON DELETE CASCADE,
  path              text NOT NULL,
  base_sha256       text NOT NULL,
  base_content      text NOT NULL,
  proposed_sha256   text NOT NULL,
  proposed_content  text NOT NULL,
  applied_sha256    text,
  applied_content   text,
  status            text NOT NULL DEFAULT 'PENDING',
  file_order        integer NOT NULL,
  applied_at        timestamptz,
  UNIQUE (review_id, path)
);

CREATE INDEX idx_cowork_review_files_review ON cowork_review_files (review_id);

-- One row per reviewable hunk. Stable identity: (review_id, file_id, hunk_order).
-- original_sha / proposed_sha pin the exact bytes each hunk moves so apply and
-- undo are deterministic and divergent states fail closed.
CREATE TABLE cowork_review_hunks (
  id             text PRIMARY KEY,
  review_id      text NOT NULL REFERENCES cowork_reviews(id) ON DELETE CASCADE,
  file_id        text NOT NULL REFERENCES cowork_review_files(id) ON DELETE CASCADE,
  hunk_order     integer NOT NULL,
  status         text NOT NULL DEFAULT 'PENDING',
  old_start      integer NOT NULL,
  old_lines      integer NOT NULL,
  new_start      integer NOT NULL,
  new_lines      integer NOT NULL,
  original_sha   text NOT NULL,
  proposed_sha   text NOT NULL,
  additions      integer NOT NULL DEFAULT 0,
  deletions      integer NOT NULL DEFAULT 0,
  context_lines  text NOT NULL DEFAULT '',
  ins_lines      text NOT NULL DEFAULT '[]',
  diff_text      text NOT NULL,
  decided_at     timestamptz,
  UNIQUE (review_id, hunk_order),
  UNIQUE (review_id, file_id, hunk_order)
);

CREATE INDEX idx_cowork_review_hunks_review ON cowork_review_hunks (review_id);
CREATE INDEX idx_cowork_review_hunks_file ON cowork_review_hunks (file_id);
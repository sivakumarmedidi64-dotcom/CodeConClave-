-- 0034: PHASE 13 — ideas workspace + brainstorming foundation.
-- New tables only; existing tables/columns are never dropped or renamed.
-- Tenant isolation follows the app.uid() RLS pattern with owner/project/team scopes.

-- ---------------------------------------------------------------------------
-- ideas: the Ideas workspace. Statuses/priorities are text + CHECK constraints
-- (project convention). Soft delete via deleted_at (30-day recovery window).
-- ai_generated/provenance preserve Memory/DNA provenance: AI-derived content is
-- labeled, never silently converted to verified memory.
-- ---------------------------------------------------------------------------

CREATE TABLE ideas (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id       text REFERENCES teams(id) ON DELETE SET NULL,
  project_id    text REFERENCES projects(id) ON DELETE SET NULL,
  title         text NOT NULL,
  description   text,
  tags          text[] NOT NULL DEFAULT '{}',
  category      text,
  priority      text NOT NULL DEFAULT 'MEDIUM'
                CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status        text NOT NULL DEFAULT 'PROPOSED'
                CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED','IMPLEMENTED')),
  assignee_id   text REFERENCES users(id) ON DELETE SET NULL,
  archived      boolean NOT NULL DEFAULT false,
  deleted_at    timestamptz,
  vote_count    integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  ai_generated  boolean NOT NULL DEFAULT false,
  provenance    text,
  "references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ideas_owner_created ON ideas (owner_id, created_at DESC);
CREATE INDEX idx_ideas_project_created ON ideas (project_id, created_at DESC);
CREATE INDEX idx_ideas_team_created ON ideas (team_id, created_at DESC);
CREATE INDEX idx_ideas_status ON ideas (status);
CREATE INDEX idx_ideas_priority ON ideas (priority);
CREATE INDEX idx_ideas_assignee ON ideas (assignee_id);
CREATE INDEX idx_ideas_deleted ON ideas (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TRIGGER trg_ideas_updated_at
  BEFORE UPDATE ON ideas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE ideas ENABLE ROW LEVEL SECURITY;

CREATE POLICY ideas_owner ON ideas
  USING (owner_id = app.uid());

CREATE POLICY ideas_project ON ideas
  USING (project_id IN (
    SELECT project_id FROM project_members WHERE user_id = app.uid()
  ));

CREATE POLICY ideas_team ON ideas
  USING (team_id IN (
    SELECT team_id FROM team_members WHERE user_id = app.uid() AND status = 'ACTIVE'
  ));

-- ---------------------------------------------------------------------------
-- idea_votes: one vote per user per idea; vote_count is a denormalized mirror
-- kept consistent by the service (INSERT ... ON CONFLICT DO NOTHING).
-- ---------------------------------------------------------------------------

CREATE TABLE idea_votes (
  id         text PRIMARY KEY,
  idea_id    text NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_idea_votes UNIQUE (idea_id, user_id)
);

CREATE INDEX idx_idea_votes_user ON idea_votes (user_id);

ALTER TABLE idea_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY idea_votes_owner ON idea_votes
  USING (user_id = app.uid());

-- ---------------------------------------------------------------------------
-- idea_comments: threaded comments (parent_id foundation), soft-deletable.
-- ---------------------------------------------------------------------------

CREATE TABLE idea_comments (
  id         text PRIMARY KEY,
  idea_id    text NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  author_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  text REFERENCES idea_comments(id) ON DELETE CASCADE,
  content    text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_idea_comments_idea_created ON idea_comments (idea_id, created_at);

ALTER TABLE idea_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY idea_comments_author ON idea_comments
  USING (author_id = app.uid());

CREATE POLICY idea_comments_idea ON idea_comments
  USING (idea_id IN (
    SELECT id FROM ideas WHERE owner_id = app.uid()
      OR project_id IN (SELECT project_id FROM project_members WHERE user_id = app.uid())
      OR team_id IN (SELECT team_id FROM team_members WHERE user_id = app.uid() AND status = 'ACTIVE')
  ));

-- ---------------------------------------------------------------------------
-- brainstorming: sessions, participants, and captured/generated ideas.
-- brainstorming_ideas links a session to an ideas row (SET NULL on idea delete)
-- and records grouping + ai_generated provenance for the History/Brainstorm UI.
-- ---------------------------------------------------------------------------

CREATE TABLE brainstorming_sessions (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('ACTIVE','COMPLETED','ARCHIVED')),
  grouping    text NOT NULL DEFAULT 'NONE'
              CHECK (grouping IN ('NONE','THEME','TOPIC')),
  ended_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_brainstorm_sessions_owner ON brainstorming_sessions (owner_id, created_at DESC);

CREATE TRIGGER trg_brainstorm_sessions_updated_at
  BEFORE UPDATE ON brainstorming_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE brainstorming_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY brainstorm_sessions_owner ON brainstorming_sessions
  USING (owner_id = app.uid());

CREATE TABLE brainstorming_participants (
  id         text PRIMARY KEY,
  session_id text NOT NULL REFERENCES brainstorming_sessions(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'PARTICIPANT'
             CHECK (role IN ('HOST','PARTICIPANT')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_brainstorm_participants UNIQUE (session_id, user_id)
);

CREATE INDEX idx_brainstorm_participants_user ON brainstorming_participants (user_id);

ALTER TABLE brainstorming_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY brainstorm_participants_self ON brainstorming_participants
  USING (user_id = app.uid());

CREATE POLICY brainstorm_participants_session ON brainstorming_participants
  USING (session_id IN (
    SELECT session_id FROM brainstorming_participants WHERE user_id = app.uid()
  ));

CREATE POLICY brainstorm_sessions_participant ON brainstorming_sessions
  USING (id IN (
    SELECT session_id FROM brainstorming_participants WHERE user_id = app.uid()
  ));

CREATE TABLE brainstorming_ideas (
  id           text PRIMARY KEY,
  session_id   text NOT NULL REFERENCES brainstorming_sessions(id) ON DELETE CASCADE,
  idea_id      text REFERENCES ideas(id) ON DELETE SET NULL,
  created_by   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal     text NOT NULL,
  grouping     text,
  ai_generated boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_brainstorm_ideas_session ON brainstorming_ideas (session_id, created_at);

ALTER TABLE brainstorming_ideas ENABLE ROW LEVEL SECURITY;

CREATE POLICY brainstorm_ideas_owner ON brainstorming_ideas
  USING (created_by = app.uid());

CREATE POLICY brainstorm_ideas_session ON brainstorming_ideas
  USING (session_id IN (
    SELECT session_id FROM brainstorming_participants WHERE user_id = app.uid()
  ));
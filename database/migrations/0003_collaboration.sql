-- 0003: collaboration — teams, team_members, projects, project_members

CREATE TABLE teams (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_teams_owner ON teams (owner_id);

CREATE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE team_members (
  id          text PRIMARY KEY,
  team_id     text NOT NULL REFERENCES teams(id),
  user_id     text NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner','admin','member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_members UNIQUE (team_id, user_id)
);

CREATE INDEX idx_team_members_user ON team_members (user_id);

CREATE TABLE projects (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id),
  team_id         text REFERENCES teams(id),
  name            text NOT NULL,
  description     text,
  repo_url        text,
  workspace_root  text,
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_owner ON projects (owner_id);
CREATE INDEX idx_projects_team ON projects (team_id);

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_members (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id),
  user_id     text NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner','admin','member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_project_members UNIQUE (project_id, user_id)
);

CREATE INDEX idx_project_members_user ON project_members (user_id);

-- 0017: feature-matrix soft delete columns (30-day recovery windows in code).
-- DATABASE CONTRACT is authoritative; these extend it exactly as the frozen
-- feature matrix requires (projects/conversations/messages soft delete).

ALTER TABLE projects ADD COLUMN deleted_at timestamptz;
ALTER TABLE conversations ADD COLUMN deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN deleted_at timestamptz;

CREATE INDEX idx_projects_deleted ON projects (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_conversations_deleted ON conversations (deleted_at) WHERE deleted_at IS NOT NULL;
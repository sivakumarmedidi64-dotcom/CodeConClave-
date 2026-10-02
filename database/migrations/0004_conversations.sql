-- 0004: conversations — conversations, messages, threads, reactions, mentions

CREATE TABLE conversations (
  id          text PRIMARY KEY,
  project_id  text REFERENCES projects(id),
  owner_id    text NOT NULL REFERENCES users(id),
  title       text NOT NULL DEFAULT 'New conversation',
  mode        text NOT NULL CHECK (mode IN ('CHAT','COWORK')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_owner_updated ON conversations (owner_id, updated_at DESC);
CREATE INDEX idx_conversations_project ON conversations (project_id);

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id),
  sender          text NOT NULL CHECK (sender IN ('USER','AI','SYSTEM','COWORKER')),
  coworker_type   text,
  role            text NOT NULL CHECK (role IN ('user','assistant','system')),
  content         text NOT NULL,
  model_id        text,
  provider_id     text,
  input_tokens    int,
  output_tokens   int,
  latency_ms      int,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','STREAMING','COMPLETED','FAILED')),
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at);

CREATE TABLE threads (
  id                 text PRIMARY KEY,
  conversation_id    text NOT NULL REFERENCES conversations(id),
  parent_message_id  text REFERENCES messages(id),
  title              text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_threads_conversation ON threads (conversation_id);

CREATE TABLE reactions (
  id          text PRIMARY KEY,
  message_id  text NOT NULL REFERENCES messages(id),
  user_id     text NOT NULL REFERENCES users(id),
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_reactions UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX idx_reactions_message ON reactions (message_id);

CREATE TABLE mentions (
  id          text PRIMARY KEY,
  message_id  text NOT NULL REFERENCES messages(id),
  user_id     text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mentions_user ON mentions (user_id);

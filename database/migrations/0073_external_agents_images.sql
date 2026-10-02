-- 0073: External Agents + Images (Prompt 4 / Provider Experience).
-- Adds the minimal columns genuinely required to persist IMAGE_GENERATION
-- artifacts onto chat messages and to audit external-agent run + capability
-- facts in usage. Purely additive — no provider secrets, no payment changes,
-- no table remodeling. RLS/tenant isolation is preserved by existing policies.

-- 1) Generated images onto messages (IMAGE_GENERATION capability).
--    image_file_id references the files gateway row (server-side storage; only
--    the file id travels to clients). image_mime lets the renderer choose an
--    inline preview without resolving the file first.

ALTER TABLE messages
  ADD COLUMN image_file_id text REFERENCES files(id) ON DELETE SET NULL,
  ADD COLUMN image_mime    text;

-- 2) Usage audit of the canonical capability + the external-agent run id.
--    capability documents WHICH canonical class produced the row
--    (NORMAL_MODEL / MULTIMODAL_MODEL / IMAGE_GENERATOR / EXTERNAL_AGENT);
--    external_run_id records the provider-side session/task id (Devin session
--    id, Manus task id) so external-artifact runs are traceable end-to-end.
--    No key material is ever written here.

ALTER TABLE model_usage_logs
  ADD COLUMN capability      text,
  ADD COLUMN external_run_id text;

-- 3) IMAGE conversations carry the same tenant-isolated row shape as CHAT.
--    The mode constraint is widened (additively) so the composer's Image mode
--    persists honestly instead of masquerading as a COWORK row.

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_mode_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_mode_check CHECK (mode IN ('CHAT', 'COWORK', 'IMAGE'));
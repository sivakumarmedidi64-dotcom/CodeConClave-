-- 0122: AGENT chat mode for conversations.
-- The selected model can drive the Local Agent from chat. This widens the
-- previously additive mode constraint (CHAT, COWORK, IMAGE) to also persist
-- AGENT conversations instead of masquerading as CHAT rows. Purely additive.

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_mode_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_mode_check
    CHECK (mode IN ('CHAT', 'COWORK', 'IMAGE', 'AGENT'));
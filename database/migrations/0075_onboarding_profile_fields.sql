-- ---------------------------------------------------------------------------
-- 0075_onboarding_profile_fields.sql
-- Add the minimal onboarding profile fields (role + primary use case) to the
-- account. Identity (email) is supplied by auth (email/password or Google
-- OAuth); the display name already lives on users.display_name. This only
-- completes the "what should we call you / role / primary use case"
-- onboarding requirement established for CodeConClave. Additive only — no
-- existing column or behaviour changes.
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_use_case text;
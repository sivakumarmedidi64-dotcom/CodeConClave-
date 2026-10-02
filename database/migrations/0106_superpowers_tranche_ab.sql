-- CodeConClave — Stage 0106 SUPERPOWERS Tranche AB (Component Graveyard, Responsive Forge, Interaction Definer, Form Builder, Theme Enforcer)

-- COMPONENT GRAVEYARD — finds every unused/broken/dead component
CREATE TABLE IF NOT EXISTS dead_components (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component_name   TEXT NOT NULL,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','REMOVED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dead_components ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dead_components_owner' AND tablename = 'dead_components') THEN CREATE POLICY dead_components_owner ON dead_components USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_dead_components_owner ON dead_components(owner_id);

-- RESPONSIVE FORGE — auto-generates responsive layouts from a single breakpoint definition
CREATE TABLE IF NOT EXISTS responsive_generations (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  breakpoints      JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_layout TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE responsive_generations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'responsive_generations_owner' AND tablename = 'responsive_generations') THEN CREATE POLICY responsive_generations_owner ON responsive_generations USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_responsive_generations_owner ON responsive_generations(owner_id);

-- INTERACTION DEFINER — vague interaction spec → full animation + states defined
CREATE TABLE IF NOT EXISTS interaction_specs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  description      TEXT NOT NULL,
  states           JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'DEFINED' CHECK (status IN ('DEFINED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE interaction_specs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'interaction_specs_owner' AND tablename = 'interaction_specs') THEN CREATE POLICY interaction_specs_owner ON interaction_specs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_interaction_specs_owner ON interaction_specs(owner_id);

-- FORM BUILDER — AI-powered form generation from field specs
CREATE TABLE IF NOT EXISTS form_builds (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  form_name        TEXT NOT NULL,
  fields           JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_code   TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE form_builds ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'form_builds_owner' AND tablename = 'form_builds') THEN CREATE POLICY form_builds_owner ON form_builds USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_form_builds_owner ON form_builds(owner_id);

-- THEME ENFORCER — design system theme enforcement with violation flagging and fixing
CREATE TABLE IF NOT EXISTS theme_violations (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  violation_type   TEXT NOT NULL,
  severity         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','FIXED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE theme_violations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'theme_violations_owner' AND tablename = 'theme_violations') THEN CREATE POLICY theme_violations_owner ON theme_violations USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_theme_violations_owner ON theme_violations(owner_id);

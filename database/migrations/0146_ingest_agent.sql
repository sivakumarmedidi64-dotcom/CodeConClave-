-- 0146: Agent Sai Srinivasa Athreya — ingest ledger (19 open sources)
-- Minute hash-check writes go here; full pulls reference these rows.
-- Every row carries project ownership; no write without project_id.

CREATE TABLE IF NOT EXISTS ingest_sources (
  id            text PRIMARY KEY,
  hf_dataset    text NOT NULL,
  license       text NOT NULL,
  diamond_box   text NOT NULL CHECK (diamond_box IN ('CODER','PLANNER','VERIFY','SCOUT','GATE')),
  tier          text NOT NULL DEFAULT 'T1_SAFE',
  eval_only     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id            text PRIMARY KEY,
  project_id    text NOT NULL REFERENCES projects(id),
  source_id     text NOT NULL REFERENCES ingest_sources(id),
  action        text NOT NULL CHECK (action IN ('CACHE_HIT','PULL','BLOCKED','UNKNOWN')),
  from_hash     text,
  to_hash       text,
  verdict       text NOT NULL CHECK (verdict IN ('PASS','FAIL')) DEFAULT 'PASS',
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_project ON ingest_runs (project_id);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_source ON ingest_runs (source_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ingest_sources_updated_at') THEN
    CREATE TRIGGER trg_ingest_sources_updated_at
      BEFORE UPDATE ON ingest_sources
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Seed the 19 final sources (idempotent). hf_dataset values verified live
-- against the HuggingFace API on 2026-10-11 (0148 refreshes older seeds).
INSERT INTO ingest_sources (id, hf_dataset, license, diamond_box, tier, eval_only) VALUES
  ('opencode-instruct','nvidia/OpenCodeInstruct','Apache-2.0','CODER','T1_SAFE',false),
  ('codex-7m-nonthink','Modotte/CodeX-7M-Non-Thinking','Permissive','CODER','T1_SAFE',false),
  ('codefeedback-filtered','m-a-p/CodeFeedback-Filtered-Instruction','MIT','CODER','T1_SAFE',false),
  ('codesearchnet','code-search-net/code_search_net','MIT','CODER','T1_SAFE',false),
  ('synth-text-to-sql','gretelai/synthetic_text_to_sql','Permissive','CODER','T1_SAFE',false),
  ('nemotron-sft-opencode-v1','nvidia/Nemotron-SFT-OpenCode-v1','NVIDIA-Open-Model','PLANNER','T1_SAFE',false),
  ('kimi-k2-5-1m','ianncity/KIMI-K2.5-1000000x','CC-BY-4.0','PLANNER','T2_ATTRIBUTION',false),
  ('orca-agentinstruct-1m','microsoft/orca-agentinstruct-1M-v1','MIT','PLANNER','T1_SAFE',false),
  ('codex-2m-thinking','Modotte/CodeX-2M-Thinking','Permissive','PLANNER','T1_SAFE',false),
  ('rstar-coder','microsoft/rStar-Coder','Apache-2.0','PLANNER','T1_SAFE',false),
  ('nemotron-sft-swe-v2','nvidia/Nemotron-SFT-SWE-v2','NVIDIA-Open-Model','VERIFY','T1_SAFE',false),
  ('open-r1-codeforces','open-r1/codeforces','CC-BY-4.0','VERIFY','T2_ATTRIBUTION',false),
  ('swe-bench','princeton-nlp/SWE-bench','MIT','VERIFY','EVAL_ONLY',true),
  ('intercode','epinnock/intercode-nl2bash-curated','Apache-2.0','VERIFY','T1_SAFE',false),
  ('autoif-instruct-61k','Post-training-Data-Flywheel/AutoIF-instruct-61k-with-funcs','MIT','SCOUT','T1_SAFE',false),
  ('glaive-fc-v2','glaiveai/glaive-function-calling-v2','Apache-2.0','SCOUT','T1_SAFE',false),
  ('toolbench','Maurus/ToolBench','Apache-2.0','GATE','T1_SAFE',false),
  ('llama-guard-safety','AuroraQuantum/llama-guard-safety-eval','Permissive','GATE','T1_SAFE',false),
  ('nemotron-sft-if-chat-v2','nvidia/Nemotron-SFT-Instruction-Following-Chat-v2','NVIDIA-Open-Model','GATE','T1_SAFE',false)
ON CONFLICT (id) DO UPDATE SET
  hf_dataset = EXCLUDED.hf_dataset,
  license = EXCLUDED.license,
  diamond_box = EXCLUDED.diamond_box,
  tier = EXCLUDED.tier,
  eval_only = EXCLUDED.eval_only,
  updated_at = now();

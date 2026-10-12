-- 0149: Agent Sai Srinivasa Athreya — Phase B: 10 non-HF sources (29 total).
-- Adds source_kind + source_ref so one registry covers HF revisions AND
-- endpoint-watched sources (arXiv categories, GitHub trending, StackExchange
-- tags, HN feeds). Proven live 2026-10-11: arXiv 200, GitHub 200, SO 200
-- (quota 299 unauth — key required for cadence), HN Firebase 200.
-- Papers-with-Code deliberately EXCLUDED: its API bot-walls non-browser
-- clients (HTTP 200 HTML). Replaced by arXiv cs.LG + cs.CL (same checker).
-- v1 for non-HF rows = change detection only; full content pulls wait for
-- per-repo license review (SO rows already T2_ATTRIBUTION: CC BY-SA).

ALTER TABLE ingest_sources
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'huggingface',
  ADD COLUMN IF NOT EXISTS source_ref text;

UPDATE ingest_sources SET source_kind = 'huggingface', source_ref = hf_dataset
WHERE source_kind = 'huggingface' AND source_ref IS NULL;

INSERT INTO ingest_sources (id, hf_dataset, license, diamond_box, tier, eval_only, source_kind, source_ref) VALUES
  ('arxiv-cs-se','arxiv:cs.SE','Permissive','PLANNER','T1_SAFE',false,'arxiv','cs.SE'),
  ('arxiv-cs-ai','arxiv:cs.AI','Permissive','PLANNER','T1_SAFE',false,'arxiv','cs.AI'),
  ('arxiv-cs-lg','arxiv:cs.LG','Permissive','PLANNER','T1_SAFE',false,'arxiv','cs.LG'),
  ('arxiv-cs-cl','arxiv:cs.CL','Permissive','PLANNER','T1_SAFE',false,'arxiv','cs.CL'),
  ('github-trending-python','github-trending:python','Permissive','CODER','T1_SAFE',false,'github-trending','python'),
  ('github-trending-typescript','github-trending:typescript','Permissive','CODER','T1_SAFE',false,'github-trending','typescript'),
  ('so-python','stackexchange:python','CC-BY-4.0','SCOUT','T2_ATTRIBUTION',false,'stackexchange','python'),
  ('so-javascript','stackexchange:javascript','CC-BY-4.0','SCOUT','T2_ATTRIBUTION',false,'stackexchange','javascript'),
  ('hn-top','hackernews:top','Permissive','SCOUT','T1_SAFE',false,'hackernews','top'),
  ('hn-newest','hackernews:newest','Permissive','SCOUT','T1_SAFE',false,'hackernews','newest')
ON CONFLICT (id) DO UPDATE SET
  hf_dataset = EXCLUDED.hf_dataset,
  license = EXCLUDED.license,
  diamond_box = EXCLUDED.diamond_box,
  tier = EXCLUDED.tier,
  eval_only = EXCLUDED.eval_only,
  source_kind = EXCLUDED.source_kind,
  source_ref = EXCLUDED.source_ref,
  updated_at = now();

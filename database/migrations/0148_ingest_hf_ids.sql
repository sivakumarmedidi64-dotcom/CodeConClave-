-- 0148: Agent Sai Srinivasa Athreya — verified HuggingFace repo ids.
-- The 0146 seed used placeholder slugs that do not resolve (every tick went
-- UNKNOWN). These ids were verified live against https://huggingface.co/api
-- on 2026-10-11. Four entries are community mirrors (no official repo on the
-- Hub): kimi-k2-5-1m, intercode, toolbench, llama-guard-safety — re-verify
-- provenance before training on those four.

UPDATE ingest_sources SET hf_dataset = v.hf_dataset, updated_at = now()
FROM (VALUES
  ('opencode-instruct','nvidia/OpenCodeInstruct'),
  ('codex-7m-nonthink','Modotte/CodeX-7M-Non-Thinking'),
  ('codefeedback-filtered','m-a-p/CodeFeedback-Filtered-Instruction'),
  ('codesearchnet','code-search-net/code_search_net'),
  ('synth-text-to-sql','gretelai/synthetic_text_to_sql'),
  ('nemotron-sft-opencode-v1','nvidia/Nemotron-SFT-OpenCode-v1'),
  ('kimi-k2-5-1m','ianncity/KIMI-K2.5-1000000x'),
  ('orca-agentinstruct-1m','microsoft/orca-agentinstruct-1M-v1'),
  ('codex-2m-thinking','Modotte/CodeX-2M-Thinking'),
  ('rstar-coder','microsoft/rStar-Coder'),
  ('nemotron-sft-swe-v2','nvidia/Nemotron-SFT-SWE-v2'),
  ('open-r1-codeforces','open-r1/codeforces'),
  ('swe-bench','princeton-nlp/SWE-bench'),
  ('intercode','epinnock/intercode-nl2bash-curated'),
  ('autoif-instruct-61k','Post-training-Data-Flywheel/AutoIF-instruct-61k-with-funcs'),
  ('glaive-fc-v2','glaiveai/glaive-function-calling-v2'),
  ('toolbench','Maurus/ToolBench'),
  ('llama-guard-safety','AuroraQuantum/llama-guard-safety-eval'),
  ('nemotron-sft-if-chat-v2','nvidia/Nemotron-SFT-Instruction-Following-Chat-v2')
) AS v(id, hf_dataset)
WHERE ingest_sources.id = v.id;

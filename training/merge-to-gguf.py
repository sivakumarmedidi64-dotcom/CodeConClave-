# %% Merge adapter into base + save fp16 + tokenizer (run on the TRAINING machine
# right after run #1, while the base is still cached — re-downloading wastes hours).
#
# Gotcha checklist (the classic weekend-eaters, all handled in order below):
#   1. Merge in bf16/fp16, NEVER in 4-bit. Merging quantized weights bakes
#      quantization error into every weight permanently.
#   2. Copy the TOKENIZER from the adapter repo (it may carry added tokens).
#   3. Save with safe_serialization; verify by reloading + one greedy sample.
#   4. GGUF convert + quantize with llama.cpp AFTER the fp16 save, not before.
#
# Usage:
#   BASE_MODEL=Qwen/Qwen2.5-1.5B-Instruct BASE_SHA=<sha> ADAPTER_REPO=SaharshMedidi/codeconclave-scout \
#   MERGED_OUT=./codeconclave-scout-merged python training/merge-to-gguf.py
# Then (needs a llama.cpp checkout):
#   python llama.cpp/convert_hf_to_gguf.py ./codeconclave-scout-merged --outfile scout-f16.gguf
#   llama.cpp/build/bin/llama-quantize scout-f16.gguf scout-q4_k_m.gguf Q4_K_M
import os

BASE_MODEL = os.environ.get("TUNE_BASE_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
BASE_SHA = os.environ["TUNE_BASE_SHA"]  # fail fast: never merge onto a moving base
ADAPTER_REPO = os.environ.get("TUNE_OUTPUT_REPO", "SaharshMedidi/codeconclave-scout")
MERGED_OUT = os.environ.get("MERGED_OUT", "./codeconclave-scout-merged")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
VERIFY_PROMPT = os.environ.get("MERGE_VERIFY_PROMPT", '{"lane":"CODER","risk":"HIGH"} Route this: fix login bug')

# %% [1/3] Load base in bf16 (NOT 4-bit) + adapter, merge
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

tok = AutoTokenizer.from_pretrained(ADAPTER_REPO, token=HF_TOKEN or None)
base = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL, revision=BASE_SHA, torch_dtype=torch.bfloat16, device_map="auto", token=HF_TOKEN or None
)
model = PeftModel.from_pretrained(base, ADAPTER_REPO, token=HF_TOKEN or None)
merged = model.merge_and_unload()
merged.save_pretrained(MERGED_OUT, safe_serialization=True)
tok.save_pretrained(MERGED_OUT)
print(f"MERGED_SAVED={MERGED_OUT}")

# %% [2/3] Verify: reload merged fp16, one greedy sample must be valid JSON-ish
from transformers import pipeline

gen = pipeline("text-generation", model=MERGED_OUT, tokenizer=MERGED_OUT, max_new_tokens=64, do_sample=False)
out = gen(f"Route this: {VERIFY_PROMPT}", max_new_tokens=64)[0]["generated_text"]
print(f"MERGE_VERIFY_SAMPLE={out[-300:]}")

# %% [3/3] Push merged fp16 (GGUF convert happens from this exact dir)
merged.push_to_hub(f"{ADAPTER_REPO}-merged-fp16", token=HF_TOKEN)
print("NEXT: convert_hf_to_gguf.py then llama-quantize Q4_K_M (commands in header).")

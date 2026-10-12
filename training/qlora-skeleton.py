# %% [1/5] Install (run once per machine)
# Colab free T4 + Kaggle GPU compatible. Stock transformers+peft+trl so the
# same file runs everywhere (Unsloth intentionally skipped: portability > speed
# on a free-tier fleet). Versions are FROZEN in training/requirements.txt —
# install from it so next month's image cannot silently change the run.
# (Available after the next push to the fork.)
# !pip install -q -r https://raw.githubusercontent.com/sivakumarmedidi64-dotcom/CodeConClave-/render-current/training/requirements.txt
# torch is NOT in that file on purpose: Colab/Kaggle ship CUDA-matched torch.

# %% [2/5] CONFIG — the ONLY cell that differs per model/run
import os

BASE_MODEL = os.environ.get("TUNE_BASE_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
# Pin the base MODEL revision too, not just the dataset: repos update, and an
# unpinned base silently changes what your evals compare against.
BASE_REVISION = os.environ.get("TUNE_BASE_REVISION", "main")  # <-- paste resolved sha after first run
# Your shared, version-pinned dataset on the Hub (one revision for every run):
DATASET_REPO = os.environ.get("TUNE_DATASET_REPO", "SaharshMedidi/codeconclave-tune-data")
DATASET_REVISION = os.environ.get("TUNE_DATASET_REVISION", "main")  # <-- paste the sha256-pinned commit here
DATASET_SPLIT_FILE = os.environ.get("TUNE_SPLIT_FILE", "scout-router.jsonl")
OUTPUT_REPO = os.environ.get("TUNE_OUTPUT_REPO", "SaharshMedidi/codeconclave-scout")
# NEVER hardcode tokens. Colab: userdata.get('HF_TOKEN'). Kaggle: Secrets addon.
HF_TOKEN = os.environ.get("HF_TOKEN", "")

# Seed discipline: split seed (cell 3) + trainer seed + sampler seed are ALL
# pinned, so Colab and Kaggle runs are comparable by construction. (CUDA
# kernels keep a small nondeterminism residue — expect ±1pt, not ±10.)
SEED = 42

# T4-free-safe knobs. Do not raise these on 16GB cards.
LORA_R = 16
LORA_ALPHA = 32
MAX_SEQ_LEN = 1024
EPOCHS = 2
LEARNING_RATE = 2e-4

# %% [3/5] Load pinned dataset (tokenizer here: formatting needs it)
from datasets import load_dataset
from transformers import AutoTokenizer
from huggingface_hub import HfApi

ds = load_dataset(DATASET_REPO, data_files=DATASET_SPLIT_FILE, split="train", revision=DATASET_REVISION, token=HF_TOKEN or None)
print(f"DATASET_ROWS={len(ds)} REVISION={DATASET_REVISION}")
# 90/10 split, fixed seed so Colab and Kaggle evals agree:
splits = ds.train_test_split(test_size=0.1, seed=SEED)

# Chat-template formatting (round-3 fix): the base's OWN template (Qwen ChatML
# here), never a foreign Alpaca wrapper. A mismatched template silently taxes
# every run a few points and you blame the data. Verified against the live
# tokenizer_config before run #1. System = task directive, user = task, assistant = answer.
api = HfApi(token=HF_TOKEN or None)
BASE_SHA = api.model_info(BASE_MODEL, revision=BASE_REVISION).sha if BASE_REVISION == "main" else BASE_REVISION
print(f"BASE_MODEL={BASE_MODEL} BASE_SHA={BASE_SHA}")
tok = AutoTokenizer.from_pretrained(BASE_MODEL, revision=BASE_SHA, token=HF_TOKEN or None)
assert tok.chat_template, "base has no chat template — stop, do not train on a foreign format"
if tok.pad_token is None:
    tok.pad_token = tok.eos_token


def format_row(row):
    messages = [
        {"role": "system", "content": row["instruction"]},
        {"role": "user", "content": row.get("input", "")},
        {"role": "assistant", "content": row["output"]},
    ]
    return {"text": tok.apply_chat_template(messages, tokenize=False)}


train_ds = splits["train"].map(format_row, remove_columns=splits["train"].column_names)
eval_ds = splits["test"].map(format_row, remove_columns=splits["test"].column_names)

# %% [4/5] 4-bit base + LoRA + SFT (resume-safe)
import torch
from transformers import AutoModelForCausalLM, BitsAndBytesConfig
from peft import LoraConfig, prepare_model_for_kbit_training, get_peft_model
from trl import SFTTrainer, SFTConfig
from huggingface_hub import ModelCard

bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
)

model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    revision=BASE_SHA,
    quantization_config=bnb,
    device_map="auto",
    token=HF_TOKEN or None,
)
model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
model = get_peft_model(
    model,
    LoraConfig(
        r=LORA_R,
        lora_alpha=LORA_ALPHA,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules="all-linear",
    ),
)

args = SFTConfig(
    output_dir="codeconclave-qlora-out",
    num_train_epochs=EPOCHS,
    per_device_train_batch_size=2,
    gradient_accumulation_steps=4,
    learning_rate=LEARNING_RATE,
    bf16=True,
    logging_steps=25,
    save_steps=500,
    save_total_limit=3,
    eval_strategy="steps",
    eval_steps=500,
    max_seq_length=MAX_SEQ_LEN,
    dataset_text_field="text",
    report_to="none",
    seed=SEED,
    data_seed=SEED,
)

trainer = SFTTrainer(model=model, train_dataset=train_ds, eval_dataset=eval_ds, args=args)
# If a disconnect happened, resume instead of restarting:
# trainer.train(resume_from_checkpoint=True)
trainer.train()

# %% [5/5] Push + eval bar
model.push_to_hub(OUTPUT_REPO, token=HF_TOKEN)
tok.push_to_hub(OUTPUT_REPO, token=HF_TOKEN)
# Adapter card carries the full provenance chain: base sha + dataset sha.
# Anyone opening the repo can rebuild this exact run. No provenance, no trust.
ModelCard(
    f"""---
base_model: {BASE_MODEL}
base_revision: {BASE_SHA}
datasets: {DATASET_REPO}@{DATASET_REVISION}
---
# {OUTPUT_REPO}

CodeConClave QLoRA adapter. Trained with training/qlora-skeleton.py
(SEED={SEED}, rank {LORA_R}, {EPOCHS} epochs, max_seq {MAX_SEQ_LEN}).
Base pinned to {BASE_SHA}; dataset pinned to {DATASET_REVISION}.
"""
).push_to_hub(OUTPUT_REPO, token=HF_TOKEN)
print(f"PUSHED={OUTPUT_REPO} BASE_SHA={BASE_SHA}")

metrics = trainer.evaluate()
print(f"EVAL={metrics}")
print("SHIP BAR: eval loss trending down AND ≥90% valid-JSON outputs on the holdout AND Gate-pass on 50 CodeConClave samples. Below bar = more data, not more epochs.")

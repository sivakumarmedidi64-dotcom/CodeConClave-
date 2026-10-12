"""CodeConClave — open-slice converter (foundation data for Scout run #1).

Pulls small streaming slices from the Hub and emits Alpaca-style JSONL
{"instruction","input","output"} that training/qlora-skeleton.py consumes.

Honest role: these slices teach strict instruction-following + clean JSON
discipline (Scout foundation). Router specialization (lane/risk) trains on
YOUR gold later via export-tune-data.ts. Foundation first, specialization
second — that order is the whole trick on free GPUs.

Slices (v1): 5000 Glaive function-calling + 3000 AutoIF-with-funcs.
Output: data/training/open-scout-foundation.jsonl (gitignored, like all data/).

Usage:
  pip install datasets
  python training/convert-open-slices.py            # full 8000
  LIMIT_GLAIVE=20 LIMIT_AUTOIF=20 python training/convert-open-slices.py   # smoke test
"""
import hashlib
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO_ROOT, "data", "training")
OUT_FILE = os.path.join(OUT_DIR, "open-scout-foundation.jsonl")

SECRET_RES = [
    re.compile(r"sk-(live|test)-[A-Za-z0-9]{8,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\.pem$"),
    re.compile(r"credentials\.json$"),
]

GLAIVE_INSTRUCTION = (
    "You are a routing assistant. If the request matches an available function, "
    "reply with the correct function call as JSON. Otherwise answer directly and briefly."
)
AUTOIF_INSTRUCTION = (
    "Follow every constraint in the request exactly, then answer. "
    "Reply with the answer only."
)


def clean(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def secret_hit(*texts):
    blob = "\n".join(t for t in texts if t)
    return any(r.search(blob) for r in SECRET_RES)


def glaive_pairs(chat):
    """'USER: ... ASSISTANT: ...' flat string -> [(user, assistant)]."""
    parts = re.split(r"(USER:|ASSISTANT:)", chat or "")
    turns = []
    current_role, current_text = None, ""
    for p in parts:
        if p in ("USER:", "ASSISTANT:"):
            if current_role and current_text.strip():
                turns.append((current_role, current_text.strip()))
            current_role, current_text = p[:-1], ""
        else:
            current_text += p
    if current_role and current_text.strip():
        turns.append((current_role, current_text.strip()))
    pairs = []
    for i, (role, text) in enumerate(turns):
        if role == "USER" and i + 1 < len(turns) and turns[i + 1][0] == "ASSISTANT":
            pairs.append((text, turns[i + 1][1]))
    return pairs


def main():
    from datasets import load_dataset

    limit_glaive = int(os.environ.get("LIMIT_GLAIVE", "5000"))
    limit_autoif = int(os.environ.get("LIMIT_AUTOIF", "3000"))
    os.makedirs(OUT_DIR, exist_ok=True)
    sha = hashlib.sha256()
    rows = 0
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        glaive = load_dataset("glaiveai/glaive-function-calling-v2", split="train", streaming=True)
        for row in glaive.take(limit_glaive):
            for user, asst in glaive_pairs(row.get("chat", ""))[:1]:
                user, asst = clean(user), clean(asst.replace("<|endoftext|>", ""))
                if not user or not asst or len(asst) > 2000 or secret_hit(user, asst):
                    continue
                line = json.dumps({"instruction": GLAIVE_INSTRUCTION, "input": user[:800], "output": asst}) + "\n"
                f.write(line)
                sha.update(line.encode())
                rows += 1
        autoif = load_dataset(
            "Post-training-Data-Flywheel/AutoIF-instruct-61k-with-funcs", split="train", streaming=True
        )
        for row in autoif.take(limit_autoif):
            msgs = row.get("messages") or []
            user = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "")
            asst = next((m.get("content", "") for m in msgs if m.get("role") == "assistant"), "")
            user, asst = clean(user), clean(asst)
            if not user or not asst or len(asst) > 2000 or secret_hit(user, asst):
                continue
            line = json.dumps({"instruction": AUTOIF_INSTRUCTION, "input": user[:800], "output": asst}) + "\n"
            f.write(line)
            sha.update(line.encode())
            rows += 1
    print(f"CONVERT_ROWS={rows}")
    print(f"CONVERT_FILE={OUT_FILE}")
    print(f"CONVERT_SHA256={sha.hexdigest()}")
    print("NEXT: huggingface-cli upload SaharshMedidi/codeconclave-tune-data data/training/open-scout-foundation.jsonl open-scout-foundation.jsonl")


if __name__ == "__main__":
    sys.exit(main())

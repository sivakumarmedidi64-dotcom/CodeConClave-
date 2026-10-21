<#
  CodeConClave AI — run your tuned resident models locally with Ollama.

  What it does (each step is skipped if already done):
    1. Checks Ollama is installed (installs it with winget if you pass -InstallOllama).
    2. Downloads the published SaharshMedidi/codeconclave-* repos from Hugging Face.
    3. Imports each one into Ollama under the name CodeConClave expects
       (codeconclave-coder-lite, codeconclave-scout, codeconclave-fastqa).
    4. Prints the .env lines that point the backend at Ollama.

  Disk / download: coder-lite ~3 GB, scout ~6.5 GB, fastqa ~15 GB (fp16).
  Use -Models to pick a subset, e.g.  -Models coder-lite
  reviewer and planner-lite are skipped: those repos are not public yet.

  Usage (PowerShell):
    .\scripts\setup-resident-models.ps1 -Models coder-lite
    .\scripts\setup-resident-models.ps1 -InstallOllama
#>
param(
  [string[]]$Models = @('coder-lite', 'scout', 'fastqa'),
  [string]$Dir = "$env:USERPROFILE\.codeconclave\models",
  [switch]$InstallOllama
)

$ErrorActionPreference = 'Stop'
$Published = @{ 'coder-lite' = $true; 'scout' = $true; 'fastqa' = $true; 'reviewer' = $false; 'planner-lite' = $false }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Yellow }

# 1. Ollama
Step 'Checking Ollama'
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
  if ($InstallOllama) {
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
    $env:Path += ";$env:LOCALAPPDATA\Programs\Ollama"
    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
  }
  if (-not $ollama) { throw 'Ollama is not installed. Re-run with -InstallOllama, or install it from https://ollama.com/download' }
}
Write-Host "Ollama: $($ollama.Source)"

# 2 + 3. Download and import each model
New-Item -ItemType Directory -Force $Dir | Out-Null
foreach ($m in $Models) {
  $repo = "SaharshMedidi/codeconclave-$m"
  $name = "codeconclave-$m"
  if (-not $Published.ContainsKey($m)) { Write-Warning "Unknown model '$m' — skipping"; continue }
  if (-not $Published[$m]) { Write-Warning "$repo is not public on Hugging Face yet — skipping"; continue }

  if ((ollama list) -match "^$name") { Write-Host "$name already in Ollama"; continue }

  $target = Join-Path $Dir $m
  Step "Downloading $repo -> $target"
  if (-not (Test-Path (Join-Path $target 'config.json'))) {
    $hf = Get-Command huggingface-cli -ErrorAction SilentlyContinue
    if ($hf) {
      huggingface-cli download $repo --local-dir $target
    } else {
      $git = Get-Command git -ErrorAction SilentlyContinue
      if (-not $git) { throw 'Need either huggingface-cli (pip install -U huggingface_hub) or git with git-lfs.' }
      git lfs install
      git clone "https://huggingface.co/$repo" $target
    }
  }

  Step "Importing $name into Ollama"
  $modelfile = Join-Path $target 'Modelfile'
  Set-Content -Path $modelfile -Encoding utf8 -Value "FROM $target"
  ollama create $name -f $modelfile
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Ollama could not import $name straight from safetensors. Convert it to GGUF with llama.cpp (convert_hf_to_gguf.py $target), then: ollama create $name -f <Modelfile with FROM path\to\model.gguf>"
  }
}

# 4. Wire the backend
Step 'Add these lines to your .env, then restart the backend'
Write-Host 'RESIDENT_OPENAI_BASE_URL=http://localhost:11434/v1'
Write-Host "`nCheck it: Settings -> Models, or GET /api/v1/ai/resident/status — drivers you imported show READY."

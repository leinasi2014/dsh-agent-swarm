param(
    [string]$Target = (Join-Path $PSScriptRoot "..\..\..\framework\deepseek-harness")
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Baseline = Get-Content -Raw -LiteralPath (Join-Path $Root "docs\OFFICIAL_BASELINE.json") | ConvertFrom-Json
$Target = [System.IO.Path]::GetFullPath($Target)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is required"
}

if (-not (Test-Path (Join-Path $Target ".git"))) {
    if ((Test-Path $Target) -and (Get-ChildItem -LiteralPath $Target -Force | Select-Object -First 1)) {
        throw "official evidence target exists but is not an empty Git checkout: $Target"
    }
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    git -C $Target init
    if ($LASTEXITCODE -ne 0) { throw "git init failed for $Target" }
    git -C $Target remote add origin $Baseline.repository
    if ($LASTEXITCODE -ne 0) { throw "git remote add failed for $Target" }
} else {
    if (git -C $Target status --porcelain) {
        throw "official evidence checkout has local changes: $Target"
    }
    git -C $Target remote set-url origin $Baseline.repository
    if ($LASTEXITCODE -ne 0) { throw "git remote set-url failed for $Target" }
}

$SparsePaths = @(
    ".agents/notes/implemented"
    "docs/architecture.md"
    "docs/subsystems"
    "packages/compaction"
    "packages/core/agent-loop"
    "packages/core/tools"
    "packages/experimental/agent-team"
    "packages/experimental/tool-agent-team"
    "packages/interaction"
    "packages/jobs"
    "packages/llm/token-meter"
    "packages/session"
    "packages/skill"
    "packages/spill"
    "packages/storage"
    "packages/subagent"
    "packages/workflow"
    "packages/workspace"
)

git -C $Target fetch --depth 1 origin $Baseline.commit
if ($LASTEXITCODE -ne 0) { throw "git fetch failed for official commit $($Baseline.commit)" }
git -C $Target sparse-checkout init --cone
if ($LASTEXITCODE -ne 0) { throw "git sparse-checkout init failed for $Target" }
git -C $Target sparse-checkout set --skip-checks $SparsePaths
if ($LASTEXITCODE -ne 0) { throw "git sparse-checkout set failed for $Target" }
git -C $Target checkout --detach $Baseline.commit
if ($LASTEXITCODE -ne 0) { throw "git checkout failed for official commit $($Baseline.commit)" }

$Actual = (git -C $Target rev-parse HEAD).Trim()
if ($Actual -ne $Baseline.commit) {
    throw "official evidence checkout mismatch: expected $($Baseline.commit), got $Actual"
}

Write-Host "Official evidence ready: $Target @ $Actual"

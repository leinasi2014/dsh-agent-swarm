$ErrorActionPreference = "Stop"

$Repository = "https://github.com/openJiuwen-ai/jiuwenswarm.git"
$Commit = "8f34291906abf7c4e1a3a94d1a819e5a94c0ff3b"
$Target = Join-Path $PSScriptRoot "source"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is required"
}

if (-not (Test-Path (Join-Path $Target ".git"))) {
    if ((Test-Path $Target) -and (Get-ChildItem -LiteralPath $Target -Force | Select-Object -First 1)) {
        throw "reference target exists but is not a Git checkout: $Target"
    }
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    git -C $Target init
    git -C $Target remote add origin $Repository
} else {
    $HasHead = git -C $Target rev-parse --verify HEAD 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "reference checkout has no HEAD; preserve and reconcile it explicitly before syncing"
    } elseif (git -C $Target status --porcelain) {
        throw "reference checkout has local changes; preserve or remove them before syncing"
    }
    git -C $Target remote set-url origin $Repository
}

git -C $Target config core.longpaths true
git -C $Target lfs install --local --skip-smudge 2>$null
git -C $Target fetch --depth 1 origin $Commit
git -C $Target checkout --detach FETCH_HEAD

$Actual = (git -C $Target rev-parse HEAD).Trim()
if ($Actual -ne $Commit) {
    throw "reference checkout mismatch: expected $Commit, got $Actual"
}

Write-Host "Reference source ready: $Target @ $Actual (Git LFS media skipped)"

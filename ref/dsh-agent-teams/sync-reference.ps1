$ErrorActionPreference = "Stop"

$Repository = "https://github.com/NanmiCoder/dsh-agent-teams.git"
$Commit = "912aae5225d3d85fa841a1b0c8a5c77021876c25"
$Target = Join-Path $PSScriptRoot "source"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is required"
}

if (-not (Test-Path (Join-Path $Target ".git"))) {
    if (Test-Path $Target) {
        Remove-Item -Recurse -Force $Target
    }
    New-Item -ItemType Directory -Force $Target | Out-Null
    git -C $Target init
    git -C $Target remote add origin $Repository
} else {
    git -C $Target remote set-url origin $Repository
}

git -C $Target fetch --depth 1 origin $Commit
git -C $Target checkout --detach FETCH_HEAD

$Actual = (git -C $Target rev-parse HEAD).Trim()
if ($Actual -ne $Commit) {
    throw "reference checkout mismatch: expected $Commit, got $Actual"
}

Write-Host "Reference source ready: $Target @ $Actual"

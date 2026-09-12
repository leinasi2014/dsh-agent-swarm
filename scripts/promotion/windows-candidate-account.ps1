#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Prepare', 'Rollback')][string]$Mode,
    [Parameter(Mandatory)][string]$ControllerSid,
    [Parameter(Mandatory)][string]$PrivateRoot,
    [string]$RuntimeRoot,
    [string]$NodeExe,
    [string]$PnpmRoot,
    [string]$CliRoot,
    [string]$GitExe,
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_-]{0,19}$')][string]$AccountName = 'DshCandidate'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $ControllerSid) {
    throw 'Elevate as the same controller user: another administrator cannot create its DPAPI credential.'
}
if ($AccountName -match '^(CodexSandbox.*|Administrator|DefaultAccount|Guest|WDAGUtilityAccount)$') {
    throw 'A new dedicated account is required; host and built-in accounts are forbidden.'
}
if (-not [IO.Path]::IsPathRooted($PrivateRoot)) { throw 'PrivateRoot must be an absolute path.' }
$accountRoot = [IO.Path]::GetFullPath($PrivateRoot).TrimEnd('\')
if ([IO.Path]::GetFileName($accountRoot) -ne 'dsh-candidate-account-private') {
    throw 'PrivateRoot must name a new dsh-candidate-account-private directory.'
}
$parentRoot = [IO.Directory]::GetParent($accountRoot).FullName
if (-not [IO.Directory]::Exists($parentRoot)) { throw 'PrivateRoot parent must already exist.' }
# No junction/symlink traversal in this administrator operation.
$ancestor = $parentRoot
while ($ancestor) {
    $item = Get-Item -LiteralPath $ancestor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PrivateRoot ancestors must not be reparse points.' }
    $parent = [IO.Directory]::GetParent($ancestor)
    $ancestor = if ($null -eq $parent) { $null } else { $parent.FullName }
}
$receiptPath = Join-Path $accountRoot 'account-receipt.json'
$credentialPath = Join-Path $accountRoot 'credential.clixml'

if ($Mode -eq 'Prepare') {
    if (Test-Path -LiteralPath $accountRoot) { throw 'PrivateRoot already exists; refusing to overwrite or adopt it.' }
    if (Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue) { throw 'Account already exists; refusing to modify or adopt it.' }
    if (-not [IO.Path]::IsPathRooted($RuntimeRoot) -or [IO.Path]::GetFileName($RuntimeRoot.TrimEnd('\')) -ne 'dsh-candidate-runtime') {
        throw 'RuntimeRoot must name a new absolute dsh-candidate-runtime directory.'
    }
    $runtimePath = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
    if ($runtimePath -notmatch '^[A-Za-z]:\\dsh-candidate-runtime$' -or
        [IO.DriveInfo]::new([IO.Path]::GetPathRoot($runtimePath)).DriveType -ne [IO.DriveType]::Fixed) {
        throw 'RuntimeRoot must be directly below a local fixed drive; UNC and mapped drives are not supported.'
    }
    # Keep every ancestor public/traversable without granting existing folders.
    if ([IO.Directory]::GetParent($runtimePath).FullName -ne [IO.Path]::GetPathRoot($runtimePath)) {
        throw 'RuntimeRoot must be directly below a local drive root.'
    }
    if (Test-Path -LiteralPath $runtimePath) { throw 'RuntimeRoot already exists; refusing to adopt it.' }
    foreach ($source in @($NodeExe, $PnpmRoot, $CliRoot, $GitExe)) {
        if (-not [IO.Path]::IsPathRooted($source) -or -not (Test-Path -LiteralPath $source)) { throw 'Explicit existing node, pnpm and independent CLI sources are required.' }
    }
    if (-not [IO.Path]::GetFullPath($GitExe).StartsWith("$env:ProgramFiles\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Git must be an existing system installation under Program Files; private Git tools are not granted access.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PnpmRoot 'bin/pnpm.cjs')) -or
        -not (Test-Path -LiteralPath (Join-Path $CliRoot 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) { throw 'Unexpected pnpm or independent CLI installation layout.' }
    $password = Read-Host "Password for new local account $AccountName" -AsSecureString
    if ($password.Length -eq 0) { $password.Dispose(); throw 'A nonempty account password is required.' }
    $createdSid = $null
    try {
        $null = New-Item -ItemType Directory -Path $accountRoot
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($identity.User)
        $acl.SetAccessRuleProtection($true, $false)
        $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($sidText in @($ControllerSid, 'S-1-5-18', 'S-1-5-32-544')) {
            $sid = [Security.Principal.SecurityIdentifier]::new($sidText)
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        # Only this newly created directory receives a changed ACL.
        Set-Acl -LiteralPath $accountRoot -AclObject $acl
        $created = New-LocalUser -Name $AccountName -Password $password -UserMayNotChangePassword -Description 'DSH candidate execution; owned by promotion account receipt'
        $createdSid = $created.SID.Value
        $receipt = [ordered]@{
            schemaVersion = 1
            owner = 'dsh-agent-swarm/#126'
            controllerSid = $ControllerSid
            accountName = $AccountName
            accountSid = $createdSid
            privateRoot = $accountRoot
            runtimeRoot = $runtimePath
            nodeSource = [IO.Path]::GetFullPath($NodeExe)
            pnpmSource = [IO.Path]::GetFullPath($PnpmRoot)
            cliSource = [IO.Path]::GetFullPath($CliRoot)
            gitDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($GitExe))
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        # Write ownership evidence before further provisioning, so an interrupted
        # preparation can be rolled back using this exact newly created SID.
        $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
        $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
        if (-not (Get-LocalGroupMember -SID $usersSid | Where-Object { $_.SID.Value -eq $createdSid })) {
            Add-LocalGroupMember -SID $usersSid -Member $created
        }
        $credential = [PSCredential]::new("$env:COMPUTERNAME\$AccountName", $password)
        # On Windows this encrypts the password with this controller user's DPAPI.
        $credential | Export-Clixml -LiteralPath $credentialPath
        foreach ($file in @($receiptPath, $credentialPath)) {
            $fileAcl = Get-Acl -LiteralPath $file
            $fileAcl.SetOwner($identity.User)
            Set-Acl -LiteralPath $file -AclObject $fileAcl
        }
        $null = New-Item -ItemType Directory -Path $runtimePath
        $runtimeAcl = [Security.AccessControl.DirectorySecurity]::new()
        $runtimeAcl.SetOwner($identity.User)
        $runtimeAcl.SetAccessRuleProtection($true, $false)
        foreach ($sidText in @($ControllerSid, 'S-1-5-18', 'S-1-5-32-544')) {
            $runtimeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sidText), 'FullControl', $inheritance, 'None', 'Allow'))
        }
        $candidateSid = [Security.Principal.SecurityIdentifier]::new($createdSid)
        $runtimeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($candidateSid, 'ReadAndExecute', $inheritance, 'None', 'Allow'))
        Set-Acl -LiteralPath $runtimePath -AclObject $runtimeAcl
        $null = New-Item -ItemType Directory -Path (Join-Path $runtimePath 'tools')
        $io = Join-Path $runtimePath 'io'
        $null = New-Item -ItemType Directory -Path $io
        $ioAcl = Get-Acl -LiteralPath $io
        $ioAcl.SetOwner($identity.User)
        # Candidate may write existing output files, but cannot replace a
        # controller-owned file/directory, create a junction, or change its ACL.
        $ioAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($candidateSid, 'Write', 'ObjectInherit', 'InheritOnly', 'Allow'))
        Set-Acl -LiteralPath $io -AclObject $ioAcl
        $runs = Join-Path $runtimePath 'runs'
        $null = New-Item -ItemType Directory -Path $runs
        $runsAcl = Get-Acl -LiteralPath $runs
        $runsAcl.SetOwner($identity.User)
        $runsAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($candidateSid, 'Modify', $inheritance, 'None', 'Allow'))
        Set-Acl -LiteralPath $runs -AclObject $runsAcl
        $tools = Join-Path $runtimePath 'tools'
        $toolsAcl = Get-Acl -LiteralPath $tools
        $toolsAcl.SetOwner($identity.User)
        Set-Acl -LiteralPath $tools -AclObject $toolsAcl
        [pscustomobject]@{
            account = $AccountName
            sid = $createdSid
            enabled = (Get-LocalUser -SID $created.SID).Enabled
            credentialRef = $credentialPath
            receipt = $receiptPath
            runtimeRoot = $runtimePath
            nativeLaunchVerified = $false
        } | ConvertTo-Json -Compress
    } catch {
        if ($createdSid) {
            $current = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
            if ($current -and $current.SID.Value -eq $createdSid) {
                Disable-LocalUser -SID $current.SID
            }
            Write-Warning "Preparation failed. Newly created account SID $createdSid is retained disabled; preserve $receiptPath for rollback."
        }
        throw
    } finally {
        $password.Dispose()
    }
    exit
}

# Rollback never discovers arbitrary paths from a receipt. It only permits the
# two fixed files under the explicitly supplied root and the pinned new account.
$rootItem = Get-Item -LiteralPath $accountRoot -Force
if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'PrivateRoot must be an ordinary directory.'
}
foreach ($item in Get-ChildItem -LiteralPath $accountRoot -Force) {
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -notin @('account-receipt.json', 'credential.clixml')) {
        throw 'PrivateRoot contains unexpected entries; refusing rollback cleanup.'
    }
}
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if ($receipt.schemaVersion -ne 1 -or $receipt.owner -ne 'dsh-agent-swarm/#126' -or
    $receipt.controllerSid -ne $ControllerSid -or $receipt.accountName -ne $AccountName -or
    $receipt.privateRoot -ne $accountRoot -or $receipt.accountSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or
    [int64]($receipt.accountSid.Split('-')[-1]) -lt 1000) {
    throw 'Receipt identity or path does not match this rollback request.'
}
$current = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
if ($current) {
    if ($current.SID.Value -ne $receipt.accountSid) { throw 'Account SID changed; refusing to touch the replacement account.' }
    Disable-LocalUser -SID $current.SID
    $accountIdentity = "$env:COMPUTERNAME\$AccountName"
    $active = @(Get-Process -IncludeUserName | Where-Object { $_.UserName -eq $accountIdentity })
    if ($active.Count -ne 0) { throw 'Account disabled; stop its candidate Jobs before rerunning rollback. No process was killed.' }
    Remove-LocalUser -SID $current.SID
}
if (Test-Path -LiteralPath $credentialPath) { Remove-Item -LiteralPath $credentialPath -Force }
Remove-Item -LiteralPath $receiptPath -Force
[IO.Directory]::Delete($accountRoot, $false)
[pscustomobject]@{ accountRemoved = $true; credentialRemoved = $true; profileDirectoryRemoved = $false; runtimeDirectoryRemoved = $false } | ConvertTo-Json -Compress

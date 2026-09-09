#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PrivateRoot, [switch]$InspectOnly, [string]$ProtectedRootsJson = '[]')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# This helper is run only by the controller, with stdout on a private anonymous
# pipe. Never run it in a terminal: its sole output is the binary logon secret.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$root = [IO.Path]::GetFullPath($PrivateRoot).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($PrivateRoot) -or [IO.Path]::GetFileName($root) -ne 'dsh-candidate-account-private') {
    throw 'Invalid private credential root.'
}
$ancestor = $root
while ($ancestor) {
    $item = Get-Item -LiteralPath $ancestor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Credential path traverses a reparse point.' }
    $parent = [IO.Directory]::GetParent($ancestor)
    $ancestor = if ($null -eq $parent) { $null } else { $parent.FullName }
}
$receiptPath = Join-Path $root 'account-receipt.json'
$credentialPath = Join-Path $root 'credential.clixml'
$allowed = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($path in @($root, $receiptPath, $credentialPath)) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Credential files must not be reparse points.' }
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]).Count -eq 0) { throw 'Credential DACL must be explicit and nonempty.' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'Credential owner differs from controller.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'Credential ACL is not controller-private.' }
    }
}
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if ($receipt.schemaVersion -ne 1 -or $receipt.owner -ne 'dsh-agent-swarm/#126' -or
    $receipt.controllerSid -ne $identity.User.Value -or $receipt.privateRoot -ne $root -or
    $receipt.accountName -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,19}$' -or
    $receipt.accountName -match '^(CodexSandbox.*|Administrator|DefaultAccount|Guest|WDAGUtilityAccount)$') { throw 'Credential receipt identity mismatch.' }
$account = Get-LocalUser -Name $receipt.accountName
if (-not $account.Enabled -or $account.SID.Value -ne $receipt.accountSid) { throw 'Candidate account is disabled or replaced.' }
$runtime = [IO.Path]::GetFullPath($receipt.runtimeRoot).TrimEnd('\')
if ($runtime -notmatch '^[A-Za-z]:\\dsh-candidate-runtime$') { throw 'Invalid candidate runtime root.' }
$readMask = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
$writeMask = [int][Security.AccessControl.FileSystemRights]::Write -bor $readMask
$modifyMask = [int][Security.AccessControl.FileSystemRights]::Modify -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
foreach ($leaf in @('', 'tools', 'io', 'runs')) {
    $path = if ($leaf) { Join-Path $runtime $leaf } else { $runtime }
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runtime path must be an ordinary directory.' }
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]).Count -eq 0) { throw 'Runtime DACL must be explicit and nonempty.' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'Runtime owner differs from controller.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -in $allowed) { continue }
        if ($rule.IdentityReference.Value -ne $receipt.accountSid) { throw 'Unexpected runtime ACL principal.' }
        $mask = [int]$rule.FileSystemRights
        $maximum = if ($leaf -eq 'runs') { $modifyMask } elseif ($leaf -eq 'io') { $writeMask } else { $readMask }
        if (($mask -band (-bnot $maximum)) -ne 0) { throw 'Candidate runtime ACL grants excessive rights.' }
        if ($leaf -eq 'io' -and ($mask -band (-bnot $readMask)) -ne 0 -and
            ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::ObjectInherit -or
             $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::InheritOnly)) { throw 'Candidate output write grant must apply only to files.' }
    }
}
if ($InspectOnly) {
    # A separate account is not a proof about arbitrary --dogfood-root ACLs.
    # Reject public/group write, DELETE, parent DELETE_CHILD and DACL/owner
    # changes. Deny ACEs are deliberately not used to excuse an unsafe Allow.
    $writeMask = 0x500D0156
    $replaceMask = 0x500D0040
    $checkedParents = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $checkedTree = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $ancestorAllowed = $allowed + ([Security.Principal.NTAccount]::new('NT SERVICE', 'TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value)
    function Assert-ControllerAcl([string]$Path, [int]$Mask) {
        $acl = Get-Acl -LiteralPath $Path
        $principals = if ($Mask -eq $replaceMask) { $ancestorAllowed } else { $allowed }
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $principals) { throw "Controller authority has an untrusted owner: $Path" }
        $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        if ($rules.Count -eq 0) { throw "Controller authority has no auditable DACL: $Path" }
        foreach ($rule in $rules) {
            if ($Mask -eq $replaceMask -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $principals -and
                (([int]$rule.FileSystemRights -band $Mask) -ne 0)) { throw "Controller authority permits non-controller writes or replacement: $Path" }
        }
    }
    function Assert-Parents([string]$Path) {
        $cursor = [IO.Directory]::GetParent($Path)
        while ($null -ne $cursor -and $checkedParents.Add($cursor.FullName)) {
            Assert-ControllerAcl $cursor.FullName $replaceMask
            $cursor = $cursor.Parent
        }
    }
    $pending = [Collections.Generic.Stack[string]]::new()
    foreach ($path in @($ProtectedRootsJson | ConvertFrom-Json)) {
        if (-not [IO.Path]::IsPathRooted($path)) { throw 'Controller authority paths must be absolute.' }
        $fullPath = [IO.Path]::GetFullPath($path)
        Assert-Parents $fullPath
        $pending.Push($fullPath)
    }
    while ($pending.Count -ne 0) {
        $path = $pending.Pop()
        if (-not $checkedTree.Add($path)) { continue }
        Assert-ControllerAcl $path $writeMask
        $item = Get-Item -LiteralPath $path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $targets = @($item.Target)
            if ($targets.Count -ne 1 -or -not $targets[0]) { throw "Unresolved controller authority reparse point: $path" }
            $target = if ([IO.Path]::IsPathRooted($targets[0])) { [IO.Path]::GetFullPath($targets[0]) } else { [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($path)) $targets[0])) }
            Assert-Parents $target
            $pending.Push($target)
        } elseif ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $pending.Push($child.FullName) }
        }
    }
}
if ($InspectOnly) { $receipt | ConvertTo-Json -Compress; exit }
$credential = Import-Clixml -LiteralPath $credentialPath
if ($credential -isnot [PSCredential] -or $credential.UserName -ne "$([Environment]::MachineName)\$($receipt.accountName)") { throw 'Credential account mismatch.' }
$pointer = [IntPtr]::Zero
$bytes = $null
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
    $length = [Runtime.InteropServices.Marshal]::ReadInt32($pointer, -4)
    if ($length -le 0 -or $length -gt 4096) { throw 'Invalid credential length.' }
    $bytes = New-Object byte[] $length
    [Runtime.InteropServices.Marshal]::Copy($pointer, $bytes, 0, $length)
    $output = [Console]::OpenStandardOutput()
    $output.Write($bytes, 0, $bytes.Length)
    $output.Flush()
} finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $credential.Password.Dispose()
}

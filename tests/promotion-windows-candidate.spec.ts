import { spawn, spawnSync } from 'node:child_process'
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allocatePrivateCandidateRoot, copyWindowsCandidateOutput, grantCandidateDirectories, spawnWindowsAccountCandidate } from '../scripts/promotion/windows-candidate.mjs'
import { laneEnv, run } from '../scripts/promotion/runner.mjs'

const prefix = resolve('scripts/promotion/windows-candidate.mjs')
const windows = process.platform === 'win32' && process.arch === 'x64'

async function removePrivateRoot(root: string): Promise<void> {
  const absolute = resolve(root)
  const driveRoot = `${process.env.SYSTEMDRIVE}\\`
  if (absolute !== root || !absolute.startsWith(`${driveRoot}dsh-candidate-`)) throw new Error('unexpected candidate cleanup root')
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function removeProtectedRoot(root: string): Promise<void> {
  const checked = resolve(root)
  if (!checked.startsWith(join(tmpdir(), 'dsh-full-protected-'))) throw new Error('unexpected protected drill cleanup')
  await rm(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe.skipIf(!windows)('Windows candidate process boundary (issue #126)', () => {
  it('audits controller authority ACLs read-only and rejects group write and parent replacement grants', async () => {
    const base = await mkdtemp(join(process.cwd(), '.promotion-acl-read-'))
    try {
      const target = join(base, 'authority')
      await writeFile(target, 'dummy authority')
      const scriptPath = resolve('scripts/promotion/windows-candidate-credential.ps1').replaceAll("'", "''")
      const script = `
        $ErrorActionPreference = 'Stop'
        $targetPath = '${target.replaceAll("'", "''")}'
        $parentPath = '${base.replaceAll("'", "''")}'
        $tokens=$null; $errors=$null
        $ast=[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}',[ref]$tokens,[ref]$errors)
        $block=$ast.Find({param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($InspectOnly) {') -and $n.Extent.Text.Contains('$writeMask = 0x500D0156')},$true)
        $body=$block.Clauses[0].Item2.Extent.Text
        $audit=[scriptblock]::Create($body.Substring(1,$body.Length-2))
        $controller=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $allowed=@($controller.Value,'S-1-5-18','S-1-5-32-544')
        $ProtectedRootsJson=ConvertTo-Json -InputObject @($targetPath) -Compress
        & $audit
        $nativeGetAcl=Get-Command Get-Acl -CommandType Cmdlet
        $fake=[Security.AccessControl.FileSecurity]::new()
        $fake.SetOwner($controller)
        $fake.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($controller,'FullControl','Allow'))
        $fake.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Write','Allow'))
        function Get-Acl { param([string]$LiteralPath) if($LiteralPath -eq $targetPath){return $fake}; & $nativeGetAcl -LiteralPath $LiteralPath }
        $rejected=$false
        try { & $audit } catch { $diagnostic=$_.Exception.Message; $rejected=$diagnostic.Contains('non-controller writes or replacement') }
        if(-not $rejected){throw "public write was not rejected: $diagnostic"}
        $fake=[Security.AccessControl.DirectorySecurity]::new()
        $fake.SetOwner($controller)
        $fake.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($controller,'FullControl','Allow'))
        $fake.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'DeleteSubdirectoriesAndFiles','Allow'))
        function Get-Acl { param([string]$LiteralPath) if($LiteralPath -eq $parentPath){return $fake}; & $nativeGetAcl -LiteralPath $LiteralPath }
        $rejected=$false
        try { & $audit } catch { $rejected=$_.Exception.Message.Contains('non-controller writes or replacement') }
        if(-not $rejected){throw 'parent replacement was not rejected'}
        Write-Output 'READ_ONLY_ACL_AUDIT_PASS'
      `
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
        env: { SystemRoot: process.env.SystemRoot, SYSTEMDRIVE: process.env.SYSTEMDRIVE },
      })
      expect(result.status, result.stderr + result.stdout).toBe(0)
      expect(result.stdout).toContain('READ_ONLY_ACL_AUDIT_PASS')
      expect(await readFile(target, 'utf8')).toBe('dummy authority')
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('copies an artifact by its final native file handle and refuses an escaping junction', async () => {
    const base = await mkdtemp(join(tmpdir(), 'promotion-copy-handle-'))
    try {
      const root = join(base, 'candidate'), outside = join(base, 'controller')
      await mkdir(root); await mkdir(outside)
      await writeFile(join(root, 'package.tgz'), 'candidate bytes')
      await writeFile(join(outside, 'private-fixture'), 'must not be copied')
      const output = join(base, 'artifact.tgz')
      await copyWindowsCandidateOutput(root, join(root, 'package.tgz'), output)
      expect(await readFile(output, 'utf8')).toBe('candidate bytes')
      await symlink(outside, join(root, 'escape'), 'junction')
      await expect(copyWindowsCandidateOutput(root, join(root, 'escape', 'private-fixture'), join(base, 'leak'))).rejects.toThrow('outside its execution root')
      await link(join(outside, 'private-fixture'), join(root, 'hardlink.tgz'))
      await expect(copyWindowsCandidateOutput(root, join(root, 'hardlink.tgz'), join(base, 'hardlink-leak'))).rejects.toThrow('single-link')
      expect(await stat(join(base, 'leak')).then(() => true, () => false)).toBe(false)
      expect(await stat(join(base, 'hardlink-leak')).then(() => true, () => false)).toBe(false)
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it.each(['windows-candidate-account.ps1', 'windows-candidate-credential.ps1'])('parses %s without executing account, credential or ACL operations', filename => {
    const path = resolve('scripts/promotion', filename).replaceAll("'", "''")
    const script = `$tokens = $null; $errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
    expect(parsed.status, parsed.stderr + parsed.stdout).toBe(0)
  })

  it('refuses unconfigured credentials and borrowed host accounts before launching', () => {
    const configured = { account: 'DshCandidate', expectedSid: 'S-1-5-21-1-2-3-1001', command: process.execPath, cwd: process.cwd(), env: {} }
    const password = Buffer.from('not-a-secret', 'utf16le')
    expect(() => spawnWindowsAccountCandidate({ ...configured, password: Buffer.alloc(0) })).toThrow('credentials are not configured')
    expect(() => spawnWindowsAccountCandidate({ ...configured, account: 'CodexSandboxOnline', password })).toThrow('dedicated local candidate account')
    expect(() => spawnWindowsAccountCandidate({ ...configured, account: 'WDAGUtilityAccount', password })).toThrow('dedicated local candidate account')
    expect(() => spawnWindowsAccountCandidate({ ...configured, expectedSid: 'S-1-5-21-1-2-3-500', password })).toThrow('built-in Windows identity')
    expect(() => spawnWindowsAccountCandidate({ ...configured, expectedSid: '', password })).toThrow('SID is not configured')
    expect(() => spawnWindowsAccountCandidate({ ...configured, command: 'node.exe', password })).toThrow('executable, cwd and argv')
    expect(() => spawnWindowsAccountCandidate({ ...configured, password: Buffer.from([0, 0]) })).toThrow('embedded terminator')
    password.fill(0)
  })

  it('fails closed on a real logon attempt for an absent dedicated account without echoing credentials', () => {
    // This deliberately nonexistent identity does not borrow or authenticate
    // any real host account. It exercises the native failure and Job cleanup.
    const password = 'fixture-password-must-not-appear-in-errors'
    let failure: unknown
    try {
      spawnWindowsAccountCandidate({
        account: 'DshMissing126', password: Buffer.from(password, 'utf16le'), expectedSid: 'S-1-5-21-1-2-3-1001',
        command: process.execPath, args: ['-e', 'process.exit(91)'], cwd: process.cwd(), env: laneEnv(),
      })
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('CreateProcessWithLogonW')
    expect(String(failure)).not.toContain(password)
  })

  it('rejects the controller SID before attempting account logon', () => {
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    expect(identity.status, identity.stderr).toBe(0)
    const sid = /S-1-5-21-\d+-\d+-\d+-\d+/.exec(identity.stdout)?.[0]
    expect(sid).toBeDefined()
    const password = Buffer.from('not-a-secret', 'utf16le')
    try {
      expect(() => spawnWindowsAccountCandidate({
        account: 'DshMissing126', password, expectedSid: sid!,
        command: process.execPath, cwd: process.cwd(), env: laneEnv(),
      })).toThrow('must differ from the controller account')
    } finally { password.fill(0) }
  })

  it('localizes default pipe failure to client reopen and proves an explicit pipe DACL works', async () => {
    const root = await allocatePrivateCandidateRoot()
    const grant = grantCandidateDirectories(root, [root])
    try {
      const require = createRequire(import.meta.url)
      require('koffi')
      // Stage the addon selected by the declared package's public loader,
      // without depending on its private optional-package installation layout.
      const pending = [require.cache[require.resolve('koffi')]]
      const visited = new Set<NodeJS.Module>()
      const addons: string[] = []
      while (pending.length) {
        const loaded = pending.pop()
        if (!loaded || visited.has(loaded)) continue
        visited.add(loaded)
        if (basename(loaded.filename) === 'koffi.node') addons.push(loaded.filename)
        pending.push(...loaded.children)
      }
      expect(addons).toHaveLength(1)
      await copyFile(addons[0]!, join(root, 'koffi.node'))
      const program = `
        const k = require('./koffi.node'), kernel = k.load('kernel32.dll'), advapi = k.load('advapi32.dll');
        const create = kernel.func('void * __stdcall CreateNamedPipeW(str16, uint32, uint32, uint32, uint32, uint32, uint32, void *)');
        const open = kernel.func('void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)');
        const err = kernel.func('uint32 __stdcall GetLastError()');
        const close = kernel.func('int __stdcall CloseHandle(void *)');
        const localFree = kernel.func('void * __stdcall LocalFree(void *)');
        const sddl = advapi.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, void *, void *)');
        const openProcess = kernel.func('void * __stdcall OpenProcess(uint32, int, uint32)');
        const openToken = advapi.func('int __stdcall OpenProcessToken(void *, uint32, void *)');
        const tokenInfo = advapi.func('int __stdcall GetTokenInformation(void *, int, void *, uint32, void *)');
        const sidText = advapi.func('int __stdcall ConvertSidToStringSidW(void *, void *)');
        const processHandle = openProcess(0x400, 0, process.pid), tokenSlot = Buffer.alloc(8), user = Buffer.alloc(1024), needed = Buffer.alloc(4), textSlot = Buffer.alloc(8);
        if (!openToken(processHandle, 8, tokenSlot)) throw Error('OpenProcessToken ' + err());
        const token = k.decode(tokenSlot, 'void *');
        if (!tokenInfo(token, 1, user, user.length, needed)) throw Error('GetTokenInformation ' + err());
        if (!sidText(k.decode(user, 'void *'), textSlot)) throw Error('ConvertSidToStringSidW ' + err());
        const textPointer = k.decode(textSlot, 'void *'), userSid = k.decode(textPointer, 'char16', -1);
        localFree(textPointer); close(token); close(processHandle);
        const result = [];
        for (const explicit of [false, true]) {
          const name = '\\\\\\\\?\\\\pipe\\\\dsh-probe-' + process.pid + '-' + explicit;
          let sd = null, sa = null;
          if (explicit) {
            const slot = Buffer.alloc(8);
            // The user ACE satisfies the normal access check, the capability
            // ACE the restricting check. This changes only this new pipe.
            if (!sddl('D:(A;;GA;;;' + userSid + ')(A;;GA;;;' + process.argv[1] + ')', 1, slot, null)) throw Error('sddl ' + err());
            sd = k.decode(slot, 'void *'); sa = Buffer.alloc(24); sa.writeUInt32LE(24); sa.writeBigUInt64LE(k.address(sd), 8);
          }
          const server = create(name, 0x40080003, 0, 1, 65536, 65536, 0, sa), serverError = err();
          const invalid = value => value === null || k.address(value) === 0xffffffffffffffffn;
          let client = null;
          const entry = { explicit, serverOk: !invalid(server), serverError: invalid(server) ? serverError : 0 };
          if (entry.serverOk) { client = open(name, 0xc0040000, 0, null, 3, 0, null); const clientError = err(); entry.clientOk = !invalid(client); entry.clientError = entry.clientOk ? 0 : clientError; }
          result.push(entry);
          if (!invalid(client)) close(client);
          if (!invalid(server)) close(server);
          if (sd !== null) localFree(sd);
        }
        console.log(JSON.stringify(result));
      `
      const result = await run(process.execPath, [prefix, grant.sid, root, process.execPath, '-e', program, grant.sid], { cwd: root, timeoutMs: 15_000 })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toEqual([
        { explicit: false, serverOk: true, serverError: 0, clientOk: false, clientError: 5 },
        { explicit: true, serverOk: true, serverError: 0, clientOk: true, clientError: 0 },
      ])
    } finally {
      grant.dispose()
      await removePrivateRoot(root)
    }
  }, 30_000)

  it('records the full restricted token default Node pipe limitation requiring the account executor', async () => {
    const root = await allocatePrivateCandidateRoot()
    const grant = grantCandidateDirectories(root, [root])
    try {
      const program = `
        const cp = require('node:child_process');
        const sync = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write("sync-output");process.stderr.write("sync-error")'], { encoding: 'utf8', windowsHide: true });
        const result = { sync: { status: sync.status, error: sync.error?.code, stdout: sync.stdout, stderr: sync.stderr } };
        let child;
        try { child = cp.spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout);process.stderr.write("async-error")'], { windowsHide: true }); }
        catch (error) { result.asyncError = error.code; console.log(JSON.stringify(result)); process.exit(0); }
        let stdout = '', stderr = '';
        child.stdout?.on('data', chunk => stdout += chunk);
        child.stderr?.on('data', chunk => stderr += chunk);
        child.on('error', error => result.asyncError = error.code);
        child.on('close', status => { result.async = { status, stdout, stderr }; console.log(JSON.stringify(result)); });
        child.stdin?.on('error', () => {});
        child.stdin?.end('async-input');
      `
      const result = await run(process.execPath, [prefix, grant.sid, root, process.execPath, '-e', program], { cwd: root, timeoutMs: 15_000 })
      expect(result.code, result.stderr).toBe(0)
      const matrix = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '{}')
      // This legacy token route remains a diagnostic, not the candidate lane.
      // The account child launcher has its own normal-pipe plumbing test;
      // successful cross-account logon still requires the prepared OS account.
      expect(matrix).toEqual({
        sync: { status: null, error: 'EPERM' },
        asyncError: 'EPERM',
      })
    } finally {
      grant.dispose()
      await removePrivateRoot(root)
    }
  }, 30_000)

  it('denies protected writes, rename, delete, directory delete and owner-DACL changes through real children', async () => {
    const root = await allocatePrivateCandidateRoot()
    const protectedRoot = await mkdtemp(join(tmpdir(), 'dsh-full-protected-'))
    const workspace = join(root, 'work')
    let grant: ReturnType<typeof grantCandidateDirectories> | undefined
    try {
      await mkdir(workspace)
      await mkdir(join(protectedRoot, 'empty'))
      for (const name of ['write', 'rename', 'delete', 'acl']) await writeFile(join(protectedRoot, name), 'parent')
      expect(() => grantCandidateDirectories(root, [protectedRoot])).toThrow('escapes')
      grant = grantCandidateDirectories(root, [root])
      const program = `
        const fs = require('node:fs'), cp = require('node:child_process'), p = require('node:path');
        const outside = process.argv[1], results = {};
        const attempt = (name, fn) => { try { fn(); results[name] = true } catch (error) { results[name] = false; results[name + 'Error'] = error.code || error.message } };
        attempt('write', () => fs.writeFileSync(p.join(outside, 'write'), 'child'));
        attempt('rename', () => fs.renameSync(p.join(outside, 'rename'), p.join(outside, 'renamed')));
        attempt('delete', () => fs.unlinkSync(p.join(outside, 'delete')));
        attempt('deleteDirectory', () => fs.rmdirSync(p.join(outside, 'empty')));
        attempt('createOutside', () => fs.writeFileSync(p.join(outside, 'new-file'), 'child'));
        attempt('readOutside', () => fs.readFileSync(p.join(outside, 'write')));
        attempt('inside', () => fs.writeFileSync('inside', 'allowed'));
        for (const [name, target] of [['descendant', outside], ['insideDescendant', process.cwd()]]) {
          const child = cp.spawnSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],"nested")', p.join(target, 'nested')], { stdio: 'inherit', windowsHide: true });
          results[name + 'Spawned'] = child.error === undefined;
          results[name] = child.status === 0;
        }
        const acl = cp.spawnSync('icacls.exe', [p.join(outside, 'acl'), '/grant', '*S-1-5-32-545:R'], { stdio: 'inherit', windowsHide: true });
        results.aclSpawned = acl.error === undefined; results.ownerChangeDacl = acl.status === 0;
        console.log(JSON.stringify(results));
      `
      const result = await run(process.execPath, [prefix, grant.sid, workspace, process.execPath, '-e', program, protectedRoot], { cwd: workspace, timeoutMs: 15_000 })
      expect(result.code, result.stderr).toBe(0)
      const matrix = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as Record<string, unknown>
      expect(matrix).toMatchObject({
        write: false, rename: false, delete: false, deleteDirectory: false, createOutside: false, readOutside: false,
        inside: true, descendantSpawned: true, descendant: false, insideDescendantSpawned: true,
        insideDescendant: true, aclSpawned: true, ownerChangeDacl: false,
      })
      for (const name of ['write', 'rename', 'delete', 'acl']) expect(await readFile(join(protectedRoot, name), 'utf8')).toBe('parent')
      expect(await readFile(join(workspace, 'nested'), 'utf8')).toBe('nested')
      // The trusted parent keeps its authority while the candidate grant exists.
      await writeFile(join(protectedRoot, 'write'), 'parent-still-writable')
      expect(await readFile(join(protectedRoot, 'write'), 'utf8')).toBe('parent-still-writable')
      grant.dispose()
      const after = await run(process.execPath, [prefix, grant.sid, workspace, process.execPath, '-e', 'try{require("fs").writeFileSync("after-revoke","no");process.exit(3)}catch(error){console.log(error.code)}'], { cwd: workspace, timeoutMs: 10_000 })
      expect(after.code, after.stderr).toBe(0)
      expect(after.stdout).toContain('EPERM')
    } finally {
      grant?.dispose()
      await removeProtectedRoot(protectedRoot)
      await removePrivateRoot(root)
    }
  }, 30_000)

  it('kills the inherited descendant Job when only its prefix process is cancelled', async () => {
    const root = await allocatePrivateCandidateRoot()
    const grant = grantCandidateDirectories(root, [root])
    const pids = join(root, 'pids.json')
    const program = `
      const cp = require('node:child_process'), fs = require('node:fs');
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit', windowsHide: true });
      child.on('spawn', () => fs.writeFileSync('pids.json', JSON.stringify([process.pid, child.pid])));
      setInterval(()=>{},1000);
    `
    const prefixProcess = spawn(process.execPath, [prefix, grant.sid, root, process.execPath, '-e', program], {
      cwd: root, env: laneEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = new Promise<void>((resolveClosed, reject) => {
      prefixProcess.once('error', reject)
      prefixProcess.once('close', () => resolveClosed())
    })
    try {
      await expect.poll(() => stat(pids).then(() => true, () => false), { timeout: 10_000 }).toBe(true)
      const childPids = JSON.parse(await readFile(pids, 'utf8')) as number[]
      expect(childPids).toHaveLength(2)
      expect(childPids.every(alive)).toBe(true)
      prefixProcess.kill() // Not taskkill /T: kernel Job ownership must do the work.
      await closed
      await expect.poll(() => childPids.some(alive), { timeout: 5_000 }).toBe(false)
      await writeFile(join(root, 'parent-after-cancel'), 'still writable')
    } finally {
      if (prefixProcess.exitCode === null) prefixProcess.kill()
      await closed
      grant.dispose()
      await removePrivateRoot(root)
    }
  }, 25_000)
})

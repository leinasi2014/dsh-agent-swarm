import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allocatePrivateCandidateRoot, grantCandidateDirectories } from '../scripts/promotion/windows-candidate.mjs'
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
        write: false, rename: false, delete: false, deleteDirectory: false, createOutside: false,
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

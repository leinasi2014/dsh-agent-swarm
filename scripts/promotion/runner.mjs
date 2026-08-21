// Process execution helpers for the promotion lane CLIs (issue #102).
//
// Every external command here runs under an explicit timeout and captures its
// output for the evidence chain — fault containment, mirroring the review
// root's kill-tree discipline (src/runtime/review-root.ts) on Windows.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default bound for one promotion-lane child process (CI lanes run long). */
export const LANE_TIMEOUT_MS = 30 * 60_000

/**
 * Run one command under a bounded timeout. Never throws on a non-zero exit —
 * the caller decides fail-loud vs evidence. Output is captured whole with a
 * 8 MiB per-stream ceiling so a runaway lane cannot exhaust memory.
 */
export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? LANE_TIMEOUT_MS
  return new Promise(resolve => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env !== undefined ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error), durationMs: 0, timedOut: false, spawnError: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { if (stdout.length < 8 * 1024 * 1024) stdout += String(chunk) })
    child.stderr.on('data', chunk => { if (stderr.length < 8 * 1024 * 1024) stderr += String(chunk) })
    const timer = setTimeout(() => {
      if (child.pid !== undefined && child.exitCode === null) killTree(child.pid)
    }, timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, durationMs: Date.now() - startedAt, timedOut: false, spawnError: String(error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut: false })
    })
  })
}

/** Kill a whole process tree (Windows-first; plain kill elsewhere). */
export function killTree(pid) {
  if (pid === undefined || pid === null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

/** Git in one cwd; resolves with the run result (see `run`). */
export function git(cwd, args, options = {}) {
  return run('git', ['-C', cwd, ...args], { timeoutMs: options.timeoutMs ?? 60_000, ...options })
}

/**
 * A detached worktree of `commit` under a fresh temp directory, handed to
 * `fn(worktreeDir)`, always removed afterwards (force + prune, the ops
 * lesson-27 cleanup form). The worktree is CLEAN-BY-CONSTRUCTION (fresh
 * checkout of a commit); callers still record `git status --porcelain` as
 * freeze evidence.
 */
export async function withDetachedWorktree(repo, commit, fn, label = 'agent-swarm-lane') {
  const base = await mkdtemp(join(tmpdir(), `${label}-`))
  const worktree = join(base, 'wt')
  const add = await git(repo, ['worktree', 'add', '--detach', worktree, commit])
  if (add.code !== 0) {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    throw new Error(`git worktree add failed for ${commit}: ${add.stderr || add.stdout}`)
  }
  try {
    return await fn(worktree)
  } finally {
    await git(repo, ['worktree', 'remove', '--force', worktree])
    await git(repo, ['worktree', 'prune'])
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}

/** Wait until `predicate()` resolves true, bounded by `timeoutMs`. */
export async function waitUntil(predicate, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  if (lastError !== undefined) throw lastError
  return false
}

/**
 * Boot one DSH plane (web-template profile) and probe the official apiproxy
 * health route. Returns the live child plus probe evidence; the CALLER owns
 * teardown via `stopPlane` (bounded tree kill + port-free check).
 */
export async function bootPlane({ cli, home, profile = 'web', port, host = '127.0.0.1', readyTimeoutMs = 90_000, extraArgs = [] }) {
  const child = spawn(process.execPath, [cli, '--profile', profile, '--host', host, '--port', String(port), '--no-open', ...extraArgs], {
    env: { ...process.env, DSH_HOME: home },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += String(chunk) })
  child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += String(chunk) })
  const startedAt = Date.now()
  const ready = await waitUntil(async () => {
    if (child.exitCode !== null) return false
    try {
      const response = await fetch(`http://${host}:${port}/api/host.describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'm3c-boot-probe', method: 'host.describe', payload: {} }),
        signal: AbortSignal.timeout(2_000),
      })
      const body = await response.json()
      return response.status === 200 && body?.result?.ok === true
    } catch {
      return false
    }
  }, { timeoutMs: readyTimeoutMs, intervalMs: 500 })
  return { child, ready, bootMs: Date.now() - startedAt, stdout: () => stdout, stderr: () => stderr }
}

/** Bounded teardown of one booted plane: tree kill, wait exit, port free. */
export async function stopPlane(boot, { waitExitMs = 20_000 } = {}) {
  if (boot.child.exitCode !== null) return { exited: true, code: boot.child.exitCode }
  killTree(boot.child.pid)
  const exited = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), waitExitMs)
    boot.child.once('exit', () => { clearTimeout(timer); resolve(true) })
    boot.child.once('close', () => { clearTimeout(timer); resolve(true) })
  })
  return { exited, code: boot.child.exitCode }
}

/** Whether anything still listens on one port (residue assertion). */
export async function portFree(port, host = '127.0.0.1') {
  const net = await import('node:net')
  return new Promise(resolveItem => {
    const socket = new net.Socket()
    const finish = open => { socket.destroy(); resolveItem(!open) }
    socket.once('connect', () => finish(false))
    socket.once('error', () => finish(true))
    socket.setTimeout(1_500, () => finish(true))
    socket.connect(port, host)
  })
}

/** Bounded wait until one port is free (tree kill settles slightly after the main exit). */
export async function waitPortFree(port, timeoutMs = 10_000, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portFree(port, host)) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return await portFree(port, host)
}

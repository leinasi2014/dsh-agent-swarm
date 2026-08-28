// Process execution helpers for the promotion lane CLIs (issue #102).
//
// Every external command here runs under an explicit timeout and captures its
// output for the evidence chain — fault containment, mirroring the review
// root's kill-tree discipline (src/runtime/review-root.ts) on Windows.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliLaunchArgs } from './cli-launch.mjs'

/** Default bound for one promotion-lane child process (CI lanes run long). */
export const LANE_TIMEOUT_MS = 30 * 60_000

/**
 * Environment allowlist for every promotion-lane child process (issue #122,
 * F2): the freeze worktree, the acceptance verification root, the acceptance
 * plane boots and the stable-plane probes all execute candidate-controlled
 * code (candidate package scripts, candidate tests, candidate plugin code in
 * a booted plane) — they must never inherit the PM session's environment
 * (model-provider keys, tokens, arbitrary session state). Children receive
 * only OS path/execution variables plus explicitly injected values (DSH_HOME
 * and friends). Windows env names are case-insensitive, so the membership
 * test upper-cases both sides. Verified live: pnpm install/build/test/pack,
 * git (with `-c` identity overrides), tar, and the official CLI boot +
 * host.describe RPC all run green under exactly this base (the CLI resolves
 * the host account home through the OS API, not the USERPROFILE env).
 */
const ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'SYSTEMDRIVE', 'OS',
  'TEMP', 'TMP', 'DSH_HOME',
])

/** The sealed child environment: allowlisted vars + explicit injections. */
export function laneEnv(injections = {}) {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value
  }
  return { ...env, ...injections }
}

/**
 * Commands that resolve to `.cmd` shims on Windows — spawn() refuses those
 * without a shell since the CVE-2024-27980 hardening, so they route through
 * cmd.exe (the official CLI does the same for pnpm). Everything else (git,
 * node, tar, powershell, taskkill) is a real executable and spawns directly,
 * keeping argument quoting and process-tree teardown exact.
 */
const CMD_SHIMS = new Set(['pnpm', 'npx', 'pnpx', 'yarn'])

/**
 * Run one command under a bounded timeout. Never throws on a non-zero exit —
 * the caller decides fail-loud vs evidence. Output is captured whole with a
 * 8 MiB per-stream ceiling so a runaway lane cannot exhaust memory.
 *
 * On Windows, `pnpm` (and other extensionless commands) resolve to `.cmd`
 * shims that spawn() refuses without a shell since the CVE-2024-27980
 * hardening — exactly why the official CLI shells out for pnpm
 * (apps/cli/src/plugin.ts). Real executables (git/node/tar/powershell) spawn
 * directly so process-tree teardown stays precise.
 */
export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? LANE_TIMEOUT_MS
  const useShell = process.platform === 'win32' && CMD_SHIMS.has(command)
  const quote = value => /[\s"^&|<>()!]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  return new Promise(resolve => {
    const startedAt = Date.now()
    let timedOut = false
    let child
    try {
      child = useShell
        ? spawn('cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quote).join(' ')], {
          cwd: options.cwd,
          env: laneEnv(options.env),
          windowsHide: true,
          shell: false,
        })
        : spawn(command, args, {
          cwd: options.cwd,
          env: laneEnv(options.env),
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
      if (child.pid !== undefined && child.exitCode === null) {
        timedOut = true
        killTree(child.pid)
      }
    }, timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, durationMs: Date.now() - startedAt, timedOut, spawnError: String(error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut })
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
 * Extract one .tgz tarball into `destDir` (tar must already exist). Windows
 * forms follow the live-proven drill pattern (issue #102 P4b): forward
 * slashes, `--force-local`, and destDir via cwd — the msys GNU tar mangles
 * backslash drive-letter arguments and `-C` is operand-order dependent.
 */
export async function extractTarball(tarballPath, destDir) {
  const posix = tarballPath.replaceAll('\\', '/')
  return run('tar', ['--force-local', '-xzf', posix], { cwd: destDir, timeoutMs: 120_000 })
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
export async function bootPlane({ cli, home, profile = 'web', port, host = '127.0.0.1', readyTimeoutMs = 90_000, extraArgs = [], cwd, env = {} }) {
  const child = spawn(process.execPath, cliLaunchArgs(cli, ['--profile', profile, '--host', host, '--port', String(port), '--no-open', ...extraArgs]), {
    cwd,
    env: laneEnv({ DSH_HOME: home, ...env }),
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

/**
 * Every netstat row whose local address ends in `:<port>` (any state), parsed
 * from netstat (Windows). This is the KERNEL truth about the port.
 */
export async function portRows(port) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const target = `:${port}`
  const rows = []
  try {
    const { stdout } = await promisify(execFile)('netstat', ['-ano', '-p', 'tcp'], { timeout: 10_000, windowsHide: true })
    for (const line of stdout.split('\n')) {
      const columns = line.trim().split(/\s+/)
      if (columns.length >= 5 && columns[1]?.endsWith(target)) {
        rows.push({ state: columns[3], pid: Number(columns[4]) })
      }
    }
  } catch { /* netstat unavailable: no rows */ }
  return rows
}

/**
 * The pid LISTENING on one TCP port (Windows netstat).
 */
export async function listenerPid(port) {
  for (const row of await portRows(port)) {
    if (row.state === 'LISTENING') return row.pid
  }
  return undefined
}

/**
 * Whether a port is free. On Windows this reads netstat (the kernel truth):
 * a connect() probe from THIS process can spuriously COMPLETE against stale
 * loopback tuples left by our own earlier client connections — observed
 * live, connect "succeeds" for minutes while netstat shows zero rows — so
 * the socket probe is only the non-Windows fallback.
 */
export async function portFree(port, host = '127.0.0.1') {
  if (process.platform === 'win32') {
    const rows = await portRows(port)
    return !rows.some(row => row.state === 'LISTENING' || row.state === 'BOUND')
  }
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

/**
 * Bounded wait until one port is free (tree kill settles slightly after the
 * main exit — a detached web child holds the socket until its heartbeat
 * notices the dead parent, observed live >10s). `reclaim: true` additionally
 * kills whatever STILL listens on the port once the grace elapsed: callers
 * pass only their own dedicated drill-pool port, so any late listener is
 * drill residue by construction and reclaiming it is bounded teardown, not a
 * foreign kill.
 */
export async function waitPortFree(port, timeoutMs = 15_000, host = '127.0.0.1', options = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portFree(port, host)) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (options.reclaim === true) {
    const pid = await listenerPid(port)
    if (pid !== undefined && pid !== process.pid) {
      killTree(pid)
      const grace = Date.now() + 10_000
      while (Date.now() < grace) {
        if (await portFree(port, host)) return true
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  }
  return await portFree(port, host)
}

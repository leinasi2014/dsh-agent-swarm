// Controller-owned Windows candidate execution. No code from the candidate
// selects an account, reads a credential, writes an acceptance verdict or owns
// the native Job. Administrator preparation is a separate explicit operation.
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { closeHandleChecked, isJobEmpty, pollProcessExit, terminateJob } from '@deepseek-ai/dsh-win32-process'
import { copyWindowsCandidateOutput, spawnWindowsAccountCandidate, windowsCandidateBindings } from './windows-candidate.mjs'

function within(root, path) {
  const local = relative(resolve(root), resolve(path))
  return local === '' || (!local.startsWith('..') && !isAbsolute(local))
}

/** Copy the installed package graph, rebasing internal junctions. Never follow
 * an installation link into a user's source checkout or another private root. */
export async function copyPortableTree(source, target) {
  const base = await realpath(source)
  // The destination does not exist yet; resolve its existing parent so short
  // Windows paths and junction ancestors share the source's physical namespace.
  target = join(await realpath(dirname(target)), basename(target))
  if (within(base, target)) throw new Error('portable copy target intersects its source')
  await mkdir(target)
  const links = []
  const copy = async (from, to) => {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const input = join(from, entry.name), output = join(to, entry.name)
      const info = await lstat(input)
      if (info.isSymbolicLink()) {
        const resolved = await realpath(input)
        if (!within(base, resolved)) throw new Error('toolchain link escapes the independent installation root')
        if ((await stat(resolved)).isDirectory()) links.push([output, join(target, relative(base, resolved))])
        else await copyFile(resolved, output)
      } else if (info.isDirectory()) {
        await mkdir(output)
        await copy(input, output)
      } else if (info.isFile()) await copyFile(input, output)
      else throw new Error('unsupported toolchain filesystem entry')
    }
  }
  await copy(base, target)
  for (const [path, destination] of links) await symlink(destination, path, 'junction')
  for (const [path] of links) {
    if (!within(target, await realpath(path))) throw new Error('relocated toolchain link escapes its copy')
  }
}

function credentialHelper(privateRoot, inspectOnly, protectedRoots = []) {
  return new Promise((resolveResult, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-File', join(import.meta.dirname, 'windows-candidate-credential.ps1'), '-PrivateRoot', privateRoot]
    if (inspectOnly) args.push('-InspectOnly', '-ProtectedRootsJson', JSON.stringify(protectedRoots))
    // System PowerShell and a minimal OS environment; no provider keys, PATH
    // resolution or candidate-selected helper script.
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot) { reject(new Error('Windows system root is unavailable')); return }
    const child = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: systemRoot, SYSTEMDRIVE: process.env.SYSTEMDRIVE ?? 'C:' },
    })
    const chunks = []
    let size = 0, failed = false
    const timer = setTimeout(() => { failed = true; child.kill() }, inspectOnly ? 120_000 : 30_000)
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > 16_384) { chunk.fill(0); failed = true; child.kill() }
      else chunks.push(chunk)
    })
    // Do not echo PowerShell output around a secret-bearing operation.
    child.stderr.on('data', chunk => { chunk.fill(0) })
    child.on('error', () => { failed = true })
    child.on('close', code => {
      clearTimeout(timer)
      if (failed || code !== 0) {
        chunks.forEach(chunk => chunk.fill(0))
        reject(new Error('candidate account preparation or private credential validation failed'))
      } else {
        const buffer = Buffer.concat(chunks)
        chunks.forEach(chunk => chunk.fill(0))
        resolveResult(buffer)
      }
    })
  })
}

export async function resolveApprovedCli(cliSource, expectedCli) {
  const sourceCli = await realpath(join(cliSource, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  if (expectedCli !== undefined && await realpath(expectedCli) !== sourceCli) throw new Error('--cli differs from the administrator-approved independent CLI')
  return sourceCli
}

/** Inspect does not decrypt. The only secret read happens immediately around
 * one native spawn, and both the pipe buffer and native copy are wiped. */
export async function openCandidateSession(privateRoot, controlRun, protectedRoots = [], expectedCli) {
  if (process.platform !== 'win32') throw new Error('dedicated account execution currently requires Windows')
  if (!isAbsolute(privateRoot ?? '')) throw new Error('--candidate-account-root must identify the administrator-prepared private directory')
  const metadata = await credentialHelper(privateRoot, true, [...protectedRoots, import.meta.dirname])
  let receipt
  try { receipt = JSON.parse(metadata.toString('utf8').replace(/^\uFEFF/, '')) } finally { metadata.fill(0) }
  const sourceCli = await resolveApprovedCli(receipt.cliSource, expectedCli)
  const runtimeRoot = resolve(receipt.runtimeRoot)
  if (!/^[A-Za-z]:[\\/]dsh-candidate-runtime$/i.test(runtimeRoot)) throw new Error('invalid prepared candidate runtime root')
  for (const directory of [runtimeRoot, join(runtimeRoot, 'tools'), join(runtimeRoot, 'runs'), join(runtimeRoot, 'io')]) {
    if ((await lstat(directory)).isSymbolicLink() || !(await stat(directory)).isDirectory()) throw new Error('prepared runtime directories must be ordinary directories')
  }
  // One Windows identity is shared by these sessions. An exclusive controller
  // lock prevents overlapping candidates from acquiring each other's state.
  const lockPath = join(privateRoot, 'active.lock')
  const lock = await open(lockPath, 'wx')
  await lock.writeFile(JSON.stringify({ controllerPid: process.pid }))
  const live = new Set()
  let terminalFailure
  let workRoot, toolsRoot, ioRoot
  const dispose = async () => {
    for (const child of [...live]) await child.stop()
    if (terminalFailure !== undefined) throw terminalFailure
    // Candidate-writable state is disposable. No path discovered in its files
    // controls this cleanup; fs.rm unlinks junctions instead of following them.
    if (workRoot) await rm(workRoot, { recursive: true, force: true, maxRetries: 5 })
    if (toolsRoot) await rm(toolsRoot, { recursive: true, force: true, maxRetries: 5 })
    if (ioRoot) await rm(ioRoot, { recursive: true, force: true, maxRetries: 5 })
    await lock.close()
    await rm(lockPath)
  }
  try {
    workRoot = await mkdtemp(join(runtimeRoot, 'runs', 'session-'))
    toolsRoot = await mkdtemp(join(runtimeRoot, 'tools', 'session-'))
    ioRoot = await mkdtemp(join(runtimeRoot, 'io', 'session-'))
    await copyFile(receipt.nodeSource, join(toolsRoot, 'node.exe'))
    await copyFile(join(import.meta.dirname, 'windows-candidate-child.mjs'), join(toolsRoot, 'child.mjs'))
    await copyPortableTree(receipt.pnpmSource, join(toolsRoot, 'pnpm'))
    await copyPortableTree(receipt.cliSource, join(toolsRoot, 'cli'))
    await writeFile(join(toolsRoot, 'pnpm.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0pnpm\\bin\\pnpm.cjs" %*\r\n')
    const node = join(toolsRoot, 'node.exe')
    const cli = join(toolsRoot, 'cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const temp = join(workRoot, 'temp')
    await mkdir(temp)
    const commandOf = (command, args) => {
      if (command === 'pnpm') return [node, [join(toolsRoot, 'pnpm', 'bin', 'pnpm.cjs'), ...args]]
      if (command === process.execPath || command === node) return [node, args]
      throw new Error('candidate command must use the staged Node or pnpm entry')
    }
    const start = async (command, args, options = {}) => {
      const cwd = options.cwd ?? workRoot
      if (!within(workRoot, cwd)) throw new Error('candidate cwd escapes its disposable execution root')
      const [executable, argv] = commandOf(command, args)
      const slot = await mkdtemp(join(ioRoot, 'command-'))
      const stdoutPath = join(slot, 'stdout'), stderrPath = join(slot, 'stderr')
      // Open output files as controller first; read the same handles even if a
      // hostile candidate renames their paths or replaces them with junctions.
      let stdoutHandle, stderrHandle
      const specification = join(toolsRoot, `command-${live.size}-${Date.now()}.json`)
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
      const env = {
        SystemRoot: systemRoot, SYSTEMDRIVE: process.env.SYSTEMDRIVE ?? 'C:',
        COMSPEC: join(systemRoot, 'System32', 'cmd.exe'),
        PATH: `${toolsRoot};${receipt.gitDirectory};${join(dirname(receipt.gitDirectory), 'usr', 'bin')};${join(systemRoot, 'System32')};${systemRoot}`,
        PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: temp, TMP: temp,
        npm_config_store_dir: join(workRoot, 'pnpm-store'), ...options.env,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: cwd,
      }
      let native, password
      try {
        stdoutHandle = await open(stdoutPath, 'wx+')
        stderrHandle = await open(stderrPath, 'wx+')
        await writeFile(specification, JSON.stringify({ command: executable, args: argv, cwd, env, stdout: stdoutPath, stderr: stderrPath }), { flag: 'wx' })
        password = await credentialHelper(privateRoot, false)
        native = spawnWindowsAccountCandidate({ account: receipt.accountName, expectedSid: receipt.accountSid, password,
          command: node, args: [join(toolsRoot, 'child.mjs'), specification], cwd, env, inheritStdio: false })
      } catch (error) {
        await stdoutHandle?.close(); await stderrHandle?.close()
        throw error
      } finally { password?.fill(0) }
      const api = windowsCandidateBindings()
      const startedAt = Date.now()
      let timedOut = false, exitCode = null, settled = false, interval, timer, stopTimer, output = '', errors = ''
      const readOutput = async handle => {
        const buffer = Buffer.alloc(Math.min((await handle.stat()).size, 8 * 1024 * 1024))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return buffer.toString('utf8', 0, bytesRead)
      }
      let resolveDone, rejectDone
      const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
      const finish = async error => {
        if (settled) return
        settled = true
        clearInterval(interval); clearTimeout(timer); clearTimeout(stopTimer)
        let failure = error
        for (const [handle, label] of [[native.job, 'candidate Job'], [native.process, 'candidate process']]) {
          try { closeHandleChecked(api, handle, label) } catch (cause) { failure ??= cause }
        }
        try {
          output = await readOutput(stdoutHandle); errors = await readOutput(stderrHandle)
        } catch (cause) { failure ??= cause }
        for (const handle of [stdoutHandle, stderrHandle]) {
          try { await handle.close() } catch (cause) { failure ??= cause }
        }
        live.delete(child)
        if (failure !== undefined) { terminalFailure = failure; rejectDone(failure) }
        else resolveDone({ code: exitCode, stdout: output, stderr: errors, timedOut, durationMs: Date.now() - startedAt })
      }
      const poll = () => {
        try {
          exitCode = pollProcessExit(api, native.process) ?? null
          if (isJobEmpty(api, native.job)) void finish()
        } catch (error) { void finish(error) }
      }
      const child = { pid: native.pid, get exitCode() { return exitCode }, done,
        stdout: () => settled ? Promise.resolve(output) : readOutput(stdoutHandle), stderr: () => settled ? Promise.resolve(errors) : readOutput(stderrHandle),
        stop: async () => {
          if (!settled) {
            stopTimer ??= setTimeout(() => { void finish(new Error('candidate Job settlement was not verified; execution roots and lock are retained')) }, 20_000)
            try { terminateJob(api, native.job, 1); poll() } catch (error) { void finish(error) }
          }
          return done
        },
      }
      live.add(child)
      interval = setInterval(poll, 50)
      timer = setTimeout(() => { timedOut = true; void child.stop().catch(() => {}) }, options.timeoutMs ?? 30 * 60_000)
      return child
    }
    return {
      root: workRoot, cli, sourceCli, node, start, dispose,
      stageInput: async source => {
        const destination = join(toolsRoot, 'candidate.tgz')
        await copyFile(source, destination, 1 /* COPYFILE_EXCL */)
        return destination
      },
      copyOutput: (source, destination) => copyWindowsCandidateOutput(workRoot, source, destination),
      run: async (command, args, options) => (await start(command, args, options)).done,
      withSource: async (repo, commit, fn) => {
        const directory = await mkdtemp(join(workRoot, 'source-'))
        // A private .git belongs to the candidate account's disposable area.
        // No linked worktree file can reach the controller's Git common-dir.
        for (const argv of [['init', '--quiet'], ['fetch', '--no-tags', '--', repo, commit], ['checkout', '--quiet', '--detach', 'FETCH_HEAD']]) {
          const result = await controlRun('git', ['-c', 'core.hooksPath=NUL', '-C', directory, ...argv], {
            timeoutMs: 120_000, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_LFS_SKIP_SMUDGE: '1' },
          })
          if (result.code !== 0) throw new Error('candidate source materialization failed')
        }
        return fn(directory)
      },
    }
  } catch (error) { await dispose(); throw error }
}

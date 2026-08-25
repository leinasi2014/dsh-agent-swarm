import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootPlane, run, stopPlane, waitPortFree, waitUntil } from '../promotion/runner.mjs'
import { sha256File } from '../p0/evidence.mjs'
import { name as probeName } from './profile-probe.mjs'

function parseArgs(argv) {
  const args = { repo: process.cwd(), port: 47941 }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    const next = () => {
      index += 1
      if (argv[index] === undefined) throw new Error(`missing value for ${current}`)
      return argv[index]
    }
    if (current === '--repo') args.repo = resolve(next())
    else if (current === '--official') args.official = resolve(next())
    else if (current === '--cli') args.cli = resolve(next())
    else if (current === '--output') args.output = resolve(next())
    else if (current === '--port') args.port = Number(next())
    else throw new Error(`unknown argument ${current}`)
  }
  for (const name of ['repo', 'official', 'cli', 'output']) {
    if (args[name] === undefined) throw new Error(`--${name} is required`)
  }
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) throw new Error('--port must be an integer from 1024 through 65535')
  return args
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function yamlString(value) {
  return `'${value.replaceAll('\\', '/').replaceAll("'", "''")}'`
}

async function records(path) {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

async function tree(root) {
  const output = []
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const target = join(path, entry.name)
      if (entry.isDirectory()) await walk(target)
      else output.push(relative(root, target).replaceAll('\\', '/'))
    }
  }
  await walk(root)
  return output.sort()
}

function patchLines({ storageRoot, sessionRoot, workspaceRoot, probeUrl, artifactContract, hostContract }) {
  return [
    '# A1b isolated official Profile development smoke; all roots are disposable.',
    '- id: storage-json',
    '  config:',
    `    root: ${yamlString(storageRoot)}`,
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${yamlString(sessionRoot)}`,
    '- id: sandbox-policy',
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: ${yamlString(workspaceRoot)}`,
    '- id: agent-swarm',
    '  disabled: false',
    '- id: agent-swarm-runtime',
    '  config:',
    '    enabled: true',
    '    memberProvider: spawn',
    '    memberMaxDepth: 1',
    '    experimentalFreshV2: true',
    `    freshV2ArtifactContract: ${artifactContract}`,
    `    freshV2HostContract: ${hostContract}`,
    '- insert:',
    `    - id: ${probeName}`,
    `      name: ${yamlString(probeUrl)}`,
    '',
  ]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!inside(args.output, join(args.output, 'runtime'))) throw new Error('invalid output/runtime relationship')
  if (await stat(args.output).then(() => true, () => false)) throw new Error(`output must be fresh and absent: ${args.output}`)
  const runtimeRoot = join(args.output, 'runtime')
  const artifactRoot = join(args.output, 'artifact')
  const evidenceRoot = join(args.output, 'evidence')
  const dshHome = join(runtimeRoot, 'dsh-home')
  const workspaceRoot = join(runtimeRoot, 'workspace')
  const storageRoot = join(runtimeRoot, 'storage')
  const sessionRoot = join(runtimeRoot, 'sessions')
  const probePath = join(runtimeRoot, 'probe.jsonl')
  const statePath = join(runtimeRoot, 'identity.json')
  const probeModule = join(runtimeRoot, 'a1b-profile-probe.mjs')
  for (const path of [artifactRoot, evidenceRoot, dshHome, workspaceRoot, storageRoot, sessionRoot]) await mkdir(path, { recursive: true })
  await copyFile(join(args.repo, 'scripts', 'a1b', 'profile-probe.mjs'), probeModule)

  const commands = []
  const execute = async (name, command, commandArgs, options = {}) => {
    const result = await run(command, commandArgs, options)
    commands.push({ name, code: result.code, durationMs: result.durationMs, timedOut: result.timedOut === true })
    await writeFile(join(evidenceRoot, `${name}.log`), result.stdout + result.stderr, 'utf8')
    if (result.code !== 0) throw new Error(`${name} failed: ${(result.stderr || result.stdout).slice(0, 2000)}`)
    return result
  }

  let boot
  try {
    const build = await execute('candidate-build', 'pnpm', ['build'], { cwd: args.repo })
    if (build.code !== 0) throw new Error('candidate build failed')
    const pack = await execute('candidate-pack', 'pnpm', ['pack', '--pack-destination', artifactRoot], {
      cwd: args.repo,
      env: { npm_config_ignore_scripts: 'true' },
    })
    const packed = /dsh-agent-swarm-[^\s]+\.tgz/.exec(pack.stdout)?.[0]
    if (packed === undefined) throw new Error(`candidate pack emitted no tarball: ${pack.stdout}`)
    const tarball = join(artifactRoot, 'dsh-agent-swarm.tgz')
    await rename(join(artifactRoot, basename(packed)), tarball)
    const artifactContract = await sha256File(tarball)
    const hostContract = (await run('git', ['rev-parse', 'HEAD'], {
      cwd: args.official,
      timeoutMs: 60_000,
    })).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(hostContract)) throw new Error(`official host has no exact Git contract: ${hostContract}`)
    await execute('profile-add', process.execPath, [args.cli, 'plugin', '--profile', 'web', 'add', '-w', '--ignore-scripts', tarball], {
      cwd: workspaceRoot,
      env: { DSH_HOME: dshHome },
      timeoutMs: 10 * 60_000,
    })
    const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await writeFile(patchPath, patchLines({
      storageRoot,
      sessionRoot,
      workspaceRoot,
      probeUrl: pathToFileURL(probeModule).href,
      artifactContract,
      hostContract,
    }).join('\n'), 'utf8')
    await writeFile(join(evidenceRoot, 'profile.patch.yml'), await readFile(patchPath), 'utf8')

    const env = {
      DSH_SWARM_A1B_PROBE_PATH: probePath,
      DSH_SWARM_A1B_STATE_PATH: statePath,
      DSH_SWARM_A1B_WORKSPACE: workspaceRoot,
    }
    boot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env })
    if (!boot.ready) throw new Error(`first Profile boot failed: ${boot.stderr().slice(0, 2000)}`)
    const firstReady = await waitUntil(async () => (await records(probePath)).some(entry => entry.phase === 'first-complete'), { timeoutMs: 30_000, intervalMs: 50 })
    if (!firstReady) throw new Error(`first Profile proof did not complete: ${JSON.stringify(await records(probePath))}`)
    await writeFile(join(evidenceRoot, 'first-boot.log'), boot.stdout() + boot.stderr(), 'utf8')
    await stopPlane(boot)
    boot = undefined
    if (!await waitPortFree(args.port, 20_000)) throw new Error('first Profile port did not become free')

    boot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env })
    if (!boot.ready) throw new Error(`restart Profile boot failed: ${boot.stderr().slice(0, 2000)}`)
    const restartReady = await waitUntil(async () => (await records(probePath)).some(entry => entry.phase === 'restart-complete'), { timeoutMs: 30_000, intervalMs: 50 })
    if (!restartReady) throw new Error(`restart Profile proof did not complete: ${JSON.stringify(await records(probePath))}`)
    await writeFile(join(evidenceRoot, 'restart-boot.log'), boot.stdout() + boot.stderr(), 'utf8')
    const probeRecords = await records(probePath)
    const errors = probeRecords.filter(entry => entry.phase === 'error')
    if (errors.length > 0) throw new Error(`Profile probe recorded errors: ${JSON.stringify(errors)}`)
    const identity = JSON.parse(await readFile(statePath, 'utf8'))
    const childEntries = probeRecords.filter(entry => entry.phase === 'model-entry'
      && entry.sessionId === identity.memberSessionId)
    if (childEntries.length !== 1 || childEntries[0].attemptPhaseAtProviderEntry !== 'reserved'
      || childEntries[0].dispatchPhaseAtProviderEntry !== 'dispatch-entered') {
      throw new Error(`expected one exact fenced child model entry across both boots: ${JSON.stringify(childEntries)}`)
    }
    const storageFiles = await tree(storageRoot)
    const hasV2 = storageFiles.some(path => path.includes('agent_swarm_v2'))
    const hasV1 = storageFiles.some(path => /(^|\/)agent_swarm(\/|$)/.test(path))
    if (!hasV2 || hasV1) throw new Error(`fresh-v2 storage boundary mismatch: ${JSON.stringify(storageFiles)}`)
    const manifest = {
      schemaVersion: 1,
      claim: 'DEV_SMOKE_ONLY',
      candidate: {
        head: (await run('git', ['rev-parse', 'HEAD'], { cwd: args.repo, timeoutMs: 60_000 })).stdout.trim(),
        status: (await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: args.repo, timeoutMs: 60_000 })).stdout,
        artifactSha256: artifactContract,
      },
      official: {
        head: (await run('git', ['rev-parse', 'HEAD'], { cwd: args.official, timeoutMs: 60_000 })).stdout.trim(),
        status: (await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: args.official, timeoutMs: 60_000 })).stdout,
      },
      commands,
      storageFiles,
      probeRecords,
      result: 'PASS',
    }
    await writeFile(join(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    process.stdout.write(`A1b official Profile DEV_SMOKE PASS\n${join(evidenceRoot, 'manifest.json')}\n`)
  } finally {
    if (boot !== undefined) await stopPlane(boot).catch(() => {})
    await waitPortFree(args.port, 20_000).catch(() => false)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

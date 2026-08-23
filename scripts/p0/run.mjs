import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rpcCall } from '../promotion/lib.mjs'
import { bootPlane, run, stopPlane, waitPortFree, waitUntil } from '../promotion/runner.mjs'
import { sha256File, verifyP0Evidence } from './evidence.mjs'
import { parsePluginInventoryResponse, pluginInventoryPayload } from './inventory.mjs'
import { name as serviceProbeName } from './profile-probe.mjs'
import { name as shutdownProbeName } from './shutdown-probe.mjs'

const OFFICIAL_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const OFFICIAL_TREE = '53915efe4e2126cc7779b73dfc8a3bcec5318c44'
const OFFICIAL_VERSION = '0.1.1-rc.2'

function parseArgs(argv) {
  const args = { repo: process.cwd(), port: 47940 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (argv[index] === undefined) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--repo') args.repo = resolve(next())
    else if (argument === '--official') args.official = resolve(next())
    else if (argument === '--cli') args.cli = resolve(next())
    else if (argument === '--output') args.output = resolve(next())
    else if (argument === '--port') args.port = Number(next())
    else throw new Error(`unknown argument ${argument}`)
  }
  for (const required of ['repo', 'official', 'cli', 'output']) {
    if (args[required] === undefined) throw new Error(`--${required} is required`)
  }
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) throw new Error('--port must be an integer from 1024 to 65535')
  return args
}

function pathInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function posix(path) {
  return path.replaceAll('\\', '/')
}

function yamlString(path) {
  return `'${posix(path).replaceAll("'", "''")}'`
}

async function gitRead(repo, args) {
  return await run('git', ['--no-optional-locks', '-C', repo, ...args], { timeoutMs: 60_000 })
}

function commandLine(command, args) {
  return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' ')
}

async function readProbe(path) {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function profilePatchLines({ storageRoot, sessionRoot, workspaceRoot, shutdownProbeUrl, serviceProbeUrl, swarmEnabled }) {
  const lines = [
    '# P0 isolated official Profile proof; all roots are disposable.',
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
  ]
  if (typeof swarmEnabled === 'boolean') {
    lines.push('- id: agent-swarm', `  disabled: ${swarmEnabled ? 'false' : 'true'}`)
  }
  lines.push('- insert:', `    - id: ${shutdownProbeName}`, `      name: ${yamlString(shutdownProbeUrl)}`)
  if (serviceProbeUrl !== undefined) {
    lines.push(`    - id: ${serviceProbeName}`, `      name: ${yamlString(serviceProbeUrl)}`)
  }
  lines.push('')
  return lines
}

async function readInventory(port, evidenceDir, label) {
  const response = await rpcCall(port, 'pluginInventory/list', pluginInventoryPayload())
  const value = response.body?.result?.value
  await writeFile(join(evidenceDir, `${label}.json`), `${JSON.stringify({ response, value }, null, 2)}\n`, 'utf8')
  try {
    return parsePluginInventoryResponse(response)
  } catch (error) {
    throw new Error(`pluginInventory/list failed for ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function swarmInventoryRow(entries) {
  return entries.find(entry => entry?.moduleName === 'dsh-agent-swarm')
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  return await new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolveExit(true) })
    child.once('close', () => { clearTimeout(timer); resolveExit(true) })
  })
}

async function gracefulStop(boot, stopPath, port) {
  await writeFile(stopPath, 'stop\n', 'utf8')
  const graceful = await waitForExit(boot.child, 15_000)
  const fallback = graceful ? undefined : await stopPlane(boot)
  const portFree = await waitPortFree(port, 15_000, '127.0.0.1', { reclaim: true })
  return { graceful, exitCode: boot.child.exitCode, fallback, portFree }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outputExists = await stat(args.output).then(() => true, () => false)
  if (outputExists) throw new Error(`output must be fresh and absent: ${args.output}`)
  if (!pathInside(args.output, join(args.output, 'runtime'))) throw new Error('invalid output/runtime relationship')

  const artifactDir = join(args.output, 'artifact')
  const evidenceDir = join(args.output, 'evidence')
  const runtimeRoot = join(args.output, 'runtime')
  const dshHome = join(runtimeRoot, 'dsh-home')
  const workspaceRoot = join(runtimeRoot, 'workspace')
  const storageRoot = join(runtimeRoot, 'state', 'storage')
  const sessionRoot = join(runtimeRoot, 'state', 'sessions')
  const probePath = join(runtimeRoot, 'probe.jsonl')
  const stopPath = join(runtimeRoot, 'stop.request')
  const probeModuleRoot = join(runtimeRoot, 'P0 probe 探针')
  const shutdownProbeModule = join(probeModuleRoot, 'shutdown probe.mjs')
  const serviceProbeModule = join(probeModuleRoot, 'service probe.mjs')
  const defaultDshHome = join(homedir(), '.dsh')
  if (resolve(dshHome).toLowerCase() === resolve(defaultDshHome).toLowerCase()) throw new Error('isolated DSH_HOME equals the user default home')
  for (const path of [artifactDir, evidenceDir, dshHome, workspaceRoot, storageRoot, sessionRoot]) {
    await mkdir(path, { recursive: true })
  }
  await mkdir(probeModuleRoot, { recursive: true })
  await copyFile(join(args.repo, 'scripts', 'p0', 'shutdown-probe.mjs'), shutdownProbeModule)
  await copyFile(join(args.repo, 'scripts', 'p0', 'profile-probe.mjs'), serviceProbeModule)
  const shutdownProbeUrl = pathToFileURL(shutdownProbeModule).href
  const serviceProbeUrl = pathToFileURL(serviceProbeModule).href

  const gates = []
  const commands = []
  const gate = (name, status, detail) => gates.push({ name, status, detail })
  const execute = async (name, command, commandArgs, options = {}) => {
    const result = await run(command, commandArgs, options)
    commands.push({ name, command: commandLine(command, commandArgs), exitCode: result.code, durationMs: result.durationMs, timedOut: result.timedOut === true })
    await writeFile(join(evidenceDir, `${name}.log`), result.stdout + result.stderr, 'utf8')
    return result
  }

  let liveBoot
  let proofError
  let manifest
  try {
    const candidateCommit = await gitRead(args.repo, ['rev-parse', 'HEAD'])
    const candidateTree = await gitRead(args.repo, ['rev-parse', 'HEAD^{tree}'])
    const candidateStatusBefore = await gitRead(args.repo, ['status', '--porcelain', '--untracked-files=all'])
    const officialCommitBefore = await gitRead(args.official, ['rev-parse', 'HEAD'])
    const officialTreeBefore = await gitRead(args.official, ['rev-parse', 'HEAD^{tree}'])
    const officialStatusBefore = await gitRead(args.official, ['status', '--porcelain', '--untracked-files=all'])
    const candidateCleanBefore = candidateStatusBefore.code === 0 && candidateStatusBefore.stdout === ''
    const officialBaselineOk = officialCommitBefore.stdout.trim() === OFFICIAL_COMMIT
      && officialTreeBefore.stdout.trim() === OFFICIAL_TREE && officialStatusBefore.stdout === ''
    if (!candidateCleanBefore) throw new Error(`candidate checkout is not clean: ${candidateStatusBefore.stdout}`)
    if (!officialBaselineOk) throw new Error('official checkout identity/cleanliness does not match the P0 baseline')
    gate('candidate-clean', 'pass', `${candidateCommit.stdout.trim()} / ${candidateTree.stdout.trim()}`)

    const version = await execute('cli-version', process.execPath, [args.cli, '--version'], { cwd: workspaceRoot })
    if (version.code !== 0 || version.stdout.trim() !== OFFICIAL_VERSION) throw new Error(`official CLI version mismatch: ${version.stdout || version.stderr}`)

    const build = await execute('candidate-build', 'pnpm', ['build'], { cwd: args.repo })
    if (build.code !== 0) throw new Error('candidate build failed')
    const pack = await execute('candidate-pack', 'pnpm', ['pack', '--pack-destination', artifactDir], {
      cwd: args.repo,
      env: { npm_config_ignore_scripts: 'true' },
    })
    if (pack.code !== 0) throw new Error('candidate pack failed')
    const packedName = /dsh-agent-swarm-[^\s]+\.tgz/.exec(pack.stdout)?.[0]
    if (packedName === undefined) throw new Error(`pnpm pack emitted no tarball name: ${pack.stdout}`)
    const tarball = join(artifactDir, 'dsh-agent-swarm.tgz')
    await rename(join(artifactDir, basename(packedName)), tarball)
    const artifactSha256 = await sha256File(tarball)
    const artifactStat = await stat(tarball)
    // Run from the artifact directory with a basename: both Windows bsdtar
    // and GNU tar accept this form, and no drive-letter colon needs special
    // parsing (`--force-local` is GNU-only and fails on the official host).
    const listing = await execute('artifact-list', 'tar', ['-tzf', basename(tarball)], { cwd: artifactDir })
    if (listing.code !== 0 || !listing.stdout.includes('package/lib/index.mjs') || !listing.stdout.includes('package/cordis.patch.yml')) {
      throw new Error('packed artifact is missing the runtime entry or Bundle patch')
    }
    gate('artifact-packed', 'pass', `sha256=${artifactSha256} bytes=${artifactStat.size}`)

    const addArgs = [args.cli, 'plugin', '--profile', 'web', 'add', '-w', '--ignore-scripts', tarball]
    const add = await execute('profile-add', process.execPath, addArgs, { cwd: workspaceRoot, env: { DSH_HOME: dshHome }, timeoutMs: 10 * 60_000 })
    if (add.code !== 0) throw new Error('official plugin add failed')
    const profilePatch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await writeFile(profilePatch, profilePatchLines({
      storageRoot, sessionRoot, workspaceRoot, shutdownProbeUrl,
    }).join('\n'), 'utf8')
    await writeFile(join(evidenceDir, 'profile-package-installed.json'), await readFile(join(dshHome, 'profiles', 'web', 'package.json')), 'utf8')
    await writeFile(join(evidenceDir, 'profile-cordis-default-disabled.patch.yml'), await readFile(profilePatch), 'utf8')
    gate('profile-add', 'pass', 'official plugin forwarder installed the immutable tarball into fresh web Profile')

    const dump = await execute('dump-config', process.execPath, [args.cli, '--profile', 'web', '--dump-config'], {
      cwd: workspaceRoot, env: { DSH_HOME: dshHome },
    })
    const dumpOk = dump.code === 0 && dump.stdout.includes('dsh-agent-swarm')
      && dump.stdout.includes('cordis:group') && dump.stdout.includes('disabled: true')
      && dump.stdout.includes(posix(storageRoot)) && dump.stdout.includes(posix(sessionRoot))
      && dump.stdout.includes(posix(workspaceRoot)) && dump.stdout.includes('agent-swarm-p0-shutdown-probe')
    if (!dumpOk) throw new Error('dump-config did not prove the default-disabled Swarm layer and isolated roots')
    gate('dump-config', 'pass', 'default-disabled structural group + isolated roots + shutdown probe composed')

    const bootEnv = { DSH_SWARM_P0_PROBE_PATH: probePath, DSH_SWARM_P0_STOP_PATH: stopPath }
    await rm(stopPath, { force: true })
    liveBoot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env: bootEnv })
    if (!liveBoot.ready) throw new Error(`web Profile did not boot: ${liveBoot.stderr().slice(0, 2000)}`)
    const defaultEntries = await readInventory(args.port, evidenceDir, 'inventory-default-disabled')
    const defaultRow = swarmInventoryRow(defaultEntries)
    if (defaultRow?.enabled !== false || defaultRow?.fiberPhase !== null) {
      throw new Error(`installed Swarm was not inert by default: ${JSON.stringify(defaultRow)}`)
    }
    gate('default-disabled', 'pass', `entry=${defaultRow.entryId}; enabled=false; fiberPhase=null`)
    const defaultStop = await gracefulStop(liveBoot, stopPath, args.port)
    liveBoot = undefined
    if (!defaultStop.graceful || !defaultStop.portFree) throw new Error(`default-disabled shutdown failed: ${JSON.stringify(defaultStop)}`)

    await writeFile(profilePatch, profilePatchLines({
      storageRoot, sessionRoot, workspaceRoot, shutdownProbeUrl, serviceProbeUrl, swarmEnabled: true,
    }).join('\n'), 'utf8')
    await writeFile(join(evidenceDir, 'profile-cordis-explicit-enabled.patch.yml'), await readFile(profilePatch), 'utf8')
    await rm(stopPath, { force: true })
    liveBoot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env: bootEnv })
    if (!liveBoot.ready) throw new Error(`explicitly enabled web Profile did not boot: ${liveBoot.stderr().slice(0, 2000)}`)
    const activeEntries = await readInventory(args.port, evidenceDir, 'inventory-explicit-enabled')
    const activeRow = swarmInventoryRow(activeEntries)
    if (activeRow?.enabled !== true || activeRow?.fiberPhase !== 'active') {
      throw new Error(`explicitly enabled Swarm was not active: ${JSON.stringify(activeRow)}`)
    }
    gate('boot-load', 'pass', `entry=${activeRow.entryId}; enabled=true; fiberPhase=active`)
    const probeReady = await waitUntil(async () => (await readProbe(probePath)).some(entry => entry.phase === 'active'), { timeoutMs: 10_000 })
    if (!probeReady) throw new Error('service/tool probe did not activate')
    const firstActive = (await readProbe(probePath)).find(entry => entry.phase === 'active')
    const servicesOk = Object.values(firstActive?.services ?? {}).every(value => value === true)
    const toolsOk = Array.isArray(firstActive?.tools) && firstActive.tools.length === 17
      && ['agent_swarm_create', 'agent_swarm_status', 'agent_swarm_send_message', 'agent_swarm_list_tasks'].every(name => firstActive.tools.includes(name))
    if (!servicesOk || !toolsOk) throw new Error(`service/tool probe mismatch: ${JSON.stringify(firstActive)}`)
    gate('service-tool-probe', 'pass', `${firstActive.tools.length} agent_swarm tools and required services active`)
    const firstStop = await gracefulStop(liveBoot, stopPath, args.port)
    liveBoot = undefined
    const firstUnloaded = await waitUntil(async () => (await readProbe(probePath)).filter(entry => entry.phase === 'unloaded').length >= 1, { timeoutMs: 5_000 })
    if (!firstStop.graceful || !firstStop.portFree || !firstUnloaded) throw new Error(`graceful unload failed: ${JSON.stringify(firstStop)}`)
    gate('unload', 'pass', 'official SIGTERM shutdown disposed the probe and released the port')

    await rm(stopPath, { force: true })
    liveBoot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env: bootEnv })
    if (!liveBoot.ready) throw new Error(`reload boot failed: ${liveBoot.stderr().slice(0, 2000)}`)
    const reloadEntries = await readInventory(args.port, evidenceDir, 'inventory-reload-enabled')
    const reloadRow = swarmInventoryRow(reloadEntries)
    if (reloadRow?.enabled !== true || reloadRow?.fiberPhase !== 'active') throw new Error(`reload inventory mismatch: ${JSON.stringify(reloadRow)}`)
    const secondActive = await waitUntil(async () => (await readProbe(probePath)).filter(entry => entry.phase === 'active').length >= 2, { timeoutMs: 10_000 })
    const secondStop = await gracefulStop(liveBoot, stopPath, args.port)
    liveBoot = undefined
    const secondUnloaded = await waitUntil(async () => (await readProbe(probePath)).filter(entry => entry.phase === 'unloaded').length >= 2, { timeoutMs: 5_000 })
    if (!secondActive || !secondStop.graceful || !secondStop.portFree || !secondUnloaded) throw new Error('reload/dispose proof failed')
    gate('reload', 'pass', 'second boot activated the same artifact and second graceful unload completed')

    await writeFile(profilePatch, profilePatchLines({
      storageRoot, sessionRoot, workspaceRoot, shutdownProbeUrl, swarmEnabled: false,
    }).join('\n'), 'utf8')
    await writeFile(join(evidenceDir, 'profile-cordis-r0-disabled.patch.yml'), await readFile(profilePatch), 'utf8')
    await rm(stopPath, { force: true })
    liveBoot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env: bootEnv })
    if (!liveBoot.ready) throw new Error(`R0-disabled web Profile did not boot: ${liveBoot.stderr().slice(0, 2000)}`)
    const disabledEntries = await readInventory(args.port, evidenceDir, 'inventory-r0-disabled')
    const disabledRow = swarmInventoryRow(disabledEntries)
    if (disabledRow?.enabled !== false || disabledRow?.fiberPhase !== null) throw new Error(`R0 inventory mismatch: ${JSON.stringify(disabledRow)}`)
    const disabledStop = await gracefulStop(liveBoot, stopPath, args.port)
    liveBoot = undefined
    if (!disabledStop.graceful || !disabledStop.portFree) throw new Error(`R0 shutdown failed: ${JSON.stringify(disabledStop)}`)
    gate('r0-disable', 'pass', `entry=${disabledRow.entryId}; enabled=false; fiberPhase=null after restart`)

    await writeFile(profilePatch, profilePatchLines({
      storageRoot, sessionRoot, workspaceRoot, shutdownProbeUrl,
    }).join('\n'), 'utf8')
    await writeFile(join(evidenceDir, 'profile-cordis-plugin-removed.patch.yml'), await readFile(profilePatch), 'utf8')
    const remove = await execute('profile-remove', process.execPath, [args.cli, 'plugin', '--profile', 'web', 'remove', 'dsh-agent-swarm'], {
      cwd: workspaceRoot, env: { DSH_HOME: dshHome }, timeoutMs: 10 * 60_000,
    })
    if (remove.code !== 0) throw new Error('official plugin remove failed')
    await writeFile(join(evidenceDir, 'profile-package-removed.json'), await readFile(join(dshHome, 'profiles', 'web', 'package.json')), 'utf8')
    await rm(stopPath, { force: true })
    liveBoot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env: bootEnv })
    if (!liveBoot.ready) throw new Error(`post-remove web Profile did not boot: ${liveBoot.stderr().slice(0, 2000)}`)
    const removedEntries = await readInventory(args.port, evidenceDir, 'inventory-plugin-removed')
    const removedRow = swarmInventoryRow(removedEntries)
    if (removedRow !== undefined) throw new Error(`removed Swarm remained in inventory: ${JSON.stringify(removedRow)}`)
    const removedStop = await gracefulStop(liveBoot, stopPath, args.port)
    liveBoot = undefined
    if (!removedStop.graceful || !removedStop.portFree) throw new Error(`post-remove shutdown failed: ${JSON.stringify(removedStop)}`)
    gate('plugin-remove', 'pass', 'package removed; no dsh-agent-swarm inventory row after restart')

    const failProfile = 'p0-missing-storage'
    const failAdd = await execute('missing-storage-add', process.execPath, [args.cli, 'plugin', '--profile', failProfile, 'add', '-w', '--ignore-scripts', tarball], {
      cwd: workspaceRoot, env: { DSH_HOME: dshHome }, timeoutMs: 10 * 60_000,
    })
    if (failAdd.code !== 0) throw new Error('failed to assemble missing-storage negative Profile')
    const failPatch = join(dshHome, 'profiles', failProfile, 'cordis.patch.yml')
    await writeFile(failPatch, ['- id: agent-swarm', '  disabled: false', ''].join('\n'), 'utf8')
    await writeFile(join(evidenceDir, 'missing-storage-explicit-enabled.patch.yml'), await readFile(failPatch), 'utf8')
    const failBoot = await execute('missing-storage-boot', process.execPath, [args.cli, '--profile', failProfile], {
      cwd: workspaceRoot, env: { DSH_HOME: dshHome }, timeoutMs: 120_000,
    })
    const failOutput = failBoot.stdout + failBoot.stderr
    if (failBoot.code === 0 || !failOutput.includes('dsh-agent-swarm: pending') || !failOutput.includes('storageDomain')) {
      throw new Error(`missing-storage Profile did not fail closed: ${failOutput.slice(0, 2000)}`)
    }
    gate('missing-storage-fail-closed', 'pass', `exit=${failBoot.code}; pending on storageDomain`)

    await writeFile(join(evidenceDir, 'profile-probe.jsonl'), await readFile(probePath), 'utf8')

    const officialCommitAfter = await gitRead(args.official, ['rev-parse', 'HEAD'])
    const officialTreeAfter = await gitRead(args.official, ['rev-parse', 'HEAD^{tree}'])
    const officialStatusAfter = await gitRead(args.official, ['status', '--porcelain', '--untracked-files=all'])
    const officialClean = officialCommitAfter.stdout.trim() === OFFICIAL_COMMIT
      && officialTreeAfter.stdout.trim() === OFFICIAL_TREE && officialStatusAfter.stdout === ''
    if (!officialClean) throw new Error('official checkout changed during P0 proof')
    gate('official-clean', 'pass', `${OFFICIAL_COMMIT} / ${OFFICIAL_TREE}`)

    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    const runtimeRemoved = !(await stat(runtimeRoot).then(() => true, () => false))
    const portFree = await waitPortFree(args.port, 15_000, '127.0.0.1', { reclaim: true })
    if (!runtimeRemoved || !portFree) throw new Error('P0 runtime cleanup did not converge')
    gate('resource-cleanup', 'pass', 'runtime roots removed; artifact/evidence retained; port free')

    const candidateStatusAfter = await gitRead(args.repo, ['status', '--porcelain', '--untracked-files=all'])
    if (candidateStatusAfter.stdout !== '') throw new Error(`candidate became dirty during proof: ${candidateStatusAfter.stdout}`)
    manifest = {
      schemaVersion: 1,
      status: 'pass',
      createdAt: new Date().toISOString(),
      candidate: {
        commit: candidateCommit.stdout.trim(), tree: candidateTree.stdout.trim(),
        cleanBefore: candidateCleanBefore, cleanAfter: true,
      },
      artifact: { relativePath: 'artifact/dsh-agent-swarm.tgz', sha256: artifactSha256, bytes: artifactStat.size },
      official: {
        root: args.official, cli: args.cli, version: version.stdout.trim(),
        commitBefore: officialCommitBefore.stdout.trim(), treeBefore: officialTreeBefore.stdout.trim(), statusBefore: officialStatusBefore.stdout,
        commitAfter: officialCommitAfter.stdout.trim(), treeAfter: officialTreeAfter.stdout.trim(), statusAfter: officialStatusAfter.stdout,
      },
      isolation: {
        runtimeRoot, dshHome, workspaceRoot, sandboxRoot: workspaceRoot, storageRoot, sessionRoot,
        probeModuleRoot, probeModuleUrls: [shutdownProbeUrl, serviceProbeUrl],
        defaultDshHome, ambientDshHomeConfigured: typeof process.env.DSH_HOME === 'string',
      },
      commands,
      gates,
      cleanup: { runtimeRemoved, portFree, artifactRetained: true, evidenceRetained: true },
    }
    await writeFile(join(evidenceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const verified = await verifyP0Evidence(args.output, manifest)
    if (!verified.ok) throw new Error(`P0 evidence gate failed: ${verified.failures.join('; ')}`)
  } catch (error) {
    proofError = error
  } finally {
    if (liveBoot !== undefined) await stopPlane(liveBoot).catch(() => undefined)
    if (await stat(runtimeRoot).then(() => true, () => false)) {
      await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
    }
  }
  if (proofError !== undefined) throw proofError
  console.log(JSON.stringify({
    p0: 'pass', candidate: manifest.candidate, artifact: manifest.artifact,
    official: { commit: manifest.official.commitAfter, tree: manifest.official.treeAfter, version: manifest.official.version },
    output: args.output, cleanup: manifest.cleanup,
  }, null, 2))
}

main().catch(error => {
  console.error(`P0 profile proof failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})

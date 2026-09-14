import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-package-install-'))

function pnpmCli() {
  const pathEntries = (process.env.PNPM_HOME === undefined ? [] : [process.env.PNPM_HOME])
    .concat((process.env.Path ?? process.env.PATH ?? '').split(delimiter))
  for (const entry of pathEntries) {
    for (const candidate of [
      join(entry, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(entry, '..', 'pnpm', 'bin', 'pnpm.cjs'),
    ]) if (existsSync(candidate)) return candidate
  }
  throw new Error('pnpm CLI cannot be resolved from PNPM_HOME or PATH')
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const executable = command === 'pnpm' ? process.execPath : command
    const commandArgs = command === 'pnpm' ? [pnpmCli(), ...args] : args
    const child = spawn(executable, commandArgs, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolveRun({ code, stdout, stderr }))
  })
}

async function writeConsumer(directory, name, deps = {}) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, private: true, version: '0.0.0', dependencies: deps }, null, 2) + '\n')
}

async function hasInstalledPackage(directory) {
  try {
    await access(join(directory, 'node_modules', 'dsh-agent-swarm', 'package.json'))
    return true
  } catch {
    return false
  }
}

async function optionalBytes(path) {
  try {
    return { exists: true, bytes: await readFile(path) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, bytes: null }
    throw error
  }
}

async function directoryState(root) {
  const entries = []
  async function visit(directory, relative) {
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' && relative === '') return false
      throw error
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative === '' ? child.name : `${relative}/${child.name}`
      const kind = child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file'
      entries.push(`${kind}:${childRelative}`)
      if (child.isDirectory()) await visit(join(directory, child.name), childRelative)
    }
    return true
  }
  return { exists: await visit(root, ''), entries }
}

async function failedInstallSnapshot(directory) {
  return {
    packageJson: await optionalBytes(join(directory, 'package.json')),
    lockfile: await optionalBytes(join(directory, 'pnpm-lock.yaml')),
    nodeModules: await directoryState(join(directory, 'node_modules')),
  }
}

function sameOptionalBytes(left, right) {
  return left.exists === right.exists && (left.bytes === null || right.bytes === null || left.bytes.equals(right.bytes))
}

function sameFailedInstallSnapshot(left, right) {
  return sameOptionalBytes(left.packageJson, right.packageJson)
    && sameOptionalBytes(left.lockfile, right.lockfile)
    && left.nodeModules.exists === right.nodeModules.exists
    && JSON.stringify(left.nodeModules.entries) === JSON.stringify(right.nodeModules.entries)
}

// The install-face probe runs as REAL consumer code: every import below is
// resolved from the consumer's own installed graph (the tarball plus the
// pinned official peers the consumer declares) — never from a development
// workspace. No model route is configured for Skills: every claim is
// zero-model (the probe adapter records every model request and asserts the
// skills chain never makes one).
const SKILLS_INSTALL_PROBE = `
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionService from '@deepseek-ai/dsh-session-projection'
import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Swarm from 'dsh-agent-swarm'
import * as Skills from 'dsh-agent-swarm/skills'

const signal = new AbortController().signal
let failure = null
const fail = message => { throw new Error(message) }

class ProbeAdapter extends LlmAdapter {
  requests = []
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async * stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Install probe bootstrap turn settled.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Install probe bootstrap turn settled.' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-skills-probe-'))
const ctx = new Context()
const fibers = []
const adapter = new ProbeAdapter()
try {
  if (typeof Swarm.apply !== 'function' || Swarm.name !== 'agent-swarm') fail('main entry plugin face drifted')
  if (typeof Skills.apply !== 'function' || Skills.name !== 'skills-management') fail('skills entry plugin face drifted')
  if (!Array.isArray(Skills.inject) || !Skills.inject.includes('agentSwarm')) fail('skills entry inject roster drifted')
  if (typeof Skills.Config?.parse !== 'function') fail('skills entry Config face drifted')

  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SystemPrompt, {}))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions', 'sessions.db'), compression: 'none' }))
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(sandbox, 'storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  await ctx.plugin(SessionProjectionService)
  await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  ctx.llm.registerAdapter(['install-probe'], adapter)
  fibers.push(await ctx.plugin(Swarm, {
    memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs: 0,
    captainLlmProvider: 'install-probe', captainModel: 'probe-model',
  }))

  const root = await ctx.agentLoop.create(SessionId('install-probe-root'), { provider: 'install-probe', model: 'probe-model' }, { cwd: join(sandbox, 'workspace') })
  root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Install-face probe bootstrap turn — settle one real turn.' }] }))
  await root.whenIdle()
  const created = await ctx.tools.execute({ signal, callId: ToolCallId('probe-team-create'), name: 'agent_swarm_create', arguments: { name: 'Skills install probe', description: 'Install-face vertical.' }, agent: root })
  if (created?.isError) fail('agent_swarm_create failed through the installed main entry: ' + JSON.stringify(created.error))
  const teamId = created.value.team_id
  const scope = ctx.agentSwarm.scopeOf(root)

  // Single official class across entries: the skills entry's half-route
  // config must throw the MAIN entry's EXACT TeamDomainError constructor.
  let thrown
  try {
    const bad = await ctx.plugin(Skills, { manager: { provider: 'half-route-only' } })
    await bad.dispose()
  } catch (error) { thrown = error }
  if (thrown === undefined || thrown.constructor !== Swarm.TeamDomainError) {
    fail('skills config failure is not the exact main-entry TeamDomainError class (duplicated class/symbol?): ' + String(thrown))
  }

  // Mount the real (routeless) Skills face: request AND status answer an
  // explicit unavailable — the packaged face is verifiable with ZERO model
  // turns, never a pretended model acceptance.
  const skillsFiber = await ctx.plugin(Skills, { management: [{ scope, teamId }] })
  fibers.push(skillsFiber)
  const request = await ctx.tools.execute({ signal, callId: ToolCallId('probe-request'), name: 'agent_swarm_skills_request', arguments: { request_id: 'install-probe-request', revision: 1, question: 'Does the installed skills face answer honestly with no manager route?' }, agent: root })
  if (request?.isError) fail('skills request face failed through the installed package: ' + JSON.stringify(request.error))
  if (request.value.received !== true || request.value.state !== 'unavailable') fail('routeless skills request must be durably unavailable, got: ' + JSON.stringify(request.value))
  const status = await ctx.tools.execute({ signal, callId: ToolCallId('probe-status'), name: 'agent_swarm_skills_status', arguments: { request_id: 'install-probe-request' }, agent: root })
  if (status?.isError) fail('skills status face failed through the installed package: ' + JSON.stringify(status.error))
  if (status.value.state !== 'unavailable') fail('skills status must report the durable unavailable, got: ' + JSON.stringify(status.value))
  if (status.value.reason !== 'manager-model-not-configured') fail('the routeless unavailable reason must be exactly manager-model-not-configured, got: ' + JSON.stringify(status.value.reason))

  // Unload ONLY Skills: BOTH its service and tool faces are released, while
  // the main agentSwarm runtime and the business Captain Agent provably
  // survive. The tool face must surface the OFFICIAL unknown-tool refusal,
  // never "any error counts as released".
  if (ctx.get('agentSwarmSkills') === undefined) fail('skills service face is missing BEFORE the unload')
  await skillsFiber.dispose()
  fibers.pop()
  if (ctx.get('agentSwarmSkills') !== undefined) fail('the skills service survived the unload')
  let refusal = ''
  try {
    const survived = await ctx.tools.execute({ signal, callId: ToolCallId('probe-status-after-unload'), name: 'agent_swarm_skills_status', arguments: { request_id: 'install-probe-request' }, agent: root })
    if (survived?.isError) refusal = [survived.error?.code, survived.error?.message].filter(Boolean).join(' ')
    else fail('skills tool face survived the unload: ' + JSON.stringify(survived?.value))
  } catch (error) {
    refusal = [error?.code, error?.name, error?.message].filter(Boolean).join(' ')
  }
  // The refusal must be the OFFICIAL unknown-tool surface for THIS tool:
  // either the literal UNKNOWN_TOOL code or the official "unknown tool"
  // wording (the installed runtime emits: unknown tool "agent_swarm_skills_status"),
  // AND it must name agent_swarm_skills_status. Any other error — for
  // example a surviving tool refusing with ADMISSION_CLOSED — fails here.
  if (!(refusal.includes('UNKNOWN_TOOL') || /unknown tool/i.test(refusal)) || !refusal.includes('agent_swarm_skills_status')) {
    fail('skills tool release must surface the official unknown-tool refusal naming agent_swarm_skills_status, got: ' + refusal)
  }
  const surviving = await ctx.agentSwarm.listTeamAggregates(scope)
  if (surviving.length !== 1 || surviving[0].id !== teamId) fail('main agentSwarm runtime did not survive the skills unload')
  if (ctx.agents.get(root.id) === undefined) fail('business Captain Agent did not survive the skills unload')
  if (adapter.requests.length !== 1) fail('skills chain pretended model work: expected exactly the bootstrap turn, got ' + adapter.requests.length)

  console.log('Installed dsh-agent-swarm + dsh-agent-swarm/skills same-Context mount, routeless unavailable, unload survival, and single-class identity: PASS')
} catch (error) {
  failure = error
} finally {
  for (const fiber of fibers.toReversed()) { try { await fiber.dispose() } catch { /* teardown noise never masks the verdict */ } }
  await rm(sandbox, { recursive: true, force: true })
}
if (failure !== null) {
  console.error('INSTALL PROBE FAIL: ' + (failure.stack ?? String(failure)))
  process.exitCode = 1
}
`

try {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (packageJson.scripts?.postinstall !== undefined) {
    throw new Error('published package must not declare a postinstall script')
  }
  if (packageJson.scripts?.['hooks:install'] !== 'lefthook install') {
    throw new Error('development hook installation must remain explicit via hooks:install')
  }

  const artifactDir = join(scratch, 'artifact')
  const consumerDir = join(scratch, 'consumer')
  const failedConsumerDir = join(scratch, 'failed-consumer')
  // The consumer project declares the SAME pinned official peer graph a real
  // Host consumer would: the skills probe below must resolve EVERYTHING from
  // THIS installed graph only — never from the development workspace.
  const consumerDeps = {}
  for (const [dep, version] of Object.entries(packageJson.peerDependencies ?? {})) {
    if (packageJson.peerDependenciesMeta?.[dep]?.optional === true
      && dep !== '@deepseek-ai/dsh-session-persistence-jsonl' && dep !== '@deepseek-ai/dsh-session-query-sqlite') continue
    consumerDeps[dep] = version
  }
  // The probe's additional official imports are NOT peers of the package;
  // pnpm strict installs never expose transitive deps at the consumer root,
  // so the consumer declares EXACTLY these five, pinned to the repository's
  // own development pins (no lane manifest changes, no workspace reuse).
  for (const dep of ['@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-subagent-spawn-in-process']) {
    const pinned = packageJson.devDependencies?.[dep]
    if (typeof pinned !== 'string') throw new Error(`probe official dependency ${dep} has no exact development pin to reuse`)
    consumerDeps[dep] ??= pinned
  }
  await Promise.all([
    writeConsumer(consumerDir, 'dsh-agent-swarm-package-install-consumer', consumerDeps),
    writeConsumer(failedConsumerDir, 'dsh-agent-swarm-package-install-failed-consumer'),
  ])

  const packed = await run('pnpm', ['pack', '--pack-destination', artifactDir], root)
  if (packed.code !== 0) throw new Error(`pnpm pack failed (exit ${packed.code}): ${packed.stdout}${packed.stderr}`)
  const packedName = /dsh-agent-swarm-[^\s]+\.tgz/.exec(packed.stdout)?.[0]
  if (packedName === undefined) throw new Error(`pnpm pack emitted no dsh-agent-swarm tarball: ${packed.stdout}`)
  const tarball = join(artifactDir, basename(packedName))

  // Deliberately omit --ignore-scripts: this is the consumer lifecycle contract.
  const installed = await run('pnpm', ['add', tarball], consumerDir)
  const installOutput = installed.stdout + installed.stderr
  if (installed.code !== 0) throw new Error(`normal tarball install failed (exit ${installed.code}): ${installOutput}`)
  if (/lefthook|ELIFECYCLE/i.test(installOutput)) {
    throw new Error(`normal tarball install reported forbidden lifecycle output: ${installOutput}`)
  }
  const consumerPackage = JSON.parse(await readFile(join(consumerDir, 'package.json'), 'utf8'))
  if (consumerPackage.dependencies?.['dsh-agent-swarm'] === undefined || !await hasInstalledPackage(consumerDir)) {
    throw new Error('normal tarball install did not materialize its dependency registration')
  }
  const installedManifest = JSON.parse(await readFile(join(consumerDir, 'node_modules', 'dsh-agent-swarm', 'package.json'), 'utf8'))
  if (installedManifest.scripts?.postinstall !== undefined) {
    throw new Error('installed tarball retained a production postinstall script')
  }

  // S1 ./skills install contract, RED face: REAL consumer code inside the
  // installed directory must import the MAIN entry first (its official
  // graph resolves from THIS consumer's own install), and only then attempt
  // the ./skills subpath. While the package face lacks that export, the
  // second import fails with ERR_PACKAGE_PATH_NOT_EXPORTED — the genuine
  // installed-face RED, never a keyword scan or a source-tree import.
  const importCheck = await run(process.execPath, ['--input-type=module', '--eval',
    "await import('dsh-agent-swarm'); console.log('INSTALLED_MAIN_IMPORT_OK'); await import('dsh-agent-swarm/skills')"], consumerDir)
  if (importCheck.code !== 0) {
    throw new Error(`installed package must import BOTH public entries from the real install directory (exit ${importCheck.code}):\nstdout: ${importCheck.stdout}\nstderr: ${importCheck.stderr}`)
  }
  if (!importCheck.stdout.includes('INSTALLED_MAIN_IMPORT_OK')) {
    throw new Error(`main entry import did not settle before the skills attempt: ${importCheck.stdout}`)
  }

  // GREEN face: REAL consumer code inside the installed directory mounts
  // BOTH public entries in ONE official Context composed entirely from THIS
  // consumer's installed graph, runs a real Captain request/status with NO
  // manager route (explicit `unavailable` — zero model turns are pretended),
  // proves the Skills plugin throws the MAIN entry's exact TeamDomainError
  // class (single-class build graph), and proves unloading Skills releases
  // its tool/service face while the main agentSwarm runtime and the business
  // Captain Agent survive.
  await writeFile(join(consumerDir, 'skills-install-probe.mjs'), SKILLS_INSTALL_PROBE, 'utf8')
  const probe = await run(process.execPath, ['skills-install-probe.mjs'], consumerDir)
  process.stdout.write(probe.stdout)
  process.stderr.write(probe.stderr)
  if (probe.code !== 0) throw new Error(`installed-package skills mount/unload probe failed (exit ${probe.code})`)

  // A corrupt tarball must fail without changing any consumer authority or
  // creating any node_modules residue in an otherwise fresh consumer project.
  const corruptTarball = join(scratch, 'corrupt-dsh-agent-swarm.tgz')
  await writeFile(corruptTarball, 'not a tarball\n', 'utf8')
  const beforeFailure = await failedInstallSnapshot(failedConsumerDir)
  const failed = await run('pnpm', ['add', corruptTarball], failedConsumerDir)
  if (failed.code === 0) throw new Error('corrupt tarball unexpectedly installed')
  const afterFailure = await failedInstallSnapshot(failedConsumerDir)
  if (!sameFailedInstallSnapshot(beforeFailure, afterFailure)) {
    throw new Error('failed tarball install changed package.json, lockfile, or node_modules state')
  }

  console.log(`Package tarball normal install and failed-install rollback: PASS (${packedName})`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

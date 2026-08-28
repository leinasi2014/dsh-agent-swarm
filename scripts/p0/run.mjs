import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rpcCall } from '../promotion/lib.mjs'
import { bootPlane, run, stopPlane, waitPortFree, waitUntil } from '../promotion/runner.mjs'
import {
  EXPECTED_P0_OFFICIAL_COMMIT as OFFICIAL_COMMIT,
  EXPECTED_P0_OFFICIAL_TREE as OFFICIAL_TREE,
  REQUIRED_P0_EVIDENCE_FILES, sha256File, verifyP0Evidence,
} from './evidence.mjs'
import { parsePluginInventoryResponse, pluginInventoryPayload } from './inventory.mjs'
import { name as serviceProbeName } from './profile-probe.mjs'
import { name as shutdownProbeName } from './shutdown-probe.mjs'
import { exactP0SwarmToolSurface } from './tool-surface.mjs'
import {
  runR3ActiveBrowserProof, runR3R0BrowserProof, runR3RemovedBrowserProof,
} from '../r3/browser-proof.mjs'

const OFFICIAL_VERSION = '0.1.1-rc.2'
// The boot plane is "ready" as soon as the official Host answers
// /api/host.describe, but the inserted P0 probe service publishes its
// 'active' row only after every injected dependency service is ready — the
// slowest segment of a cold Profile activation under load. Give the
// probe-activation wait a budget comparable to boot readiness rather than a
// fixed tight 10s, and surface the observed probe tail on timeout so a
// recurrence is diagnosable, not silent.
const PROBE_ACTIVATION_TIMEOUT_MS = 60_000

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
    else if (argument === '--browser-executable') args.browserExecutable = resolve(next())
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

export function assertP0ProfileModelRoute(lines) {
  const modelIndex = lines.indexOf('- id: agent-default-model')
  if (modelIndex < 0 || lines[modelIndex + 1] !== '  config:'
    || lines[modelIndex + 2] !== '    provider: dev-smoke'
    || lines[modelIndex + 3] !== '    model: DEV_SMOKE') {
    throw new Error('P0 Profile must configure the official agent-default-model DEV_SMOKE route for deployment:persona')
  }
}

export function profilePatchLines({ storageRoot, sessionRoot, workspaceRoot, shutdownProbeUrl, serviceProbeUrl, swarmEnabled }) {
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
    '- id: agent-default-model',
    '  config:',
    '    provider: dev-smoke',
    '    model: DEV_SMOKE',
  ]
  if (typeof swarmEnabled === 'boolean') {
    lines.push('- id: agent-swarm', `  disabled: ${swarmEnabled ? 'false' : 'true'}`)
  }
  lines.push('- insert:', `    - id: ${shutdownProbeName}`, `      name: ${yamlString(shutdownProbeUrl)}`)
  if (serviceProbeUrl !== undefined) {
    lines.push(`    - id: ${serviceProbeName}`, `      name: ${yamlString(serviceProbeUrl)}`)
  }
  lines.push('')
  assertP0ProfileModelRoute(lines)
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

async function readSwarmRpc(port, evidenceDir, label, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/swarm/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const value = await response.json()
  await writeFile(join(evidenceDir, `${label}.json`), `${JSON.stringify({ status: response.status, value }, null, 2)}\n`, 'utf8')
  return { status: response.status, value }
}

async function readDisabledSwarmRoute(port) {
  const response = await fetch(`http://127.0.0.1:${port}/swarm/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, method: 'capabilities' }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.text()
  const observed = {
    status: response.status,
    bodyBytes: Buffer.byteLength(body, 'utf8'),
    contentType: response.headers.get('content-type'),
  }
  if (observed.status !== 405 || observed.bodyBytes !== 0 || observed.contentType !== null) {
    throw new Error(`R0-disabled /swarm/v1 did not match the exact official Host fallback: ${JSON.stringify(observed)}`)
  }
  return {
    routeObserved: observed,
    routeOwner: 'official-host-fallback',
    swarmRouteRegistered: false,
  }
}

function requireSwarmValue(response, label) {
  if (response.status !== 200 || response.value?.ok !== true || response.value?.schemaVersion !== 1) {
    throw new Error(`${label} did not return a versioned success: ${JSON.stringify(response)}`)
  }
  return response.value.value
}

function assertReadBinding(value, rootSessionId, teamId, label) {
  if (value?.binding?.rootSessionId !== rootSessionId || value?.binding?.teamId !== teamId
    || value?.team?.id !== teamId || !Number.isSafeInteger(value?.team?.createdAt)
    || typeof value?.cursor !== 'string') {
    throw new Error(`${label} identity/cursor mismatch: ${JSON.stringify(value)}`)
  }
}

function assertProducerCapabilities(value, label) {
  const expected = [
    ['snapshot.read', 'available', undefined],
    ['receipt.read', 'available', undefined],
    ['message.write', 'unavailable', 'i1b-effect-correlation'],
    ['control.write', 'unavailable', 'i1b-effect-correlation'],
    ['effect.cancel', 'unavailable', 'i1b-effect-correlation'],
  ]
  const actual = value?.capabilities?.map(entry => [entry.capability, entry.state, entry.blocker])
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} producer capabilities drifted: ${JSON.stringify(actual)}`)
  }
}

function assertReadPage(value, kind, cursor, visibleTotal, authoritativeTotal) {
  if (value?.kind !== kind || value?.cursor !== cursor || value?.visibleTotal !== visibleTotal
    || value?.authoritativeTotal !== authoritativeTotal || !Array.isArray(value?.entries)
    || value.entries.length !== visibleTotal || value?.offset !== 0 || value?.nextOffset !== undefined) {
    throw new Error(`${kind} page identity/cursor/totals mismatch: ${JSON.stringify(value)}`)
  }
}

function requireOfficialValue(response, label) {
  if (!response.ok || response.body?.result?.ok !== true) {
    throw new Error(`${label} failed: ${JSON.stringify(response)}`)
  }
  return response.body.result.value
}

async function createOfficialWorkspaceSession({
  port, evidenceDir, label, workspaceRoot, rootSessionId, expectedWorkspaceId, expectedCreated,
}) {
  const workspaceResponse = await rpcCall(port, 'workspace.create', { path: workspaceRoot })
  await writeFile(join(evidenceDir, `${label}-workspace-create.json`), `${JSON.stringify(workspaceResponse, null, 2)}\n`, 'utf8')
  const workspaceValue = requireOfficialValue(workspaceResponse, `${label} workspace.create`)
  const workspace = workspaceValue?.workspace
  if (typeof workspace?.workspaceId !== 'string' || workspace.workspaceId.length === 0
    || workspace.path !== workspaceRoot || workspaceValue.created !== expectedCreated
    || (expectedWorkspaceId !== undefined && workspace.workspaceId !== expectedWorkspaceId)) {
    throw new Error(`${label} workspace.create identity/path mismatch: ${JSON.stringify(workspaceValue)}`)
  }

  const sessionResponse = await rpcCall(port, 'session.create', {
    sessionId: rootSessionId,
    workspaceId: workspace.workspaceId,
  })
  await writeFile(join(evidenceDir, `${label === 'r3' ? 'r2' : 'r2-reload'}-session-create.json`), `${JSON.stringify(sessionResponse, null, 2)}\n`, 'utf8')
  const sessionValue = requireOfficialValue(sessionResponse, `${label} session.create`)
  if (sessionValue?.sessionId !== rootSessionId) {
    throw new Error(`${label} session.create did not establish the exact root: ${JSON.stringify(sessionValue)}`)
  }
  return workspace
}

async function readWorkspaceSessionAccounting({
  port, evidenceDir, label, workspaceRoot, workspaceId, rootSessionId,
}) {
  const workspaceResponse = await rpcCall(port, 'workspace.list', {})
  const sessionResponse = await rpcCall(port, 'session.list', {})
  const workspaces = requireOfficialValue(workspaceResponse, `${label} workspace.list`)?.items
  const sessions = requireOfficialValue(sessionResponse, `${label} session.list`)?.items
  const workspace = Array.isArray(workspaces)
    ? workspaces.find(entry => entry.workspaceId === workspaceId)
    : undefined
  const session = Array.isArray(sessions)
    ? sessions.find(entry => entry.sessionId === rootSessionId)
    : undefined
  const fixture = {
    exactRoot: session?.sessionId === rootSessionId,
    workspaceAttached: workspace?.path === workspaceRoot && workspace?.sessionIds?.includes(rootSessionId) === true
      && session?.cwd === workspaceRoot,
    sessionNonBlank: session?.blank === false,
    rootSessionId,
    workspaceId,
    workspacePath: workspaceRoot,
  }
  await writeFile(join(evidenceDir, `${label}-workspace-accounting.json`), `${JSON.stringify({
    workspaceResponse, sessionResponse, workspace, session, fixture,
  }, null, 2)}\n`, 'utf8')
  if (!fixture.exactRoot || !fixture.workspaceAttached || !fixture.sessionNonBlank) {
    throw new Error(`${label} official Workspace/Session accounting mismatch: ${JSON.stringify({ workspace, session })}`)
  }
  return fixture
}

const TURN_END_REASON_KINDS = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted'])

function assertSessionFixture(target, expectedEvents) {
  const fixture = target?.sessionFixture
  const events = fixture?.events
  const starts = new Map()
  const ends = new Map()
  const shapeOk = Array.isArray(events) && events.length >= 2 && events.every((event) => {
    if (!Number.isSafeInteger(event?.seq) || !Number.isSafeInteger(event?.turn) || event.turn < 1) return false
    if (event.type === 'turn/start') {
      if (starts.has(event.turn)) return false
      starts.set(event.turn, event.seq)
      return true
    }
    if (event.type !== 'turn/end' || typeof event.reason?.kind !== 'string'
      || !TURN_END_REASON_KINDS.has(event.reason.kind) || ends.has(event.turn)) return false
    ends.set(event.turn, event.seq)
    return true
  }) && starts.size > 0 && starts.size === ends.size
    && [...starts].every(([turn, startSeq]) => {
      const endSeq = ends.get(turn)
      return endSeq !== undefined && endSeq > startSeq
    })
  // Reload may append a new, fully settled official turn while the prior
  // authoritative boundaries remain immutable. Require that exact prefix,
  // then validate every newly observed turn with the same closed-pair rules.
  const preservedPrefix = expectedEvents === undefined
    || JSON.stringify(events.slice(0, expectedEvents.length)) === JSON.stringify(expectedEvents)
  if (fixture?.mode !== 'agent-loop' || !shapeOk || !preservedPrefix) {
    throw new Error(`official closed-turn fixture mismatch: ${JSON.stringify(fixture)}`)
  }
  return events
}

function assertReceiptShape(value, path = '$') {
  if (value === null || value === undefined || ['string', 'boolean', 'number'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`P0 receipt contains a non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    const expected = Array.from({ length: value.length }, (_, index) => String(index))
    if (keys.length !== expected.length + 1 || keys.at(-1) !== 'length' || keys.slice(0, -1).some((key, index) => key !== expected[index])) {
      throw new Error(`P0 receipt contains a sparse or extended array at ${path}`)
    }
    for (const [index, key] of expected.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`P0 receipt contains an accessor array entry at ${path}[${index}]`)
      }
      assertReceiptShape(descriptor.value, `${path}[${index}]`)
    }
    return
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`P0 receipt contains a non-plain value at ${path}`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`P0 receipt contains a symbol key at ${path}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`P0 receipt contains an accessor or hidden field at ${path}.${key}`)
    }
    assertReceiptShape(descriptor.value, `${path}.${key}`)
  }
}

function canonicalizeReceipt(value) {
  if (value === undefined) return ['undefined']
  if (value === null) return ['null']
  switch (typeof value) {
    case 'string': return ['string', value]
    case 'boolean': return ['boolean', value]
    case 'number': return ['number', Object.is(value, -0) ? '-0' : value]
    case 'object':
      if (Array.isArray(value)) return ['array', value.map(canonicalizeReceipt)]
      return ['object', Object.keys(value).toSorted().map(key => [key, canonicalizeReceipt(value[key])])]
    default: throw new Error(`P0 receipt contains an unsupported value type: ${typeof value}`)
  }
}

/** Strict JSON-receipt equality: object keys are canonicalized, array order and every value type remain exact. */
export function canonicalDeepEqual(left, right) {
  // Receipt values come from JSONL/RPC parsing, but retain a fail-closed guard
  // for direct fixture calls: reject accessors/non-plain values and make the
  // platform structured clone reject proxy/exotic objects before comparison.
  assertReceiptShape(left); assertReceiptShape(right)
  let leftClone; let rightClone
  try {
    leftClone = structuredClone(left)
    rightClone = structuredClone(right)
  } catch (error) {
    throw new Error(`P0 receipt cannot be cloned for canonical comparison: ${error instanceof Error ? error.message : String(error)}`)
  }
  return JSON.stringify(canonicalizeReceipt(leftClone)) === JSON.stringify(canonicalizeReceipt(rightClone))
}

export function canonicalTerminalIdentity(team) {
  assertReceiptShape(team ?? {})
  const { revision, budget, usageCursors, updatedAt, ...business } = structuredClone(team ?? {})
  const identity = {
    id: team?.id, revision, captainSessionId: team?.captainSessionId, phase: team?.phase,
    members: team?.members?.map(member => ({ name: member.name, sessionId: member.sessionId, provider: member.provider, phase: member.phase })),
    tasks: team?.tasks?.map(task => ({ id: task.id, revision: task.revision, status: task.status, ownerSessionId: task.ownerSessionId, currentAttemptId: task.currentAttemptId })),
    attempts: team?.attempts?.map(attempt => ({ id: attempt.id, taskId: attempt.taskId, generation: attempt.generation, memberSessionId: attempt.memberSessionId, phase: attempt.phase, assignmentPhase: attempt.assignmentPhase })),
    business,
    budget,
    usageCursors: Object.fromEntries(Object.entries(usageCursors ?? {}).sort(([left], [right]) => left.localeCompare(right))),
  }
  if (identity.phase !== 'active' || identity.members?.length !== 1 || identity.tasks?.length !== 1 || identity.attempts?.length !== 1
    || identity.tasks[0]?.status !== 'completed' || identity.attempts[0]?.phase !== 'accepted') {
    throw new Error(`W0 terminal Team shape is not exactly one accepted completion: ${JSON.stringify(identity)}`)
  }
  return identity
}

export function deriveRootProbeUsageDelta(preProbe, rootSessionId, probeUsage) {
  if (!Array.isArray(probeUsage) || probeUsage.length === 0) throw new Error('W0 reload probe has no durable usage events')
  const previousCursor = preProbe?.usageCursors?.[rootSessionId] ?? -1
  let lastSeq = previousCursor
  let usedTokens = 0
  for (const entry of probeUsage) {
    if (!Number.isSafeInteger(entry?.seq) || !Number.isSafeInteger(entry?.tokens) || entry.seq <= lastSeq || entry.tokens < 0) {
      throw new Error(`W0 reload probe usage is not an ordered durable suffix: ${JSON.stringify({ previousCursor, probeUsage })}`)
    }
    lastSeq = entry.seq
    usedTokens += entry.tokens
  }
  return {
    teamRevision: probeUsage.length,
    budget: { usedTokens, usedRequests: 0, usedRetries: 0 },
    rootUsageCursor: lastSeq,
    rootSessionId,
    durableEvents: probeUsage,
  }
}

export function assertReloadProbeTransition({ initial, preProbe, postProbe, rootSessionId, probeUsage }) {
  const delta = deriveRootProbeUsageDelta(preProbe, rootSessionId, probeUsage)
  const violations = []
  const same = canonicalDeepEqual
  if (!same(preProbe, initial)) violations.push('pre-probe Team identity drifted from the settled initial identity')
  if (!same(preProbe.business, postProbe.business)) violations.push('probe changed Team/member/task/attempt business identity')
  if (postProbe.revision !== preProbe.revision + delta.teamRevision) violations.push('Team revision does not equal the durable probe usage-event count')
  for (const field of ['usedTokens', 'usedRequests', 'usedRetries']) {
    const expected = preProbe.budget?.[field] + delta.budget[field]
    if (!Object.is(postProbe.budget?.[field], expected)) violations.push(`budget.${field} is not explained by durable probe usage`)
  }
  const { [rootSessionId]: preRootCursor, ...preOtherCursors } = preProbe.usageCursors
  const { [rootSessionId]: postRootCursor, ...postOtherCursors } = postProbe.usageCursors
  if (!same(preOtherCursors, postOtherCursors)) violations.push('a non-root usage cursor changed during the root probe')
  if (postRootCursor !== delta.rootUsageCursor) violations.push('root usage cursor does not end at the last durable probe usage event')
  if (preRootCursor !== undefined && delta.durableEvents[0].seq <= preRootCursor) violations.push('root probe usage replayed or predated its durable cursor')
  if (violations.length > 0) {
    throw new Error(`W0 reload probe transition is not exactly explained: ${JSON.stringify({ initial, preProbe, postProbe, delta, violations })}`)
  }
  return delta
}

function r2BusinessIdentity(identity) {
  return { teamId: identity.teamId, roster: identity.roster, tasks: identity.tasks, attempts: identity.attempts }
}

async function waitForTarget(probePath, rootSessionId, minimumCount) {
  const ready = await waitUntil(async () => (await readProbe(probePath)).filter(
    entry => entry.phase === 'r2-target-ready' && entry.rootSessionId === rootSessionId,
  ).length >= minimumCount, { timeoutMs: 15_000 })
  const entries = await readProbe(probePath)
  if (!ready) throw new Error(`R2 live target did not become ready: ${JSON.stringify(entries)}`)
  return entries.filter(entry => entry.phase === 'r2-target-ready' && entry.rootSessionId === rootSessionId).at(-1)
}

async function decisionEvidenceRecords(output) {
  const records = []
  for (const relativePath of REQUIRED_P0_EVIDENCE_FILES) {
    const path = resolve(output, relativePath)
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw new Error(`required decision evidence is not a file: ${relativePath}`)
    records.push({ relativePath, bytes: fileStat.size, sha256: await sha256File(path) })
  }
  return records
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
  if (args.browserExecutable !== undefined
    && !await stat(args.browserExecutable).then(value => value.isFile(), () => false)) {
    throw new Error(`--browser-executable is not a file: ${args.browserExecutable}`)
  }
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
  let serviceProbeUrl = pathToFileURL(serviceProbeModule).href

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
    const selectionSourcePath = 'packages/client/runtime/src/client/sessions/service.ts'
    const selectionSourceBlob = await gitRead(args.official, ['rev-parse', `HEAD:${selectionSourcePath}`])
    const selectionSource = {
      relativePath: selectionSourcePath,
      gitBlob: selectionSourceBlob.stdout.trim(),
      sha256: await sha256File(join(args.official, ...selectionSourcePath.split('/'))),
    }
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
    if (listing.code !== 0 || !listing.stdout.includes('package/lib/index.mjs')
      || !listing.stdout.includes('package/lib/client.js') || !listing.stdout.includes('package/cordis.patch.yml')) {
      throw new Error('packed artifact is missing the Host entry, browser client or Bundle patch')
    }
    gate('artifact-packed', 'pass', `sha256=${artifactSha256} bytes=${artifactStat.size}`)

    const addArgs = [args.cli, 'plugin', '--profile', 'web', 'add', '-w', tarball]
    const add = await execute('profile-add', process.execPath, addArgs, { cwd: workspaceRoot, env: { DSH_HOME: dshHome }, timeoutMs: 10 * 60_000 })
    if (add.code !== 0) throw new Error('official plugin add failed')
    if (/lefthook|ELIFECYCLE/i.test(add.stdout + add.stderr)) throw new Error('official plugin add reported forbidden lifecycle failure output')
    const profilePatch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    // This disposable Profile-local module resolves LlmAdapter from the exact
    // dependency tree used by the official CLI. It is never packed/published.
    const profileProbeDir = join(dshHome, 'profiles', 'web', 'P0 probe 探针')
    await mkdir(profileProbeDir, { recursive: true })
    const profileProbeModule = join(profileProbeDir, 'w0 profile 探针.mjs')
    await copyFile(join(args.repo, 'scripts', 'p0', 'profile-probe.mjs'), profileProbeModule)
    serviceProbeUrl = pathToFileURL(profileProbeModule).href
    await writeFile(profilePatch, profilePatchLines({
      storageRoot, sessionRoot, workspaceRoot, shutdownProbeUrl, serviceProbeUrl,
    }).join('\n'), 'utf8')
    await writeFile(join(evidenceDir, 'profile-package-installed.json'), await readFile(join(dshHome, 'profiles', 'web', 'package.json')), 'utf8')
    await writeFile(join(evidenceDir, 'profile-cordis-default-enabled.patch.yml'), await readFile(profilePatch), 'utf8')
    gate('profile-add', 'pass', 'official plugin forwarder installed the immutable tarball into fresh web Profile with lifecycle scripts enabled')

    const dump = await execute('dump-config', process.execPath, [args.cli, '--profile', 'web', '--dump-config'], {
      cwd: workspaceRoot, env: { DSH_HOME: dshHome },
    })
    const dumpOk = dump.code === 0 && dump.stdout.includes('dsh-agent-swarm')
      && dump.stdout.includes('cordis:group') && dump.stdout.includes('disabled: false')
      && dump.stdout.includes(posix(storageRoot)) && dump.stdout.includes(posix(sessionRoot))
      && dump.stdout.includes(posix(workspaceRoot)) && dump.stdout.includes('agent-swarm-p0-shutdown-probe')
    if (!dumpOk) throw new Error('dump-config did not prove the enabled-by-default Swarm layer and isolated roots')
    gate('dump-config', 'pass', 'enabled-by-default structural group + isolated roots + shutdown probe composed')

    const rootSessionId = 'swarm-r2-profile-root'
    const bootEnv = {
      DSH_SWARM_P0_PROBE_PATH: probePath,
      DSH_SWARM_P0_STOP_PATH: stopPath,
      DSH_SWARM_R2_ROOT_SESSION_ID: rootSessionId,
      DSH_SWARM_P0_WORKSPACE_ROOT: workspaceRoot,
    }
    await rm(stopPath, { force: true })
    liveBoot = await bootPlane({ cli: args.cli, home: dshHome, profile: 'web', port: args.port, cwd: workspaceRoot, env: bootEnv })
    if (!liveBoot.ready) throw new Error(`web Profile did not boot: ${liveBoot.stderr().slice(0, 2000)}`)
    const defaultEntries = await readInventory(args.port, evidenceDir, 'inventory-default-enabled')
    const defaultRow = swarmInventoryRow(defaultEntries)
    if (defaultRow?.enabled !== true || defaultRow?.fiberPhase !== 'active') {
      throw new Error(`installed Swarm was not active by default: ${JSON.stringify(defaultRow)}`)
    }
    gate('default-enabled', 'pass', `entry=${defaultRow.entryId}; enabled=true; fiberPhase=active`)
    const probeReady = await waitUntil(async () => (await readProbe(probePath)).some(entry => entry.phase === 'active'), { timeoutMs: PROBE_ACTIVATION_TIMEOUT_MS })
    if (!probeReady) throw new Error(`service/tool probe did not activate within ${PROBE_ACTIVATION_TIMEOUT_MS}ms; probe tail=${JSON.stringify(await readProbe(probePath).catch(() => null))}`)
    const firstActive = (await readProbe(probePath)).find(entry => entry.phase === 'active')
    const servicesOk = Object.values(firstActive?.services ?? {}).every(value => value === true)
    const toolSurface = exactP0SwarmToolSurface(firstActive?.tools)
    if (!servicesOk || !toolSurface.ok) {
      throw new Error(`service/tool probe mismatch: ${JSON.stringify({ services: firstActive?.services, actualTools: toolSurface.actual, expectedTools: toolSurface.expected })}`)
    }
    gate('service-tool-probe', 'pass', `${toolSurface.expected.length} exact agent_swarm tools and required services active`)

    const workspace = await createOfficialWorkspaceSession({
      port: args.port, evidenceDir, label: 'r3', workspaceRoot, rootSessionId, expectedCreated: true,
    })
    const targetReady = await waitForTarget(probePath, rootSessionId, 1)
    const agentLoopEvents = assertSessionFixture(targetReady)
    const teamId = targetReady.teamId
    if (typeof teamId !== 'string' || teamId.length === 0 || targetReady.resumed !== false) {
      throw new Error(`fresh R2 captain Team was not created through the real runtime: ${JSON.stringify(targetReady)}`)
    }
    const e2eReady = (await readProbe(probePath)).find(entry => entry.phase === 'w0-agent-loop-e2e')
    if (e2eReady?.e2e?.resumed !== false || e2eReady?.e2e?.review?.status !== 'completed') {
      throw new Error(`W0 real Agent Loop did not create/member-submit/review: ${JSON.stringify(e2eReady)}`)
    }
    gate('w0-real-agent-loop', 'pass', 'DEV_SMOKE isolated adapter drove member agent_swarm_submit_task; captain accepted exact attempt')
    const browserFixture = await readWorkspaceSessionAccounting({
      port: args.port, evidenceDir, label: 'r3', workspaceRoot,
      workspaceId: workspace.workspaceId, rootSessionId,
    })

    const capabilityHandshake = await readSwarmRpc(args.port, evidenceDir, 'r2-capabilities', {
      schemaVersion: 1, method: 'capabilities',
    }, { origin: `http://127.0.0.1:${args.port}`, 'sec-fetch-site': 'same-origin' })
    if (capabilityHandshake.status !== 200
      || capabilityHandshake.value?.ok !== true
      || capabilityHandshake.value?.value?.trust?.mode !== 'local-single-user-target-bound'
      || capabilityHandshake.value?.value?.trust?.principalBound !== false) {
      throw new Error(`R2 capability handshake mismatch: ${JSON.stringify(capabilityHandshake)}`)
    }
    const forgedOrigin = await readSwarmRpc(args.port, evidenceDir, 'r2-forged-origin', {
      schemaVersion: 1, method: 'capabilities',
    }, { origin: 'http://attacker.invalid', 'sec-fetch-site': 'cross-site' })
    if (forgedOrigin.status !== 403 || forgedOrigin.value?.ok !== false) {
      throw new Error(`R2 forged Origin did not fail closed: ${JSON.stringify(forgedOrigin)}`)
    }
    const fakeTarget = await readSwarmRpc(args.port, evidenceDir, 'r2-fake-target', {
      schemaVersion: 1, method: 'snapshot', target: { rootSessionId: 'session-not-live' },
    })
    if (fakeTarget.status !== 404 || fakeTarget.value?.error?.code !== 'SWARM_RPC_TARGET_NOT_LIVE') {
      throw new Error(`R2 fake target did not fail closed: ${JSON.stringify(fakeTarget)}`)
    }
    const trustedHeaders = { origin: `http://127.0.0.1:${args.port}`, 'sec-fetch-site': 'same-origin' }
    const target = { rootSessionId, teamId }
    const binding = requireSwarmValue(await readSwarmRpc(args.port, evidenceDir, 'r2-binding', {
      schemaVersion: 1, method: 'binding', target,
    }, trustedHeaders), 'R2 binding')
    assertReadBinding(binding, rootSessionId, teamId, 'R2 binding')
    const status = requireSwarmValue(await readSwarmRpc(args.port, evidenceDir, 'r2-status', {
      schemaVersion: 1, method: 'status', target,
    }, trustedHeaders), 'R2 status')
    assertReadBinding(status, rootSessionId, teamId, 'R2 status')
    assertProducerCapabilities(status, 'R2 status')
    const snapshot = requireSwarmValue(await readSwarmRpc(args.port, evidenceDir, 'r2-snapshot', {
      schemaVersion: 1, method: 'snapshot', target,
    }, trustedHeaders), 'R2 snapshot')
    assertReadBinding(snapshot, rootSessionId, teamId, 'R2 snapshot')
    assertProducerCapabilities(snapshot, 'R2 snapshot')
    if (binding.cursor !== status.cursor || status.cursor !== snapshot.cursor
      || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.attempts) || !Array.isArray(snapshot.pendingInteractions)) {
      throw new Error('R2 binding/status/snapshot did not share one authoritative cursor and collections')
    }
    const terminalIdentity = {
      teamId: snapshot.team.id,
      teamRevision: snapshot.team.revision,
      roster: snapshot.roster, tasks: snapshot.tasks, attempts: snapshot.attempts,
    }
    if ('members' in snapshot.team || JSON.stringify(snapshot).includes('sessionId')) throw new Error('R2 snapshot leaked member session identity')
    for (const kind of ['tasks', 'attempts', 'pendingInteractions']) {
      const page = requireSwarmValue(await readSwarmRpc(args.port, evidenceDir, `r2-page-${kind}`, {
        schemaVersion: 1, method: 'page', target, page: { kind, offset: 0, limit: 50 },
      }, trustedHeaders), `R2 ${kind} page`)
      assertReadPage(page, kind, snapshot.cursor, snapshot[kind].length, snapshot.totals[kind])
    }
    gate('r2-read-rpc-handshake', 'pass', 'real live root + captain Team: binding/status/snapshot and three pages pass; forged Origin and fake target fail closed')
    await runR3ActiveBrowserProof({
      port: args.port, evidenceDir, rootSessionId, teamId,
      browserExecutable: args.browserExecutable, selectionSource, fixture: browserFixture,
    })
    gate('r3-browser-active', 'pass', 'real browser rendered the live Team, used keyboard controls, handed off to official Captain Chat and survived reload')
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
    const reloadWorkspace = await createOfficialWorkspaceSession({
      port: args.port, evidenceDir, label: 'r3-reload', workspaceRoot, rootSessionId,
      expectedWorkspaceId: workspace.workspaceId, expectedCreated: false,
    })
    const reloadTarget = await waitForTarget(probePath, rootSessionId, 2)
    assertSessionFixture(reloadTarget, agentLoopEvents)
    if (reloadTarget.teamId !== teamId || reloadTarget.resumed !== true) {
      throw new Error(`reload did not recover the same authoritative captain Team: ${JSON.stringify(reloadTarget)}`)
    }
    const reloadE2e = (await readProbe(probePath)).filter(entry => entry.phase === 'w0-agent-loop-e2e').at(-1)
    if (reloadE2e?.e2e?.resumed !== true) throw new Error(`W0 reload repeated a task, submit, or review: ${JSON.stringify(reloadE2e)}`)
    const probeEntries = await readProbe(probePath)
    const reloadPreProbeIndex = probeEntries.findLastIndex(entry => entry.phase === 'w0-reload-pre-probe' && entry.rootSessionId === rootSessionId)
    const reloadScopeIndex = probeEntries.findLastIndex(entry => entry.phase === 'w0-scope-ready' && entry.rootSessionId === rootSessionId)
    const reloadPreProbe = probeEntries[reloadPreProbeIndex]
    const reloadSettled = probeEntries.filter(entry => entry.phase === 'w0-root-agent-loop-settled' && entry.rootSessionId === rootSessionId).at(-1)
    if (reloadPreProbeIndex < 0 || reloadPreProbeIndex > reloadScopeIndex || reloadPreProbe?.team === undefined) {
      throw new Error(`W0 reload did not read authoritative Team state before resume/root probe: ${JSON.stringify({ reloadPreProbe, reloadPreProbeIndex, reloadScopeIndex })}`)
    }
    if (reloadSettled?.settledTurn?.reason?.kind !== 'completed') {
      throw new Error(`W0 reload root probe did not complete: ${JSON.stringify(reloadSettled)}`)
    }
    await readWorkspaceSessionAccounting({
      port: args.port, evidenceDir, label: 'r3-reload', workspaceRoot,
      workspaceId: reloadWorkspace.workspaceId, rootSessionId,
    })
    const reloadBinding = requireSwarmValue(await readSwarmRpc(args.port, evidenceDir, 'r2-reload-binding', {
      schemaVersion: 1, method: 'binding', target,
    }, trustedHeaders), 'R2 reload binding')
    assertReadBinding(reloadBinding, rootSessionId, teamId, 'R2 reload binding')
    const reloadSnapshot = requireSwarmValue(await readSwarmRpc(args.port, evidenceDir, 'r2-reload-snapshot', {
      schemaVersion: 1, method: 'snapshot', target,
    }, trustedHeaders), 'R2 reload snapshot')
    const reloadIdentity = {
      teamId: reloadSnapshot.team.id, teamRevision: reloadSnapshot.team.revision,
      roster: reloadSnapshot.roster, tasks: reloadSnapshot.tasks, attempts: reloadSnapshot.attempts,
    }
    const exactInitial = canonicalTerminalIdentity(e2eReady?.e2e?.team)
    const exactReloadPreProbe = canonicalTerminalIdentity(reloadPreProbe.team)
    const exactReloadPostProbe = canonicalTerminalIdentity(reloadE2e?.e2e?.team)
    const probeDelta = assertReloadProbeTransition({
      initial: exactInitial, preProbe: exactReloadPreProbe, postProbe: exactReloadPostProbe,
      rootSessionId, probeUsage: reloadSettled.probeUsage,
    })
    if (!canonicalDeepEqual(r2BusinessIdentity(reloadIdentity), r2BusinessIdentity(terminalIdentity))
      || reloadIdentity.teamRevision !== exactReloadPostProbe.revision
      || reloadIdentity.tasks.some(task => task.status !== 'completed') || reloadIdentity.attempts.some(attempt => attempt.phase !== 'accepted')) {
      throw new Error(`W0 reload terminal identity changed or repeated work: ${JSON.stringify({
        terminalIdentity, reloadIdentity, exactInitial, exactReloadPreProbe, exactReloadPostProbe, probeDelta,
      })}`)
    }
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
    const r0RouteEvidence = await readDisabledSwarmRoute(args.port)
    await runR3R0BrowserProof({
      port: args.port, evidenceDir, rootSessionId, browserExecutable: args.browserExecutable,
      selectionSource, routeEvidence: r0RouteEvidence,
    })
    gate('r3-browser-r0', 'pass', 'R0 removed the Team action, exposed only the official Host 405 fallback and rendered no Team data')
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
    await runR3RemovedBrowserProof({
      port: args.port, evidenceDir, rootSessionId, browserExecutable: args.browserExecutable,
      selectionSource,
    })
    gate('r3-browser-removed', 'pass', 'package removal disposed the Team client action')
    const removedStop = await gracefulStop(liveBoot, stopPath, args.port)
    liveBoot = undefined
    if (!removedStop.graceful || !removedStop.portFree) throw new Error(`post-remove shutdown failed: ${JSON.stringify(removedStop)}`)
    gate('plugin-remove', 'pass', 'package removed; no dsh-agent-swarm inventory row after restart')

    const failProfile = 'p0-missing-storage'
    const failAdd = await execute('missing-storage-add', process.execPath, [args.cli, 'plugin', '--profile', failProfile, 'add', '-w', tarball], {
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
    const evidenceFiles = await decisionEvidenceRecords(args.output)
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
      evidenceFiles,
      cleanup: { runtimeRemoved, portFree, artifactRetained: true, evidenceRetained: true },
    }
    await writeFile(join(evidenceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const verified = await verifyP0Evidence(args.output, manifest, {
      candidateCommit: candidateCommit.stdout.trim(),
      candidateTree: candidateTree.stdout.trim(),
    })
    if (!verified.ok) throw new Error(`P0 evidence gate failed: ${verified.failures.join('; ')}`)
  } catch (error) {
    proofError = error
    // Evidence is intentionally retained even though the disposable runtime
    // is removed in finally.  This is the only failure handoff surface for a
    // fresh-only Profile run; do not include env, prompts, or process args.
    const failure = {
      schemaVersion: 1,
      status: 'fail',
      phase: gates.at(-1)?.name ?? 'bootstrap',
      error: error instanceof Error ? error.message.replaceAll(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/giu, '[redacted]') : String(error),
      gates,
      commands,
    }
    await writeFile(join(evidenceDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8').catch(() => undefined)
    await copyFile(probePath, join(evidenceDir, 'profile-probe.failure.jsonl')).catch(() => undefined)
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`P0 profile proof failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  })
}

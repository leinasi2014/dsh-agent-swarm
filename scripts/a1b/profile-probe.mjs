import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'agent-swarm-a1b-profile-probe'
export const inject = [
  'agentLoop',
  'agentSwarmV2Initial',
  'agents',
  'llm',
  'sessions',
  'sessionPersistence',
  'storageDomain',
  'subagents',
  'tools',
]

const PROVIDER = 'a1b-profile-mock'
const MODEL = 'a1b-profile-mock'

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function append(phase, detail = {}) {
  appendFileSync(requiredEnv('DSH_SWARM_A1B_PROBE_PATH'), `${JSON.stringify({
    phase,
    at: Date.now(),
    ...detail,
  })}\n`, 'utf8')
}

function swarmTools(ctx) {
  return ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('agent_swarm_')).sort()
}

function readIdentity() {
  const path = requiredEnv('DSH_SWARM_A1B_STATE_PATH')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeIdentity(value) {
  writeFileSync(requiredEnv('DSH_SWARM_A1B_STATE_PATH'), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function tool(ctx, agent, signal, callId, name, args) {
  const result = await ctx.tools.execute({ signal, callId, name, arguments: args, agent })
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  return result.value
}

async function waitFor(predicate, signal, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const value = await predicate()
    if (value !== undefined && value !== false) return value
    await new Promise((resolveWait, reject) => {
      const timer = setTimeout(resolveWait, 25)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    })
  }
  throw new Error(`A1b probe condition did not become true within ${timeoutMs}ms`)
}

function assistantEvents(snapshot) {
  return snapshot.events.filter(event => event.type === 'assistant/message')
}

function createAdapter(ctx, getIdentity) {
  const entries = []
  const adapter = {
    providerInfo(provider) { return { id: provider, name: provider } },
    providerRetryPolicy() { return undefined },
    listModels() { return Promise.resolve([{ provider: PROVIDER, id: MODEL, name: MODEL }]) },
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) },
    async prepareCall(provider, model, signal) {
      return { model: await adapter.resolveModel(provider, model, signal), stream: options => adapter.stream(options) }
    },
    async * stream(options) {
      const identity = getIdentity()
      const snapshot = identity === undefined
        ? undefined
        : ctx.agentSwarmV2Initial.snapshot(resolve(requiredEnv('DSH_SWARM_A1B_WORKSPACE')), identity.teamId)
      const attempt = snapshot?.attempts.find(candidate => candidate.memberSessionId === options.sessionId)
      const entry = {
        sessionId: options.sessionId,
        attemptPhaseAtProviderEntry: attempt?.phase,
        dispatchPhaseAtProviderEntry: attempt?.dispatchEpochs[0]?.phase,
        turn: options.metadata?.agentLoop?.turn,
        step: options.metadata?.agentLoop?.step,
      }
      entries.push(entry)
      append('model-entry', entry)
      const text = 'A1b official Profile dispatch completed.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { adapter, entries }
}

async function firstBoot(ctx, signal, identityRef) {
  const workspace = resolve(requiredEnv('DSH_SWARM_A1B_WORKSPACE'))
  const rootSessionId = 'a1b-profile-captain'
  const captain = ctx.agentLoop.create(rootSessionId, { provider: PROVIDER, model: MODEL }, { cwd: workspace })
  const created = await tool(ctx, captain, signal, 'a1b-create', 'agent_swarm_create', {
    name: 'A1b Profile Team',
    description: 'Prove first assignment through the official installed DSH Profile.',
  })
  const added = await tool(ctx, captain, signal, 'a1b-add', 'agent_swarm_add_member', {
    name: 'profile-worker',
    role: 'Return the first assignment through the official Agent Loop.',
    llm_provider: PROVIDER,
    model: MODEL,
  })
  identityRef.value = {
    rootSessionId,
    teamId: created.team_id,
    memberSessionId: added.session_id,
  }
  writeIdentity(identityRef.value)
  const declared = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)
  append('declared', {
    identity: identityRef.value,
    memberPhase: declared?.members[0]?.phase,
    attemptCount: declared?.attempts.length,
    liveChildBeforeTask: ctx.agents.get(added.session_id) !== undefined,
  })
  await tool(ctx, captain, signal, 'a1b-task', 'agent_swarm_create_task', {
    subject: 'First Profile vertical',
    description: 'Return one model response through the official installed Profile.',
    acceptance_criteria: ['One provider entry and durable assistant evidence.'],
    target_member: 'profile-worker',
  })
  const running = await waitFor(async () => {
    await ctx.agentSwarmV2Initial.drainEvidence()
    const value = ctx.agentSwarmV2Initial.snapshot(workspace, created.team_id)
    const attempt = value?.attempts[0]
    return attempt?.phase === 'parked' && attempt.dispatchEpochs[0]?.phase === 'settled' ? value : undefined
  }, signal)
  const persisted = await waitFor(async () => {
    const child = await ctx.sessionPersistence.load(added.session_id).catch(() => undefined)
    return child !== undefined && assistantEvents(child).length === 1 ? child : undefined
  }, signal)
  append('first-complete', {
    identity: identityRef.value,
    memberPhase: running.members[0]?.phase,
    taskStatus: running.tasks[0]?.status,
    attemptPhase: running.attempts[0]?.phase,
    dispatchPhases: running.attempts[0]?.dispatchEpochs.map(epoch => epoch.phase),
    assistantEventCount: assistantEvents(persisted).length,
    userMessageCount: persisted.events.filter(event => event.type === 'user/message').length,
  })
}

async function restartBoot(ctx, signal, identityRef, entries) {
  const identity = identityRef.value
  if (identity === undefined) throw new Error('A1b restart probe lacks the first-boot identity')
  const workspace = resolve(requiredEnv('DSH_SWARM_A1B_WORKSPACE'))
  const snapshot = ctx.agentSwarmV2Initial.snapshot(workspace, identity.teamId)
  if (snapshot?.attempts[0]?.phase !== 'parked' || snapshot.attempts[0].dispatchEpochs[0]?.phase !== 'settled') {
    throw new Error(`A1b restart state did not reopen as parked/settled: ${JSON.stringify(snapshot)}`)
  }
  await new Promise((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, 500)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
  if (entries.length !== 0) throw new Error(`A1b restart duplicated model dispatch: ${JSON.stringify(entries)}`)
  const persisted = await ctx.sessionPersistence.load(identity.memberSessionId).catch(() => undefined)
  if (persisted === undefined || assistantEvents(persisted).length !== 1) {
    throw new Error('A1b restart did not retain exactly one durable assistant message')
  }
  append('restart-complete', {
    identity,
    memberPhase: snapshot.members[0]?.phase,
    attemptPhase: snapshot.attempts[0]?.phase,
    dispatchPhases: snapshot.attempts[0]?.dispatchEpochs.map(epoch => epoch.phase),
    assistantEventCount: assistantEvents(persisted).length,
    restartModelEntryCount: entries.length,
  })
}

export function apply(ctx) {
  const tools = swarmTools(ctx)
  if (JSON.stringify(tools) !== JSON.stringify([
    'agent_swarm_add_member',
    'agent_swarm_continue_task',
    'agent_swarm_create',
    'agent_swarm_create_task',
    'agent_swarm_reassign_task',
    'agent_swarm_submit_task',
  ])) throw new Error(`fresh-v2 Profile exposed unexpected tools: ${JSON.stringify(tools)}`)
  const identityRef = { value: readIdentity() }
  const { adapter, entries } = createAdapter(ctx, () => identityRef.value)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  append('active', {
    mode: identityRef.value === undefined ? 'first' : 'restart',
    services: Object.fromEntries(inject.map(name => [name, ctx[name] !== undefined])),
    tools,
  })
  ctx.effect(() => {
    const controller = new AbortController()
    const run = identityRef.value === undefined
      ? firstBoot(ctx, controller.signal, identityRef)
      : restartBoot(ctx, controller.signal, identityRef, entries)
    void run.catch(error => {
      if (!controller.signal.aborted) append('error', { message: error instanceof Error ? error.message : String(error) })
    })
    return () => controller.abort(new Error('A1b Profile probe unloaded'))
  })
}

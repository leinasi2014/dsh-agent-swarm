/** Callback operations on official continuable children; the Subagent service owns residency. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { TeamDomainError } from '../domain/error.js'

const PREFIX = 'Agent Swarm transport maintenance v1: '
const MARKER = /^Agent Swarm transport maintenance v1: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const tails = new Map<string, Promise<unknown>>()
const maintained = new WeakSet<Agent>()

/** A claim cannot advance while this plugin holds the exact recipient's maintenance. */
export function childIsMaintained(child: Agent): boolean { return maintained.has(child) }

function maintain<T>(child: Agent, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // Preserve the official synchronous admission error for marker cleanup.
  return child.runMaintenance(signal => {
    maintained.add(child)
    return operation(signal)
  }).finally(() => maintained.delete(child))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function markerText(message: UserMessage): string | undefined {
  if (message.source.kind !== 'plugin' || message.source.plugin !== 'dsh-agent-swarm' || message.content.length !== 1) return undefined
  const part = message.content[0]
  return part?.type === 'text' && MARKER.test(part.text) ? part.text : undefined
}

/** An interrupted transport callback is retried from Team debt, never from its old wake marker. */
export function installChildOperationRecovery(ctx: Context): () => void {
  const removeOrphans = (agent: Agent): void => {
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (markerText(message) !== undefined) agent.inbox.remove(message.id)
    }
  }
  const off = ctx.on('agent/session-start', ({ agent }) => removeOrphans(agent))
  // A failed removal must never turn a transport marker into model instructions.
  const offAdmission = ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const retained = decision.messages.filter(message => markerText(message) === undefined)
    if (retained.length === decision.messages.length) return decision
    const ordinary = retained.some(message => message.source.kind !== 'plugin' || message.source.plugin !== '@deepseek-ai/dsh-system-prompt')
    return { ...decision, messages: ordinary ? retained : [] }
  }, { prepend: true })
  for (const agent of ctx.agents.list()) removeOrphans(agent)
  return () => { off(); offAdmission() }
}

function assertParent(ctx: Context, parent: Agent, signal: AbortSignal): void {
  signal.throwIfAborted()
  if (ctx.agents.get(parent.id) !== parent || ctx.sessions.get(parent.id) !== parent.session)
    throw new TeamDomainError('child operation requires the exact live parent', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
}

function assertChild(ctx: Context, parent: Agent, child: Agent, childId: SessionId, signal: AbortSignal): void {
  assertParent(ctx, parent, signal)
  if (child.id !== childId || ctx.agents.get(childId) !== child || ctx.sessions.get(childId) !== child.session
    || child.session.header.parentSession !== parent.id)
    throw new TeamDomainError('child operation requires the exact live direct child', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
}

/** Serialize this plugin's operations; cancellation never drops another caller's work. */
async function serialize<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(key)
  const next = (previous ?? Promise.resolve()).then(async () => { signal.throwIfAborted(); return await run() })
  const stored = next.then(() => {}, () => {})
  tails.set(key, stored)
  try { return await next } finally { if (tails.get(key) === stored) tails.delete(key) }
}

/**
 * Resume through the official descriptor and hold the callback in Agent maintenance.
 * The synchronous enqueue observer claims maintenance before the official wake;
 * only its own transport marker is removed. Later input keeps its normal wake.
 */
async function coldOperation<T>(ctx: Context, parent: Agent, childId: SessionId, signal: AbortSignal,
  operation: (child: Agent, lease: AbortSignal) => Promise<T> | T): Promise<T> {
  const marker = PREFIX + randomUUID(), admitted = deferred<void>(), result = deferred<T>()
  // Enqueue can fail before either promise has an awaiting consumer.
  void admitted.promise.catch(() => {})
  void result.promise.catch(() => {})
  let captured = false, maintenance: Promise<T> | undefined
  const off = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (captured || agent.id !== childId || markerText(message) !== marker) return
    captured = true
    try {
      assertChild(ctx, parent, agent, childId, signal)
      maintenance = maintain(agent, async maintenanceSignal => {
        if (!agent.inbox.remove(message.id)) throw new TeamDomainError('transport marker was not pending', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
        // Do not re-enter the official child lock from inside its admission window.
        await admitted.promise
        const lease = AbortSignal.any([signal, maintenanceSignal])
        assertChild(ctx, parent, agent, childId, lease)
        return await operation(agent, lease)
      })
      void maintenance.then(result.resolve, result.reject)
    } catch (error) {
      // Official event dispatch contains listener errors; settle our own result.
      let failure = error
      try { agent.inbox.remove(message.id) }
      catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'child transport maintenance and marker cleanup failed') }
      finally { result.reject(failure) }
    }
  }, { prepend: true })
  try {
    assertParent(ctx, parent, signal)
    await queueHostSubagentPrompt(ctx.subagents, parent, childId, [{ type: 'text', text: marker }],
      { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal)
    admitted.resolve(undefined)
    if (!captured) throw new TeamDomainError('official child admission did not expose its transport marker', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
    return await result.promise
  } catch (error) {
    admitted.reject(error)
    if (maintenance !== undefined) await Promise.allSettled([maintenance])
    throw error
  } finally { off() }
}

/** Resolve under the exact parent; never create a bare Agent outside continuation ownership. */
export async function withLiveChild<T>(ctx: Context, parent: Agent, childId: SessionId, signal: AbortSignal,
  operation: (child: Agent, lease: AbortSignal) => Promise<T> | T): Promise<T> {
  assertParent(ctx, parent, signal)
  return await serialize(String(childId), signal, async () => {
    assertParent(ctx, parent, signal)
    const child = ctx.agents.get(childId)
    if (child === undefined) return await coldOperation(ctx, parent, childId, signal, operation)
    assertChild(ctx, parent, child, childId, signal)
    if (child.status === 'idle') return await maintain(child, async maintenanceSignal => {
      const lease = AbortSignal.any([signal, maintenanceSignal])
      assertChild(ctx, parent, child, childId, lease)
      return await operation(child, lease)
    })
    // A running official activation already owns its turn. Callers revalidate
    // the exact participants after awaits before any authoritative admission.
    return await operation(child, signal)
  })
}

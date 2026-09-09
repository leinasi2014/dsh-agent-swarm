/** Recover dormant managed work through the official continuable seam. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { SessionId, foldRequestHeader, type EpochHeader, type SessionHeader } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { TeamState } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'

/** Restore only a committed route; adapter-owned effort remains an adapter default. */
function selectionFromHeader(header: EpochHeader | undefined): ModelSelection {
  if (!header?.config.provider || !header.config.model) throw new Error('Main Brain has no persisted model route; re-attach it through its Host before recovery')
  const { provider, model, reasoningEffort } = header.config
  return { provider, model, ...(reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort }) }
}

export class ManagedActivationRecovery {
  private readonly roots = new Map<string, AgentHandle>()
  private readonly abort = new AbortController()
  private recovery?: Promise<void>

  constructor(private readonly ctx: Context, private readonly deps: {
    teams(scope: TeamScope): Promise<TeamState[]>
    trackChild(parent: Agent, childId: string): void
  }) {}

  /** One startup pass; idle events never replay recovery messages. */
  run(): Promise<void> { return this.recovery ??= this.recover() }

  private async recover(): Promise<void> {
    const signal = this.abort.signal
    const headers = await this.ctx.sessionPersistence.list(signal)
    const byId = new Map(headers.map(header => [String(header.id), header]))
    const scopes = new Set(headers.flatMap(header => header.cwd === undefined ? [] : [resolve(header.cwd)]))
    for (const scope of scopes) {
      for (const team of await this.deps.teams(scope)) {
        signal.throwIfAborted()
        if (team.phase !== 'active' || team.managedOrigin === undefined
          || !team.tasks.some(task => ['pending', 'in_progress', 'submitted', 'verifying'].includes(task.status))) continue
        const captainHeader = byId.get(team.captainSessionId)
        const parentId = captainHeader?.parentSession
          ?? headers.find(header => team.managedOrigin!.startsWith(`managed:${header.id}:`))?.id
          ?? team.managedOrigin.replace(/^managed:(.*):(?:turn|detached):.*$/u, '$1')
        try {
          if (captainHeader === undefined || captainHeader.parentSession !== parentId
            || !team.managedOrigin.startsWith(`managed:${parentId}:`)) {
            throw new Error('persisted dedicated Captain lineage is missing or does not match managed ownership')
          }
          const parentHeader = byId.get(parentId)
          if (captainHeader.cwd === undefined || resolve(captainHeader.cwd) !== scope
            || parentHeader?.cwd === undefined || resolve(parentHeader.cwd) !== scope) {
            throw new Error('Team, Captain and Main Brain workspace scopes do not match')
          }
          if (this.ctx.agents.get(SessionId(team.captainSessionId)) !== undefined) continue
          const root = await this.attachRoot(parentId, byId, scope)
          this.deps.trackChild(root, team.captainSessionId)
          // A bare agents.resume(child) would lose the continuation descriptor,
          // delegated setup, Activation owner, and its disposer. followup owns
          // all of them and records the recovery request in the Session log.
          await queueHostSubagentPrompt(this.ctx.subagents, root, SessionId(team.captainSessionId), [{
            type: 'text',
            text: 'The Host restarted while this managed Team still had unfinished work. '
              + 'Inspect the current task board and continue the existing work: review submitted tasks; '
              + 'for an already delivered in-progress attempt, wake its existing member with agent_swarm_send_message '
              + 'and preserve its exact current attempt. Do not recruit replacements or replay old assignments. '
              + `Team identity (data): ${JSON.stringify(team.id)}.`,
          }], { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal)
        } catch (cause) {
          if (signal.aborted) throw cause
          throw new TeamDomainError(
            `managed Team ${JSON.stringify(team.id)} cannot recover child Session ${JSON.stringify(team.captainSessionId)}; `
              + `re-attach parent Session ${JSON.stringify(parentId)} and retry recovery: ${cause instanceof Error ? cause.message : String(cause)}`,
            'TEAM_PARENT_REATTACH_FAILED', { cause },
          )
        }
      }
    }
  }

  private async attachRoot(parentId: string, headers: ReadonlyMap<string, SessionHeader>, scope: TeamScope): Promise<Agent> {
    const header = headers.get(parentId)
    if (header === undefined || header.parentSession !== undefined) throw new Error('the managed Main Brain must be a persisted top-level Session')
    const live = this.ctx.agents.get(SessionId(parentId))
    if (live !== undefined) return this.checkedRoot(live, parentId, scope)
    const controller = this.ctx.get('sessionController')
    if (controller !== undefined) {
      // The Host owns ordinary Web Session composition, pending model
      // selection and disposal. Never adopt its shared handle into roots.
      return this.checkedRoot(await this.resolveHostedRoot(controller, SessionId(parentId)), parentId, scope)
    }
    const stored = await this.ctx.sessionPersistence.inspect(SessionId(parentId), this.abort.signal)
    const headerRoute = foldRequestHeader(stored.events)
    const agentOptions = selectionFromHeader(headerRoute)
    const presetId = stored.events.reduce(agentPresetProjectionDefinition.apply, agentPresetProjectionDefinition.init(stored.meta)) ?? undefined
    const presets = this.ctx.get('agentPresets')
    if (presetId !== undefined && presets === undefined) throw new Error(`persisted Main Brain preset ${JSON.stringify(presetId)} requires the official agentPresets service`)
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(parentId), signal: this.abort.signal,
      agentOptions: {
        ...agentOptions,
        ...(headerRoute?.config.maxTokens === undefined || headerRoute.adapterDefaults?.maxTokens === true ? {} : { maxTokens: headerRoute.config.maxTokens }),
      },
      setup: async (agentCtx: Context) => {
        const root = agentCtx.agent!
        const current = (): ModelSelection => {
          const state = agentCtx.get('sessionProjections')?.stateOf(root.session, 'modelSelection')
          if (state?.pending != null) {
            const { provider, model, reasoningEffort } = state.pending
            return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }) }
          }
          if (state === undefined && root.session.snapshotEvents().some(event => event.type === 'model/selection')) {
            throw new Error('Main Brain model-selection history requires the official modelSelection projection; headless recovery cannot determine pending selection')
          }
          return selectionFromHeader(root.session.requestHeader())
        }
        current() // Reject unsupported selection history before publication.
        installModelSelection(agentCtx, { get current() { return current() }, assembled: undefined })
        if (presets !== undefined) await presets.mount(agentCtx, presetId)
      },
    })
    // The returned capability belongs to this runtime, including cancellation
    // after factory publication. Existing host-owned roots are never adopted.
    this.roots.set(parentId, handle)
    this.abort.signal.throwIfAborted()
    return handle.agent
  }

  private checkedRoot(root: Agent, parentId: string, scope: TeamScope): Agent {
    if (this.ctx.agents.get(SessionId(parentId)) !== root || root.session.id !== parentId
      || root.session.header.parentSession !== undefined || root.session.header.cwd === undefined
      || resolve(root.session.header.cwd) !== scope) throw new Error('live Main Brain identity has a different workspace or parent')
    return root
  }

  private async resolveHostedRoot(controller: Context['sessionController'], parentId: SessionId): Promise<Agent> {
    const signal = this.abort.signal
    signal.throwIfAborted()
    let onAbort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // Cancellation stops our wait and child dispatch, not the Controller's
      // shared resolution. A late Host result is never ours to dispose.
      const found = await Promise.race([controller.resolveAgent(parentId), cancelled])
      signal.throwIfAborted()
      if ('error' in found) throw found.error
      return found.agent
    } finally { signal.removeEventListener('abort', onAbort) }
  }

  close(): void { this.abort.abort(new Error('managed activation recovery disposed')) }
  async wait(): Promise<void> { await Promise.allSettled(this.recovery === undefined ? [] : [this.recovery]) }

  /** Called after official descendants are drained, before closing the store. */
  async disposeRoots(): Promise<void> {
    const handles = [...this.roots.values()].toReversed()
    this.roots.clear()
    const settled = await Promise.allSettled(handles.map(handle => handle.dispose()))
    const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'managed recovery root disposal failed')
  }
}

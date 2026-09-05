/** Recover dormant managed work through the official continuable seam. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { TeamState } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'

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
          await this.ctx.subagents.followup(root, SessionId(team.captainSessionId), [{
            type: 'text',
            text: 'The Host restarted while this managed Team still had unfinished work. '
              + 'Inspect the current task board and continue the existing work: review submitted tasks; '
              + 'for an already delivered in-progress attempt, wake its existing member with agent_swarm_send_message '
              + 'and preserve its exact current attempt. Do not recruit replacements or replay old assignments. '
              + `Team identity (data): ${JSON.stringify(team.id)}.`,
          }], { source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, signal })
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
    if (live !== undefined) {
      if (live.session.header.parentSession !== undefined || live.session.header.cwd === undefined || resolve(live.session.header.cwd) !== scope) throw new Error('live Main Brain identity has a different workspace or parent')
      return live
    }
    const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(parentId), signal: this.abort.signal })
    // The returned capability belongs to this runtime, including cancellation
    // after factory publication. Existing host-owned roots are never adopted.
    this.roots.set(parentId, handle)
    this.abort.signal.throwIfAborted()
    return handle.agent
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

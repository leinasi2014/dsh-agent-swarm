/** Participant-local model changes through the official Session and selection hook. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamState } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'
import { nonEmpty } from '../domain/team-domain-shared.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'

function ownSelection(agent: Agent): ModelSelection | undefined {
  // Seeded children contain the parent's selection history. Only a local
  // selection can supersede this child's official creation descriptor.
  if (!agent.session.ownEvents().some(event => event.type === 'model/selection')) return undefined
  const state = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')
  if (state === undefined) throw new TeamDomainError('Captain model selection requires the official modelSelection projection', 'TEAM_MODEL_SELECTION_UNAVAILABLE')
  if (state.pending !== null) {
    const { provider, model, reasoningEffort } = state.pending
    return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }) }
  }
  const header = agent.session.requestHeader()
  if (header === undefined) throw new TeamDomainError('Captain model selection has no committed request route', 'TEAM_MODEL_SELECTION_UNAVAILABLE')
  const { provider, model, reasoningEffort } = header.config
  return { provider, model, ...(reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort }) }
}

export class CaptainModelSelection {
  /** Rebuilt from canonical Team records, never inferred from child labels.
   * Issue #233: the install roster is every Team participant (dedicated
   * Captain plus members), but it only supplies identity for startup
   * installs; the durable model authority stays each Session's own
   * model/selection events plus the official projection. */
  private readonly participants = new Map<string, TeamScope>()
  private readonly installed = new Map<Agent, () => void>()
  private closing = false

  constructor(private readonly ctx: Context, private readonly deps: {
    domain(): TeamDomainPort
    scopeOf(agent: Agent): TeamScope
    assertOpen(): void
  }) {}

  remember(team: TeamState, scope: TeamScope): void {
    const resolved = resolve(scope)
    if (team.captainSessionId !== '') this.participants.set(team.captainSessionId, resolved)
    for (const member of team.members) {
      if (member.sessionId !== '') this.participants.set(member.sessionId, resolved)
    }
  }

  /** Install before automatic continuation; the start notification is synchronous. */
  install(): () => void {
    const offStart = this.ctx.on('agent/session-start', ({ agent }) => this.attach(agent))
    const offDisposed = this.ctx.on('agent/disposed', ({ agent }) => {
      this.installed.get(agent)?.()
      this.installed.delete(agent)
    })
    for (const id of this.participants.keys()) {
      const agent = this.ctx.agents.get(SessionId(id))
      if (agent !== undefined) this.attach(agent)
    }
    return () => {
      this.closing = true
      offStart(); offDisposed()
      for (const dispose of this.installed.values()) dispose()
      this.installed.clear(); this.participants.clear()
    }
  }

  private attach(agent: Agent): void {
    if (this.closing || this.installed.has(agent)
      || agent.session.header.parentSession === undefined
      || this.participants.get(String(agent.id)) !== resolve(this.deps.scopeOf(agent))) return
    this.installed.set(agent, installModelSelection(agent.ctx, {
      get current() { return ownSelection(agent) }, assembled: undefined,
    }))
  }

  /** The one official Session commit path behind both public entries. */
  private async commit(exec: ToolExecutionAuthority, agent: Agent, scope: TeamScope,
    input: { llmProvider: string; model: string; reasoningEffort?: string },
    guards: { assertLive(): void; authorize(): Promise<TeamState>; kind: string }): Promise<ModelSelection> {
    await guards.authorize()
    const selected: ModelSelection = {
      provider: nonEmpty(input.llmProvider, 'LLM provider', 128), model: nonEmpty(input.model, 'model', 128),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(nonEmpty(input.reasoningEffort, 'reasoning effort', 128)) }),
    }
    if (this.ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection') === undefined)
      throw new TeamDomainError(`${guards.kind} model selection requires the official modelSelection projection`, 'TEAM_MODEL_SELECTION_UNAVAILABLE')
    await this.ctx.llm.resolveCallConfig(selected, exec.signal)
    if (!await this.ctx.sessions.flush(agent.session)) throw new TeamDomainError(`${guards.kind} model selection requires Session durability`, 'TEAM_MODEL_SELECTION_UNAVAILABLE')
    const team = await guards.authorize()
    this.remember(team, scope)
    this.attach(agent)
    guards.assertLive()
    agent.session.append('model/selection', selected)
    if (!await this.ctx.sessions.flush(agent.session)) throw new TeamDomainError(`${guards.kind} model selection was appended but durability could not be confirmed`, 'TEAM_MODEL_SELECTION_UNAVAILABLE')
    return selected
  }

  async select(exec: ToolExecutionAuthority, input: { llmProvider: string; model: string; reasoningEffort?: string }): Promise<ModelSelection> {
    const agent = requireAgent(exec), scope = this.deps.scopeOf(agent)
    const assertLive = () => {
      exec.signal.throwIfAborted()
      this.deps.assertOpen()
      if (this.closing || this.ctx.agents.get(agent.id) !== agent || agent.session.id !== agent.id)
        throw new TeamDomainError('Captain Session is no longer live', 'TEAM_RUNTIME_CLOSING')
    }
    const authorize = async () => {
      assertLive()
      const membership = await this.deps.domain().requireMembership(scope, agent.id)
      assertLive()
      if (membership.role !== 'captain' || membership.team.phase !== 'active')
        throw new TeamDomainError('Only the active Captain may select its own model', 'TEAM_CAPTAIN_REQUIRED')
      if (agent.session.header.parentSession === undefined || membership.team.managedOrigin === undefined)
        throw new TeamDomainError('This tool requires a dedicated managed Captain; a legacy root Captain uses the Host model selector', 'TEAM_DEDICATED_CAPTAIN_REQUIRED')
      return membership.team
    }
    return await this.commit(exec, agent, scope, input, { assertLive, authorize, kind: 'Captain' })
  }

  /**
   * Issue #233: any active Team participant (the dedicated Captain or a
   * member) selects its own model for subsequent requests. Self-only by
   * construction — there is no target parameter. The commit pipeline is the
   * one official Session selection shared with {@link select}; the Team
   * aggregate is never written, so no second durable route can diverge from
   * the Session. A cold participant installs through the Team identity roster.
   */
  async selectParticipant(exec: ToolExecutionAuthority, input: { llmProvider: string; model: string; reasoningEffort?: string }): Promise<ModelSelection> {
    const agent = requireAgent(exec), scope = this.deps.scopeOf(agent)
    const assertLive = () => {
      exec.signal.throwIfAborted()
      this.deps.assertOpen()
      if (this.closing || this.ctx.agents.get(agent.id) !== agent || agent.session.id !== agent.id)
        throw new TeamDomainError('Participant Session is no longer live', 'TEAM_RUNTIME_CLOSING')
    }
    const authorize = async () => {
      assertLive()
      const membership = await this.deps.domain().requireMembership(scope, agent.id)
      assertLive()
      if (membership.team.phase !== 'active')
        throw new TeamDomainError('Only an active Team participant may select its own model', 'TEAM_PARTICIPANT_REQUIRED')
      if (agent.session.header.parentSession === undefined)
        throw new TeamDomainError('Model self-selection requires a plugin-owned continuable participant; a legacy root Captain uses the Host model selector', 'TEAM_DEDICATED_CAPTAIN_REQUIRED')
      return membership.team
    }
    return await this.commit(exec, agent, scope, input, { assertLive, authorize, kind: 'Participant' })
  }
}

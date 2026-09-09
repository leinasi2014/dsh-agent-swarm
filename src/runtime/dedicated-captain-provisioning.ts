import { captainModelDefaults, resolveTeamModelRoute, toAgentModelOptions } from './model-routing.js'
/** Dedicated Captain creation over the official continuable-subagent seam. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
import type { TeamModelRoute, TeamState } from '../domain/types.js'
import { captainPersona, captainStartNotice } from './prompts.js'
import type { RuntimeConfig } from './runtime-contract.js'

type InitialCaptain = {
  readonly scope: TeamScope
  readonly team: TeamState
  readonly root: Agent
  readonly captainId: SessionId
  admitted: boolean
  terminalReason?: string
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Owns Captain startup, initial-turn settlement and runtime disposal. */
export class DedicatedCaptainProvisioner {
  private readonly starts = new Set<Promise<unknown>>()
  private readonly settlements = new Set<Promise<unknown>>()
  private readonly initial = new Map<string, InitialCaptain>()
  private readonly abort = new AbortController()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      readonly config: RuntimeConfig
      readonly domain: () => TeamDomainPort
      readonly trackChild: (parent: Agent, childId: SessionId) => void
      readonly rememberCaptain: (team: TeamState, scope: TeamScope) => void
    },
  ) {}

  async create(input: {
    readonly scope: TeamScope
    readonly root: Agent
    readonly name: string
    readonly description: string
    readonly managedOrigin?: string
    readonly allowedSkills?: readonly string[]
    readonly llmProvider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly signal: AbortSignal
  }): Promise<TeamState> {
    if (this.closing) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
    const start = this.start(input)
    this.starts.add(start)
    try { return await start } finally { this.starts.delete(start) }
  }

  private async start(input: Parameters<DedicatedCaptainProvisioner['create']>[0]): Promise<TeamState> {
    this.requireCaptainProvider()
    const route = await resolveTeamModelRoute(this.ctx, input.root, input, captainModelDefaults(this.deps.config), input.signal)
    if (!await this.ctx.sessions.flush(input.root.session)) throw new Error('Captain startup requires a Session durability listener')
    input.signal.throwIfAborted()
    const captainId = SessionId(randomUUID())
    const team = await this.deps.domain().createTeam(
      input.scope, captainId, input.name, input.description, -1, input.managedOrigin, input.allowedSkills, route,
    )
    this.deps.config.teamSkills.rememberTeam(team)
    this.deps.rememberCaptain(team, input.scope)
    // A concurrent manager may have already won this managed origin at the
    // Storage Domain (atomic claim): its Team (with the winner's Captain) is
    // returned instead of a freshly-minted one. Do NOT provision a duplicate
    // Captain for that Team — the winner already owns and runs it.
    if (team.captainSessionId !== String(captainId)) {
      this.initial.delete(captainId)
      return team
    }
    const pending: InitialCaptain = { scope: input.scope, team, root: input.root, captainId, admitted: false }
    this.initial.set(captainId, pending)
    // Ownership begins before the provider call: partial start and disposal
    // races can never create an untracked continuable Session.
    this.deps.trackChild(input.root, captainId)
    try {
      await this.spawnCaptain(team, input.root, route, AbortSignal.any([input.signal, this.abort.signal]))
      pending.admitted = true
      this.settleObserved(pending)
      return team
    } catch (error) {
      this.initial.delete(captainId)
      const cleanup: unknown[] = []
      await this.ctx.subagents.drainContinuableChildren(input.root, [captainId]).catch(value => cleanup.push(value))
      await this.deps.domain().archiveTeam(input.scope, team.id, captainId, 'dedicated Captain failed to start')
        .then(archived => { if (archived.phase !== 'archived') cleanup.push(new Error('Captain Team did not archive')) })
        .catch(value => cleanup.push(value))
      if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], `dedicated Captain startup failed: ${describe(error)}`)
      throw error
    }
  }


  /**
   * Provision the dedicated Captain for an ALREADY-APPROVED (active) Team.
   *
   * Used by the plan-first approve path: the staged->active boundary commits
   * first (durable authority) with the generated captain id, then this method
   * starts the declared continuable child on the same team. A failure here
   * drains the child but deliberately does NOT archive the Team — the approved
   * Team stays active for the later recovery path that re-provisions the
   * declared captain.
   */
  async provisionForTeam(input: {
    readonly scope: TeamScope
    readonly team: TeamState
    readonly root: Agent
    readonly captainId: SessionId
    readonly llmProvider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly signal: AbortSignal
  }): Promise<TeamState> {
    if (this.closing) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
    this.requireCaptainProvider()
    const { team, root, captainId } = input
    const route = team.captainRoute ?? await resolveTeamModelRoute(this.ctx, root, input, captainModelDefaults(this.deps.config), input.signal)
    await this.ctx.llm.resolveCallConfig(toAgentModelOptions(route), input.signal)
    if (!await this.ctx.sessions.flush(root.session)) throw new Error('Captain startup requires a Session durability listener')
    input.signal.throwIfAborted()
    this.deps.config.teamSkills.rememberTeam(team)
    this.deps.rememberCaptain(team, input.scope)
    this.deps.trackChild(root, captainId)
    try {
      await this.spawnCaptain(team, root, route, AbortSignal.any([input.signal, this.abort.signal]))
      return team
    } catch (error) {
      await this.ctx.subagents.drainContinuableChildren(root, [captainId]).catch(() => undefined)
      throw error
    }
  }
  private async spawnCaptain(team: TeamState, root: Agent, route: TeamModelRoute, signal: AbortSignal): Promise<void> {
    await this.ctx.subagents.startContinuable({
      provider: this.requireCaptainProvider(),
      label: `${team.name} · Captain`,
      childId: SessionId(team.captainSessionId),
      request: {
        prompt: [{ type: 'text', text: captainStartNotice(team) }],
        parent: root,
        persona: captainPersona(team),
        toolFilter: { deny: ['agent_swarm_create_managed'] },
        agentOptions: toAgentModelOptions(route),
        // Official maxDepth is absolute: Main Brain=0, Captain=1, members=2.
        maxDepth: this.deps.config.memberMaxDepth + 1,
      },
      signal,
    })
  }

  private requireCaptainProvider(): string {
    const providerName = this.deps.config.memberProvider
    const provider = this.ctx.subagents.getProvider(providerName)
    if (provider?.prepareContinuable === undefined || !provider.capabilities.depthLimit
      || !provider.capabilities.persona || !provider.capabilities.toolFilter) {
      throw new TeamDomainError(`subagent provider "${providerName}" cannot host a dedicated Captain`, 'TEAM_MEMBER_PROVIDER_INCOMPATIBLE')
    }
    return providerName
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    const pending = this.initial.get(session.id)
    if (pending === undefined || event.type !== 'turn/end') return
    pending.terminalReason = event.data.reason.kind
    this.settleObserved(pending)
  }

  private settleObserved(pending: InitialCaptain): void {
    if (!pending.admitted || pending.terminalReason === undefined) return
    this.initial.delete(pending.captainId)
    if (pending.terminalReason !== 'error') return
    const settlement = (async () => {
      const failures: unknown[] = []
      await this.ctx.subagents.drainContinuableChildren(pending.root, [pending.captainId]).catch(error => failures.push(error))
      await this.deps.domain().archiveTeam(pending.scope, pending.team.id, pending.captainId, 'dedicated Captain initial turn failed')
        .then(archived => { if (archived.phase !== 'archived') failures.push(new Error('Captain Team did not archive')) })
        .catch(error => failures.push(error))
      if (failures.length > 0) throw new AggregateError(failures, 'dedicated Captain initial-turn cleanup failed')
    })()
    this.settlements.add(settlement)
    void settlement.catch(error => this.ctx.logger.error(String(error))).finally(() => this.settlements.delete(settlement))
  }

  dispose(): void { this.closing = true; this.abort.abort('Team orchestrator disposal') }
  wait(): Promise<Array<PromiseSettledResult<unknown>>> { return Promise.allSettled([...this.starts, ...this.settlements]) }
}


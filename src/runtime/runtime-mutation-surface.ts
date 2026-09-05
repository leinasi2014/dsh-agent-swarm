import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TaskId, TeamId, type AttemptId, type TaskAttempt, type TeamAnnouncement, type TeamMessage, type TeamMessageCausal, type TeamPlanDraft, type TeamState, type TeamTask } from '../domain/types.js'
import type { CreateTaskInput, TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { TeamDomainError } from '../domain/error.js'
import type { MemberIdentityInput } from '../domain/identity-profile.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import type { DedicatedCaptainProvisioner } from './dedicated-captain-provisioning.js'
import type { ExecutionRootSurface } from './execution-root-surface.js'
import type { MemberProvisioner } from './member-provisioning.js'
import type { MessageDelivery } from './message-delivery.js'
import type { TeamReviewProvider } from './providers.js'
import { runReviewTransaction } from './review-transaction.js'
import type { RuntimeConfig } from './runtime-contract.js'
import { resolveTaskTarget } from './task-targeting.js'
import type { RuntimeCreateTaskInput } from './verification-commands.js'
import type { VerificationFamily } from './verification-family.js'

interface RuntimeMutationDeps {
  ctx: Context
  config: RuntimeConfig
  domain: () => TeamDomainPort
  ensureReady: () => Promise<void>
  assertOpen: () => void
  assertConfiguredProviders: () => void
  scopeOf: (agent: Agent) => TeamScope
  watchJobsScope: (scope: TeamScope) => void
  listTeamAggregates: (scope: TeamScope) => Promise<TeamState[]>
  provisioning: MemberProvisioner
  captainProvisioning: DedicatedCaptainProvisioner
  verificationFamily: VerificationFamily
  executionRoots: ExecutionRootSurface
  delivery: MessageDelivery
  reviewProvider: (name: string) => TeamReviewProvider | undefined
  requestSchedule: (scope: TeamScope, teamId: TeamId, captain: Agent) => void
}

/** Internal implementation of the runtime's public state-changing operations. */
export class RuntimeMutationSurface {
  private readonly managedInflight = new Map<string, Promise<TeamState>>()

  constructor(private readonly deps: RuntimeMutationDeps) {}

  async create(exec: ToolExecutionAuthority, name: string, description: string): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const agent = requireAgent(exec), scope = this.deps.scopeOf(agent)
    this.deps.watchJobsScope(scope)
    return await this.deps.domain().createTeam(
      scope, agent.id, name, description, agent.session.events.at(-1)?.seq ?? -1, undefined,
      this.deps.config.newTeamAllowedSkills(),
    )
  }

  async createWithDedicatedCaptain(exec: ToolExecutionAuthority, name: string, description: string, options: { llmProvider?: string; model?: string } = {}): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const root = requireAgent(exec), scope = this.deps.scopeOf(root)
    if (root.session.header.parentSession !== undefined || await this.deps.domain().findMembership(scope, root.id) !== undefined)
      throw new TeamDomainError('managed Team creation requires a top-level main Chat outside every Team', 'TEAM_CAPTAIN_REQUIRED')
    const identity = this.resolveManagedIdentity(root, exec)
    const inFlight = this.managedInflight.get(identity)
    if (inFlight !== undefined) {
      try { return await inFlight } finally { /* kept in map until settle */ }
    }
    const creation = (async () => {
      const owned = await this.findManagedTeamByOrigin(scope, identity)
      if (owned !== undefined) return owned
      this.deps.watchJobsScope(scope)
      return await this.deps.captainProvisioning.create({
        scope, root, name, description, managedOrigin: identity, allowedSkills: this.deps.config.newTeamAllowedSkills(),
        ...(options.llmProvider === undefined ? {} : { llmProvider: options.llmProvider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        signal: exec.signal,
      })
    })()
    this.managedInflight.set(identity, creation)
    try {
      return await creation
    } finally {
      if (this.managedInflight.get(identity) === creation) this.managedInflight.delete(identity)
    }
  }


  /** Plan-first: create a durable staged managed Team (no Captain is provisioned). */
  async createStagedManaged(exec: ToolExecutionAuthority, name: string, description: string): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const root = requireAgent(exec), scope = this.deps.scopeOf(root)
    await this.assertMainBrain(root, scope)
    const identity = this.resolveManagedIdentity(root, exec)
    return await this.deps.domain().createStagedManaged(scope, identity, name, description)
  }

  /** Plan-first: Main Brain stores one bounded declaration on its staged Team. */
  async setPlan(exec: ToolExecutionAuthority, teamId: string, expectedRevision: number, draft: TeamPlanDraft): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const root = requireAgent(exec), scope = this.deps.scopeOf(root)
    await this.assertMainBrain(root, scope)
    const team = await this.ownedStagedTeam(root, scope, teamId)
    return await this.deps.domain().setPlanDraft(scope, team.id, expectedRevision, draft)
  }

  /**
   * Plan-first approval: durable staged->active commit first, then provision
   * the declared dedicated Captain, the planned members and the planned task
   * graph (plan-local keys mapped to real task ids, dependencies wired,
   * targets resolved to member sessions). Any provisioning failure after the
   * commit leaves the Team active for the recovery path; the next approved
   * state is never silently rolled back.
   */
  async approvePlan(exec: ToolExecutionAuthority, teamId: string, expectedRevision: number, options: { llmProvider?: string; model?: string; askUser?: boolean } = {}): Promise<TeamState> {

    await this.deps.ensureReady(); this.deps.assertOpen(); this.deps.assertConfiguredProviders()
    const root = requireAgent(exec), scope = this.deps.scopeOf(root)
    await this.assertMainBrain(root, scope)
    const staged = await this.ownedStagedTeam(root, scope, teamId)
    const draft = staged.planDraft
    if (draft === undefined || draft.members.length === 0 || draft.tasks.length === 0) {
      throw new TeamDomainError('approval requires a complete plan declaration (members and tasks)', 'TEAM_PLAN_INCOMPLETE')
    }
    if (options.askUser === true) {
      const port = this.deps.config.planApproval
      if (port === undefined) throw new TeamDomainError('Plan approval requires the official ctx.userQuestions service', 'TEAM_HUMAN_QUESTIONS_MISSING')
      const decision = await port.ask({
        agent: root,
        signal: exec.signal,
        teamId,
        question: `Approve the staged plan for Team "${staged.name}" (${draft.members.length} members, ${draft.tasks.length} tasks)?`,
        approveLabel: 'Approve & Run',
        discardLabel: 'Discard',
      })
      if (decision === 'discard') return await this.deps.domain().discardStagedPlan(scope, staged.id, expectedRevision)
    }
    const captainId = SessionId(randomUUID())
    const committed = await this.deps.domain().approveStagedPlan(scope, staged.id, expectedRevision, String(captainId))
    await this.deps.captainProvisioning.provisionForTeam({
      scope, team: committed, root, captainId, signal: exec.signal,
      ...(options.llmProvider === undefined ? {} : { llmProvider: options.llmProvider }),
      ...(options.model === undefined ? {} : { model: options.model }),
    })
    const captain = this.deps.ctx.agents.get(captainId)
    if (captain === undefined) {
      throw new TeamDomainError('dedicated Captain did not register after approval; the Team is active and waits for recovery', 'TEAM_CAPTAIN_PROVISION_PENDING')
    }
    await this.provisionPlannedMembers(captain, draft, exec.signal)
    const fresh = (await this.deps.listTeamAggregates(scope)).find(candidate => candidate.id === staged.id)
    if (fresh === undefined) throw new TeamDomainError('approved Team disappeared after provisioning', 'TEAM_NOT_FOUND')
    await this.createPlannedTasks(scope, fresh, captainId, draft)
    return committed
  }

  /** Plan-first: archive one staged draft owned by the calling Main Brain. */
  async discardPlan(exec: ToolExecutionAuthority, teamId: string, expectedRevision: number): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const root = requireAgent(exec), scope = this.deps.scopeOf(root)
    await this.assertMainBrain(root, scope)
    const team = await this.ownedStagedTeam(root, scope, teamId)
    return await this.deps.domain().discardStagedPlan(scope, team.id, expectedRevision)
  }


  /**
   * Crash-window recovery for an approved managed Team: the staged->active
   * commit already happened but the declared dedicated Captain (and possibly
   * the planned members/tasks) were never provisioned. Re-provisions the
   * declared Captain on the existing Team, then the missing planned members
   * and — only when no task exists yet — the planned task graph. Idempotent:
   * a live Captain and present members are left untouched.
   */
  async recoverApprovedTeam(scope: TeamScope, team: TeamState): Promise<TeamState> {
    if (team.phase !== 'active' || team.managedOrigin === undefined || team.captainSessionId === '') return team
    const captainId = SessionId(team.captainSessionId)
    let captain = this.deps.ctx.agents.get(captainId)
    if (captain === undefined) {
      const rootId = String(team.managedOrigin).replace(/^managed:([^:]+):.*/u, '$1')
      let root = this.deps.ctx.agents.get(SessionId(rootId))
      if (root === undefined) {
        const resumed = await this.deps.ctx.agents.resume({ resumeSessionId: SessionId(rootId) })
        root = resumed.agent
      }
      await this.deps.captainProvisioning.provisionForTeam({ scope, team, root, captainId, signal: new AbortController().signal })
      captain = this.deps.ctx.agents.get(captainId)
      if (captain === undefined) throw new TeamDomainError('approved Captain re-provision did not register', 'TEAM_CAPTAIN_PROVISION_PENDING')
    }
    const draft = team.planDraft
    if (draft === undefined) return team
    const live = (await this.deps.listTeamAggregates(scope)).find(candidate => candidate.id === team.id)
    if (live === undefined) throw new TeamDomainError(`approved Team "${team.id}" disappeared during recovery`, 'TEAM_NOT_FOUND')
    await this.provisionPlannedMembers(captain, draft, new AbortController().signal, member => live.members.some(existing => existing.name === member.name && existing.phase === 'active'))
    if (live.tasks.length > 0) return await this.deps.listTeamAggregates(scope).then(all => all.find(candidate => candidate.id === team.id) ?? team)
    const ready = (await this.deps.listTeamAggregates(scope)).find(candidate => candidate.id === team.id)
    if (ready === undefined) throw new TeamDomainError(`approved Team "${team.id}" disappeared while creating tasks`, 'TEAM_NOT_FOUND')
    const taskTeam = (await this.deps.listTeamAggregates(scope)).find(candidate => candidate.id === team.id)
    if (taskTeam === undefined) throw new TeamDomainError(`approved Team "${team.id}" disappeared while creating tasks`, 'TEAM_NOT_FOUND')
    await this.createPlannedTasks(scope, taskTeam, captainId, draft)
    return (await this.deps.listTeamAggregates(scope)).find(candidate => candidate.id === team.id) ?? team
  }

  private async provisionPlannedMembers(captain: Agent, draft: TeamPlanDraft, signal: AbortSignal, skip?: (member: TeamPlanDraft['members'][number]) => boolean): Promise<void> {
    for (const member of draft.members) {
      if (skip?.(member) === true) continue
      await this.deps.provisioning.addMember({ agent: captain, signal } as ToolExecutionAuthority, {
        name: member.name,
        role: member.role,
        ...(member.llmProvider === undefined ? {} : { llmProvider: member.llmProvider }),
        ...(member.model === undefined ? {} : { model: member.model }),
        ...(member.denyTools === undefined ? {} : { denyTools: member.denyTools }),
      })
    }
  }

  private async createPlannedTasks(scope: TeamScope, team: TeamState, captainId: SessionId, draft: TeamPlanDraft): Promise<void> {
    const byKey = new Map<string, TaskId>()
    for (const task of draft.tasks) {
      const blockedBy = (task.dependencies ?? []).map(key => {
        const taskId = byKey.get(key)
        if (taskId === undefined) throw new TeamDomainError(`plan task "${task.key}" depends on unresolved task "${key}"`, 'TEAM_INPUT_INVALID')
        return taskId
      })
      const target = task.targetMemberName === undefined ? undefined : resolveTaskTarget(team.members, task.targetMemberName)
      const created = await this.deps.domain().createTask(scope, team.id, captainId, {
        subject: task.subject,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria ?? [],
        blockedBy,
        ...(task.writeScopes === undefined ? {} : { writeScopes: task.writeScopes }),
        ...(target === undefined ? {} : { targetMemberSessionId: target }),
      })
      byKey.set(task.key, created.id)
    }
  }

  private async assertMainBrain(root: Agent, scope: TeamScope): Promise<void> {
    if (root.session.header.parentSession !== undefined || await this.deps.domain().findMembership(scope, root.id) !== undefined) {
      throw new TeamDomainError('managed Team operations require a top-level main Chat outside every Team', 'TEAM_CAPTAIN_REQUIRED')
    }
  }

  private async ownedStagedTeam(root: Agent, scope: TeamScope, teamId: string): Promise<TeamState> {
    const teams = await this.deps.listTeamAggregates(scope)
    const team = teams.find(candidate => candidate.id === TeamId(teamId))
    if (team === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
    if (team.phase !== 'staged') throw new TeamDomainError('plan operation requires a staged Team', 'TEAM_PHASE_INVALID')
    const prefix = `managed:${String(root.id)}:`
    if ((team.managedOrigin ?? '').startsWith(prefix) === false) {
      throw new TeamDomainError('plan operation requires ownership by the calling Main Brain', 'TEAM_UNAUTHORIZED')
    }
    return team
  }
  private resolveManagedIdentity(root: Agent, exec: ToolExecutionAuthority): string {
    const main = String(root.id)
    const callId = exec.callId === undefined ? undefined : String(exec.callId)
    if (callId !== undefined) {
      for (const event of root.session.events) {
        if (event.type !== 'tool/call') continue
        const data = event.data as { callId?: unknown; turn?: number }
        if (String(data.callId) === callId) return `managed:${main}:turn:${data.turn}`
      }
    }
    return `managed:${main}:detached:${callId ?? 'unknown'}`
  }

  private async findManagedTeamByOrigin(scope: TeamScope, origin: string): Promise<TeamState | undefined> {
    const teams = await this.deps.listTeamAggregates(scope)
    return teams.find(team => team.phase === 'active' && team.managedOrigin === origin)
  }

  async addMember(exec: ToolExecutionAuthority, input: { name: string; role: string; provider?: string; llmProvider?: string; model?: string; denyTools?: readonly string[] } & MemberIdentityInput): Promise<TeamState['members'][number]> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    return await this.deps.provisioning.addMember(exec, input)
  }

  async setCaptainProfile(exec: ToolExecutionAuthority, expectedRevision: number, input: MemberIdentityInput): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    return await this.deps.domain().setCaptainProfile(scope, membership.team.id, captain.id, expectedRevision, input)
  }

  async publishAnnouncement(exec: ToolExecutionAuthority, expectedRevision: number, text: string): Promise<{ team: TeamState; announcement: TeamAnnouncement }> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    return await this.deps.domain().publishAnnouncement(scope, membership.team.id, captain.id, expectedRevision, text)
  }

  async setPublicGoal(exec: ToolExecutionAuthority, expectedRevision: number, text: string): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    return await this.deps.domain().setPublicGoal(scope, membership.team.id, captain.id, expectedRevision, text)
  }

  async createTask(exec: ToolExecutionAuthority, input: RuntimeCreateTaskInput): Promise<TeamTask> {
    await this.deps.ensureReady(); this.deps.assertOpen(); this.deps.assertConfiguredProviders()
    const actor = requireAgent(exec), scope = this.deps.scopeOf(actor)
    const membership = await this.deps.domain().requireMembership(scope, actor.id)
    const { verification, targetMemberName, ...taskInput } = input
    let domainInput: CreateTaskInput = taskInput
    if (targetMemberName !== undefined) domainInput = { ...domainInput, targetMemberSessionId: resolveTaskTarget(membership.team.members, targetMemberName) }
    if (verification !== undefined) {
      const compiled = await this.deps.verificationFamily.compile(verification, this.deps.config.limits.maxVerificationCommands, exec.signal)
      domainInput = { ...domainInput, verification: compiled }
    }
    const task = await this.deps.domain().createTask(scope, membership.team.id, actor.id, domainInput)
    const captain = this.deps.ctx.agents.get(SessionId(membership.team.captainSessionId)); if (captain !== undefined) this.deps.requestSchedule(scope, membership.team.id, captain)
    return task
  }

  async removeMember(exec: ToolExecutionAuthority, name: string, reason: string) {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    const removed = await this.deps.domain().removeMember(scope, membership.team.id, captain.id, name, reason)
    this.deps.ctx.subagents.interrupt(SessionId(removed.member.sessionId), { kind: 'ancestor', agent: captain })
    await this.deps.ctx.subagents.drainContinuableChildren(captain, [SessionId(removed.member.sessionId)])
    await this.deps.executionRoots.sweep(scope, membership.team.id)
    this.deps.requestSchedule(scope, membership.team.id, captain)
    return removed
  }

  async archive(exec: ToolExecutionAuthority, reason: string): Promise<TeamState> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    const activeIds = membership.team.members.filter(member => member.phase === 'active' || member.phase === 'provisioning').map(member => SessionId(member.sessionId))
    const archived = await this.deps.domain().archiveTeam(scope, membership.team.id, captain.id, reason)
    for (const id of activeIds) this.deps.ctx.subagents.interrupt(id, { kind: 'ancestor', agent: captain })
    await this.deps.ctx.subagents.drainContinuableChildren(captain, activeIds)
    await this.deps.executionRoots.sweep(scope, membership.team.id)
    return archived
  }

  async claimTask(exec: ToolExecutionAuthority, taskId: string, expectedRevision: number): Promise<{ task: TeamTask; attempt: TaskAttempt; executionRoot?: { path: string; isolation: 'git-worktree' | 'temp-directory' } }> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const actor = requireAgent(exec), scope = this.deps.scopeOf(actor)
    const membership = await this.deps.domain().requireMembership(scope, actor.id)
    const claim = await this.deps.domain().claimTask(scope, membership.team.id, actor.id, TaskId(taskId), expectedRevision)
    return await this.deps.executionRoots.settleClaim(scope, membership.team, claim)
  }

  async submitTask(exec: ToolExecutionAuthority, input: { taskId: string; expectedRevision: number; attemptId: string; output: string; evidence?: readonly string[] }): Promise<TeamTask> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const actor = requireAgent(exec), scope = this.deps.scopeOf(actor)
    const membership = await this.deps.domain().requireMembership(scope, actor.id)
    const attemptId = input.attemptId as AttemptId
    // Issue #191: submitting a git-worktree attempt must persist a durable
    // diff/patch of the isolated worktree into the attempt evidence, so review
    // can read the code the root once isolated after the root is reclaimed.
    // Captured BEFORE the domain submit (the sweep below reclaims the root).
    const evidence = [...(input.evidence ?? [])]
    const current = membership.team.tasks.find(task => task.id === input.taskId)
    const ownsCurrent = current?.currentAttemptId === attemptId && current.ownerSessionId === actor.id
      && current.revision === input.expectedRevision && current.status === 'in_progress'
    // Invalid/stale calls reach the canonical Domain validation without IO.
    const durableDiff = ownsCurrent
      ? await this.deps.executionRoots.captureSubmission(scope, membership.team.id, TaskId(input.taskId), attemptId, actor)
      : undefined
    if (durableDiff !== undefined) evidence.push(durableDiff)
    const task = await this.deps.domain().submitTask(scope, membership.team.id, actor.id, TaskId(input.taskId), input.expectedRevision, attemptId, input.output, evidence)
    await this.deps.executionRoots.sweep(scope, membership.team.id)
    return task
  }

  async reassignTask(exec: ToolExecutionAuthority, taskId: string, expectedRevision: number, reason: string, targetMemberName?: string): Promise<TeamTask> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    const targetMemberSessionId = targetMemberName === undefined ? undefined : resolveTaskTarget(membership.team.members, targetMemberName)
    const before = membership.team.tasks.find(task => task.id === taskId)
    const released = await this.deps.domain().cancelAttempt(scope, membership.team.id, captain.id, TaskId(taskId), expectedRevision, reason, targetMemberSessionId)
    if (before?.ownerSessionId !== undefined) this.deps.ctx.subagents.interrupt(SessionId(before.ownerSessionId), { kind: 'ancestor', agent: captain })
    await this.deps.executionRoots.sweep(scope, membership.team.id)
    this.deps.requestSchedule(scope, membership.team.id, captain)
    return released
  }

  async reviewTask(exec: ToolExecutionAuthority, input: { taskId: string; expectedRevision: number; attemptId: string; decision: 'accept' | 'reject'; diagnostic?: string }): Promise<{ task: TeamTask; decision: 'accept' | 'reject' }> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const outcome = await runReviewTransaction({
      ctx: this.deps.ctx, domain: this.deps.domain,
      reviewProvider: () => this.deps.reviewProvider(this.deps.config.reviewProvider),
      reviewProviderName: () => this.deps.config.reviewProvider, scopeOf: this.deps.scopeOf,
      requestSchedule: this.deps.requestSchedule,
    }, exec, input)
    const captain = requireAgent(exec), scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    await this.deps.executionRoots.sweep(scope, membership.team.id)
    if (outcome.decision === 'reject') this.deps.requestSchedule(scope, membership.team.id, captain)
    return outcome
  }

  async sendMessage(exec: ToolExecutionAuthority, target: string, content: string, delivery: 'quiet' | 'wakeup', causal?: TeamMessageCausal, supersedes?: TeamMessage['supersedes']): Promise<TeamMessage> {
    await this.deps.ensureReady(); this.deps.assertOpen()
    const sender = requireAgent(exec), scope = this.deps.scopeOf(sender)
    const membership = await this.deps.domain().requireMembership(scope, sender.id)
    const message = await this.deps.domain().queueMessage(scope, membership.team.id, sender.id, target, content, delivery, causal, supersedes)
    const captain = this.deps.ctx.agents.get(SessionId(membership.team.captainSessionId))
    if (captain === undefined) return message
    return await this.deps.delivery.deliverQueuedMessage(scope, membership.team.id, captain, message.id, exec.signal) ?? message
  }
}





/**
 * Framework-neutral Team protocol core composing the subdomain modules.
 *
 * `TeamDomain` remains the one `TeamDomainPort` Provider over a single
 * `TeamAggregateStore`; the transition bodies live in cohesive subdomain
 * modules — roster (team lifecycle and membership), task board, mailbox,
 * budget and usage, memory and read projections — wired together here
 * through the shared `TeamDomainDeps` bundle. The public API, error
 * vocabulary and failure semantics are exactly those of the port.
 */
import { expectDomain } from './error.js'
import type { MemberIdentityInput } from './identity-profile.js'
import * as board from './team-domain-board.js'
import * as budget from './team-domain-budget.js'
import * as mailbox from './team-domain-mailbox.js'
import * as interaction from './team-domain-interaction.js'
import * as projection from './team-domain-projection.js'
import * as roster from './team-domain-roster.js'
import type { TeamDomainDeps } from './team-domain-shared.js'
import {
  AttemptId,
  TaskId,
  TeamId,
  TeamMessageId,
  type TaskAttempt,
  type TeamAnnouncement,
  type TeamBudget,
  type TeamLimits,
  type TeamMember,
  type TeamMembership,
  type TeamMemoryCategory,
  type TeamMessageDelivery,
  type TeamMessageCausal,
  type TeamMessage,
  type TeamState,
  type TeamStatusSnapshot,
  type TeamTask,
} from './types.js'
import type { CreateTaskInput, TeamAggregateStore, TeamDomainPort, TeamScope } from './team-domain-port.js'

export const DEFAULT_TEAM_LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxPendingMessagesPerMember: 64,
  maxRetainedMessages: 256,
  maxRetainedAttempts: 64,
  maxMessageBytes: 65_536,
  maxTaskBytes: 65_536,
  maxDependencies: 64,
  maxMemories: 512,
  maxInteractionEffects: 1024,
  maxVerificationCommands: 16,
  maxVerificationCommandMs: 600_000,
}

/** Framework-neutral Team protocol used by the DSH tool and scheduler consumers. */
export class TeamDomain implements TeamDomainPort {
  private readonly deps: TeamDomainDeps

  constructor(
    store: TeamAggregateStore,
    limits: TeamLimits = DEFAULT_TEAM_LIMITS,
    now: () => number = Date.now,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      expectDomain(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
    }
    this.deps = { store, limits, now }
  }

  async createTeam(
    scope: TeamScope,
    captainSessionId: string,
    name: string,
    description: string,
    captainUsageSeq = -1,
    managedOrigin?: string,
    allowedSkills?: readonly string[],
  ): Promise<TeamState> {
    return await roster.createTeam(this.deps, scope, captainSessionId, name, description, captainUsageSeq, managedOrigin, allowedSkills)
  }

  async findMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
    return await roster.findMembership(this.deps, scope, sessionId)
  }

  async requireMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership> {
    return await roster.requireMembership(this.deps, scope, sessionId)
  }

  async findReadMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
    return await roster.findReadMembership(this.deps, scope, sessionId)
  }

  async requireReadMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership> {
    return await roster.requireReadMembership(this.deps, scope, sessionId)
  }

  async findAccountingMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
    return await roster.findAccountingMembership(this.deps, scope, sessionId)
  }

  async provisionMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    input: { name: string; role: string; sessionId: string; provider: string } & MemberIdentityInput,
  ): Promise<TeamMember> {
    return await roster.provisionMember(this.deps, scope, teamId, captainSessionId, input)
  }

  async setCaptainProfile(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    expectedRevision: number,
    input: MemberIdentityInput,
  ): Promise<TeamState> {
    return await roster.setCaptainProfile(this.deps, scope, teamId, captainSessionId, expectedRevision, input)
  }

  async publishAnnouncement(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    expectedRevision: number,
    text: string,
  ): Promise<{ team: TeamState; announcement: TeamAnnouncement }> {
    return await roster.publishAnnouncement(this.deps, scope, teamId, captainSessionId, expectedRevision, text)
  }

  async setPublicGoal(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    expectedRevision: number,
    text: string,
  ): Promise<TeamState> {
    return await roster.setPublicGoal(this.deps, scope, teamId, captainSessionId, expectedRevision, text)
  }

  async settleMember(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    outcome: { active: true } | { active: false; error: string },
  ): Promise<TeamMember> {
    return await roster.settleMember(this.deps, scope, teamId, sessionId, outcome)
  }

  async recoverProvisioningMembers(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    diagnostic: string,
  ): Promise<TeamMember[]> {
    return await roster.recoverProvisioningMembers(this.deps, scope, teamId, captainSessionId, diagnostic)
  }

  async removeMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    name: string,
    diagnostic: string,
  ): Promise<{ member: TeamMember; requeuedTaskIds: TaskId[] }> {
    return await roster.removeMember(this.deps, scope, teamId, captainSessionId, name, diagnostic)
  }

  async archiveTeam(scope: TeamScope, teamId: TeamId, captainSessionId: string, diagnostic: string): Promise<TeamState> {
    return await roster.archiveTeam(this.deps, scope, teamId, captainSessionId, diagnostic)
  }

  async createTask(scope: TeamScope, teamId: TeamId, actorSessionId: string, input: CreateTaskInput): Promise<TeamTask> {
    return await board.createTask(this.deps, scope, teamId, actorSessionId, input)
  }

  async claimTask(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    assigneeSessionId = actorSessionId,
  ): Promise<{ task: TeamTask; attempt: TaskAttempt }> {
    return await board.claimTask(this.deps, scope, teamId, actorSessionId, taskId, expectedRevision, assigneeSessionId)
  }

  async acknowledgeAssignment(
    scope: TeamScope,
    teamId: TeamId,
    taskId: TaskId,
    attemptId: AttemptId,
  ): Promise<TaskAttempt> {
    return await board.acknowledgeAssignment(this.deps, scope, teamId, taskId, attemptId)
  }

  async submitTask(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    attemptId: AttemptId,
    output: string,
    evidence: readonly string[] = [],
  ): Promise<TeamTask> {
    return await board.submitTask(this.deps, scope, teamId, actorSessionId, taskId, expectedRevision, attemptId, output, evidence)
  }

  async reviewTask(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    attemptId: AttemptId,
    decision: 'accept' | 'reject',
    diagnostic?: string,
  ): Promise<TeamTask> {
    return await board.reviewTask(this.deps, scope, teamId, captainSessionId, taskId, expectedRevision, attemptId, decision, diagnostic)
  }

  async cancelAttempt(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    diagnostic: string,
    targetMemberSessionId?: string,
  ): Promise<TeamTask> {
    return await board.cancelAttempt(this.deps, scope, teamId, captainSessionId, taskId, expectedRevision, diagnostic, targetMemberSessionId)
  }

  async retryAttempt(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    assigneeSessionId: string,
    diagnostic: string,
  ): Promise<{ task: TeamTask; attempt: TaskAttempt }> {
    return await board.retryAttempt(this.deps, scope, teamId, captainSessionId, taskId, expectedRevision, assigneeSessionId, diagnostic)
  }

  async reinstateAttempt(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    taskId: TaskId,
    expectedRevision: number,
    misfiredAttemptId: AttemptId,
    diagnostic: string,
  ): Promise<TeamTask> {
    return await board.reinstateAttempt(this.deps, scope, teamId, captainSessionId, taskId, expectedRevision, misfiredAttemptId, diagnostic)
  }

  async queueMessage(
    scope: TeamScope,
    teamId: TeamId,
    senderSessionId: string,
    targetName: string,
    content: string,
    delivery: TeamMessageDelivery,
    causal?: TeamMessageCausal,
    supersedes?: TeamMessage['supersedes'],
  ): Promise<TeamState['messages'][number]> {
    return await mailbox.queueMessage(this.deps, scope, teamId, senderSessionId, targetName, content, delivery, causal, supersedes)
  }

  async queueMemberQuestionRelayOnce(scope: TeamScope, teamId: TeamId, senderSessionId: string, requestId: string, body: string) {
    return await interaction.queueMessageOnce(this.deps, scope, teamId, {
      requestId, step: 'member-question-relay-mail', senderSessionId, targetName: 'captain', content: body, delivery: 'wakeup',
    })
  }

  async findMemberQuestionRelayEffect(scope: TeamScope, teamId: TeamId, requestId: string, memberSessionId: string, body: string) {
    const team = await this.deps.store.read(scope, teamId)
    if (team === undefined) return undefined
    return interaction.findMemberQuestionRelayEffect(team, scope, teamId, requestId, memberSessionId, body)
  }

  async acknowledgeMessage(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId): Promise<TeamState['messages'][number]> {
    return await mailbox.acknowledgeMessage(this.deps, scope, teamId, messageId)
  }

  async markMessageObsolete(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId, reason: string): Promise<TeamState['messages'][number]> {
    return await mailbox.markMessageObsolete(this.deps, scope, teamId, messageId, reason)
  }

  async setBudget(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    limits: Pick<TeamBudget, 'tokenLimit' | 'requestLimit' | 'retryLimit' | 'deadlineAt'>,
  ): Promise<TeamBudget> {
    return await budget.setBudget(this.deps, scope, teamId, captainSessionId, limits)
  }

  async adoptBudget(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    carried: TeamBudget,
  ): Promise<TeamBudget> {
    return await budget.adoptBudget(this.deps, scope, teamId, captainSessionId, carried)
  }

  async consumeTokens(scope: TeamScope, teamId: TeamId, tokens: number): Promise<TeamBudget> {
    return await budget.consumeTokens(this.deps, scope, teamId, tokens)
  }

  async recordSessionUsage(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    eventSeq: number,
    tokens: number,
  ): Promise<TeamBudget> {
    return await budget.recordSessionUsage(this.deps, scope, teamId, sessionId, eventSeq, tokens)
  }

  async recordSessionUsageBatch(
    scope: TeamScope,
    teamId: TeamId,
    sessionId: string,
    entries: readonly { readonly eventSeq: number; readonly tokens: number }[],
  ): Promise<TeamBudget> {
    return await budget.recordSessionUsageBatch(this.deps, scope, teamId, sessionId, entries)
  }

  async addMemory(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    category: TeamMemoryCategory,
    content: string,
    evidenceRefs: readonly string[],
  ): Promise<TeamState['memory'][number]> {
    return await projection.addMemory(this.deps, scope, teamId, actorSessionId, category, content, evidenceRefs)
  }

  async snapshot(scope: TeamScope, teamId: TeamId, actorSessionId: string): Promise<TeamStatusSnapshot> {
    return await projection.snapshot(this.deps, scope, teamId, actorSessionId)
  }

  async waitForChange(
    scope: TeamScope,
    teamId: TeamId,
    actorSessionId: string,
    afterRevision: number,
    signal: AbortSignal,
  ): Promise<TeamStatusSnapshot> {
    return await projection.waitForChange(this.deps, scope, teamId, actorSessionId, afterRevision, signal)
  }
}

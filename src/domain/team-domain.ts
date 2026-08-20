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
import * as board from './team-domain-board.js'
import * as budget from './team-domain-budget.js'
import * as mailbox from './team-domain-mailbox.js'
import * as projection from './team-domain-projection.js'
import * as roster from './team-domain-roster.js'
import type { TeamDomainDeps } from './team-domain-shared.js'
import {
  AttemptId,
  TaskId,
  TeamId,
  TeamMessageId,
  type TaskAttempt,
  type TeamBudget,
  type TeamLimits,
  type TeamMember,
  type TeamMembership,
  type TeamMemoryCategory,
  type TeamMessageDelivery,
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
  maxMessageBytes: 65_536,
  maxTaskBytes: 65_536,
  maxDependencies: 64,
  maxMemories: 512,
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
  ): Promise<TeamState> {
    return await roster.createTeam(this.deps, scope, captainSessionId, name, description, captainUsageSeq)
  }

  async findMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership | undefined> {
    return await roster.findMembership(this.deps, scope, sessionId)
  }

  async requireMembership(scope: TeamScope, sessionId: string): Promise<TeamMembership> {
    return await roster.requireMembership(this.deps, scope, sessionId)
  }

  async provisionMember(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    input: { name: string; role: string; sessionId: string; provider: string },
  ): Promise<TeamMember> {
    return await roster.provisionMember(this.deps, scope, teamId, captainSessionId, input)
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
    expectedRevision: number,
    attemptId: AttemptId,
  ): Promise<TaskAttempt> {
    return await board.acknowledgeAssignment(this.deps, scope, teamId, taskId, expectedRevision, attemptId)
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
  ): Promise<TeamTask> {
    return await board.cancelAttempt(this.deps, scope, teamId, captainSessionId, taskId, expectedRevision, diagnostic)
  }

  async queueMessage(
    scope: TeamScope,
    teamId: TeamId,
    senderSessionId: string,
    targetName: string,
    content: string,
    delivery: TeamMessageDelivery,
  ): Promise<TeamState['messages'][number]> {
    return await mailbox.queueMessage(this.deps, scope, teamId, senderSessionId, targetName, content, delivery)
  }

  async acknowledgeMessage(scope: TeamScope, teamId: TeamId, messageId: TeamMessageId): Promise<TeamState['messages'][number]> {
    return await mailbox.acknowledgeMessage(this.deps, scope, teamId, messageId)
  }

  async setBudget(
    scope: TeamScope,
    teamId: TeamId,
    captainSessionId: string,
    limits: Pick<TeamBudget, 'tokenLimit' | 'requestLimit' | 'retryLimit' | 'deadlineAt'>,
  ): Promise<TeamBudget> {
    return await budget.setBudget(this.deps, scope, teamId, captainSessionId, limits)
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

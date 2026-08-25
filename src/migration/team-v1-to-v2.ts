import { assertTeamState } from '../domain/state-validation.js'
import { assertTeamStateV2 } from '../domain/state-validation-v2.js'
import type { ParkedAttemptState, TaskAttemptPhaseV2, TeamMemberPhaseV2, TeamStateV2 } from '../domain/team-state-v2.js'
import type { TaskAttempt, TeamMember, TeamState } from '../domain/types.js'
import { canonicalV2Digest, type CanonicalValue } from '../protocol/canonical-v2.js'

interface LegacyMemberMigrationEvidence {
  /** Verified official child creation-depth policy; never inferred from prose. */
  readonly maxDepth: number
  /** Required only for a legacy provisioning row after v1-writer reconciliation. */
  readonly resolvedPhase?: 'active' | 'failed'
  readonly error?: string
  /** Required for every member resolved active. */
  readonly initialPromptDigest?: string
  readonly initialMessageSeq?: number
  readonly activatedAt?: number
}

interface LegacyAttemptMigrationEvidence {
  /** Required for a legacy nonterminal running attempt. */
  readonly phase: 'reserved' | 'running' | 'parked'
  readonly parkedAt?: number
  readonly parkedReason?: ParkedAttemptState['parkedReason']
  readonly lastSessionSeq?: number
}

export interface TeamV1ToV2Evidence {
  readonly members: Readonly<Record<string, LegacyMemberMigrationEvidence>>
  readonly attempts: Readonly<Record<string, LegacyAttemptMigrationEvidence>>
}

export type TeamV1ToV2Result =
  | { readonly kind: 'transformed'; readonly team: TeamStateV2; readonly digest: string }
  | { readonly kind: 'blocked'; readonly blockers: readonly string[] }

function activeEvidence(member: TeamMember, evidence: LegacyMemberMigrationEvidence, blockers: string[]): {
  initialPromptDigest?: string; initialMessageSeq?: number; activatedAt?: number
} {
  if (!/^[0-9a-f]{64}$/.test(evidence.initialPromptDigest ?? '')
    || !Number.isSafeInteger(evidence.initialMessageSeq) || (evidence.initialMessageSeq ?? -1) < 0
    || !Number.isSafeInteger(evidence.activatedAt) || (evidence.activatedAt ?? -1) < 0) {
    blockers.push(`member ${member.sessionId}: active mapping lacks verified initial prompt/message/activation evidence`)
    return {}
  }
  return {
    initialPromptDigest: evidence.initialPromptDigest!,
    initialMessageSeq: evidence.initialMessageSeq!,
    activatedAt: evidence.activatedAt!,
  }
}

function mapMember(member: TeamMember, evidence: LegacyMemberMigrationEvidence | undefined, blockers: string[]) {
  if (evidence === undefined || !Number.isSafeInteger(evidence.maxDepth) || evidence.maxDepth < 0) {
    blockers.push(`member ${member.sessionId}: maxDepth/applied descriptor evidence is missing`)
  }
  let phase: TeamMemberPhaseV2
  if (member.phase === 'provisioning') {
    if (evidence?.resolvedPhase === undefined) {
      blockers.push(`member ${member.sessionId}: provisioning must be reconciled while v1 is still authoritative`)
      phase = 'failed'
    } else {
      phase = evidence.resolvedPhase
    }
  } else {
    phase = member.phase
  }
  const activation = phase === 'active' && evidence !== undefined ? activeEvidence(member, evidence, blockers) : {}
  const error = phase === 'failed' ? evidence?.error ?? member.error : member.error
  if (phase === 'failed' && error === undefined) blockers.push(`member ${member.sessionId}: failed mapping lacks a diagnostic`)
  return {
    name: member.name,
    role: member.role,
    sessionId: member.sessionId,
    provider: member.provider,
    ...(member.llmProvider === undefined ? {} : { llmProvider: member.llmProvider }),
    ...(member.model === undefined ? {} : { model: member.model }),
    modelSource: member.modelSource ?? 'unresolved' as const,
    deniedTools: [...(member.deniedTools ?? [])],
    assignedSkills: [...(member.assignedSkills ?? [])],
    maxDepth: evidence?.maxDepth ?? 0,
    phase,
    ...activation,
    createdAt: member.createdAt,
    ...(error === undefined ? {} : { error }),
  }
}

function mapAttempt(attempt: TaskAttempt, evidence: LegacyAttemptMigrationEvidence | undefined, blockers: string[]) {
  let phase: TaskAttemptPhaseV2 = attempt.phase
  let parked: ParkedAttemptState | undefined
  if (attempt.phase === 'running') {
    if (evidence === undefined) {
      blockers.push(`attempt ${attempt.id}: nonterminal running state lacks official migration evidence`)
      phase = attempt.assignmentPhase === 'reserved' ? 'reserved' : 'parked'
    } else {
      phase = evidence.phase
    }
    if (phase === 'reserved' && attempt.assignmentPhase !== 'reserved') {
      blockers.push(`attempt ${attempt.id}: delivered assignment cannot map to reserved`)
    }
    if (phase === 'running' && attempt.assignmentPhase !== 'delivered') {
      blockers.push(`attempt ${attempt.id}: undelivered assignment cannot map to running`)
    }
    if (phase === 'parked') {
      if (!Number.isSafeInteger(evidence?.parkedAt) || (evidence?.parkedAt ?? -1) < 0 || evidence?.parkedReason === undefined) {
        blockers.push(`attempt ${attempt.id}: parked mapping lacks classified settlement evidence`)
      }
      parked = {
        parkedAt: evidence?.parkedAt ?? attempt.updatedAt,
        parkedReason: evidence?.parkedReason ?? 'migration-unknown',
        ...(evidence?.lastSessionSeq === undefined ? {} : { lastSessionSeq: evidence.lastSessionSeq }),
        continuationPolicy: 'team-autonomous',
      }
    }
  }
  return {
    id: attempt.id,
    taskId: attempt.taskId,
    generation: attempt.generation,
    memberSessionId: attempt.memberSessionId,
    phase,
    assignmentPhase: attempt.assignmentPhase,
    ...(attempt.assignmentDeliveredAt === undefined ? {} : { assignmentDeliveredAt: attempt.assignmentDeliveredAt }),
    ...(attempt.replacesAttemptId === undefined ? {} : { replacesAttemptId: attempt.replacesAttemptId }),
    ...(parked === undefined ? {} : { parked }),
    dispatchEpochs: [],
    ...(attempt.output === undefined ? {} : { output: attempt.output }),
    evidence: [...attempt.evidence],
    ...(attempt.diagnostic === undefined ? {} : { diagnostic: attempt.diagnostic }),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  }
}

/**
 * Pure, deterministic disposable-fixture transform. It performs no I/O and
 * refuses to infer creation policy, provisioning outcome or running state.
 */
export function transformTeamV1ToV2(source: TeamState, evidence: TeamV1ToV2Evidence): TeamV1ToV2Result {
  const blockers: string[] = []
  try {
    assertTeamState(source, `${source.id}/v1-transform-source`)
  } catch (error) {
    return { kind: 'blocked', blockers: [error instanceof Error ? error.message : 'legacy Team state is invalid'] }
  }
  const team: TeamStateV2 = {
    schemaVersion: 2,
    id: source.id,
    revision: source.revision,
    name: source.name,
    description: source.description,
    captainSessionId: source.captainSessionId,
    phase: source.phase,
    members: source.members.map(member => mapMember(member, evidence.members[member.sessionId], blockers)),
    tasks: structuredClone(source.tasks),
    attempts: source.attempts.map(attempt => mapAttempt(attempt, evidence.attempts[attempt.id], blockers)),
    messages: structuredClone(source.messages),
    interactionEffects: [],
    budget: structuredClone(source.budget),
    usageCursors: structuredClone(source.usageCursors),
    memory: structuredClone(source.memory),
    nextTaskNumber: source.nextTaskNumber,
    nextMemoryNumber: source.nextMemoryNumber,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
  if (blockers.length > 0) return { kind: 'blocked', blockers }
  try {
    assertTeamStateV2(team, `${source.id}/v2-transform-target`)
  } catch (error) {
    return { kind: 'blocked', blockers: [error instanceof Error ? error.message : 'transformed Team v2 state is invalid'] }
  }
  const canonical = JSON.parse(JSON.stringify(team)) as CanonicalValue
  return {
    kind: 'transformed',
    team,
    digest: canonicalV2Digest('dsh-agent-swarm/team-state/v2', canonical),
  }
}

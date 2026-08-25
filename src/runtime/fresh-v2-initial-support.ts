import { TeamDomainError } from '../domain/error.js'
import type { InitialDispatchCheckpoint } from '../domain/team-domain-v2-start.js'
import type { ModelDispatchEpoch, TaskAttemptV2, TeamMemberV2, TeamStateV2 } from '../domain/team-state-v2.js'
import type { TeamTask } from '../domain/types.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import type { VerificationDeclaration } from './verification-commands.js'

export function describeFreshV2Error(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function initialCheckpointOf(
  member: TeamMemberV2,
  dispatch: ModelDispatchEpoch,
): InitialDispatchCheckpoint {
  if (member.initialPromptDigest === undefined || dispatch.messageSeq === undefined
    || dispatch.turn === undefined || dispatch.step === undefined) {
    throw new TeamDomainError('initial dispatch lacks its persisted Session fence', 'TEAM_STATE_CORRUPT')
  }
  return {
    initialPromptDigest: member.initialPromptDigest,
    messageSeq: dispatch.messageSeq,
    turn: dispatch.turn,
    step: dispatch.step,
    witnessCapabilityDigest: dispatch.witnessCapabilityDigest,
    dispatchId: dispatch.dispatchId,
    effectId: dispatch.effectId,
  }
}

export function compileInitialVerification(
  declarations: readonly VerificationDeclaration[] | undefined,
  maximum: number,
  maximumMs: number,
): TeamTask['verification'] {
  if (declarations === undefined) return undefined
  if (declarations.length > maximum) {
    throw new TeamDomainError(`at most ${maximum} verification commands are supported`, 'TEAM_INPUT_INVALID')
  }
  return declarations.map(declaration => {
    if (!('command' in declaration) || declaration.command.trim() === '') {
      throw new TeamDomainError('fresh-v2 A1b accepts concrete verification commands only', 'TEAM_INPUT_INVALID')
    }
    if (declaration.timeoutMs !== undefined
      && (!Number.isSafeInteger(declaration.timeoutMs) || declaration.timeoutMs < 1 || declaration.timeoutMs > maximumMs)) {
      throw new TeamDomainError(`verification timeout must be from 1 through ${maximumMs}ms`, 'TEAM_INPUT_INVALID')
    }
    return {
      command: declaration.command,
      ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
    }
  })
}

export type FreshV2Membership =
  | { readonly role: 'captain'; readonly team: TeamStateV2 }
  | { readonly role: 'member'; readonly team: TeamStateV2; readonly member: TeamMemberV2 }

export interface CurrentInitialAttempt {
  readonly task: TeamTask
  readonly attempt: TaskAttemptV2
  readonly member: TeamMemberV2
  readonly dispatch?: ModelDispatchEpoch
}

export interface CurrentFreshV2TaskAttempt {
  readonly task: TeamTask
  readonly attempt: TaskAttemptV2
  readonly member: TeamMemberV2
}

export function findFreshV2Membership(
  store: StorageDomainTeamStoreV2,
  scope: string,
  sessionId: string,
): FreshV2Membership | undefined {
  const matches: FreshV2Membership[] = []
  for (const team of store.list(scope)) {
    if (team.phase !== 'active') continue
    if (team.captainSessionId === sessionId) matches.push({ role: 'captain', team })
    const member = team.members.find(candidate => candidate.sessionId === sessionId)
    if (member !== undefined) matches.push({ role: 'member', team, member })
  }
  if (matches.length > 1) throw new TeamDomainError('Team membership is ambiguous', 'TEAM_MEMBERSHIP_AMBIGUOUS')
  return matches[0]
}

export function currentFreshV2InitialAttempt(
  team: TeamStateV2,
  sessionId: string,
): CurrentInitialAttempt | undefined {
  const current = currentFreshV2TaskAttempt(team, sessionId)
  if (current === undefined) return undefined
  return {
    ...current,
    ...(current.attempt.dispatchEpochs[0] === undefined ? {} : { dispatch: current.attempt.dispatchEpochs[0] }),
  }
}

export function currentFreshV2TaskAttempt(
  team: TeamStateV2,
  sessionId: string,
): CurrentFreshV2TaskAttempt | undefined {
  const member = team.members.find(candidate => candidate.sessionId === sessionId)
  if (member === undefined) return undefined
  const tasks = team.tasks.filter(task => task.ownerSessionId === sessionId
    && task.status === 'in_progress' && task.currentAttemptId !== undefined)
  if (tasks.length === 0) return undefined
  if (tasks.length !== 1) throw new TeamDomainError('member owns multiple current tasks', 'TEAM_STATE_CORRUPT')
  const task = tasks[0]!
  const attempt = team.attempts.find(candidate => candidate.id === task.currentAttemptId)
  if (attempt === undefined) throw new TeamDomainError('current task lacks its Attempt', 'TEAM_STATE_CORRUPT')
  return { task, attempt, member }
}

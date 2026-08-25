import { z } from 'zod'
import { TeamDomainError } from './error.js'
import { assertTaskGraph } from './graph.js'
import {
  MAX_V2_DISPATCH_EPOCHS_PER_ATTEMPT,
  MAX_V2_EFFECT_RECEIPTS,
  type ContinuationPrincipal,
  type TeamStateV2,
} from './team-state-v2.js'

const text = z.string().min(1)
const timestamp = z.number().int().min(0)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const sessionId = text

const memberSchema = z.object({
  name: text,
  role: text,
  sessionId,
  provider: text,
  llmProvider: text.optional(),
  model: text.optional(),
  modelSource: z.enum(['explicit', 'member-default', 'captain-inherited', 'unresolved']),
  deniedTools: z.array(text),
  assignedSkills: z.array(text),
  maxDepth: z.number().int().min(0),
  phase: z.enum(['declared', 'starting', 'active', 'failed', 'removed']),
  startingAttemptId: text.optional(),
  initialPromptDigest: digest.optional(),
  initialMessageSeq: z.number().int().min(0).optional(),
  activatedAt: timestamp.optional(),
  createdAt: timestamp,
  error: text.optional(),
}).strict()

const verificationSchema = z.object({
  command: text,
  timeoutMs: z.number().int().min(1).optional(),
}).strict()

const taskSchema = z.object({
  id: text,
  revision: z.number().int().min(1),
  subject: text,
  description: text,
  acceptanceCriteria: z.array(text),
  status: z.enum(['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled']),
  blockedBy: z.array(text),
  writeScopes: z.array(text),
  priority: z.number().int(),
  verification: z.array(verificationSchema).optional(),
  reservationTokens: z.number().int().min(1).optional(),
  targetMemberSessionId: sessionId.optional(),
  ownerSessionId: sessionId.optional(),
  currentAttemptId: text.optional(),
  output: text.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const principalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), memberId: text, memberSessionId: sessionId }).strict(),
  z.object({ kind: z.literal('team-leader'), captainSessionId: sessionId }).strict(),
  z.object({ kind: z.literal('authenticated-human'), subjectId: text, attestationDigest: digest }).strict(),
])

const continuationIntentSchema = z.object({
  continuationEffectId: text,
  taskId: text,
  attemptId: text,
  expectedTaskRevision: z.number().int().min(1),
  requestedBy: principalSchema,
  requestedAt: timestamp,
  checkpointDigest: digest.optional(),
  wakeCondition: text.optional(),
  resumeEffectId: text.optional(),
  currentDispatchId: text.optional(),
  phase: z.enum([
    'requested', 'admitted', 'claimed', 'dispatch-pending', 'dispatch-entered',
    'dispatch-unknown', 'settled', 'superseded', 'cancelled',
  ]),
}).strict()

const parkedSchema = z.object({
  parkedAt: timestamp,
  parkedReason: z.enum(['turn-settled', 'owner-not-live', 'migration-unknown']),
  lastSessionSeq: z.number().int().min(0).optional(),
  continuationPolicy: z.enum(['team-autonomous', 'captain', 'human']),
  currentContinuationIntentId: text.optional(),
}).strict()

const dispatchEpochSchema = z.object({
  dispatchId: text,
  kind: z.enum(['initial', 'continuation', 'recovery']),
  ordinal: z.number().int().min(1),
  effectId: text,
  recoveryOf: text.optional(),
  recoveryProofTurnEndSeq: z.number().int().min(0).optional(),
  recoveryProofDigest: digest.optional(),
  targetSessionId: sessionId,
  frameMessageId: text.optional(),
  turn: z.number().int().min(1).optional(),
  step: z.number().int().min(1).optional(),
  messageSeq: z.number().int().min(0).optional(),
  witnessCapabilityDigest: digest,
  assistantEvidenceSeq: z.number().int().min(0).optional(),
  assistantEvidenceType: z.literal('assistant/message').optional(),
  turnEndEvidenceSeq: z.number().int().min(0).optional(),
  turnEndEvidenceReason: z.enum(['completed', 'aborted', 'blocked', 'error', 'max-tokens']).optional(),
  phase: z.enum([
    'frame-pending', 'frame-claimed', 'dispatch-pending', 'dispatch-entered',
    'dispatch-unknown', 'settled', 'superseded', 'cancelled',
  ]),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const attemptSchema = z.object({
  id: text,
  taskId: text,
  generation: z.number().int().min(1),
  memberSessionId: sessionId,
  phase: z.enum(['reserved', 'running', 'parked', 'submitted', 'verifying', 'accepted', 'rejected', 'cancelled', 'stale']),
  assignmentPhase: z.enum(['reserved', 'delivered']),
  assignmentDeliveredAt: timestamp.optional(),
  replacesAttemptId: text.optional(),
  parked: parkedSchema.optional(),
  currentContinuationIntent: continuationIntentSchema.optional(),
  dispatchEpochs: z.array(dispatchEpochSchema).max(MAX_V2_DISPATCH_EPOCHS_PER_ATTEMPT),
  output: text.optional(),
  evidence: z.array(text),
  diagnostic: text.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const messageSchema = z.object({
  id: text,
  senderSessionId: sessionId,
  senderName: text,
  targetSessionId: sessionId,
  targetName: text,
  content: text,
  delivery: z.enum(['quiet', 'wakeup']),
  phase: z.enum(['queued', 'delivered', 'cancelled']),
  createdAt: timestamp,
  deliveredAt: timestamp.optional(),
}).strict()

const effectSchema = z.object({
  effectId: text,
  kind: z.enum(['interaction', 'model-dispatch', 'continuation', 'continuation-recovery']),
  status: z.enum(['applied', 'settled', 'superseded', 'cancelled']),
  appliedAt: timestamp,
  resultingTeamRevision: z.number().int().min(1),
  requestId: text.optional(),
  step: z.enum(['relay-mail', 'answer-mail', 'wake-mail', 'correct-mail', 'task-reassign', 'task-review']).optional(),
  taskId: text.optional(),
  attemptId: text.optional(),
  dispatchId: text.optional(),
  recoveryOf: text.optional(),
  recoveryProofTurnEndSeq: z.number().int().min(0).optional(),
  recoveryProofDigest: digest.optional(),
  decision: z.enum(['accept', 'reject']).optional(),
  continuationEffectId: text.optional(),
  continuationRequestedBy: principalSchema.optional(),
  continuationRequestedAt: timestamp.optional(),
  continuationExpectedTaskRevision: z.number().int().min(1).optional(),
  continuationCheckpointDigest: digest.optional(),
  continuationWakeCondition: text.optional(),
}).strict()

const budgetSchema = z.strictObject({
  tokenLimit: z.number().int().positive().optional(),
  requestLimit: z.number().int().positive().optional(),
  retryLimit: z.number().int().positive().optional(),
  deadlineAt: z.number().int().positive().optional(),
  usedTokens: z.number().int().nonnegative(),
  usedRequests: z.number().int().nonnegative(),
  usedRetries: z.number().int().nonnegative(),
})

const memorySchema = z.object({
  id: text,
  category: z.enum(['decision', 'lesson', 'member', 'context']),
  content: text,
  evidenceRefs: z.array(text),
  scope: z.enum(['team', 'member']).optional(),
  ownerSessionId: sessionId.optional(),
  authorSessionId: sessionId.optional(),
  createdAt: timestamp,
}).strict()

export const teamStateV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^team-[a-z0-9-]{8,80}$/),
  revision: z.number().int().min(1),
  name: text,
  description: text,
  captainSessionId: sessionId,
  phase: z.enum(['active', 'archived']),
  usageCursors: z.record(text, z.number().int().min(-1)),
  members: z.array(memberSchema),
  tasks: z.array(taskSchema),
  attempts: z.array(attemptSchema),
  messages: z.array(messageSchema),
  interactionEffects: z.array(effectSchema).max(MAX_V2_EFFECT_RECEIPTS),
  budget: budgetSchema,
  memory: z.array(memorySchema),
  nextTaskNumber: z.number().int().min(1), nextMemoryNumber: z.number().int().min(1),
  createdAt: timestamp, updatedAt: timestamp,
})

function fail(path: string, detail: string): never {
  throw new TeamDomainError(`invalid Team v2 state at ${path}: ${detail}`, 'TEAM_STATE_CORRUPT')
}

function unique(values: readonly string[], path: string, label: string): void {
  if (new Set(values).size !== values.length) fail(path, `${label} contains duplicate identities`)
}

function principalIdentity(principal: ContinuationPrincipal): string {
  if (principal.kind === 'member') return `member:${principal.memberId}:${principal.memberSessionId}`
  if (principal.kind === 'team-leader') return `team-leader:${principal.captainSessionId}`
  return `authenticated-human:${principal.subjectId}:${principal.attestationDigest}`
}

const LIVE_TASKS = new Set(['in_progress', 'submitted', 'verifying'])
const EXECUTION_BOUND_TASKS = new Set([...LIVE_TASKS, 'completed'])
const NONTERMINAL_INTENTS = new Set(['requested', 'admitted', 'claimed', 'dispatch-pending', 'dispatch-entered', 'dispatch-unknown'])

/** Strict structural plus cross-record semantic validation for Team schema v2. */
export function assertTeamStateV2(value: unknown, path: string): asserts value is TeamStateV2 {
  const parsed = teamStateV2Schema.safeParse(value)
  if (!parsed.success) fail(path, z.prettifyError(parsed.error))
  const team = parsed.data as TeamStateV2
  unique(team.members.map(member => member.sessionId), path, 'member session ids')
  unique(team.members.map(member => member.name), path, 'member names')
  unique(team.tasks.map(task => task.id), path, 'task ids')
  unique(team.attempts.map(attempt => attempt.id), path, 'attempt ids')
  unique(team.messages.map(message => message.id), path, 'message ids')
  unique(team.interactionEffects.map(effect => effect.effectId), path, 'effect ids')

  const members = new Map<string, TeamStateV2['members'][number]>(team.members.map(member => [member.sessionId, member]))
  const tasks = new Map<string, TeamStateV2['tasks'][number]>(team.tasks.map(task => [task.id, task]))
  const attempts = new Map<string, TeamStateV2['attempts'][number]>(team.attempts.map(attempt => [attempt.id, attempt]))
  const allDispatchIds: string[] = []

  for (const task of team.tasks) {
    if (task.targetMemberSessionId !== undefined && !members.has(task.targetMemberSessionId)) {
      fail(path, `task ${task.id} targets a missing member`)
    }
    const executionBound = EXECUTION_BOUND_TASKS.has(task.status)
    if (executionBound !== (task.ownerSessionId !== undefined && task.currentAttemptId !== undefined)) {
      fail(path, `task ${task.id} execution fields do not match status ${task.status}`)
    }
    if (task.currentAttemptId !== undefined) {
      const attempt = attempts.get(task.currentAttemptId)
      if (attempt === undefined || attempt.taskId !== task.id || attempt.memberSessionId !== task.ownerSessionId) {
        fail(path, `task ${task.id} current attempt/owner tuple is inconsistent`)
      }
    }
  }

  for (const attempt of team.attempts) {
    if (!tasks.has(attempt.taskId)) fail(path, `attempt ${attempt.id} references a missing task`)
    if (!members.has(attempt.memberSessionId)) fail(path, `attempt ${attempt.id} references a missing member`)
    if ((attempt.assignmentPhase === 'delivered') !== (attempt.assignmentDeliveredAt !== undefined)) {
      fail(path, `attempt ${attempt.id} assignment checkpoint is inconsistent`)
    }
    if ((attempt.phase === 'parked') !== (attempt.parked !== undefined)) {
      fail(path, `attempt ${attempt.id} parked metadata does not match its phase`)
    }
    if (attempt.replacesAttemptId === attempt.id) fail(path, `attempt ${attempt.id} replaces itself`)
    if (attempt.currentContinuationIntent !== undefined) {
      const intent = attempt.currentContinuationIntent
      if (intent.attemptId !== attempt.id || intent.taskId !== attempt.taskId || !NONTERMINAL_INTENTS.has(intent.phase)) {
        fail(path, `attempt ${attempt.id} current continuation intent is stale or terminal`)
      }
      const preParkRequest = intent.phase === 'requested' && attempt.phase === 'running'
      if (preParkRequest) {
        if (attempt.parked !== undefined || intent.resumeEffectId !== undefined || intent.currentDispatchId !== undefined) {
          fail(path, `attempt ${attempt.id} pre-park continuation request carries admitted effect state`)
        }
      } else if (attempt.parked?.currentContinuationIntentId !== intent.continuationEffectId) {
        fail(path, `attempt ${attempt.id} continuation slot does not match parked metadata`)
      }
      const dispatch = intent.currentDispatchId === undefined
        ? undefined : attempt.dispatchEpochs.find(epoch => epoch.dispatchId === intent.currentDispatchId)
      if (intent.phase === 'requested') {
        if (intent.resumeEffectId !== undefined || intent.currentDispatchId !== undefined || dispatch !== undefined) {
          fail(path, `attempt ${attempt.id} requested continuation carries admitted dispatch state`)
        }
      } else {
        if (intent.resumeEffectId === undefined || intent.currentDispatchId === undefined || dispatch === undefined
          || dispatch.kind !== 'continuation' || dispatch.effectId !== intent.resumeEffectId) {
          fail(path, `attempt ${attempt.id} continuation intent lost its admitted dispatch tuple`)
        }
        const expectedDispatchPhase = intent.phase === 'admitted'
          ? 'frame-pending'
          : intent.phase === 'claimed' ? 'frame-claimed' : intent.phase
        if (dispatch.phase !== expectedDispatchPhase) {
          fail(path, `attempt ${attempt.id} continuation intent/dispatch phases are inconsistent`)
        }
        const reservation = team.interactionEffects.find(effect => effect.effectId === intent.resumeEffectId)
        if (reservation?.kind !== 'continuation' || reservation.status !== 'applied'
          || reservation.requestId !== intent.continuationEffectId
          || reservation.dispatchId !== intent.currentDispatchId) {
          fail(path, `attempt ${attempt.id} continuation intent lacks its active reservation`)
        }
      }
    } else if (attempt.parked?.currentContinuationIntentId !== undefined) {
      fail(path, `attempt ${attempt.id} names a missing continuation intent`)
    }
    const ordinals = attempt.dispatchEpochs.map(epoch => epoch.ordinal)
    unique(ordinals.map(String), path, `attempt ${attempt.id} dispatch ordinals`)
    for (let index = 0; index < ordinals.length; index += 1) {
      if (ordinals[index] !== index + 1) fail(path, `attempt ${attempt.id} dispatch ordinals are not contiguous`)
    }
    for (const epoch of attempt.dispatchEpochs) {
      allDispatchIds.push(epoch.dispatchId)
      if (epoch.targetSessionId !== attempt.memberSessionId) fail(path, `dispatch ${epoch.dispatchId} targets another member`)
      if (epoch.kind === 'initial' && epoch.frameMessageId !== undefined) {
        fail(path, `initial dispatch ${epoch.dispatchId} carries a continuation inbox identity`)
      }
      if ((epoch.kind === 'continuation' || epoch.kind === 'recovery')
        && epoch.phase !== 'frame-pending' && epoch.frameMessageId === undefined) {
        fail(path, `continuation dispatch ${epoch.dispatchId} lacks its official inbox identity`)
      }
      const bound = epoch.turn !== undefined && epoch.step !== undefined && epoch.messageSeq !== undefined
      if (['dispatch-pending', 'dispatch-entered', 'dispatch-unknown', 'settled'].includes(epoch.phase) && !bound) {
        fail(path, `dispatch ${epoch.dispatchId} lacks its Session turn/step/message fence`)
      }
      const hasAssistantEvidence = epoch.assistantEvidenceSeq !== undefined
        && epoch.assistantEvidenceType !== undefined
      const hasTurnEndEvidence = epoch.turnEndEvidenceSeq !== undefined
        && epoch.turnEndEvidenceReason !== undefined
      if ((epoch.assistantEvidenceSeq !== undefined) !== (epoch.assistantEvidenceType !== undefined)) {
        fail(path, `dispatch ${epoch.dispatchId} carries a partial assistant evidence fence`)
      }
      if ((epoch.turnEndEvidenceSeq !== undefined) !== (epoch.turnEndEvidenceReason !== undefined)) {
        fail(path, `dispatch ${epoch.dispatchId} carries a partial turn-end evidence fence`)
      }
      if (hasAssistantEvidence && hasTurnEndEvidence) {
        fail(path, `dispatch ${epoch.dispatchId} carries competing terminal evidence`)
      }
      if ((epoch.phase === 'settled') !== (hasAssistantEvidence || hasTurnEndEvidence)) {
        fail(path, `dispatch ${epoch.dispatchId} terminal evidence does not match its phase`)
      }
      if (epoch.kind === 'recovery' && (epoch.recoveryOf === undefined
        || epoch.recoveryProofTurnEndSeq === undefined || epoch.recoveryProofDigest === undefined)) {
        fail(path, `recovery dispatch ${epoch.dispatchId} lacks its cold proof fence`)
      }
      if (epoch.kind === 'recovery') {
        const receipt = team.interactionEffects.find(effect => effect.effectId === epoch.effectId)
        if (receipt?.kind !== 'continuation-recovery' || receipt.dispatchId !== epoch.dispatchId
          || receipt.recoveryOf !== epoch.recoveryOf) {
          fail(path, `recovery dispatch ${epoch.dispatchId} lacks its recovery receipt`)
        }
      }
      if (epoch.kind !== 'recovery' && (epoch.recoveryOf !== undefined
        || epoch.recoveryProofTurnEndSeq !== undefined || epoch.recoveryProofDigest !== undefined)) {
        fail(path, `non-recovery dispatch ${epoch.dispatchId} has recovery metadata`)
      }
    }
    const stagedRecoveries = attempt.dispatchEpochs.filter(epoch => epoch.kind === 'recovery'
      && epoch.phase === 'frame-pending'
      && epoch.recoveryOf === attempt.currentContinuationIntent?.currentDispatchId)
    if (stagedRecoveries.length > 1) fail(path, `attempt ${attempt.id} has competing staged recovery reservations`)
    if (attempt.phase === 'running'
      && (attempt.assignmentPhase !== 'delivered' || !attempt.dispatchEpochs.some(epoch => epoch.phase === 'settled'))) {
      fail(path, `running attempt ${attempt.id} lacks settled model-dispatch evidence`)
    }
  }
  unique(allDispatchIds, path, 'dispatch ids')

  const startingIds: string[] = []
  for (const member of team.members) {
    const starting = member.phase === 'starting'
    if (starting !== (member.startingAttemptId !== undefined)) fail(path, `member ${member.name} starting fence is inconsistent`)
    if (starting) {
      if (member.initialPromptDigest === undefined || member.initialMessageSeq !== undefined || member.activatedAt !== undefined) {
        fail(path, `member ${member.name} starting checkpoint is inconsistent`)
      }
      const attempt = attempts.get(member.startingAttemptId!)
      const task = attempt === undefined ? undefined : tasks.get(attempt.taskId)
      if (attempt === undefined || task === undefined
        || task.status !== 'in_progress'
        || task.currentAttemptId !== attempt.id
        || task.ownerSessionId !== member.sessionId
        || attempt.memberSessionId !== member.sessionId
        || attempt.phase !== 'reserved'
        || attempt.assignmentPhase !== 'reserved'
        || attempt.dispatchEpochs.length !== 0) {
        fail(path, `member ${member.name} starting attempt tuple is inconsistent`)
      }
      startingIds.push(member.startingAttemptId!)
    }
    if (member.phase === 'declared') {
      if (member.initialPromptDigest !== undefined || member.initialMessageSeq !== undefined || member.activatedAt !== undefined) {
        fail(path, `declared member ${member.name} carries activation evidence`)
      }
      if (team.tasks.some(task => LIVE_TASKS.has(task.status) && task.ownerSessionId === member.sessionId)) {
        fail(path, `declared member ${member.name} owns open work`)
      }
    }
    if (member.phase === 'active'
      && (member.initialPromptDigest === undefined || member.initialMessageSeq === undefined || member.activatedAt === undefined)) {
      fail(path, `active member ${member.name} lacks initial activation evidence`)
    }
    if ((member.phase === 'failed' || member.phase === 'removed')
      && team.tasks.some(task => LIVE_TASKS.has(task.status) && task.ownerSessionId === member.sessionId)) {
      fail(path, `terminal member ${member.name} owns open work`)
    }
  }
  unique(startingIds, path, 'member starting attempt ids')

  for (const effect of team.interactionEffects) {
    if (effect.resultingTeamRevision > team.revision) fail(path, `effect ${effect.effectId} names a future Team revision`)
    if (effect.kind === 'continuation-recovery') {
      if (effect.requestId === undefined || effect.taskId === undefined || effect.attemptId === undefined
        || effect.dispatchId === undefined || effect.recoveryOf === undefined
        || effect.recoveryProofTurnEndSeq === undefined || effect.recoveryProofDigest === undefined) {
        fail(path, `continuation recovery effect ${effect.effectId} lacks its complete tuple`)
      }
      const attempt = attempts.get(effect.attemptId)
      const dispatch = attempt?.dispatchEpochs.find(epoch => epoch.dispatchId === effect.dispatchId)
      const recovered = attempt?.dispatchEpochs.find(epoch => epoch.dispatchId === effect.recoveryOf)
      if (attempt === undefined || attempt.taskId !== effect.taskId || dispatch?.kind !== 'recovery'
        || dispatch.effectId !== effect.effectId || dispatch.recoveryOf !== effect.recoveryOf
        || dispatch.recoveryProofTurnEndSeq !== effect.recoveryProofTurnEndSeq
        || dispatch.recoveryProofDigest !== effect.recoveryProofDigest
        || recovered === undefined || recovered.ordinal >= dispatch.ordinal) {
        fail(path, `continuation recovery effect ${effect.effectId} lost its Attempt/dispatch tuple`)
      }
      if (effect.status === 'applied') {
        const intent = attempt.currentContinuationIntent
        if (dispatch.phase !== 'frame-pending' || intent === undefined
          || intent.currentDispatchId !== effect.recoveryOf
          || intent.phase !== 'dispatch-pending') {
          fail(path, `continuation recovery effect ${effect.effectId} is not an exact pending reservation`)
        }
      }
      continue
    }
    if (effect.kind !== 'continuation') continue
    if (effect.requestId === undefined || effect.taskId === undefined || effect.attemptId === undefined
      || effect.dispatchId === undefined || effect.continuationEffectId !== effect.requestId
      || effect.continuationRequestedBy === undefined || effect.continuationRequestedAt === undefined
      || effect.continuationExpectedTaskRevision === undefined) {
      fail(path, `continuation effect ${effect.effectId} lacks its complete request tuple`)
    }
    const attempt = attempts.get(effect.attemptId)
    const dispatch = attempt?.dispatchEpochs.find(epoch => epoch.dispatchId === effect.dispatchId)
    if (attempt === undefined || attempt.taskId !== effect.taskId || dispatch?.effectId !== effect.effectId
      || dispatch.kind !== 'continuation') {
      fail(path, `continuation effect ${effect.effectId} lost its Attempt/dispatch tuple`)
    }
    if (effect.status === 'applied') {
      const intent = attempt.currentContinuationIntent
      if (intent === undefined || intent.phase === 'requested'
        || intent.continuationEffectId !== effect.requestId
        || intent.resumeEffectId !== effect.effectId || intent.currentDispatchId !== effect.dispatchId
        || intent.requestedAt !== effect.continuationRequestedAt
        || intent.expectedTaskRevision !== effect.continuationExpectedTaskRevision
        || intent.checkpointDigest !== effect.continuationCheckpointDigest
        || intent.wakeCondition !== effect.continuationWakeCondition
        || principalIdentity(intent.requestedBy) !== principalIdentity(effect.continuationRequestedBy)) {
        fail(path, `continuation effect ${effect.effectId} is not an exact active reservation`)
      }
    } else if (effect.status === 'settled') {
      if (dispatch.phase !== 'settled'
        || attempt.currentContinuationIntent?.continuationEffectId === effect.requestId) {
        fail(path, `continuation effect ${effect.effectId} settlement is inconsistent`)
      }
    }
  }
  try {
    assertTaskGraph(team.tasks)
  } catch (error) {
    fail(path, error instanceof Error ? error.message : 'task graph is invalid')
  }
}

import { TeamDomainError } from './error.js'
import { assertTaskGraph } from './graph.js'
import { CAPTAIN_ANNOUNCEMENT_ID_RE, isSafePixelAvatarSvg, MAX_CAPTAIN_ANNOUNCEMENTS, MAX_CAPTAIN_ANNOUNCEMENT_TEXT } from './identity-profile.js'
import type { TeamState } from './types.js'

const TASK_STATUSES = new Set(['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled'])
const ATTEMPT_PHASES = new Set(['running', 'submitted', 'verifying', 'accepted', 'rejected', 'cancelled', 'stale'])
const MEMBER_PHASES = new Set(['provisioning', 'active', 'failed', 'removed'])
const MESSAGE_PHASES = new Set(['queued', 'delivered', 'cancelled', 'obsolete'])
const MEMORY_CATEGORIES = new Set(['decision', 'lesson', 'member', 'context'])
const INTERACTION_EFFECT_KEYS = new Set([
  'effectId', 'requestId', 'step', 'bindingDigest', 'senderSessionId', 'targetSessionId',
  'bodyDigest', 'delivery', 'messageId', 'resultingTeamRevision', 'committedAt',
])
const CAPTAIN_PROFILE_KEYS = new Set(['displayName', 'profession', 'personality', 'pixelAvatarSvg'])
const ANNOUNCEMENT_KEYS = new Set(['id', 'text', 'createdAt'])

function corrupt(path: string, detail: string): never {
  throw new TeamDomainError(`invalid Team state at ${path}: ${detail}`, 'TEAM_STATE_CORRUPT')
}

function record(value: unknown, path: string, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(path, `${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, path: string, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) corrupt(path, `unknown field ${JSON.stringify(key)}`)
}

function text(value: unknown, path: string, label: string): string {
  if (typeof value !== 'string' || value === '') corrupt(path, `${label} must be a non-empty string`)
  return value
}

/** Non-empty text bounded by the same code-point limit as admission. */
function codePointText(value: unknown, max: number, path: string, label: string): string {
  const result = text(value, path, label)
  if ([...result].length > max) corrupt(path, `${label} exceeds ${max} code points`)
  return result
}

function integer(value: unknown, path: string, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) corrupt(path, `${label} must be a safe integer >= ${minimum}`)
  return value as number
}

function list(value: unknown, path: string, label: string): unknown[] {
  if (!Array.isArray(value)) corrupt(path, `${label} must be an array`)
  return value
}

function stringList(value: unknown, path: string, label: string): string[] {
  return list(value, path, label).map((item, index) => text(item, path, `${label}[${index}]`))
}

function unique(values: readonly string[], path: string, label: string): void {
  if (new Set(values).size !== values.length) corrupt(path, `${label} contains duplicate identities`)
}

/** Validate the complete persisted compatibility format before it gains domain authority. */
export function assertTeamState(value: unknown, path: string): asserts value is TeamState {
  const team = record(value, path, 'root')
  if (team.schemaVersion !== 1 && team.schemaVersion !== 2) corrupt(path, 'schemaVersion must be 1 or 2')
  const teamId = text(team.id, path, 'id')
  if (!/^team-[a-z0-9-]{8,80}$/.test(teamId)) corrupt(path, 'id is malformed')
  integer(team.revision, path, 'revision', 1)
  text(team.name, path, 'name')
  text(team.description, path, 'description')
  text(team.captainSessionId, path, 'captainSessionId')
  if (team.phase !== 'active' && team.phase !== 'archived') corrupt(path, 'phase is invalid')
  integer(team.nextTaskNumber, path, 'nextTaskNumber', 1)
  integer(team.nextMemoryNumber, path, 'nextMemoryNumber', 1)
  integer(team.createdAt, path, 'createdAt')
  integer(team.updatedAt, path, 'updatedAt')

  const members = list(team.members, path, 'members').map((raw, index) => {
    const member = record(raw, path, `members[${index}]`)
    text(member.name, path, `members[${index}].name`)
    text(member.role, path, `members[${index}].role`)
    text(member.sessionId, path, `members[${index}].sessionId`)
    text(member.provider, path, `members[${index}].provider`)
    if (!MEMBER_PHASES.has(String(member.phase))) corrupt(path, `members[${index}].phase is invalid`)
    integer(member.createdAt, path, `members[${index}].createdAt`)
    if (member.error !== undefined) text(member.error, path, `members[${index}].error`)
    if (member.displayName !== undefined) codePointText(member.displayName, 128, path, `members[${index}].displayName`)
    if (member.profession !== undefined) codePointText(member.profession, 256, path, `members[${index}].profession`)
    if (member.personality !== undefined) codePointText(member.personality, 1024, path, `members[${index}].personality`)
    if (member.pixelAvatarSvg !== undefined) {
      if (typeof member.pixelAvatarSvg !== 'string' || !isSafePixelAvatarSvg(member.pixelAvatarSvg)) {
        corrupt(path, `members[${index}].pixelAvatarSvg violates the strict allowlist`)
      }
    }
    return member
  })
  unique(members.map(member => member.sessionId as string), path, 'member session ids')

  if (team.captainProfile !== undefined) {
    // Captain profile must be a plain object carrying at least one canonical field.
    const profile = record(team.captainProfile, path, 'captainProfile')
    exactKeys(profile, `${path}.captainProfile`, CAPTAIN_PROFILE_KEYS)
    const hasField = profile.displayName !== undefined || profile.profession !== undefined
      || profile.personality !== undefined || profile.pixelAvatarSvg !== undefined
    if (!hasField) corrupt(path, 'captainProfile requires at least one field')
    if (profile.displayName !== undefined) codePointText(profile.displayName, 128, path, 'captainProfile.displayName')
    if (profile.profession !== undefined) codePointText(profile.profession, 256, path, 'captainProfile.profession')
    if (profile.personality !== undefined) codePointText(profile.personality, 1024, path, 'captainProfile.personality')
    if (profile.displayName !== undefined && String(profile.displayName) !== String(profile.displayName).trim()) corrupt(path, 'captainProfile.displayName must be canonical (trimmed)')
    if (profile.profession !== undefined && String(profile.profession) !== String(profile.profession).trim()) corrupt(path, 'captainProfile.profession must be canonical (trimmed)')
    if (profile.personality !== undefined && String(profile.personality) !== String(profile.personality).trim()) corrupt(path, 'captainProfile.personality must be canonical (trimmed)')
    if (profile.pixelAvatarSvg !== undefined) {
      if (typeof profile.pixelAvatarSvg !== 'string' || profile.pixelAvatarSvg !== profile.pixelAvatarSvg.trim() || !isSafePixelAvatarSvg(profile.pixelAvatarSvg)) {
        corrupt(path, 'captainProfile.pixelAvatarSvg violates the strict allowlist')
      }
    }
  }
  if (team.announcements !== undefined) {
    const announcements = list(team.announcements, path, 'announcements')
    if (announcements.length > MAX_CAPTAIN_ANNOUNCEMENTS) corrupt(path, `announcements exceed ${MAX_CAPTAIN_ANNOUNCEMENTS}`)
    const seenIds = new Set<string>()
    let previousCreatedAt = -1
    announcements.forEach((raw, index) => {
      const announcement = record(raw, path, `announcements[${index}]`)
      exactKeys(announcement, `${path}.announcements[${index}]`, ANNOUNCEMENT_KEYS)
      const id = text(announcement.id, path, `announcements[${index}].id`)
      if (!CAPTAIN_ANNOUNCEMENT_ID_RE.test(id)) corrupt(path, `announcements[${index}].id is malformed`)
      if (seenIds.has(id)) corrupt(path, `announcements[${index}].id is not unique`)
      seenIds.add(id)
      const textValue = codePointText(announcement.text, MAX_CAPTAIN_ANNOUNCEMENT_TEXT, path, `announcements[${index}].text`)
      if (textValue !== textValue.trim()) corrupt(path, `announcements[${index}].text must be canonical (trimmed)`)
      const createdAt = integer(announcement.createdAt, path, `announcements[${index}].createdAt`)
      if (createdAt < previousCreatedAt) corrupt(path, `announcements[${index}].createdAt is not non-decreasing`)
      previousCreatedAt = createdAt
    })
  }

  const tasks = list(team.tasks, path, 'tasks').map((raw, index) => {
    const task = record(raw, path, `tasks[${index}]`)
    text(task.id, path, `tasks[${index}].id`)
    integer(task.revision, path, `tasks[${index}].revision`, 1)
    text(task.subject, path, `tasks[${index}].subject`)
    text(task.description, path, `tasks[${index}].description`)
    stringList(task.acceptanceCriteria, path, `tasks[${index}].acceptanceCriteria`)
    if (!TASK_STATUSES.has(String(task.status))) corrupt(path, `tasks[${index}].status is invalid`)
    stringList(task.blockedBy, path, `tasks[${index}].blockedBy`)
    stringList(task.writeScopes, path, `tasks[${index}].writeScopes`)
    if (task.verification !== undefined) {
      list(task.verification, path, `tasks[${index}].verification`).forEach((entryRaw, command) => {
        const entry = record(entryRaw, path, `tasks[${index}].verification[${command}]`)
        text(entry.command, path, `tasks[${index}].verification[${command}].command`)
        if (entry.timeoutMs !== undefined) integer(entry.timeoutMs, path, `tasks[${index}].verification[${command}].timeoutMs`, 1)
      })
    }
    if (task.reservationTokens !== undefined) {
      integer(task.reservationTokens, path, `tasks[${index}].reservationTokens`, 1)
    }
    if (task.targetMemberSessionId !== undefined) text(task.targetMemberSessionId, path, `tasks[${index}].targetMemberSessionId`)
    integer(task.priority, path, `tasks[${index}].priority`, Number.MIN_SAFE_INTEGER)
    if (task.ownerSessionId !== undefined) text(task.ownerSessionId, path, `tasks[${index}].ownerSessionId`)
    if (task.currentAttemptId !== undefined) text(task.currentAttemptId, path, `tasks[${index}].currentAttemptId`)
    if (task.output !== undefined) text(task.output, path, `tasks[${index}].output`)
    integer(task.createdAt, path, `tasks[${index}].createdAt`)
    integer(task.updatedAt, path, `tasks[${index}].updatedAt`)
    return task
  })
  unique(tasks.map(task => task.id as string), path, 'task ids')
  for (const task of tasks) {
    if (task.targetMemberSessionId === undefined) continue
    const target = members.find(member => member.sessionId === task.targetMemberSessionId)
    if (target === undefined) corrupt(path, `task ${String(task.id)} assignment target is not a Team member`)
    if ((task.status === 'pending' || ['in_progress', 'submitted', 'verifying'].includes(String(task.status)))
      && target.phase !== 'provisioning' && target.phase !== 'active') corrupt(path, `task ${String(task.id)} assignment target is unavailable`)
  }

  const attempts = list(team.attempts, path, 'attempts').map((raw, index) => {
    const attempt = record(raw, path, `attempts[${index}]`)
    text(attempt.id, path, `attempts[${index}].id`)
    text(attempt.taskId, path, `attempts[${index}].taskId`)
    integer(attempt.generation, path, `attempts[${index}].generation`, 1)
    text(attempt.memberSessionId, path, `attempts[${index}].memberSessionId`)
    if (!ATTEMPT_PHASES.has(String(attempt.phase))) corrupt(path, `attempts[${index}].phase is invalid`)
    if (attempt.assignmentPhase !== 'reserved' && attempt.assignmentPhase !== 'delivered') {
      corrupt(path, `attempts[${index}].assignmentPhase is invalid`)
    }
    if (attempt.assignmentDeliveredAt !== undefined) integer(attempt.assignmentDeliveredAt, path, `attempts[${index}].assignmentDeliveredAt`)
    if (attempt.assignmentPhase === 'delivered' && attempt.assignmentDeliveredAt === undefined) {
      corrupt(path, `attempts[${index}] is delivered without assignmentDeliveredAt`)
    }
    if (attempt.assignmentPhase === 'reserved' && attempt.assignmentDeliveredAt !== undefined) {
      corrupt(path, `attempts[${index}] is reserved with assignmentDeliveredAt`)
    }
    if (attempt.replacesAttemptId !== undefined) {
      text(attempt.replacesAttemptId, path, `attempts[${index}].replacesAttemptId`)
      if (attempt.replacesAttemptId === attempt.id) corrupt(path, `attempts[${index}].replacesAttemptId is self-referential`)
    }
    if (attempt.output !== undefined) text(attempt.output, path, `attempts[${index}].output`)
    stringList(attempt.evidence, path, `attempts[${index}].evidence`)
    if (attempt.diagnostic !== undefined) text(attempt.diagnostic, path, `attempts[${index}].diagnostic`)
    integer(attempt.createdAt, path, `attempts[${index}].createdAt`)
    integer(attempt.updatedAt, path, `attempts[${index}].updatedAt`)
    return attempt
  })
  unique(attempts.map(attempt => attempt.id as string), path, 'attempt ids')
  const taskIds = new Set(tasks.map(task => task.id as string))
  const attemptIds = new Set(attempts.map(attempt => attempt.id as string))
  for (const attempt of attempts) if (!taskIds.has(attempt.taskId as string)) corrupt(path, `attempt ${String(attempt.id)} references a missing task`)
  for (const task of tasks) {
    if (task.currentAttemptId !== undefined && !attemptIds.has(task.currentAttemptId as string)) {
      corrupt(path, `task ${String(task.id)} references a missing current attempt`)
    }
    if (task.currentAttemptId !== undefined) {
      const attempt = attempts.find(candidate => candidate.id === task.currentAttemptId)
      if (attempt === undefined) corrupt(path, `task ${String(task.id)} references a missing current attempt`)
      if (attempt.taskId !== task.id) corrupt(path, `task ${String(task.id)} references an attempt for another task`)
      if (task.ownerSessionId !== attempt.memberSessionId) corrupt(path, `task ${String(task.id)} owner differs from its current attempt`)
      if (task.targetMemberSessionId !== undefined && task.ownerSessionId !== task.targetMemberSessionId) corrupt(path, `task ${String(task.id)} owner differs from its assignment target`)
    }
  }

  const messages = list(team.messages, path, 'messages').map((raw, index) => {
    const message = record(raw, path, `messages[${index}]`)
    text(message.id, path, `messages[${index}].id`)
    text(message.senderSessionId, path, `messages[${index}].senderSessionId`)
    text(message.senderName, path, `messages[${index}].senderName`)
    text(message.targetSessionId, path, `messages[${index}].targetSessionId`)
    text(message.targetName, path, `messages[${index}].targetName`)
    text(message.content, path, `messages[${index}].content`)
    if (message.delivery !== 'quiet' && message.delivery !== 'wakeup') corrupt(path, `messages[${index}].delivery is invalid`)
    if (!MESSAGE_PHASES.has(String(message.phase))) corrupt(path, `messages[${index}].phase is invalid`)
    integer(message.createdAt, path, `messages[${index}].createdAt`)
    if (message.deliveredAt !== undefined) integer(message.deliveredAt, path, `messages[${index}].deliveredAt`)
    if (message.causal !== undefined) {
      const causal = record(message.causal, path, `messages[${index}].causal`)
      if (causal.taskId !== undefined) text(causal.taskId, path, `messages[${index}].causal.taskId`)
      if (causal.attemptId !== undefined) text(causal.attemptId, path, `messages[${index}].causal.attemptId`)
      if (causal.revision !== undefined) integer(causal.revision, path, `messages[${index}].causal.revision`, 1)
    }
    if (message.supersedes !== undefined) text(message.supersedes, path, `messages[${index}].supersedes`)
    if (message.supersededBy !== undefined) text(message.supersededBy, path, `messages[${index}].supersededBy`)
    if (message.obsoletedAt !== undefined) integer(message.obsoletedAt, path, `messages[${index}].obsoletedAt`)
    if (message.obsoletedReason !== undefined) text(message.obsoletedReason, path, `messages[${index}].obsoletedReason`)
    if (message.phase === 'obsolete' && message.obsoletedReason === undefined) {
      corrupt(path, `messages[${index}] is obsolete without an obsoletedReason`)
    }
    if (message.phase !== 'obsolete' && message.obsoletedAt !== undefined) {
      corrupt(path, `messages[${index}] carries obsoletedAt outside obsolete phase`)
    }
    return message
  })
  unique(messages.map(message => message.id as string), path, 'message ids')

  if (team.schemaVersion === 1 && team.interactionEffects !== undefined) corrupt(path, 'v1 state must not carry interactionEffects')
  if (team.schemaVersion === 2) {
    const effects = list(team.interactionEffects, path, 'interactionEffects').map((raw, index) => {
      const effect = record(raw, path, `interactionEffects[${index}]`)
      exactKeys(effect, `${path}.interactionEffects[${index}]`, INTERACTION_EFFECT_KEYS)
      const effectId = text(effect.effectId, path, `interactionEffects[${index}].effectId`)
      if (!/^i1b:[a-f0-9]{64}$/.test(effectId)) corrupt(path, `interactionEffects[${index}].effectId is malformed`)
      text(effect.requestId, path, `interactionEffects[${index}].requestId`)
      if (effect.step !== 'member-question-relay-mail') corrupt(path, `interactionEffects[${index}].step is invalid`)
      const bindingDigest = text(effect.bindingDigest, path, `interactionEffects[${index}].bindingDigest`)
      if (!/^sha256:[a-f0-9]{64}$/.test(bindingDigest)) corrupt(path, `interactionEffects[${index}].bindingDigest is malformed`)
      const senderSessionId = text(effect.senderSessionId, path, `interactionEffects[${index}].senderSessionId`)
      const targetSessionId = text(effect.targetSessionId, path, `interactionEffects[${index}].targetSessionId`)
      const bodyDigest = text(effect.bodyDigest, path, `interactionEffects[${index}].bodyDigest`)
      if (!/^sha256:[a-f0-9]{64}$/.test(bodyDigest)) corrupt(path, `interactionEffects[${index}].bodyDigest is malformed`)
      if (effect.delivery !== 'quiet' && effect.delivery !== 'wakeup') corrupt(path, `interactionEffects[${index}].delivery is invalid`)
      const messageId = text(effect.messageId, path, `interactionEffects[${index}].messageId`)
      integer(effect.resultingTeamRevision, path, `interactionEffects[${index}].resultingTeamRevision`, 1)
      integer(effect.committedAt, path, `interactionEffects[${index}].committedAt`)
      // A terminal mailbox row may be pruned by normal retention.  The
      // durable effect receipt intentionally outlives that row, while any
      // retained row must still agree with its authority binding.
      const message = messages.find(candidate => candidate.id === messageId)
      if (message !== undefined && (message.senderSessionId !== senderSessionId || message.targetSessionId !== targetSessionId || message.delivery !== effect.delivery)) {
        corrupt(path, `interactionEffects[${index}] differs from retained message`)
      }
      return effect
    })
    unique(effects.map(effect => effect.effectId as string), path, 'interaction effect ids')
    unique(effects.map(effect => `${String(effect.requestId)}:${String(effect.step)}`), path, 'interaction effect request steps')
  }

  const budget = record(team.budget, path, 'budget')
  for (const field of ['usedTokens', 'usedRequests', 'usedRetries'] as const) integer(budget[field], path, `budget.${field}`)
  for (const field of ['tokenLimit', 'requestLimit', 'retryLimit', 'deadlineAt'] as const) {
    if (budget[field] !== undefined) integer(budget[field], path, `budget.${field}`, 1)
  }
  const usageCursors = record(team.usageCursors, path, 'usageCursors')
  for (const [sessionId, seq] of Object.entries(usageCursors)) {
    text(sessionId, path, 'usageCursors session id')
    integer(seq, path, `usageCursors.${sessionId}`, -1)
  }

  const memory = list(team.memory, path, 'memory').map((raw, index) => {
    const entry = record(raw, path, `memory[${index}]`)
    text(entry.id, path, `memory[${index}].id`)
    if (!MEMORY_CATEGORIES.has(String(entry.category))) corrupt(path, `memory[${index}].category is invalid`)
    text(entry.content, path, `memory[${index}].content`)
    stringList(entry.evidenceRefs, path, `memory[${index}].evidenceRefs`)
    integer(entry.createdAt, path, `memory[${index}].createdAt`)
    return entry
  })
  unique(memory.map(entry => entry.id as string), path, 'memory ids')

  try {
    assertTaskGraph(tasks as unknown as TeamState['tasks'])
  } catch (error) {
    corrupt(path, error instanceof Error ? error.message : 'task graph is invalid')
  }
}

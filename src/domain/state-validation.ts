import { TeamDomainError } from './error.js'
import { assertTaskGraph } from './graph.js'
import type { TeamState } from './types.js'

const TASK_STATUSES = new Set(['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled'])
const ATTEMPT_PHASES = new Set(['running', 'submitted', 'verifying', 'accepted', 'rejected', 'cancelled', 'stale'])
const MEMBER_PHASES = new Set(['provisioning', 'active', 'failed', 'removed'])
const MESSAGE_PHASES = new Set(['queued', 'delivered', 'cancelled'])
const MEMORY_CATEGORIES = new Set(['decision', 'lesson', 'member', 'context'])

function corrupt(path: string, detail: string): never {
  throw new TeamDomainError(`invalid Team state at ${path}: ${detail}`, 'TEAM_STATE_CORRUPT')
}

function record(value: unknown, path: string, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(path, `${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, path: string, label: string): string {
  if (typeof value !== 'string' || value === '') corrupt(path, `${label} must be a non-empty string`)
  return value
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
  if (team.schemaVersion !== 1) corrupt(path, 'schemaVersion must be 1')
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
    return member
  })
  unique(members.map(member => member.sessionId as string), path, 'member session ids')

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
    integer(task.priority, path, `tasks[${index}].priority`, Number.MIN_SAFE_INTEGER)
    if (task.ownerSessionId !== undefined) text(task.ownerSessionId, path, `tasks[${index}].ownerSessionId`)
    if (task.currentAttemptId !== undefined) text(task.currentAttemptId, path, `tasks[${index}].currentAttemptId`)
    if (task.output !== undefined) text(task.output, path, `tasks[${index}].output`)
    integer(task.createdAt, path, `tasks[${index}].createdAt`)
    integer(task.updatedAt, path, `tasks[${index}].updatedAt`)
    return task
  })
  unique(tasks.map(task => task.id as string), path, 'task ids')

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
    return message
  })
  unique(messages.map(message => message.id as string), path, 'message ids')

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

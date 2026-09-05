/**
 * Plan-first staged lifecycle (P0-2 S1): durable pre-execution Team drafts.
 *
 * A staged Team is the durable declaration BEFORE any Captain Session, member
 * or task exists: `captainSessionId` is the empty marker while staged, the
 * Main Brain declares a bounded `planDraft`, and `approveStagedPlan` is the
 * single atomic `staged -> active` boundary (the runtime supplies the real
 * provisioned captain id). `discardStagedPlan` archives the draft without
 * creating work and is idempotent.
 *
 * Authority stays with TeamDomainPort: these functions only run through the
 * storage `transact`/`createManaged` seams and publish after durable commit.
 * @module dsh-agent-swarm/domain/team-domain-plan
 */
import { randomUUID } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import { nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
import { TeamId, type TeamPlanDraft, type TeamState } from './types.js'
import type { TeamScope } from './team-domain-port.js'

const MAX_PLAN_MEMBERS = 64
const MAX_PLAN_TASKS = 64
const MAX_PLAN_TASK_KEY = 32

function revisionConflict(expected: number, actual: number): never {
  throw new TeamDomainError(`team revision conflict: expected ${expected}, current ${actual}`, 'TEAM_REVISION_CONFLICT')
}

/** Validate and return a defensive clone of one bounded plan declaration. */
function normalizePlanDraft(draft: TeamPlanDraft): TeamPlanDraft {
  expectDomain(draft !== null && typeof draft === 'object', 'plan draft must be an object', 'TEAM_INPUT_INVALID')
  expectDomain(Array.isArray(draft.members) && draft.members.length <= MAX_PLAN_MEMBERS, 'plan member count exceeds the limit', 'TEAM_INPUT_LIMIT')
  expectDomain(Array.isArray(draft.tasks) && draft.tasks.length <= MAX_PLAN_TASKS, 'plan task count exceeds the limit', 'TEAM_INPUT_LIMIT')
  const memberNames = new Set<string>()
  const members = draft.members.map((raw, index) => {
    const name = nonEmpty(raw?.name ?? '', `plan members[${index}].name`, 64)
    expectDomain(!memberNames.has(name), `plan member "${name}" is duplicated`, 'TEAM_INPUT_INVALID')
    memberNames.add(name)
    const normalized: TeamPlanDraft['members'][number] = {
      name,
      role: nonEmpty(raw?.role ?? '', `plan members[${index}].role`, 256),
      ...(raw?.llmProvider === undefined ? {} : { llmProvider: nonEmpty(raw.llmProvider, `plan members[${index}].llmProvider`, 128) }),
      ...(raw?.model === undefined ? {} : { model: nonEmpty(raw.model, `plan members[${index}].model`, 128) }),
      ...(raw?.denyTools === undefined ? {} : {
        denyTools: raw.denyTools.map((tool: string, toolIndex: number) => nonEmpty(tool, `plan members[${index}].denyTools[${toolIndex}]`, 128)),
      }),
    }
    if (normalized.denyTools !== undefined) expectDomain(normalized.denyTools.length <= 64, 'deny tools exceed the limit', 'TEAM_INPUT_LIMIT')
    return normalized
  })
  const taskKeys = new Set<string>()
  const tasks = draft.tasks.map((raw, index) => {
    const key = nonEmpty(raw?.key ?? '', `plan tasks[${index}].key`, MAX_PLAN_TASK_KEY)
    expectDomain(/^[a-z0-9][a-z0-9-]{0,31}$/.test(key), `plan task key "${key}" is malformed`, 'TEAM_INPUT_INVALID')
    expectDomain(!taskKeys.has(key), `plan task key "${key}" is duplicated`, 'TEAM_INPUT_INVALID')
    taskKeys.add(key)
    const target = raw?.targetMemberName
    if (target !== undefined) expectDomain(memberNames.has(target), `plan task "${key}" targets unknown member "${target}"`, 'TEAM_INPUT_INVALID')
    const dependencies = raw?.dependencies ?? []
    expectDomain(Array.isArray(dependencies) && dependencies.length <= MAX_PLAN_TASKS, 'plan dependencies exceed the limit', 'TEAM_INPUT_LIMIT')
    expectDomain(!dependencies.includes(key), `plan task "${key}" depends on itself`, 'TEAM_INPUT_INVALID')
    for (const dependency of dependencies) {
      expectDomain(taskKeys.has(dependency) || draft.tasks.some(candidate => candidate.key === dependency),
        `plan task "${key}" depends on unknown task "${dependency}"`, 'TEAM_INPUT_INVALID')
    }
    return {
      key,
      subject: nonEmpty(raw?.subject ?? '', `plan tasks[${index}].subject`, 256),
      description: nonEmpty(raw?.description ?? '', `plan tasks[${index}].description`, 16_384),
      ...(raw?.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: raw.acceptanceCriteria.map((item: string, itemIndex: number) => nonEmpty(item, `plan tasks[${index}].acceptanceCriteria[${itemIndex}]`, 1_024)) }),
      ...(raw?.dependencies === undefined ? {} : { dependencies }),
      ...(target === undefined ? {} : { targetMemberName: target }),
      ...(raw?.writeScopes === undefined ? {} : { writeScopes: raw.writeScopes.map((item: string, itemIndex: number) => nonEmpty(item, `plan tasks[${index}].writeScopes[${itemIndex}]`, 256)) }),
    }
  })
  return { members, tasks }
}

/** Create one durable staged managed Team (no Captain Session is provisioned). */
export async function createStagedManaged(
  deps: TeamDomainDeps,
  scope: TeamScope,
  managedOrigin: string,
  name: string,
  description: string,
): Promise<TeamState> {
  const origin = nonEmpty(managedOrigin, 'managed origin', 256)
  const timestamp = deps.now()
  const team: TeamState = {
    schemaVersion: 2,
    id: TeamId(`team-${randomUUID()}`),
    revision: 1,
    name: nonEmpty(name, 'team name', 128),
    description: nonEmpty(description, 'team description', 16_384),
    captainSessionId: '',
    managedOrigin: origin,
    phase: 'staged',
    members: [],
    tasks: [],
    attempts: [],
    messages: [],
    interactionEffects: [],
    budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: {},
    memory: [],
    nextTaskNumber: 1,
    nextMemoryNumber: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const winner = await deps.store.createManaged(scope, team)
  return structuredClone(winner)
}

/** Store one bounded plan declaration on a staged Team (revision CAS). */
export async function setPlanDraft(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  expectedRevision: number,
  draft: TeamPlanDraft,
): Promise<TeamState> {
  expectDomain(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'expected revision is invalid', 'TEAM_INPUT_INVALID')
  const normalized = normalizePlanDraft(draft)
  let committed!: TeamState
  await deps.store.transact(scope, teamId, team => {
    expectDomain(team.phase === 'staged', 'plan mutation requires a staged Team', 'TEAM_PHASE_INVALID')
    if (team.revision !== expectedRevision) revisionConflict(expectedRevision, team.revision)
    const timestamp = deps.now()
    Object.assign(team, { planDraft: normalized, revision: team.revision + 1, updatedAt: timestamp })
    committed = team
  })
  return structuredClone(committed)
}

/** Atomic `staged -> active` boundary; the runtime supplies the real captain id. */
export async function approveStagedPlan(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  expectedRevision: number,
  captainSessionId: string,
): Promise<TeamState> {
  expectDomain(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'expected revision is invalid', 'TEAM_INPUT_INVALID')
  const captain = nonEmpty(captainSessionId, 'captain session id', 256)
  let committed!: TeamState
  await deps.store.transact(scope, teamId, team => {
    expectDomain(team.phase === 'staged', 'approval requires a staged Team', 'TEAM_PHASE_INVALID')
    if (team.revision !== expectedRevision) revisionConflict(expectedRevision, team.revision)
    const timestamp = deps.now()
    Object.assign(team, { phase: 'active', captainSessionId: captain, revision: team.revision + 1, updatedAt: timestamp })
    committed = team
  })
  return structuredClone(committed)
}

/** Archive one staged draft without creating work; idempotent. */
export async function discardStagedPlan(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  expectedRevision: number,
): Promise<TeamState> {
  expectDomain(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'expected revision is invalid', 'TEAM_INPUT_INVALID')
  let committed!: TeamState
  await deps.store.transact(scope, teamId, team => {
    if (team.phase === 'archived' && team.discardReason === 'discarded') {
      committed = team
      return
    }
    expectDomain(team.phase === 'staged', 'discard requires a staged Team (archive an active Team instead)', 'TEAM_PHASE_INVALID')
    if (team.revision !== expectedRevision) revisionConflict(expectedRevision, team.revision)
    const timestamp = deps.now()
    delete (team as { planDraft?: TeamPlanDraft }).planDraft
    Object.assign(team, { phase: 'archived', discardReason: 'discarded', revision: team.revision + 1, updatedAt: timestamp })
    committed = team
  })
  return structuredClone(committed)
}



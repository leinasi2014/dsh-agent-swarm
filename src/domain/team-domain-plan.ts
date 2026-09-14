import type { TeamModelRoute } from './types.js'
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
import { assertTaskGraph } from './graph.js'
import { actorMembership, nonEmpty, normalizeTeamModelRoute, type TeamDomainDeps } from './team-domain-shared.js'
import { TaskId, TeamId, type TeamAppendChange, type TeamPlanDraft, type TeamState, type TeamTask } from './types.js'
import type { TeamScope } from './team-domain-port.js'
import { assertRecruitmentIdentity, normalizeMemberIdentity } from './identity-profile.js'

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
    assertRecruitmentIdentity(raw)
    const normalized: TeamPlanDraft['members'][number] = {
      name,
      role: nonEmpty(raw?.role ?? '', `plan members[${index}].role`, 256),
      ...normalizeMemberIdentity({ displayName: raw.displayName, profession: raw.profession, personality: raw.personality, biography: raw.biography, pixelAvatarSvg: raw.pixelAvatarSvg }),
      ...(raw?.llmProvider === undefined ? {} : { llmProvider: nonEmpty(raw.llmProvider, `plan members[${index}].llmProvider`, 128) }),
      ...(raw?.model === undefined ? {} : { model: nonEmpty(raw.model, `plan members[${index}].model`, 128) }),
      ...(raw?.reasoningEffort === undefined ? {} : { reasoningEffort: nonEmpty(raw.reasoningEffort, `plan members[${index}].reasoningEffort`, 128) }),
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
  captainRoute?: TeamModelRoute,
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
    ...(captainRoute === undefined ? {} : { captainRoute: normalizeTeamModelRoute(captainRoute) }),
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
  captainRoute?: TeamModelRoute,
): Promise<TeamState> {
  expectDomain(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'expected revision is invalid', 'TEAM_INPUT_INVALID')
  const captain = nonEmpty(captainSessionId, 'captain session id', 256)
  let committed!: TeamState
  await deps.store.transact(scope, teamId, team => {
    expectDomain(team.phase === 'staged', 'approval requires a staged Team', 'TEAM_PHASE_INVALID')
    if (team.revision !== expectedRevision) revisionConflict(expectedRevision, team.revision)
    const timestamp = deps.now()
    Object.assign(team, { ...(captainRoute === undefined ? {} : { captainRoute: normalizeTeamModelRoute(captainRoute) }), phase: 'active', captainSessionId: captain, revision: team.revision + 1, updatedAt: timestamp })
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

/**
 * §2.3 append-only protocol (issue #294 slice 1). A stable change id is
 * canonicalized key-order-insensitively so an idempotent replay compares the
 * logical payload, not a serialization accident (zod rebuilds nested objects
 * in schema order).
 */
function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`).join(',')}}`
}

/**
 * Validate one append payload BEFORE any aggregate read. Member entries run
 * through the same identity gate as `normalizePlanDraft`
 * (`assertRecruitmentIdentity`) at the same position relative to the phase
 * gate as in `setPlanDraft`, so the same forged payload is refused with the
 * same code from both entry points.
 */
function normalizeAppendChange(change: TeamAppendChange): TeamAppendChange {
  expectDomain(change !== null && typeof change === 'object', 'append change must be an object', 'TEAM_INPUT_INVALID')
  const changeId = nonEmpty(change.changeId ?? '', 'append change id', 128)
  const initiatedBySessionId = nonEmpty(change.initiatedBySessionId ?? '', 'append initiatedBy session id', 256)
  expectDomain(Array.isArray(change.members) && change.members.length <= MAX_PLAN_MEMBERS, 'append member count exceeds the limit', 'TEAM_INPUT_LIMIT')
  expectDomain(Array.isArray(change.tasks) && change.tasks.length <= MAX_PLAN_TASKS, 'append task count exceeds the limit', 'TEAM_INPUT_LIMIT')
  const memberNames = new Set<string>()
  const members = change.members.map((raw, index): TeamAppendChange['members'][number] => {
    const name = nonEmpty(raw?.name ?? '', `append members[${index}].name`, 64)
    expectDomain(!memberNames.has(name), `append member "${name}" is duplicated`, 'TEAM_INPUT_INVALID')
    memberNames.add(name)
    assertRecruitmentIdentity(raw)
    return {
      name,
      role: nonEmpty(raw?.role ?? '', `append members[${index}].role`, 256),
      ...normalizeMemberIdentity({ displayName: raw.displayName, profession: raw.profession, personality: raw.personality, biography: raw.biography, pixelAvatarSvg: raw.pixelAvatarSvg }),
      ...(raw?.llmProvider === undefined ? {} : { llmProvider: nonEmpty(raw.llmProvider, `append members[${index}].llmProvider`, 128) }),
      ...(raw?.model === undefined ? {} : { model: nonEmpty(raw.model, `append members[${index}].model`, 128) }),
      ...(raw?.reasoningEffort === undefined ? {} : { reasoningEffort: nonEmpty(raw.reasoningEffort, `append members[${index}].reasoningEffort`, 128) }),
      ...(raw?.denyTools === undefined ? {} : {
        denyTools: raw.denyTools.map((tool: string, toolIndex: number) => nonEmpty(tool, `append members[${index}].denyTools[${toolIndex}]`, 128)),
      }),
    }
  })
  const taskKeys = new Set<string>()
  const tasks = change.tasks.map((raw, index): TeamAppendChange['tasks'][number] => {
    const key = nonEmpty(raw?.key ?? '', `append tasks[${index}].key`, MAX_PLAN_TASK_KEY)
    expectDomain(/^[a-z0-9][a-z0-9-]{0,31}$/.test(key), `append task key "${key}" is malformed`, 'TEAM_INPUT_INVALID')
    expectDomain(!taskKeys.has(key), `append task key "${key}" is duplicated`, 'TEAM_INPUT_INVALID')
    taskKeys.add(key)
    const dependencies = raw?.dependencies ?? []
    expectDomain(Array.isArray(dependencies) && dependencies.length <= MAX_PLAN_TASKS, 'append dependencies exceed the limit', 'TEAM_INPUT_LIMIT')
    return {
      key,
      subject: nonEmpty(raw?.subject ?? '', `append tasks[${index}].subject`, 256),
      description: nonEmpty(raw?.description ?? '', `append tasks[${index}].description`, 16_384),
      ...(raw?.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: raw.acceptanceCriteria.map((item: string, itemIndex: number) => nonEmpty(item, `append tasks[${index}].acceptanceCriteria[${itemIndex}]`, 1_024)) }),
      ...(raw?.dependencies === undefined ? {} : { dependencies }),
      ...(raw?.targetMemberName === undefined ? {} : { targetMemberName: nonEmpty(raw.targetMemberName, `append tasks[${index}].targetMemberName`, 64) }),
      ...(raw?.writeScopes === undefined ? {} : { writeScopes: raw.writeScopes.map((item: string, itemIndex: number) => nonEmpty(item, `append tasks[${index}].writeScopes[${itemIndex}]`, 256)) }),
    }
  })
  return { changeId, initiatedBySessionId, members, tasks }
}

/**
 * Apply one append-only change to an ACTIVE Team (§2.3, issue #294 slice 1).
 * Exactly one of these outcomes commits inside the single aggregate
 * transaction:
 * - an idempotent replay (same `changeId`, same logical payload) returns the
 *   existing result without a second member/task/event (:66);
 * - a reused id carrying a different payload rejects with
 *   `TEAM_APPEND_CHANGE_CONFLICT`;
 * - a CAS mismatch rejects with `TEAM_REVISION_CONFLICT` and zero partial
 *   application;
 * - an append-only violation (existing member name, dependency on anything
 *   outside the appended batch, non-Captain actor, non-active phase) rejects
 *   without partial application (:63/:64);
 * - a fresh change mints new tasks with fresh `nextTaskNumber` ids and records
 *   the audit fact (actor / time / declaration / resulting revision) in
 *   `appendChanges` alone (:69). Slice-1 ruling: the member DECLARATION is
 *   recorded but no TeamMember row is minted (provision lands with slice 2),
 *   and `planDraft` is never touched — an append is its own lifecycle event,
 *   not a plan v2.
 */
export async function appendActiveTeam(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  expectedRevision: number,
  change: TeamAppendChange,
): Promise<TeamState> {
  expectDomain(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'expected revision is invalid', 'TEAM_INPUT_INVALID')
  const normalized = normalizeAppendChange(change)
  let committed!: TeamState
  await deps.store.transact(scope, teamId, team => {
    expectDomain(team.phase === 'active', 'append requires an active Team (§2.1 stays authoritative while staged)', 'TEAM_PHASE_INVALID')
    if (team.revision !== expectedRevision) revisionConflict(expectedRevision, team.revision)
    expectDomain(actorMembership(team, normalized.initiatedBySessionId).role === 'captain', 'only the captain can append to the Team', 'TEAM_CAPTAIN_REQUIRED')
    const prior = (team.appendChanges ?? []).find(entry => entry.changeId === normalized.changeId)
    if (prior !== undefined) {
      expectDomain(
        canonicalSerialize({ members: prior.members, tasks: prior.tasks }) === canonicalSerialize({ members: normalized.members, tasks: normalized.tasks }),
        `append change id "${normalized.changeId}" carries a different payload`, 'TEAM_APPEND_CHANGE_CONFLICT',
      )
      committed = team
      return
    }
    const declaredMembers = new Set((team.appendChanges ?? []).flatMap(entry => entry.members.map(member => member.name)))
    for (const member of normalized.members) {
      expectDomain(
        !team.members.some(existing => existing.name === member.name) && !declaredMembers.has(member.name),
        `appended member "${member.name}" collides with an existing member declaration`, 'TEAM_APPEND_NOT_APPEND_ONLY',
      )
    }
    const batchKeys = new Set(normalized.tasks.map(task => task.key))
    for (const task of normalized.tasks) {
      for (const dependency of task.dependencies ?? []) {
        expectDomain(
          dependency !== task.key && batchKeys.has(dependency),
          `appended task "${task.key}" may only depend on tasks from the same append (found "${dependency}")`, 'TEAM_APPEND_TOPOLOGY_FORBIDDEN',
        )
      }
    }
    for (const key of batchKeys) {
      const visiting = new Set<string>()
      const settled = new Set<string>()
      const visit = (at: string): void => {
        if (visiting.has(at)) throw new TeamDomainError(`appended tasks contain a dependency cycle at "${at}"`, 'TEAM_APPEND_TOPOLOGY_FORBIDDEN')
        if (settled.has(at)) return
        visiting.add(at)
        for (const dependency of normalized.tasks.find(task => task.key === at)?.dependencies ?? []) visit(dependency)
        visiting.delete(at)
        settled.add(at)
      }
      visit(key)
    }
    const knownMemberNames = new Set([
      ...team.members.filter(member => member.phase === 'active' || member.phase === 'provisioning').map(member => member.name),
      ...normalized.members.map(member => member.name),
    ])
    for (const task of normalized.tasks) {
      if (task.targetMemberName !== undefined) {
        expectDomain(knownMemberNames.has(task.targetMemberName), `appended task "${task.key}" targets unknown member "${task.targetMemberName}"`, 'TEAM_INPUT_INVALID')
      }
    }
    const timestamp = deps.now()
    const idByKey = new Map<string, TaskId>()
    let nextNumber = team.nextTaskNumber
    for (const declared of normalized.tasks) idByKey.set(declared.key, TaskId(`task-${nextNumber++}`))
    const minted: TeamTask[] = normalized.tasks.map(declared => {
      const targetSession = declared.targetMemberName === undefined
        ? undefined
        : team.members.find(member => member.name === declared.targetMemberName && (member.phase === 'active' || member.phase === 'provisioning'))?.sessionId
      return {
        id: idByKey.get(declared.key)!,
        revision: 1,
        createdBySessionId: normalized.initiatedBySessionId,
        subject: declared.subject,
        description: declared.description,
        acceptanceCriteria: declared.acceptanceCriteria === undefined ? [] : [...declared.acceptanceCriteria],
        status: 'pending',
        blockedBy: (declared.dependencies ?? []).map(dependency => idByKey.get(dependency)!),
        writeScopes: declared.writeScopes === undefined ? [] : [...declared.writeScopes],
        priority: 0,
        ...(targetSession === undefined ? {} : { targetMemberSessionId: targetSession }),
        createdAt: timestamp,
        updatedAt: timestamp,
      }
    })
    assertTaskGraph([...team.tasks, ...minted])
    team.tasks.push(...minted)
    const appendRecord: TeamAppendChange = {
      changeId: normalized.changeId,
      initiatedBySessionId: normalized.initiatedBySessionId,
      members: normalized.members,
      tasks: normalized.tasks,
      createdAt: timestamp,
      resultingRevision: team.revision + 1,
    }
    Object.assign(team, {
      nextTaskNumber: nextNumber,
      appendChanges: [...(team.appendChanges ?? []), appendRecord],
      revision: team.revision + 1,
      updatedAt: timestamp,
    })
    committed = team
  })
  return structuredClone(committed)
}

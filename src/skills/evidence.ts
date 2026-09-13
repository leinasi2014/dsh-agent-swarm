/**
 * Precise evidence resolution (root contract ④): internal refs are decided by
 * READING the exact retained task/attempt projection the official
 * `projectTaskDetail` already defines — teamRevision, `task.output`, retained
 * attempts' output/evidence, explicit retainedCount/returnedCount/truncated,
 * limit 100 — over the authorized aggregate. A request string never passes
 * just because a task ID exists; a target beyond the 100-entry returned
 * window is never assumed absent; external paths and hashes stay explicitly
 * unprovable (no file permission, no provable historical version). Private
 * Sessions and arbitrary files are never read.
 *
 * @module dsh-agent-swarm/skills/evidence
 */
import type { TeamState } from '../domain/types.js'
import { projectTaskDetail } from '../host/task-detail-read.js'
import type { SkillsRequestRecord } from '../storage/skills-management.js'

export interface SkillsEvidenceState {
  readonly ref: string
  readonly state: 'proven' | 'referenced' | 'needs_evidence'
  readonly detail?: string
}

export interface EvidenceResolution {
  readonly entries: readonly SkillsEvidenceState[]
  readonly sourceRevision?: number
  readonly insufficient: boolean
}

/** Structural view of the official task-detail projection this module reads. */
interface TaskEvidenceProjection {
  readonly teamRevision: number
  readonly task: { readonly output?: string }
  readonly attempts: {
    readonly entries: readonly { readonly id: string; readonly output?: string; readonly evidence: readonly string[] }[]
    readonly retainedCount: number
    readonly returnedCount: number
    readonly truncated: boolean
  }
}

/** Resolve one request's evidence from the authorized Team (undefined = source gone). */
export function resolveEvidenceFromSnapshot(record: SkillsRequestRecord, team: TeamState | undefined): EvidenceResolution {
  if (team === undefined) {
    return {
      entries: record.payload.evidence.map(entry => ({ ref: entry.ref, state: 'needs_evidence' as const, detail: 'source-team-missing' })),
      insufficient: true,
    }
  }
  const entries: SkillsEvidenceState[] = []
  let insufficient = false
  let projection: TaskEvidenceProjection | undefined
  if (record.payload.taskId === undefined) {
    insufficient = true
    entries.push({ ref: 'task-binding', state: 'needs_evidence', detail: 'no-task-binding' })
  } else if (!team.tasks.some(task => task.id === record.payload.taskId)) {
    insufficient = true
    entries.push({ ref: `task:${record.payload.taskId}`, state: 'needs_evidence', detail: 'task-unprovable' })
  } else {
    try {
      projection = projectTaskDetail(team, record.payload.taskId, team.captainSessionId, 1) as TaskEvidenceProjection
    } catch {
      // Over-projection bounds stay an EXPLICIT gap, never a silent absence.
      insufficient = true
      entries.push({ ref: `task:${record.payload.taskId}`, state: 'needs_evidence', detail: 'projection-limit' })
    }
  }
  if (record.payload.attemptId !== undefined) {
    const attempt = team.attempts.find(candidate => candidate.id === record.payload.attemptId)
    if (attempt === undefined || (record.payload.taskId !== undefined && attempt.taskId !== record.payload.taskId)) {
      insufficient = true
      entries.push({ ref: `attempt:${record.payload.attemptId}`, state: 'needs_evidence', detail: 'attempt-unprovable' })
    }
  }
  for (const evidence of record.payload.evidence) {
    if (evidence.external) {
      // Root ruling: a Captain-supplied path/hash grants NO file permission
      // and cannot prove the original working version. Never stat, never
      // read — explicitly unprovable.
      entries.push({ ref: evidence.ref, state: 'needs_evidence', detail: 'external-version-unprovable' })
      insufficient = true
      continue
    }
    const state = resolveRetainedRef(evidence.ref, projection, record)
    if (state.state !== 'proven') insufficient = true
    entries.push(state)
  }
  return { entries, sourceRevision: team.revision, insufficient }
}

function resolveRetainedRef(ref: string, projection: TaskEvidenceProjection | undefined, record: SkillsRequestRecord): SkillsEvidenceState {
  if (projection === undefined) return { ref, state: 'needs_evidence', detail: 'no-authoritative-projection' }
  const bound = record.payload.attemptId === undefined
    ? projection.attempts.entries
    : projection.attempts.entries.filter(attempt => attempt.id === record.payload.attemptId)
  for (const attempt of bound) {
    if (attempt.evidence.includes(ref)) return { ref, state: 'proven', detail: `retained:${attempt.id}` }
    if (attempt.output !== undefined && attempt.output === ref) return { ref, state: 'proven', detail: `retained-output:${attempt.id}` }
  }
  if (projection.task.output !== undefined && projection.task.output === ref) return { ref, state: 'proven', detail: 'retained-task-output' }
  // Never ASSUME absence beyond the explicit 100-entry returned window.
  if (projection.attempts.truncated) return { ref, state: 'needs_evidence', detail: 'beyond-returned-window' }
  return { ref, state: 'needs_evidence', detail: 'ref-not-in-retained-evidence' }
}

/**
 * The durable outcome of one investigation. Minimal S1 has NO release
 * authority of its own: without a real scope/Team-bound, verifiable,
 * immutable manifest source, claiming `available` would be a fake approval
 * — with fully proven evidence it answers `unavailable / no_approved_version`.
 */
export function decideOutcome(record: SkillsRequestRecord, evidence: EvidenceResolution, activityCursorSequence: number): {
  readonly state: SkillsRequestRecord['state']
  readonly reason?: string
  readonly result?: SkillsRequestRecord['result']
} {
  const resultBase = {
    evidenceStates: evidence.entries.map(entry => ({
      ref: entry.ref, state: entry.state, ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    })),
    ...(evidence.sourceRevision === undefined ? {} : { sourceRevision: evidence.sourceRevision }),
    activityCursorSequence,
  }
  if (record.payload.taskId === undefined || evidence.insufficient || evidence.entries.some(entry => entry.state === 'needs_evidence')) {
    return { state: 'needs_evidence', reason: 'evidence-insufficient', result: resultBase }
  }
  return { state: 'unavailable', reason: 'no_approved_version', result: resultBase }
}

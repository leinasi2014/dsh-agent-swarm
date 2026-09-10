import { z } from 'zod'
import { DraftIndexedDatabase } from './draft-indexed-db.js'
import { goalSaveRequestSchema, goalControlRequestSchema } from '../rpc/goal-rpc-contract.js'
import type { GoalDefinition, GoalSnapshot } from '../shared/goal-lifecycle.js'

const version = z.number().int().safe().nonnegative()
const draftSchema = z.object({ text: z.string(), acceptanceCriteria: z.string(), constraints: z.string(), mode: z.enum(['finite', 'maintenance']),
  intervalSeconds: z.string(), tokenLimit: z.string(), baseTokenLimit: z.number().int().safe().positive().nullable(),
  baseLifecycleRevision: version, version, initialized: z.boolean(), dirty: z.boolean() }).strict()
const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('save'), request: goalSaveRequestSchema, version }).strict(),
  z.object({ kind: z.literal('control'), request: goalControlRequestSchema, version }).strict(),
])
const outcomeSchema = z.object({ requestId: z.string().min(1), state: z.enum(['committed', 'expired', 'rejected']), operationRevision: version.optional() }).strict()
const recordSchema = z.object({ schemaVersion: z.literal(1), draft: draftSchema, pending: pendingSchema.optional(), outcome: outcomeSchema.optional() }).strict()
export type GoalDraft = z.infer<typeof draftSchema>
export type GoalPending = z.infer<typeof pendingSchema>
export type GoalDraftOutcome = z.infer<typeof outcomeSchema>
export type GoalDraftRecord = z.infer<typeof recordSchema>
export const emptyGoalDraft = (): GoalDraft => ({ text: '', acceptanceCriteria: '', constraints: '', mode: 'finite', intervalSeconds: '60', tokenLimit: '',
  baseTokenLimit: null, baseLifecycleRevision: 0, version: 0, initialized: false, dirty: false })
export function goalDraftFromSnapshot(snapshot: GoalSnapshot, nextVersion: number): GoalDraft {
  const lifecycle = snapshot.lifecycle
  return { text: snapshot.text, acceptanceCriteria: lifecycle?.acceptanceCriteria ?? '', constraints: lifecycle?.constraints ?? '',
    mode: lifecycle?.mode ?? 'finite', intervalSeconds: String((lifecycle?.intervalMs ?? 60_000) / 1000), tokenLimit: String(snapshot.budget.tokenLimit ?? ''),
    baseTokenLimit: snapshot.budget.tokenLimit ?? null, baseLifecycleRevision: lifecycle?.revision ?? 0, version: nextVersion, initialized: true, dirty: false }
}
export function goalDefinitionFromDraft(draft: GoalDraft): GoalDefinition {
  return { text: draft.text.trim(), acceptanceCriteria: draft.acceptanceCriteria.trim(), constraints: draft.constraints.trim(), mode: draft.mode,
    ...(draft.mode === 'maintenance' ? { intervalMs: Number(draft.intervalSeconds) * 1000 } : {}) }
}
const fail = (reason: string) => new Error(`Goal draft storage: ${reason}`)

/** One atomic browser record per Host/Main/Team; unknown operations retain their original payload and CAS. */
export class GoalDraftStore {
  private readonly database: DraftIndexedDatabase
  constructor(factory: IDBFactory = globalThis.indexedDB, name = 'swarm.goal.drafts') { this.database = new DraftIndexedDatabase(factory, name, fail) }
  read(key: string): Promise<GoalDraftRecord> { return this.access(key) }
  writeDraft(key: string, draft: GoalDraft, expectedVersion: number): Promise<GoalDraftRecord> {
    const replacement = draftSchema.parse(structuredClone(draft))
    return this.access(key, current => {
      if (current.draft.version !== expectedVersion || replacement.version < expectedVersion
        || (replacement.version === expectedVersion && JSON.stringify(current.draft) !== JSON.stringify(replacement))) throw fail('draft revision conflict')
      return { ...current, draft: replacement }
    })
  }
  freeze(key: string, pending: GoalPending, expectedVersion: number): Promise<GoalDraftRecord> {
    const frozen = pendingSchema.parse(structuredClone(pending))
    return this.access(key, current => {
      if (current.pending !== undefined) throw fail('pending operation already exists')
      if (current.draft.version !== expectedVersion || frozen.version !== current.draft.version) throw fail('draft revision conflict')
      if (frozen.kind === 'save' && (frozen.request.expectedLifecycleRevision !== current.draft.baseLifecycleRevision
        || JSON.stringify(frozen.request.goal) !== JSON.stringify(goalDefinitionFromDraft(current.draft)))) throw fail('frozen payload differs from draft')
      return { schemaVersion: 1, draft: current.draft, pending: frozen }
    })
  }
  settle(key: string, pending: GoalPending, outcome: GoalDraftOutcome, replacement?: GoalDraft): Promise<GoalDraftRecord> {
    return this.access(key, current => {
      if (current.pending?.request.requestId !== pending.request.requestId || current.pending.request.expectedLifecycleRevision !== pending.request.expectedLifecycleRevision
        || current.pending.version !== pending.version) return current
      if (outcome.requestId !== pending.request.requestId) throw fail('outcome identity differs from pending operation')
      return { schemaVersion: 1, draft: current.draft.version === pending.version ? replacement ?? current.draft : current.draft, outcome: outcomeSchema.parse(outcome) }
    })
  }
  close(): void { this.database.close() }
  private access(key: string, change?: (record: GoalDraftRecord) => GoalDraftRecord): Promise<GoalDraftRecord> {
    return this.database.transaction(key, change !== undefined, raw => {
      const record = raw === undefined ? { schemaVersion: 1 as const, draft: emptyGoalDraft() } : recordSchema.parse(raw)
      return recordSchema.parse(change?.(record) ?? record)
    })
  }
}

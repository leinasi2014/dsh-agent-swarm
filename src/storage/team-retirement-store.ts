/** Minimal durable operator receipts; no Team copy, conversation or private-memory content. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import { retirementCountsSchema } from '../shared/team-retirement.js'
import { referencedSessionIds } from '../domain/team-retirement.js'
import type { TeamState } from '../domain/types.js'

const id = z.string().min(1).max(256)
const counter = z.number().int().safe().nonnegative()
const retirementSessionSchema = z.object({ id, cwd: z.string().min(1).max(4096), parentSessionId: id.optional(),
  origin: z.literal('subagent').optional(), createdAt: counter, version: z.number().int().positive(),
  artifact: z.object({ root: z.string(), directory: z.string(), rootIdentity: z.string(), directoryIdentity: z.string() }).strict().optional() }).strict()
const receiptSchema = z.object({ schemaVersion: z.literal(1), scope: z.string().min(1).max(4096), teamId: id,
  mainSessionId: id, captainSessionId: z.string().max(256), requestId: id, action: z.enum(['archive', 'delete']),
  expectedTeamRevision: counter, teamRevision: counter, previewDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  counts: retirementCountsSchema, ownedSessionIds: z.array(id).max(8192), sessions: z.array(retirementSessionSchema).max(8192),
  requiresConfirmation: z.boolean().default(false),
  stage: z.enum(['frozen', 'confirmation-required', 'stopped', 'sessions-deleted', 'data-deleted', 'completed']), createdAt: counter, updatedAt: counter,
}).strict()
export type RetirementSession = z.infer<typeof retirementSessionSchema>
export type RetirementReceipt = z.infer<typeof receiptSchema>
const retirementDomainSpec = defineDomain({ name: 'agent_swarm_retirement', version: 1,
  tables: { operations: domainTable<string, RetirementReceipt>(receiptSchema) } })
const fences = new WeakMap<DomainFacility, TeamRetirementStore>()

/** Synchronous last-write check, shared by all plugin stores over the same official facility. */
export function assertTeamWritable(ctx: Context, scope: string, teamId: string): void {
  if (teamIsRetired(ctx, scope, teamId)) throw new TeamDomainError('Team is retired and cannot accept writes', 'TEAM_RETIRED')
}
export function teamIsRetired(ctx: Context, scope: string, teamId: string): boolean {
  return fences.get(ctx.storageDomain)?.isRetired(scope, teamId) ?? false
}
/** An unrelated Team cannot acquire a frozen Session between preview and physical purge. */
export function assertRetiredReferencesExcluded(ctx: Context, team: TeamState): void {
  const store = fences.get(ctx.storageDomain)
  if (store !== undefined && [...referencedSessionIds(team)].some(id => store.ownsSession(id))) {
    throw new TeamDomainError('A Team cannot reference a retired Session', 'TEAM_RETIREMENT_REFERENCE_CONFLICT')
  }
}

export class TeamRetirementStore {
  private constructor(private readonly ctx: Context, private readonly domain: Domain<typeof retirementDomainSpec>) {}
  static async open(ctx: Context): Promise<TeamRetirementStore> {
    const store = new TeamRetirementStore(ctx, await ctx.storageDomain.open(retirementDomainSpec))
    fences.set(ctx.storageDomain, store)
    return store
  }
  private key(scope: string, teamId: string, requestId: string): string { return JSON.stringify([scope, teamId, requestId]) }
  get(scope: string, teamId: string, requestId: string): RetirementReceipt | undefined {
    const row = this.domain.table('operations').get(this.key(scope, teamId, requestId))
    return row === undefined ? undefined : structuredClone(row)
  }
  list(): RetirementReceipt[] { return [...this.domain.table('operations').entries()].map(([, row]) => structuredClone(row)) }
  isRetired(scope: string, teamId: string): boolean {
    return [...this.domain.table('operations').entries()].some(([, row]) => row.scope === scope && row.teamId === teamId)
  }
  ownsSession(id: string): boolean { return [...this.domain.table('operations').entries()].some(([, row]) => row.ownedSessionIds.includes(id)) }
  async put(receipt: RetirementReceipt): Promise<void> {
    const validated = receiptSchema.parse(receipt)
    await this.domain.table('operations').put(this.key(receipt.scope, receipt.teamId, receipt.requestId), validated)
  }
  async close(): Promise<void> {
    if (fences.get(this.ctx.storageDomain) === this) fences.delete(this.ctx.storageDomain)
    await this.domain.close()
  }
}

/**
 * The `agent_swarm_workflow` Storage Domain (M2-1, issue #75): the durable
 * boundary of the Team bridge's workflow-run overlay. Per the planning-note
 * trap 1, a Team-started run has NO official durable record (the durable
 * `tool-workflow/*` session events are package-private and nested transports
 * do not write them), so this overlay is the single source of run truth: the
 * run id, its Team linkage and its settled state live here and nowhere else.
 *
 * Kept as a separate domain from `agent_swarm` (ADR-0007 analysis in the
 * design note §3): the Team aggregate's unit keeps its frozen version stamp
 * (a same-version layout change is undefined and a version bump rejects
 * every stored medium), while the run record family owns its own schema
 * lifecycle. The bridge is the sole writer of the `runs` table.
 * @module dsh-agent-swarm/storage/workflow-run-overlay
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
export const WORKFLOW_OVERLAY_DOMAIN_NAME = 'agent_swarm_workflow'
/** Domain format version; a medium stamped differently rejects at open. */
export const WORKFLOW_OVERLAY_DOMAIN_VERSION = 1

/** Run lifecycle states the overlay records. */
export type WorkflowRunOverlayState = 'running' | 'completed' | 'cancelled' | 'error' | 'interrupted'

/** One persisted run overlay record (the only durable run truth). */
export interface WorkflowRunOverlayRecord {
  readonly schemaVersion: 1
  /** The official `WorkflowRunId` (a UUID minted by the bridge engine). */
  readonly runId: string
  /** The Team aggregate backing the run. */
  readonly teamId: string
  /** The workspace scope partitioning the Team. */
  readonly scope: string
  /** The validated workflow identity snapshot (display/persistence key). */
  readonly meta: { readonly name: string; readonly description: string }
  readonly state: WorkflowRunOverlayState
  /** Terminal stop reason; present iff the state is terminal. */
  readonly stopReason?: 'completed' | 'cancelled' | 'error'
  /** Failure text; present iff `stopReason` is not `completed`. */
  readonly error?: string
  /** Host-observed count of `agent()` calls admitted over the run's lifetime. */
  readonly agentsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt?: number
}

const timestamp = z.number().int().min(0)

/** Structural durable-boundary schema of one `runs` record. */
const overlayRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  teamId: z.string().min(1),
  scope: z.string().min(1),
  meta: z.object({ name: z.string().min(1), description: z.string().min(1) }),
  state: z.enum(['running', 'completed', 'cancelled', 'error', 'interrupted']),
  stopReason: z.enum(['completed', 'cancelled', 'error']).optional(),
  error: z.string().min(1).optional(),
  agentsStarted: z.number().int().min(0),
  createdAt: timestamp,
  updatedAt: timestamp,
  settledAt: timestamp.optional(),
})

// Single contained type-erasure: the zod object owns runtime validation at the
// durable boundary; `WorkflowRunOverlayRecord` is its precise in-memory
// projection (the team-spec pattern).
const storedOverlayRecordSchema = overlayRecordSchema as unknown as z.ZodType<WorkflowRunOverlayRecord>

/** The `agent_swarm_workflow` domain spec opened through `ctx.storageDomain`. */
export const workflowOverlayDomainSpec = defineDomain({
  name: WORKFLOW_OVERLAY_DOMAIN_NAME,
  version: WORKFLOW_OVERLAY_DOMAIN_VERSION,
  tables: {
    runs: domainTable<string, WorkflowRunOverlayRecord>(storedOverlayRecordSchema),
  },
})

/**
 * The overlay store over one open domain handle. Writes reach backend
 * durability through the domain's write chain before `put` resolves, so a
 * committed record is observable after a crash (the reload-recovery path).
 */
export class WorkflowRunOverlayStore {
  private readonly runs: ReturnType<Domain<typeof workflowOverlayDomainSpec>['table']>
  private storeClosed = false

  constructor(
    _ctx: Context,
    domain: Domain<typeof workflowOverlayDomainSpec>,
    private readonly now: () => number = Date.now,
  ) {
    this.runs = domain.table('runs')
  }

  /** Read one run record (any scope; linkage fields carry the scope). */
  get(runId: string): WorkflowRunOverlayRecord | undefined {
    if (this.storeClosed) throw new Error('workflow run overlay store is closed')
    const record = this.runs.get(runId)
    return record === undefined ? undefined : { ...record }
  }

  /** List every run record, oldest first. */
  list(): WorkflowRunOverlayRecord[] {
    if (this.storeClosed) throw new Error('workflow run overlay store is closed')
    return [...this.runs.entries()]
      .toSorted((left, right) => left[1].createdAt - right[1].createdAt || left[0].localeCompare(right[0]))
      .map(([, record]) => ({ ...record }))
  }

  /** Durably upsert one run record; resolves after backend durability. */
  async put(record: WorkflowRunOverlayRecord): Promise<void> {
    if (this.storeClosed) throw new Error('workflow run overlay store is closed')
    await this.runs.put(record.runId, { ...record })
  }

  /**
   * Mark one non-settled run as interrupted by a process boundary (crash or
   * teardown without settlement). Evidence-only: the run is never re-driven
   * here — re-driving belongs to the orchestration-mode surface (#77).
   * @returns the updated record, or `undefined` when the run already settled.
   */
  async markInterrupted(runId: string, diagnostic: string): Promise<WorkflowRunOverlayRecord | undefined> {
    const record = this.get(runId)
    if (record === undefined || record.state !== 'running') return undefined
    const updated: WorkflowRunOverlayRecord = {
      ...record,
      state: 'interrupted',
      error: diagnostic,
      updatedAt: this.now(),
    }
    await this.put(updated)
    return updated
  }

  /** Stop accepting operations (the domain handle itself is closed by the owner). */
  close(): void {
    this.storeClosed = true
  }
}

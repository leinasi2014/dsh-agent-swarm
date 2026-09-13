/**
 * The S1 skills-management module (docs/04 §7.2, docs/07 §5): a Captain's
 * skill request is durably persisted in the module-owned official Storage
 * Domain BEFORE the tool face returns "received"; the same requestId +
 * revision + canonical payload hash is idempotent (read-back), a differing
 * payload at the same revision conflicts loudly, and cancellation / admission
 * closure / pre-write identity re-checks fence every durable write. Intake and
 * investigation share the ONE true per-Team serialization lane; every durable
 * write re-validates the full key + revision + payload hash inside the
 * official single-record update, and a `needs_evidence` request is
 * supplemented by the same requestId at strictly revision+1.
 *
 * The dedicated manager is one module-owned Agent Handle on its OWN
 * provider/model route (never the Team default) identified by a DURABLE
 * binding: restarts resume the same Session identity through the official
 * `agents.resume` (setup-commit generation re-check; a late handle never
 * publishes), scoped registrations only, inherited tools continuously removed
 * via the official `tools.restrict({ allow: [] })`. It consumes authorized
 * work facts only through the manifest-gated official Consumer tool (one
 * aggregate read yields baseline facts + watermarks; pages advance with ONE
 * atomic update each; evidence is referenced and hash-verified, never read).
 *
 * Teardown order (memoized): close admission → invalidate generation and
 * abort opening work → start the official manager-handle dispose FIRST
 * (cancel → whenIdle → flush → unregister, own handle only) → drain wakes,
 * queued writes and revocations → close store → close domain. Business
 * Agents are never touched. All model routes, identities, scopes and Team
 * bindings are Host-derived; no model-facing parameter can borrow another
 * Session or root.
 *
 * @module dsh-agent-swarm/skills/module
 */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamState } from '../domain/types.js'
import { requireAgent } from '../runtime/authority.js'
import { planConsumerAdvance, projectConsumerPage, skillsAckHash, type ConsumerSourceSnapshot } from './consumer-sync.js'
import { decideOutcome, resolveEvidenceFromSnapshot, type EvidenceResolution } from './evidence.js'
import { AuthorityGuards } from './authority-guards.js'
import { ManagerLifecycle } from './manager-lifecycle.js'
import { ReleaseAuthority } from './release-authority.js'
import { CandidateAuthority } from './release-candidates.js'
import { statusViewOf, toCanonicalPayload, type SkillsAckReceipt, type SkillsCallAuthority, type SkillsReceipt, type SkillsRequestInput, type SkillsStatusView, type SkillsSyncPage } from './contracts.js'
import {
  skillsPayloadHash,
  type SkillsManagementStore,
  type SkillsRequestPayload,
  type SkillsRequestRecord,
} from '../storage/skills-management.js'

export type { EvidenceResolution }
export type { SkillsAckReceipt, SkillsCallAuthority, SkillsReceipt, SkillsRequestInput, SkillsStatusView, SkillsSyncPage } from './contracts.js'

/** Host-resolved module configuration (validated at plugin apply). */
export interface SkillsManagementConfig {
  readonly manager: { readonly provider?: string; readonly model?: string }
  /** Management manifest: the ONLY workspace+Team pairs this Host grants. */
  readonly management: { scope: string; teamId: string }[]
  readonly activityPageSize: number
}

/** Official swarm reads the module consumes (never a mutation path). */
export interface SkillsManagementDeps {
  readonly domain: TeamDomainPort
  readonly listTeamAggregates: (scope: TeamScope) => Promise<TeamState[]>
  readonly scopeOf: (agent: Agent) => TeamScope
}

/** Caller context the consumer-side-effect fence re-validates before any write. */
interface ConsumerFence {
  readonly generation: number
  readonly agent?: Agent
  readonly signal?: AbortSignal
}

/**
 * The module. One instance owns one manager handle, one admission state, one
 * authorization generation, and per-Team serialized writers over the store.
 */
export class SkillsManagementModule {
  private admissionClosed = false
  private generation = 1
  private closePromise: Promise<void> | undefined
  private readonly teamWrites = new Map<string, Promise<void>>()
  private readonly revocations = new Set<Promise<unknown>>()
  private managersRef: ManagerLifecycle | undefined
  private releasesRef: ReleaseAuthority | undefined
  private candidatesRef: CandidateAuthority | undefined

  constructor(
    private readonly ctx: Context,
    private readonly store: SkillsManagementStore,
    private readonly deps: SkillsManagementDeps,
    private readonly config: SkillsManagementConfig,
  ) {}

  /** Session mechanics live in the lifecycle helper; decisions/fences stay here. */
  private get managers(): ManagerLifecycle {
    this.managersRef ??= new ManagerLifecycle({
      ctx: this.ctx,
      store: this.store,
      config: this.config,
      generation: () => this.generation,
      isAdmissionClosed: () => this.admissionClosed,
      assertAdmission: () => this.guards.assertAdmission(),
      investigateTool: (requestId, exec) => this.investigate(requestId, exec),
      ackTool: (batchId, outcome, exec) => this.ackBatch(batchId, outcome, exec),
      proposeTool: (raw, exec) => this.candidates.proposeCandidate(raw, exec),
    })
    return this.managersRef
  }

  /** Host-visible identity of the dedicated manager Session: the live handle, else the DURABLE binding (identity is stable across restarts — the same Session identity is resumed, never randomly replaced). */
  get managerAgentId(): string {
    return this.managers.agentHandle?.agent.id ?? this.store.getManagerBinding()?.sessionId ?? ''
  }

  /** S2 release/assignment face (host approval + Captain assignment) over this module's fences and per-Team lane (docs04 §release/assign). */
  get releases(): ReleaseAuthority {
    this.releasesRef ??= new ReleaseAuthority({ ctx: this.ctx, store: this.store, guards: this.guards, domain: this.deps, lane: (s, t, fn) => this.forTeam(s, t, fn) })
    return this.releasesRef
  }

  /** S2 candidate chain (manager capture + independent Captain review) over
   * the same fences. Team ownership of a capture comes from the DURABLE
   * request among the manifest Teams (the manager's own cwd/scope is never
   * assumed to be the business Team); a request id matching multiple Teams is
   * refused as ambiguous, never silently picked. */
  get candidates(): CandidateAuthority {
    this.candidatesRef ??= new CandidateAuthority({
      store: this.store, guards: this.guards, domain: this.deps, lane: (s, t, fn) => this.forTeam(s, t, fn),
      lookupCandidateTeam: requestId => {
        const matches = this.store.findRequestByIdentity(requestId, this.guards.manifestKeys())
        if (matches.length === 0) return undefined
        if (matches.length > 1) return { ambiguous: true as const }
        return { scope: matches[0]!.scope, teamId: matches[0]!.teamId }
      },
      // Exact live-handle object identity through the registry — a bare
      // SessionId string match (binding) is NOT accepted as the manager.
      isManagerAgent: agent => this.managers.agentHandle?.agent === agent,
    })
    return this.candidatesRef
  }

  /**
   * Host-side authorization change: bumps the fencing generation, shrinks the
   * manifest, and durably retires that pair's still-live requests to an
   * explicit `unavailable / authorization-revoked` (never left hanging).
   */
  revokeManagement(scope: string, teamId: string): number {
    const index = this.config.management.findIndex(entry => entry.scope === scope && entry.teamId === teamId)
    if (index >= 0) this.config.management.splice(index, 1)
    this.generation += 1
    const doomed = this.store.listRequestsByStates(scope, teamId, ['received', 'investigating'])
    const revocation = (async (): Promise<void> => {
      for (const record of doomed) {
        try {
          await this.store.updateRequest(scope, teamId, record.requestId, current =>
            (current.state === 'received' || current.state === 'investigating')
            && current.revision === record.revision && current.payloadHash === record.payloadHash
              ? { ...current, state: 'unavailable' as const, reason: 'authorization-revoked' }
              : current)
        } catch {
          // A fenced or already-closed transition stays visible via the record itself.
        }
      }
    })()
    this.revocations.add(revocation)
    void revocation.finally(() => { this.revocations.delete(revocation) })
    return this.generation
  }

  /** Teardown step one, all synchronous: stop admission, invalidate the
   * generation (every in-flight fence now fails closed), abort opening work. */
  closeAdmission(): void {
    if (this.admissionClosed) return
    this.admissionClosed = true
    this.generation += 1
    this.managers.abortClosing(new TeamDomainError('the skills-management module is closing', 'SKILLS_ADMISSION_CLOSED'))
  }

  /**
   * Full teardown, memoized (the official disposer may call repeatedly):
   * synchronous admission close → start the official manager-handle dispose
   * (cancel → whenIdle → Session flush → unregister, OWN handle only) FIRST
   * and only then drain wakes/queued writes/revocations → close the store.
   * Business Agents are never touched.
   */
  close(): Promise<void> {
    this.closePromise ??= (async (): Promise<void> => {
      this.closeAdmission()
      await this.releasesRef?.closeAssembly()
      // Official dispose starts FIRST inside beginClose(): it cancels in-flight
      // turns so wakes waiting on whenIdle settle; settle() drains the rest.
      const { disposal, settle } = this.managers.beginClose()
      await settle()
      await Promise.allSettled(this.teamWrites.values())
      await Promise.allSettled(this.revocations)
      await disposal
      this.store.close()
    })()
    return this.closePromise
  }

  /** Bounded mount-time recovery (delegated to the Session lifecycle owner). */
  startRecovery(): Promise<void> {
    return this.managers.startRecovery()
  }

  // ── Captain faces ─────────────────────────────────────────────────────────

  /** Durable intake: persist the accepted intent before returning the receipt. */
  async request(input: SkillsRequestInput, exec: SkillsCallAuthority): Promise<SkillsReceipt> {
    const agent = requireAgent(exec)
    const scope = this.deps.scopeOf(agent)
    const payload = toCanonicalPayload(input)
    const payloadHash = skillsPayloadHash(payload)
    // Identity comes from the official membership read; the REAL Team id then
    // keys the SAME serialization lane as investigate/cancel (root ruling: one
    // true per-Team request key, no separate intake queue).
    const membership = await this.guards.assertCaptain(agent, scope)
    const teamId = membership.team.id
    return await this.forTeam(scope, teamId, async () => {
      this.guards.assertAdmission()
      exec.signal.throwIfAborted()
      // New Teams outside the Host management manifest are refused BEFORE any
      // intake write and never start a model.
      this.guards.assertManifest(scope, teamId)
      // Pre-write fence: abort, admission and the exact live identity are
      // re-checked right before the durable write.
      exec.signal.throwIfAborted()
      this.guards.assertAdmission()
      this.guards.assertLive(agent)
      const put = await this.store.putRequestIfAbsent(scope, teamId, input.requestId, {
        revision: input.revision,
        payloadHash,
        payload,
        state: 'received',
        captainSessionId: agent.id,
      })
      let record = put.record
      // `replayed` means EXACTLY: an identical intake for the CURRENT
      // revision already stands (same revision + same canonical payload).
      // A legally accepted revision+1 continuation is a fresh receipt.
      let replayed = false
      if (!put.created) {
        const reconciled = await this.reconcileExisting(scope, teamId, input, payloadHash, payload, record)
        record = reconciled.record
        replayed = reconciled.replayed
      }
      const managerConfigured = this.config.manager.provider !== undefined && this.config.manager.model !== undefined
      if (record.state === 'received' && !managerConfigured) {
        record = await this.store.updateRequest(scope, teamId, input.requestId, current => ({ ...current, state: 'unavailable', reason: 'manager-model-not-configured' }))
      }
      if (record.state === 'received' && managerConfigured) this.managers.trackWake(record)
      return {
        request_id: record.requestId, revision: record.revision, received: true,
        replayed, state: record.state, accepted_at: record.createdAt, updated_at: record.updatedAt,
      }
    })
  }

  /** Storage-only read of the durable receipt (never a model call). */
  async status(requestId: string, exec: SkillsCallAuthority): Promise<SkillsStatusView> {
    const agent = requireAgent(exec)
    const scope = this.deps.scopeOf(agent)
    const membership = await this.guards.assertCaptain(agent, scope)
    const record = this.store.getRequest(scope, membership.team.id, requestId)
    if (record === undefined) throw new TeamDomainError(`skill request ${requestId} not found`, 'SKILLS_REQUEST_NOT_FOUND')
    this.guards.assertLive(agent)
    return statusViewOf(record)
  }

  /** Captain cancellation: effective only while the request is still pre-investigation. */
  async cancel(requestId: string, revision: number, exec: SkillsCallAuthority): Promise<SkillsStatusView> {
    const agent = requireAgent(exec)
    const scope = this.deps.scopeOf(agent)
    const membership = await this.guards.assertCaptain(agent, scope)
    const teamId = membership.team.id
    return await this.forTeam(scope, teamId, async () => {
      this.guards.assertAdmission()
      this.guards.assertLive(agent)
      const toCancelled = (current: SkillsRequestRecord): Omit<SkillsRequestRecord, 'schemaVersion' | 'scope' | 'teamId' | 'requestId' | 'createdAt'> => {
        if (current.state !== 'received') throw new TeamDomainError(`skill request ${requestId} is already ${current.state}`, 'SKILLS_REQUEST_NOT_CANCELLABLE')
        return { ...current, state: 'cancelled', reason: 'cancelled-after-intake' }
      }
      const existing = this.store.getRequest(scope, teamId, requestId)
      if (existing === undefined) {
        // Pre-intake cancellation: a durable tombstone blocks that revision.
        const put = await this.store.putRequestIfAbsent(scope, teamId, requestId, {
          revision,
          payloadHash: '0'.repeat(64),
          payload: { question: 'cancelled before intake', evidence: [] },
          state: 'cancelled',
          reason: 'cancelled-before-intake',
          captainSessionId: agent.id,
        })
        if (put.created) return statusViewOf(put.record)
        return statusViewOf(await this.store.updateRequest(scope, teamId, requestId, toCancelled))
      }
      return statusViewOf(await this.store.updateRequest(scope, teamId, requestId, toCancelled))
    })
  }

  // ── Manager face (dedicated Session only) ─────────────────────────────────

  /**
   * The restricted official Consumer read + durable outcome write, executed
   * only by the exact live module-owned manager Agent inside its scoped tool.
   */
  async investigate(requestId: string, exec: SkillsCallAuthority): Promise<{ request: SkillsStatusView; activity: SkillsSyncPage }> {
    const agent = requireAgent(exec)
    const handle = this.managers.agentHandle
    if (this.admissionClosed || handle === undefined || handle.agent !== agent || this.ctx.agents.get(agent.id) !== agent) {
      throw new TeamDomainError('skills investigation requires the exact live module manager Session', 'SKILLS_UNAUTHORIZED')
    }
    const generation = this.generation
    const candidates = this.store.findRequestByIdentity(requestId, this.guards.manifestKeys())
    if (candidates.length === 0) throw new TeamDomainError(`skill request ${requestId} is outside the management manifest`, 'SKILLS_UNAUTHORIZED')
    if (candidates.length > 1) throw new TeamDomainError(`skill request ${requestId} is ambiguous across authorized Teams`, 'SKILLS_AMBIGUOUS')
    const target = candidates[0]!
    return await this.forTeam(target.scope, target.teamId, async () => {
      this.guards.assertAdmission()
      this.guards.assertManifest(target.scope, target.teamId)
      // Work against the CURRENT record inside the shared per-Team lane, never
      // the pre-queue lookup: a supplement/cancel that landed meanwhile wins.
      let record = this.store.getRequest(target.scope, target.teamId, requestId) ?? target
      if (record.state === 'investigating' && record.managerSessionId !== agent.id) {
        throw new TeamDomainError(`skill request ${requestId} is held by another investigation`, 'SKILLS_BUSY')
      }
      if (record.state === 'received') {
        record = await this.store.updateRequest(target.scope, target.teamId, requestId, current => ({
          ...current, state: 'investigating' as const, managerSessionId: agent.id,
        }))
      }
      if (record.state !== 'investigating') {
        throw new TeamDomainError(`skill request ${requestId} is ${record.state}; nothing to investigate`, 'SKILLS_REQUEST_STALE')
      }
      const expected = { revision: record.revision, payloadHash: record.payloadHash }
      const activity = await this.syncWorkActivityLocked(target.scope, target.teamId, {
        generation,
        agent,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
      const evidence = await this.resolveEvidence(record)
      const outcome = decideOutcome(record, evidence, activity.cursorSequence)
      const adoption = outcome.reason === 'no_approved_version' ? await this.releases.adoptionForRequest(target.scope, target.teamId, record) : undefined
      const updated = await this.store.updateRequest(target.scope, target.teamId, requestId, current => {
        // FINAL commit boundary (docs04 §L200: authorization is checked before
        // the actual durable side effect, across BOTH the commit-queue and the
        // record-update queue): the COMPLETE authorization set — admission,
        // manifest, generation, abort, exact live Agent/handle — is
        // re-validated HERE, not merely before queueing.
        this.guards.assertAdmission()
        this.guards.assertManifest(target.scope, target.teamId)
        if (generation !== this.generation) throw new TeamDomainError('skills authorization generation changed during investigation', 'SKILLS_REVOKED')
        exec.signal?.throwIfAborted()
        // Exact live Agent AND Session instances (assertLive), plus this
        // investigation's own handle ownership — nothing less is "live".
        this.guards.assertLive(agent)
        if (this.managers.agentHandle?.agent !== agent) {
          throw new TeamDomainError('manager Session changed during investigation', 'SKILLS_REVOKED')
        }
        if (current.state !== 'investigating' || current.managerSessionId !== agent.id) {
          throw new TeamDomainError(`skill request ${requestId} investigation was fenced`, 'SKILLS_BUSY')
        }
        // Full-key re-validation INSIDE the one official record update: a wake
        // for an old revision/hash can never overwrite a newer revision.
        if (current.revision !== expected.revision || current.payloadHash !== expected.payloadHash) {
          throw new TeamDomainError(`skill request ${requestId} advanced to revision ${current.revision}; this writer (revision ${expected.revision}) is stale`, 'SKILLS_REQUEST_STALE')
        }
        return { ...current, ...(adoption !== undefined && this.releases.stillPinned(target.scope, target.teamId, adoption) ? { state: 'available' as const, result: { ...outcome.result, ...this.releases.adoptionResult(adoption) } } : outcome) }
      })
      return { request: statusViewOf(updated), activity }
    })
  }

  /**
   * Per-Team activity consumption (contract ①+②): ONE un-acked bounded batch
   * per Team, captured from ONE aggregate snapshot with refs + batchId +
   * page-tail cursor in one consumer update; an un-acked batch is RE-SERVED
   * with zero writes and never extended or evicted. Gap / regression /
   * replaced-ID / archived / missing are explicit, sticky, deduplicated, and
   * overflow-counted; the first slice stops and reports instead of rebuilding.
   * Contract ③ fence: every consumer side effect (first-touch creation AND the
   * batch commit) re-validates admission, manifest, generation, live Agent and
   * abort AFTER the real source-read await — an authorization change or
   * cancellation landing inside the window can never advance the consumer.
   */
  async syncWorkActivity(scope: string, teamId: string, exec?: SkillsCallAuthority): Promise<SkillsSyncPage> {
    this.guards.assertManifest(scope, teamId)
    const fence: ConsumerFence = {
      generation: this.generation,
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    }
    return await this.forTeam(scope, teamId, () => this.syncWorkActivityLocked(scope, teamId, fence))
  }

  /** Contract ① explicit acknowledgement: only the dedicated live manager
   * Session may ack, re-validated on all five fence axes plus the batch
   * identity; clearing the batch and recording `lastAck` happen in ONE consumer
   * update. A lost-response retry replays idempotently against the current
   * lastAck, a differing payload conflicts, an unknown/superseded batch is
   * refused. Ack proves the bounded batch was processed — nothing more. */
  async ackBatch(batchId: string, outcome: string, exec: SkillsCallAuthority): Promise<SkillsAckReceipt> {
    const parsedOutcome = z.string().min(1).max(512).safeParse(outcome)
    if (!parsedOutcome.success) throw new TeamDomainError('the ack outcome must be a bounded non-empty conclusion', 'SKILLS_INPUT_INVALID')
    const agent = requireAgent(exec)
    const handle = this.managers.agentHandle
    if (this.admissionClosed || handle === undefined || handle.agent !== agent || this.ctx.agents.get(agent.id) !== agent) {
      throw new TeamDomainError('only the live module manager Session may acknowledge batches', 'SKILLS_UNAUTHORIZED')
    }
    const generation = this.generation
    const owners = this.config.management
      .map(pair => ({ ...pair, consumer: this.store.getConsumer(pair.scope, pair.teamId) }))
      .filter(entry => entry.consumer?.pendingBatch?.batchId === batchId || entry.consumer?.lastAck?.batchId === batchId)
    if (owners.length === 0) throw new TeamDomainError(`ack for unknown or superseded batch ${batchId}`, 'SKILLS_ACK_STALE')
    if (owners.length > 1) throw new TeamDomainError(`batch ${batchId} is ambiguous across authorized Teams`, 'SKILLS_AMBIGUOUS')
    const { scope, teamId } = owners[0]!
    return await this.forTeam(scope, teamId, async () => {
      const auth: ConsumerFence = { generation, agent, ...(exec.signal === undefined ? {} : { signal: exec.signal }) }
      let receipt: SkillsAckReceipt | undefined
      // All decisions AND the five-way fence live inside the official queued
      // update callback — the final commit boundary: a revoke/cancel landing in
      // the await windows can never be raced or clear a superseded batch.
      await this.store.updateConsumer(scope, teamId, current => {
        this.fence(auth, scope, teamId)
        const pending = current.pendingBatch
        if (pending?.batchId === batchId) {
          const ackedAt = Date.now()
          receipt = { batch_id: batchId, replayed: false, acked_at: ackedAt }
          return {
            ...current,
            pendingBatch: undefined,
            lastAck: { batchId, refs: pending.refs, payloadHash: skillsAckHash(batchId, parsedOutcome.data, pending.refs), outcome: parsedOutcome.data, ackedAt },
          }
        }
        const lastAck = current.lastAck
        if (lastAck?.batchId === batchId) {
          // Idempotent read-back of the ORIGINAL durable receipt (retry).
          if (lastAck.payloadHash !== skillsAckHash(batchId, parsedOutcome.data, lastAck.refs)) {
            throw new TeamDomainError(`ack for acknowledged batch ${batchId} carries a different payload`, 'SKILLS_ACK_CONFLICT')
          }
          receipt = { batch_id: batchId, replayed: true, acked_at: lastAck.ackedAt }
          return current
        }
        throw new TeamDomainError(`ack for unknown or superseded batch ${batchId}`, 'SKILLS_ACK_STALE')
      })
      // After the real write IO, re-validate before handing back the receipt.
      this.fence(auth, scope, teamId)
      return receipt!
    })
  }

  /** Five-way re-validation guarding every consumer side effect in the same key. */
  private fence(fence: ConsumerFence, scope: string, teamId: string): void {
    this.guards.assertAdmission()
    this.guards.assertManifest(scope, teamId)
    if (fence.generation !== this.generation) {
      throw new TeamDomainError('skills authorization generation changed during activity consumption', 'SKILLS_REVOKED')
    }
    if (fence.agent !== undefined) this.guards.assertLive(fence.agent)
    fence.signal?.throwIfAborted()
  }

  /** Lock-held body of {@link syncWorkActivity}; callers already hold the Team key. */
  private async syncWorkActivityLocked(scope: string, teamId: string, fence: ConsumerFence = { generation: this.generation }): Promise<SkillsSyncPage> {
    const consumer = await this.store.ensureConsumer(scope, teamId, this.generation, () => this.fence(fence, scope, teamId))
    const teams = await this.deps.listTeamAggregates(scope)
    const team = teams.find(candidate => candidate.id === teamId)
    // EVERY watermark below derives from this ONE official aggregate snapshot.
    const snapshot: ConsumerSourceSnapshot = {
      found: team !== undefined,
      archived: team?.phase === 'archived',
      hasWorkActivity: team?.workActivity !== undefined,
      retained: team?.workActivity?.entries ?? [],
      nextSequence: team?.workActivity?.nextSequence ?? 1,
      teamRevision: team?.revision ?? 0,
      taskWatermarks: (team?.tasks ?? []).slice(0, 400).map(t => ({
        taskId: t.id, revision: t.revision, status: t.status as string,
        ...(t.currentAttemptId === undefined ? {} : { currentAttemptId: t.currentAttemptId as string }),
      })),
    }
    const plan = planConsumerAdvance(consumer, snapshot, this.config.activityPageSize, Date.now())
    if (!plan.mutate) {
      // No write happens, but the source IO already elapsed: re-validate the
      // caller before returning the projected view.
      this.fence(fence, scope, teamId)
      return projectConsumerPage(consumer, plan)
    }
    const updated = await this.store.updateConsumer(scope, teamId, current => {
      // The official queued update callback is the FINAL commit boundary:
      // authorization and the plan's basis are re-checked HERE, so a revoke
      // or cancel that landed inside the real source-read await can never be
      // raced past, and no captured pre-await value can clobber a newer batch.
      this.fence(fence, scope, teamId)
      if (current.cursorSequence !== plan.basis.cursorSequence || current.pendingBatch?.batchId !== (plan.basis.batchId ?? undefined)) {
        throw new TeamDomainError(`consumer moved to batch ${current.pendingBatch?.batchId ?? 'none'}; this advance (basis ${plan.basis.batchId ?? 'none'}) is stale`, 'SKILLS_BUSY')
      }
      return plan.next(current)
    })
    return projectConsumerPage(updated, plan)
  }

  /** Resolve one request's evidence against the exact Team/task/attempt + source revision. */
  async readEvidence(requestScope: string, requestTeamId: string, requestId: string): Promise<EvidenceResolution> {
    this.guards.assertManifest(requestScope, requestTeamId)
    const record = this.store.getRequest(requestScope, requestTeamId, requestId)
    if (record === undefined) throw new TeamDomainError(`skill request ${requestId} not found`, 'SKILLS_REQUEST_NOT_FOUND')
    return await this.resolveEvidence(record)
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * QA-④ precise evidence: internal refs are resolved by READING the exact
   * retained projection the official `projectTaskDetail` already defines
   * (teamRevision, task.output, retained attempts' output/evidence, explicit
   * retainedCount/returnedCount/truncated, limit 100) — never by checking an
   * ID and echoing the request string. A ref counts `proven` only when it is
   * actually present in the precisely-bound retained attempt's evidence /
   * output (or the retained task output) of the authorized aggregate.
   */
  private async resolveEvidence(record: SkillsRequestRecord): Promise<EvidenceResolution> {
    this.guards.assertManifest(record.scope, record.teamId)
    const teams = await this.deps.listTeamAggregates(record.scope)
    return resolveEvidenceFromSnapshot(record, teams.find(candidate => candidate.id === record.teamId))
  }

  private async reconcileExisting(scope: string, teamId: string, input: SkillsRequestInput, payloadHash: string, payload: SkillsRequestPayload, stored: SkillsRequestRecord): Promise<{ record: SkillsRequestRecord, replayed: boolean }> {
    if (input.revision === stored.revision) {
      if (stored.state === 'cancelled') throw new TeamDomainError(`skill request ${input.requestId} was cancelled at this revision`, 'SKILLS_REQUEST_CANCELLED')
      if (stored.payloadHash === payloadHash) return { record: stored, replayed: true }
      throw new TeamDomainError(`skill request ${input.requestId} revision ${input.revision} already carries a different canonical payload`, 'SKILLS_REQUEST_CONFLICT')
    }
    if (input.revision < stored.revision) {
      throw new TeamDomainError(`skill request ${input.requestId} is at revision ${stored.revision}; revision ${input.revision} is stale`, 'SKILLS_REQUEST_STALE')
    }
    if ((stored.state === 'cancelled' || stored.state === 'needs_evidence') && input.revision === stored.revision + 1) {
      // A strictly-next revision over a CANCELLATION is a fresh attempt on the
      // same requestId; over NEEDS_EVIDENCE it is the evidence supplement
      // (docs04 §7.2 @ cced2c18) — the ONLY legal supplement entry. Both
      // restart the record at revision+1 with complete new material. A
      // superseded in-flight writer that lands after it re-validates the full
      // key + revision + payload hash inside the official single-record
      // update and fences itself out — a late old writer can never overwrite
      // the newer revision.
      return { record: await this.store.updateRequest(scope, teamId, input.requestId, current => ({
        ...current, revision: input.revision, payloadHash, payload, state: 'received', reason: undefined, result: undefined, managerSessionId: undefined,
      })), replayed: false }
    }
    throw new TeamDomainError(`skill request ${input.requestId} is ${stored.state} at revision ${stored.revision}; revision ${input.revision} is not accepted`, 'SKILLS_REQUEST_STALE')
  }

  private guardsRef: AuthorityGuards | undefined
  /** The single source of the module's non-public authorization guards. */
  private get guards(): AuthorityGuards {
    this.guardsRef ??= new AuthorityGuards({
      ctx: this.ctx,
      domain: this.deps.domain,
      management: () => this.config.management,
      isAdmissionClosed: () => this.admissionClosed,
    })
    return this.guardsRef
  }

  /** One serialized writer per Team key; first creation is serial by this owner. */
  private async forTeam<T>(scope: string, teamId: string, work: () => Promise<T>): Promise<T> {
    const key = `${scope}\u0000${teamId}`
    const previous = this.teamWrites.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    this.teamWrites.set(key, previous.catch(() => undefined).then(() => gate))
    await previous.catch(() => undefined)
    try {
      return await work()
    } finally {
      release()
    }
  }

  /** Lazily open the dedicated manager Agent on its durable Session identity
   * (resume-first, generation re-checks — see {@link ManagerLifecycle}). */
  async ensureManager(): Promise<AgentHandle | undefined> {
    return await this.managers.ensureManager()
  }

  /** Host/fixture drain primitive: settles every in-flight manager wake (the
   * full followup → model turn → investigate/ack → persist cycle); `close()`
   * drains the same set. */
  async flushWakes(): Promise<void> {
    await this.managers.flushWakes()
  }
}

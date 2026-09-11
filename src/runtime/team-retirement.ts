/** Local operator retirement coordinator; Team authority and durable cleanup receipts stay separate. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import { TeamId, type TeamState, type TeamLimits } from '../domain/types.js'
import type { StorageDomainTeamStore } from '../storage/storage-domain-team-store.js'
import { TeamRetirementStore, type RetirementReceipt } from '../storage/team-retirement-store.js'
import type { RetirementCounts, RetirementPreview, RetirementRequest, RetirementResult } from '../shared/team-retirement.js'
import { assertExclusiveReferences, retirementDigest, retirementManifest } from './retirement-manifest.js'
import { RetirementJsonlProvider } from './retirement-jsonl-provider.js'
import type { RetirementData } from './retirement-data.js'
import { stopRetirementSessions } from './retirement-stop.js'
import { readRetirementHistory } from './retirement-history.js'
import { settleRetirementPublic } from './retirement-public-settlement.js'
import type { RetirementHistoryRequest } from '../shared/team-retirement.js'

export interface RetirementBinding {
  readonly scope: string
  readonly mainSessionId: string
  readonly team: TeamState
  readonly verify: () => Promise<void>
  readonly assertTeam: (team: TeamState) => void
}

export class TeamRetirement {
  private receipts?: TeamRetirementStore
  private data?: RetirementData
  private queryContext: Context | undefined
  private readonly admissionLifetimes = new Set<() => void>()
  private readonly operations = new Map<string, { signature: string; result: Promise<RetirementResult> }>()
  constructor(private readonly ctx: Context, private readonly deps: {
    store(): StorageDomainTeamStore
    limits: TeamLimits
    fence<T>(scope: string, teamId: TeamId, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
    suspend(scope: string, teamId: TeamId): Promise<void>
    settle(scope: string, teamId: TeamId): Promise<void>
  }) {
    ctx.inject(['sessionQuery'], queryContext => {
      this.queryContext = queryContext
      return () => { if (this.queryContext === queryContext) this.queryContext = undefined }
    })
  }
  async start(): Promise<void> { this.receipts = await TeamRetirementStore.open(this.ctx) }
  bindData(data: RetirementData): void { this.data = data }
  private get store(): TeamRetirementStore {
    if (this.receipts === undefined) throw new TeamDomainError('Team retirement is not ready', 'TEAM_RETIREMENT_UNAVAILABLE')
    return this.receipts
  }
  isRetired(scope: string, teamId: string): boolean { return this.receipts?.isRetired(scope, teamId) ?? false }
  ownsSession(id: string): boolean { return this.receipts?.ownsSession(id) ?? false }
  install(): () => void {
    let active = true
    const deactivate = () => { active = false }
    this.admissionLifetimes.add(deactivate)
    const stopCreation = this.ctx.on('session/created', session => {
      if (!active) return
      let id: string | undefined = session.id
      const seen = new Set<string>()
      while (id !== undefined && !seen.has(id)) {
        seen.add(id)
        if (this.ownsSession(id)) throw new TeamDomainError('Retired Session cannot be created or resumed', 'TEAM_RETIRED')
        const header: SessionHeader | undefined = id === session.id ? session.header : this.ctx.sessions.get(SessionId(id))?.header
        id = header?.origin === 'subagent' && !header.isSeeded ? header.parentSession : undefined
      }
    })
    const stopStep = this.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (active && this.ownsSession(agent.id)) return { kind: 'reject' }
      const result = await next()
      return active && this.ownsSession(agent.id) ? { kind: 'reject' } : result
    })
    const stopTool = this.ctx.tools.guard(exec => active && exec.agent !== undefined && this.ownsSession(exec.agent.id)
      ? 'Retired Team cannot execute tools.' : undefined)
    return () => { deactivate(); this.admissionLifetimes.delete(deactivate); stopTool(); stopStep(); stopCreation() }
  }
  private provider(): Promise<RetirementJsonlProvider> {
    if (this.queryContext === undefined) throw new TeamDomainError('Session query cleanup is unavailable', 'TEAM_RETIREMENT_PROVIDER_UNAVAILABLE')
    return RetirementJsonlProvider.resolve(this.queryContext)
  }
  private async inspect(scope: string, mainSessionId: string, team: TeamState, signal: AbortSignal) {
    const manifest = await retirementManifest(this.ctx, scope, mainSessionId, team, this.deps.store().records(), signal)
    const counts: RetirementCounts = { sessions: manifest.sessions.length,
      ...(this.data?.counts(scope, team.id) ?? { memories: 0, humanInteractions: 0, workflowRuns: 0 }),
      protectedSessions: manifest.protectedSessionIds.length,
      unfinishedTasks: team.tasks.filter(task => ['pending', 'in_progress', 'submitted', 'verifying'].includes(task.status)).length,
      activeAttempts: team.attempts.filter(attempt => ['running', 'submitted', 'verifying'].includes(attempt.phase)).length }
    let deletion: RetirementPreview['deletion']
    try {
      if (this.data === undefined) throw new Error('Team cleanup stores are not ready')
      const provider = await this.provider()
      manifest.sessions = await provider.prepare(manifest.sessions, signal)
      deletion = { available: true }
    } catch (error) {
      signal.throwIfAborted()
      deletion = { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const preview: RetirementPreview = { schemaVersion: 1, target: { rootSessionId: mainSessionId, teamId: team.id },
      teamName: team.name, teamRevision: team.revision, phase: team.phase, counts, deletion,
      previewDigest: retirementDigest(team, mainSessionId, manifest, counts) }
    return { manifest, preview }
  }
  async preview(binding: RetirementBinding, signal: AbortSignal): Promise<RetirementPreview> {
    const { preview } = await this.inspect(binding.scope, binding.mainSessionId, binding.team, signal)
    await binding.verify(); signal.throwIfAborted()
    return preview
  }
  history(binding: RetirementBinding, request: RetirementHistoryRequest, signal: AbortSignal) {
    return readRetirementHistory(this.ctx, this.deps.store(), binding, request, signal)
  }
  result(scope: string, mainSessionId: string, teamId: string, requestId: string): RetirementResult | undefined {
    const receipt = this.store.get(scope, teamId, requestId)
    if (receipt === undefined) return undefined
    if (receipt.mainSessionId !== mainSessionId) throw new TeamDomainError('Retirement belongs to another Main', 'SWARM_HOST_BINDING_MISMATCH')
    return this.project(receipt, true)
  }
  private validateRequest(receipt: RetirementReceipt, main: string, request: RetirementRequest): void {
    if (receipt.action !== request.action || receipt.mainSessionId !== main || receipt.expectedTeamRevision !== request.expectedTeamRevision
      || (request.action === 'delete' && receipt.previewDigest !== request.previewDigest)) {
      throw new TeamDomainError('Request ID already belongs to another retirement', 'TEAM_RETIREMENT_CONFLICT')
    }
  }
  private join(scope: string, main: string, request: RetirementRequest, run: () => Promise<RetirementResult>): Promise<RetirementResult> {
    const key = JSON.stringify([scope, request.target.teamId, request.requestId])
    const signature = JSON.stringify([main, request.action, request.expectedTeamRevision, request.previewDigest])
    const prior = this.operations.get(key)
    if (prior !== undefined) {
      if (prior.signature !== signature) return Promise.reject(new TeamDomainError('Request ID belongs to another retirement payload', 'TEAM_RETIREMENT_CONFLICT'))
      return prior.result
    }
    const result = run().finally(() => { if (this.operations.get(key)?.result === result) this.operations.delete(key) })
    this.operations.set(key, { signature, result })
    return result
  }
  /** Existing receipts remain replayable under exact Main authority after the Team is gone. */
  resume(scope: string, main: string, request: RetirementRequest, signal: AbortSignal): Promise<RetirementResult> | undefined {
    const receipt = this.store.get(scope, request.target.teamId, request.requestId)
    if (receipt === undefined) return undefined
    this.validateRequest(receipt, main, request)
    return this.join(scope, main, request, () => this.deps.fence(scope, TeamId(receipt.teamId), signal, async () => {
      await this.complete(receipt)
      return this.project(receipt, true)
    }))
  }
  execute(binding: RetirementBinding, request: RetirementRequest, signal: AbortSignal): Promise<RetirementResult> {
    return this.resume(binding.scope, binding.mainSessionId, request, signal) ?? this.join(binding.scope, binding.mainSessionId, request, () => this.run(binding, request, signal))
  }
  private async run(binding: RetirementBinding, request: RetirementRequest, signal: AbortSignal): Promise<RetirementResult> {
    return this.deps.fence(binding.scope, binding.team.id, signal, async currentSignal => {
      const { manifest, preview } = await this.inspect(binding.scope, binding.mainSessionId, binding.team, currentSignal)
      if (request.action === 'delete') {
        if (!preview.deletion.available) throw new TeamDomainError(preview.deletion.reason, 'TEAM_RETIREMENT_PROVIDER_UNAVAILABLE')
        if (request.previewDigest !== preview.previewDigest) throw new TeamDomainError('Deletion scope changed; refresh and confirm its preview', 'TEAM_RETIREMENT_PREVIEW_CHANGED')
      }
      const receipt: RetirementReceipt = { schemaVersion: 1, scope: binding.scope, teamId: binding.team.id, mainSessionId: binding.mainSessionId,
        captainSessionId: binding.team.captainSessionId, requestId: request.requestId, action: request.action, expectedTeamRevision: request.expectedTeamRevision,
        teamRevision: binding.team.revision, previewDigest: preview.previewDigest, counts: preview.counts, ownedSessionIds: manifest.ownedSessionIds,
        sessions: manifest.sessions, requiresConfirmation: false, stage: 'frozen', createdAt: Date.now(), updatedAt: Date.now() }
      await binding.verify(); currentSignal.throwIfAborted()
      await this.deps.store().freezeForOperator(binding.scope, binding.team.id, request.expectedTeamRevision, this.deps.limits, current => {
        binding.assertTeam(current)
        assertExclusiveReferences(current.id, receipt.ownedSessionIds, this.deps.store().records())
        currentSignal.throwIfAborted()
      }, async revision => { receipt.teamRevision = revision; await this.store.put(receipt) })
      await this.complete(receipt)
      return this.project(receipt, false)
    })
  }
  private async refreshStoppedManifest(receipt: RetirementReceipt, team: TeamState): Promise<void> {
    const manifest = await retirementManifest(this.ctx, receipt.scope, receipt.mainSessionId, team, this.deps.store().records(), new AbortController().signal)
    if (manifest.ownedSessionIds.some(id => !receipt.ownedSessionIds.includes(id)) || manifest.sessions.length > receipt.counts.sessions) receipt.requiresConfirmation = true
    const known = new Map(receipt.sessions.map(session => [session.id, session]))
    if (receipt.action === 'delete') {
      const provider = await this.provider()
      manifest.sessions = await provider.prepare(manifest.sessions, new AbortController().signal)
    }
    receipt.ownedSessionIds = [...new Set([...receipt.ownedSessionIds, ...manifest.ownedSessionIds])].sort()
    for (const session of manifest.sessions) {
      const frozen = known.get(session.id)
      if (frozen !== undefined) {
        const frozenArtifact = frozen.artifact, currentArtifact = session.artifact
        if (frozen.cwd !== session.cwd || frozen.parentSessionId !== session.parentSessionId || frozen.origin !== session.origin
          || frozen.createdAt !== session.createdAt || frozen.version !== session.version
          || (receipt.action === 'delete' && frozenArtifact !== undefined && (frozenArtifact.root !== currentArtifact?.root || frozenArtifact.directory !== currentArtifact.directory
            || frozenArtifact.rootIdentity !== currentArtifact.rootIdentity || frozenArtifact.directoryIdentity !== currentArtifact.directoryIdentity))) {
          throw new TeamDomainError('Frozen Session identity changed; replacement data was preserved', 'TEAM_RETIREMENT_SESSION_CONFLICT')
        }
      }
      // An already known pending Session may materialize its first canonical
      // artifact while stopping. Existing confirmed identities never change.
      known.set(session.id, receipt.action === 'archive' && frozen?.artifact !== undefined ? { ...session, artifact: frozen.artifact } : session)
    }
    receipt.sessions = [...known.values()].sort((a, b) => a.id.localeCompare(b.id))
    const counts = this.data?.counts(receipt.scope, receipt.teamId)
    if (counts !== undefined) for (const key of ['memories', 'humanInteractions', 'workflowRuns'] as const) {
      if (counts[key] > receipt.counts[key]) receipt.requiresConfirmation = true
      receipt.counts[key] = counts[key]
    }
    receipt.counts.sessions = receipt.sessions.length
    await this.save(receipt)
  }
  private async complete(receipt: RetirementReceipt): Promise<void> {
    if (receipt.stage === 'completed' || receipt.stage === 'confirmation-required') return
    const teamId = TeamId(receipt.teamId)
    if (receipt.stage === 'frozen') {
      const current = await this.deps.store().read(receipt.scope, teamId)
      if (current === undefined) throw new TeamDomainError('Frozen Team disappeared before cleanup', 'TEAM_RETIREMENT_CONFLICT')
      const archived = current.phase === 'archived' ? current : await this.deps.store().freezeForOperator(receipt.scope, teamId,
        receipt.expectedTeamRevision, this.deps.limits, () => {}, async revision => { receipt.teamRevision = revision; await this.store.put(receipt) }, true)
      await this.refreshStoppedManifest(receipt, archived)
      assertExclusiveReferences(receipt.teamId, receipt.ownedSessionIds, this.deps.store().records())
      await this.deps.suspend(receipt.scope, teamId)
      await stopRetirementSessions(this.ctx, receipt)
      await this.data?.settle(receipt.scope, teamId)
      await this.deps.settle(receipt.scope, teamId)
      await this.refreshStoppedManifest(receipt, archived)
      if (receipt.ownedSessionIds.some(id => this.ctx.agents.get(SessionId(id)) !== undefined || this.ctx.sessions.get(SessionId(id)) !== undefined)) {
        throw new TeamDomainError('Retired Session producers have not drained', 'TEAM_RETIREMENT_DRAIN_PENDING')
      }
      await settleRetirementPublic(this.ctx, this.deps.store(), receipt)
      receipt.stage = receipt.action === 'delete' && receipt.requiresConfirmation ? 'confirmation-required' : 'stopped'
      await this.save(receipt)
      if (receipt.stage === 'confirmation-required') return
    }
    if (receipt.action === 'delete') {
      if (this.data === undefined) throw new TeamDomainError('Cleanup stores are not ready', 'TEAM_RETIREMENT_UNAVAILABLE')
      assertExclusiveReferences(receipt.teamId, receipt.ownedSessionIds, this.deps.store().records())
      if (receipt.stage === 'stopped') {
        await (await this.provider()).purge(receipt.sessions)
        receipt.stage = 'sessions-deleted'; await this.save(receipt)
      }
      if (receipt.stage === 'sessions-deleted') {
        await this.data.purge(receipt.scope, receipt.teamId)
        receipt.stage = 'data-deleted'; await this.save(receipt)
      }
      if (receipt.stage === 'data-deleted') await this.deps.store().purgeRetired(receipt.scope, teamId)
    }
    receipt.stage = 'completed'; await this.save(receipt)
    if (receipt.action === 'delete') for (const prior of this.store.list()) {
      if (prior.scope === receipt.scope && prior.teamId === receipt.teamId && prior.stage === 'confirmation-required') {
        prior.stage = 'completed'; await this.save(prior)
      }
    }
  }
  async recover(): Promise<void> {
    for (const receipt of this.store.list()) if (receipt.stage !== 'completed' && receipt.stage !== 'confirmation-required') {
      try { await this.complete(receipt) } catch (error) { this.ctx.logger.warn(`agent-swarm: Team retirement remains frozen for ${receipt.teamId}: ${String(error)}`) }
    }
  }
  private async save(receipt: RetirementReceipt): Promise<void> { receipt.updatedAt = Date.now(); await this.store.put(receipt) }
  private project(receipt: RetirementReceipt, replayed: boolean): RetirementResult {
    return { schemaVersion: 1, target: { rootSessionId: receipt.mainSessionId, teamId: receipt.teamId }, requestId: receipt.requestId,
      action: receipt.action, state: receipt.stage === 'completed' || receipt.stage === 'confirmation-required' ? receipt.stage : 'pending',
      counts: receipt.counts, replayed, teamRevision: receipt.teamRevision }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.operations.values()].map(operation => operation.result))
    await this.data?.close()
    // Runtime disposal may precede removal of its install effect. Old awaited
    // callbacks must stop reading this domain before the domain is closed.
    for (const deactivate of this.admissionLifetimes) deactivate()
    await this.receipts?.close()
  }
}

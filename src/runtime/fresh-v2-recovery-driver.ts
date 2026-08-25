import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import { TeamV2ContinuationRecoveryDomain } from '../domain/team-domain-v2-continuation-recovery.js'
import { DispatchId, TeamEffectId, type TeamStateV2 } from '../domain/team-state-v2.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { workspaceOf } from './authority.js'
import {
  claimedContinuationFrame,
  continuationCheckpointOf,
  continuationFrameDigest,
  currentContinuationAttempt,
  durableClaimedContinuationFrame,
  frameOfStagedRecovery,
  stagedContinuationRecovery,
} from './fresh-v2-continuation-fold.js'
import { foldPendingContinuationRecovery } from './fresh-v2-continuation-recovery-fold.js'
import { frameVisibility } from './frame-visibility.js'
import type { FreshV2WitnessCapability } from './fresh-v2-witness-capability.js'

const RECOVERY_DELIVERY_TIMEOUT_MS = 30_000

/** Drives only the safe absent→claimed recovery-trigger path over official DSH seams. */
export class FreshV2RecoveryDriver {
  private readonly delivering = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly store: StorageDomainTeamStoreV2,
    private readonly witness: FreshV2WitnessCapability,
    private readonly domain = new TeamV2ContinuationRecoveryDomain(store),
  ) {}

  async beforeAgentRequest(scope: string, team: TeamStateV2, input: {
    readonly agent: Agent
    readonly turn: number
    readonly step: number
    readonly signal: AbortSignal
  }): Promise<boolean> {
    const staged = stagedContinuationRecovery(team, input.agent.id)
    if (staged === undefined) return false
    const witnessDigest = await this.witness.assertCurrent()
    if (witnessDigest !== staged.recovery.witnessCapabilityDigest) {
      throw new TeamDomainError('recovery trigger witness capability changed', 'TEAM_ATTEMPT_STALE')
    }
    const frame = frameOfStagedRecovery(staged)
    const claimed = claimedContinuationFrame(
      input.agent.session, input.turn, input.step, continuationFrameDigest(frame),
    )
    input.signal.throwIfAborted()
    if (!await this.ctx.sessions.flush(input.agent.session)) {
      throw new TeamDomainError('recovery frame requires durable Session persistence', 'TEAM_RUNTIME_NOT_STARTED')
    }
    input.signal.throwIfAborted()
    const durable = claimedContinuationFrame(
      input.agent.session, input.turn, input.step, continuationFrameDigest(frame), claimed.messageId,
    )
    await this.domain.claimRecoveryFrame(scope, team.id, {
      checkpoint: continuationCheckpointOf(staged.current),
      recoveryDispatchId: staged.recovery.dispatchId,
      frameMessageId: durable.messageId,
      messageSeq: durable.messageSeq,
      turn: durable.turn,
      step: durable.step,
    })
    return true
  }

  async reconcileClaimed(
    scope: string,
    team: TeamStateV2,
    memberSessionId: string,
    beforeRepair: readonly SessionEvent[],
    afterRepair: readonly SessionEvent[],
  ): Promise<boolean> {
    const staged = stagedContinuationRecovery(team, memberSessionId)
    if (staged === undefined) return false
    const frame = frameOfStagedRecovery(staged)
    const claimed = durableClaimedContinuationFrame(afterRepair, continuationFrameDigest(frame))
    if (claimed === undefined) return false
    await this.domain.claimRecoveryFrame(scope, team.id, {
      checkpoint: continuationCheckpointOf(staged.current),
      recoveryDispatchId: staged.recovery.dispatchId,
      frameMessageId: claimed.messageId,
      messageSeq: claimed.messageSeq,
      turn: claimed.turn,
      step: claimed.step,
    })
    const updated = this.store.read(scope, team.id)
    const current = updated === undefined ? undefined : currentContinuationAttempt(updated, memberSessionId)
    if (current === undefined || current.dispatch.dispatchId !== staged.recovery.dispatchId) return true
    const evidence = foldPendingContinuationRecovery(
      beforeRepair, afterRepair, continuationCheckpointOf(current), continuationFrameDigest(frame),
    )
    if (evidence.kind !== 'proven-not-entered') return true
    const ordinal = current.dispatch.ordinal + 1
    await this.domain.reserveProvenNotEntered(scope, team.id, {
      checkpoint: continuationCheckpointOf(current),
      recoveryEffectId: TeamEffectId(`effect:${current.attempt.id}:recovery:${ordinal}`),
      recoveryDispatchId: DispatchId(`dispatch:${current.attempt.id}:recovery:${ordinal}`),
      recoveryProofTurnEndSeq: evidence.interruptedTurnEndSeq,
      recoveryProofDigest: evidence.proofDigest,
    })
    return true
  }

  async driveAllLiveCaptains(): Promise<void> {
    for (const captain of this.ctx.agents.roots()) await this.driveForCaptain(captain)
  }

  async driveForCaptain(captain: Agent): Promise<void> {
    const scope = resolve(workspaceOf(captain))
    for (const entry of this.store.listAll()) {
      if (entry.scope !== scope || entry.team.captainSessionId !== captain.id) continue
      for (const attempt of entry.team.attempts) {
        const staged = stagedContinuationRecovery(entry.team, attempt.memberSessionId)
        if (staged !== undefined) await this.deliver(captain, staged)
      }
    }
  }

  private async deliver(
    captain: Agent,
    staged: NonNullable<ReturnType<typeof stagedContinuationRecovery>>,
  ): Promise<void> {
    const key = staged.recovery.effectId
    if (this.delivering.has(key)) return
    this.delivering.add(key)
    try {
      const frame = frameOfStagedRecovery(staged)
      const visibility = await frameVisibility(
        this.ctx,
        staged.current.attempt.memberSessionId,
        frame,
        AbortSignal.timeout(RECOVERY_DELIVERY_TIMEOUT_MS),
        `recovery ${staged.recovery.dispatchId}`,
      )
      if (visibility !== 'absent') {
        if (visibility === 'pending') {
          this.ctx.logger.warn(
            `agent-swarm: recovery ${staged.recovery.dispatchId} is durably pending; official DSH has no safe resume-only seam`,
          )
        }
        return
      }
      await this.ctx.subagents.followup(
        captain,
        SessionId(staged.current.attempt.memberSessionId),
        [{ type: 'text', text: frame }],
        {
          source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
          signal: AbortSignal.timeout(RECOVERY_DELIVERY_TIMEOUT_MS),
        },
      )
    } catch (error) {
      this.ctx.logger.warn(`agent-swarm: recovery ${staged.recovery.dispatchId} was not accepted: ${String(error)}`)
    } finally {
      this.delivering.delete(key)
    }
  }
}

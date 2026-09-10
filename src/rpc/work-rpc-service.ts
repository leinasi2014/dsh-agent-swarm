/** Versioned human work requests on the existing authenticated Connection channel. */
import type { Context } from '@deepseek-ai/cordis'
import { TeamDomainError } from '../domain/error.js'
import type { HostTargetReadService } from '../host/target-read-service.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { publicAppendEligibility } from '../runtime/public-lineage.js'
import { projectWorkRequest } from '../domain/team-domain-work-requests.js'
import { WORK_RPC_ENDPOINTS, workSubmitRequestSchema, workRequestResultRequestSchema, workActivityRequestSchema } from './work-rpc-contract.js'

export async function handleWorkRpc(ctx: Context, runtime: AgentSwarmRuntime, targets: HostTargetReadService,
  endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
  const schema = endpoint === WORK_RPC_ENDPOINTS.submit ? workSubmitRequestSchema
    : endpoint === WORK_RPC_ENDPOINTS.requestResult ? workRequestResultRequestSchema
      : endpoint === WORK_RPC_ENDPOINTS.activity ? workActivityRequestSchema : undefined
  const parsed = schema?.safeParse(payload)
  if (parsed === undefined || !parsed.success) throw new TeamDomainError('Invalid work request', 'SWARM_RPC_INVALID_REQUEST')
  return await targets.withPublicTeam(parsed.data.target, async (scope, team, verify) => {
    const response = (teamRevision = team.revision) => ({ schemaVersion: 1 as const,
      binding: { rootSessionId: team.captainSessionId, teamId: team.id }, teamRevision, observedAt: Date.now() })
    if (endpoint === WORK_RPC_ENDPOINTS.submit) {
      const { target: _target, schemaVersion: _version, ...input } = workSubmitRequestSchema.parse(payload)
      const committed = await runtime.withPublicAdmissionFence(scope, team.id, signal, async current => {
        if ((await publicAppendEligibility(ctx, scope, team, current)).state !== 'available') {
          throw new TeamDomainError('Work requests require an active managed Team with official lineage', 'TEAM_WORK_REQUEST_UNAVAILABLE')
        }
        await verify(); current.throwIfAborted()
        return await runtime.domain.submitWorkRequest(scope, team.id, { kind: 'local-operator' }, input, {
          expectedCaptainSessionId: team.captainSessionId, expectedTeamRevision: team.revision, expectedManagedOrigin: team.managedOrigin!,
        })
      })
      runtime.kickWorkRequests(scope, team.id)
      return { ...response(committed.teamRevision), request: committed.request, replayed: committed.replayed }
    }
    if (endpoint === WORK_RPC_ENDPOINTS.requestResult) {
      const input = workRequestResultRequestSchema.parse(payload)
      const record = team.workRequests?.requests.find(candidate => candidate.origin.kind === 'local-operator' && candidate.requestId === input.requestId)
      const request = record === undefined ? undefined : projectWorkRequest(record)
      await verify(); signal.throwIfAborted()
      return request === undefined ? { ...response(), state: 'not-found' as const }
        : { ...response(), state: 'committed' as const, request }
    }
    const input = workActivityRequestSchema.parse(payload)
    const activity = await runtime.domain.workActivity(scope, team.id, input.afterSequence, input.limit)
    const submitEligibility = await publicAppendEligibility(ctx, scope, team, signal)
    // These display hints never replace the transaction's final capacity check.
    const available = submitEligibility.state === 'available'
    const capacityReason = (team.workRequests?.requests.length ?? 0) >= 256 ? 'request-limit' as const
      : team.messages.filter(message => message.phase === 'queued' && message.targetSessionId === team.captainSessionId).length >= runtime.config.limits.maxPendingMessagesPerMember ? 'mailbox-full' as const : undefined
    await verify(); signal.throwIfAborted()
    return { ...response(), ...activity,
      submitEligibility: available && capacityReason !== undefined ? { state: 'unavailable' as const, reason: capacityReason } : submitEligibility,
      limits: { maxDescriptionChars: 8192, maxAcceptanceCriteriaChars: 4096, maxRequests: 256, maxActivityEntries: 1024 } }
  })
}

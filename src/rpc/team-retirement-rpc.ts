/** Mounted only on the existing authenticated local Connection, never the model tool surface. */
import type { HostTargetReadService } from '../host/target-read-service.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { TeamDomainError } from '../domain/error.js'
import { retirementExecuteRequestSchema, retirementHistoryRequestSchema, retirementPreviewRequestSchema, retirementResultRequestSchema } from '../shared/team-retirement.js'

export async function handleTeamRetirementRpc(runtime: AgentSwarmRuntime, targets: HostTargetReadService,
  endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
  if (endpoint === 'team/v1/history') {
    const parsed = retirementHistoryRequestSchema.safeParse(payload)
    if (!parsed.success) throw new TeamDomainError('Invalid archived history request', 'SWARM_RPC_INVALID_REQUEST')
    return targets.withOperatorTeam(parsed.data.target, binding => runtime.retirement.history(binding, parsed.data, signal))
  }
  if (endpoint === 'team/v1/requestResult') {
    const parsed = retirementResultRequestSchema.safeParse(payload)
    if (!parsed.success) throw new TeamDomainError('Invalid Team retirement request', 'SWARM_RPC_INVALID_REQUEST')
    return targets.withOperatorMain(parsed.data.target.rootSessionId, async (scope, main) => {
      signal.throwIfAborted()
      return runtime.retirement.result(scope, main, parsed.data.target.teamId, parsed.data.requestId) ?? { state: 'not-found' }
    })
  }
  if (endpoint === 'team/v1/preview') {
    const parsed = retirementPreviewRequestSchema.safeParse(payload)
    if (!parsed.success) throw new TeamDomainError('Invalid Team retirement request', 'SWARM_RPC_INVALID_REQUEST')
    return targets.withOperatorTeam(parsed.data.target, binding => runtime.retirement.preview(binding, signal))
  }
  const parsed = endpoint === 'team/v1/execute' ? retirementExecuteRequestSchema.safeParse(payload) : undefined
  if (parsed === undefined || !parsed.success) throw new TeamDomainError('Invalid Team retirement request', 'SWARM_RPC_INVALID_REQUEST')
  return targets.withOperatorMain(parsed.data.target.rootSessionId, (scope, main) => runtime.retirement.resume(scope, main, parsed.data, signal)
    ?? targets.withOperatorTeam(parsed.data.target, binding => runtime.retirement.execute(binding, parsed.data, signal)))
}

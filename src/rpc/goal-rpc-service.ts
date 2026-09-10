/** Human goal control on the official authenticated public Connection channel. */
import type { Context } from '@deepseek-ai/cordis'
import type { HostTargetReadService } from '../host/target-read-service.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { TeamDomainError } from '../domain/error.js'
import { publicAppendEligibility } from '../runtime/public-lineage.js'
import { GOAL_RPC_ENDPOINTS, goalReadRequestSchema, goalSaveRequestSchema,
  goalControlRequestSchema, goalRequestResultRequestSchema } from './goal-rpc-contract.js'

export async function handleGoalRpc(ctx: Context, runtime: AgentSwarmRuntime, targets: HostTargetReadService,
  endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
  const schema = endpoint === GOAL_RPC_ENDPOINTS.read ? goalReadRequestSchema : endpoint === GOAL_RPC_ENDPOINTS.save ? goalSaveRequestSchema
    : endpoint === GOAL_RPC_ENDPOINTS.control ? goalControlRequestSchema : endpoint === GOAL_RPC_ENDPOINTS.requestResult ? goalRequestResultRequestSchema : undefined
  const parsed = schema?.safeParse(payload)
  if (parsed === undefined || !parsed.success) throw new TeamDomainError('Invalid goal request', 'SWARM_RPC_INVALID_REQUEST')
  return await targets.withPublicTeam(parsed.data.target, async (scope, team, verify, assertCurrentTeam) => {
    const response = (current: typeof team) => ({ schemaVersion: 1 as const,
      binding: { rootSessionId: current.captainSessionId, teamId: current.id },
      teamRevision: current.revision, observedAt: Date.now(), snapshot: runtime.goals.project(scope, current) })
    if (endpoint === GOAL_RPC_ENDPOINTS.save || endpoint === GOAL_RPC_ENDPOINTS.control) {
      const committed = await runtime.withPublicAdmissionFence(scope, team.id, signal, async current => {
        if ((await publicAppendEligibility(ctx, scope, team, current)).state !== 'available') {
          throw new TeamDomainError('Goal control requires an active managed Team with official lineage', 'TEAM_GOAL_ORIGIN_INVALID')
        }
        await verify(); current.throwIfAborted()
        const guards = { expectedCaptainSessionId: team.captainSessionId, expectedManagedOrigin: team.managedOrigin!,
          assertExecution: () => current.throwIfAborted(), assertTeam: assertCurrentTeam }
        if (endpoint === GOAL_RPC_ENDPOINTS.save) {
          const { target: _target, schemaVersion: _version, ...input } = goalSaveRequestSchema.parse(payload)
          return runtime.goals.saveOperator(scope, team.id, input, guards)
        }
        const { target: _target, schemaVersion: _version, ...input } = goalControlRequestSchema.parse(payload)
        return runtime.goals.controlOperator(scope, team.id, input, guards)
      })
      // Admission may itself read/deliver public debt. It must run outside the
      // existing public fence, after the goal and its notification are durable.
      await runtime.goals.afterOperatorOperation(scope, committed.team, signal)
      signal.throwIfAborted()
      return { ...response(committed.team), operationRevision: committed.operationRevision, replayed: committed.replayed }
    }
    if (endpoint === GOAL_RPC_ENDPOINTS.requestResult) {
      const input = goalRequestResultRequestSchema.parse(payload)
      const result = await runtime.goals.operationResult(scope, team.id, { kind: 'local-operator' }, input)
      await verify(); signal.throwIfAborted()
      return result.state === 'committed' ? { ...response(result.team), state: result.state, operationRevision: result.operationRevision }
        : { ...response(result.team), state: result.state }
    }
    await verify(); signal.throwIfAborted()
    return response(team)
  })
}

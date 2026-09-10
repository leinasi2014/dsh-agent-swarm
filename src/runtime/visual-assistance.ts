/** Model authority and official attachment/recipient checks around the existing public fence. */
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { TeamDomainError } from '../domain/error.js'
import { isPublicMessageV3 } from '../domain/public-message.js'
import { findAssistanceRequest, findInflightVisualAssistance, normalizeAssistanceRequest, validateAssistanceRequest } from '../domain/team-domain-visual-assistance.js'
import type { RequestVisualAssistanceInput, CompleteVisualAssistanceInput } from '../domain/visual-assistance.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'
import { publicRecipientEligibility } from './public-lineage.js'
import { publicRecipientImageCapability } from './public-image-delivery.js'

export async function requestVisualAssistance(ctx: Context, runtime: AgentSwarmRuntime, exec: ToolExecutionAuthority,
  raw: RequestVisualAssistanceInput) {
  const input = normalizeAssistanceRequest(raw), agent = requireAgent(exec), scope = runtime.scopeOf(agent)
  const initial = await runtime.domain.requireMembership(scope, agent.id)
  try { return await runtime.withPublicAdmissionFence(scope, initial.team.id, exec.signal, async signal => {
    const exact = () => {
      signal.throwIfAborted()
      if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session || runtime.scopeOf(agent) !== scope)
        throw new TeamDomainError('Visual assistance caller changed', 'TEAM_VISUAL_PERMISSION_REVOKED')
    }
    exact()
    await runtime.domain.reconcileVisualAssistance(scope, initial.team.id)
    let { team } = await runtime.domain.requireMembership(scope, agent.id)
    exact()
    if (team.id !== initial.team.id) throw new TeamDomainError('Team membership changed', 'TEAM_VISUAL_PERMISSION_REVOKED')
    const existing = findAssistanceRequest(team, agent.id, input)
    if (existing !== undefined) return { assistance: existing, replayed: true }
    if (findInflightVisualAssistance(team, agent.id, input, Date.now()) !== undefined) {
      exact(); return await runtime.domain.requestVisualAssistance(scope, team.id, agent.id, input, team.revision)
    }
    validateAssistanceRequest(team, agent.id, input)
    if (!await publicRecipientEligibility(ctx, scope, team, [agent.id, input.helperSessionId], signal))
      throw new TeamDomainError('Visual helper is unavailable', 'TEAM_VISUAL_HELPER_UNAVAILABLE')
    const source = team.publicChat!.messages.find(row => row.id === input.sourceMessageId)!
    if (!isPublicMessageV3(source)) throw new TeamDomainError('Original image unavailable', 'TEAM_VISUAL_IMAGE_UNAVAILABLE')
    try {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('Attachment service unavailable')
      for (const part of source.content) if (part.type === 'image' && input.imageIds.includes(part.imageId)) {
        const read = await attachments.readImage(part.attachment, signal)
        if (!isDeepStrictEqual(read.ref, part.attachment)) throw new Error('Image mapping changed')
      }
    } catch (error) { signal.throwIfAborted(); ctx.logger.warn(`agent-swarm: visual reference read failed: ${String(error)}`)
      throw new TeamDomainError('Original image is unreadable', 'TEAM_VISUAL_IMAGE_UNAVAILABLE') }
    const capability = await publicRecipientImageCapability(ctx, scope, team, input.helperSessionId, signal)
    if (capability !== 'supported') throw new TeamDomainError(capability === 'unknown' ? 'Visual helper capability is unknown' : 'Selected helper cannot receive images',
      capability === 'unknown' ? 'TEAM_VISUAL_CAPABILITY_UNKNOWN' : 'TEAM_VISUAL_MODEL_UNSUPPORTED')
    team = (await runtime.domain.requireMembership(scope, agent.id)).team
    exact()
    if (team.id !== initial.team.id) throw new TeamDomainError('Team membership changed', 'TEAM_VISUAL_PERMISSION_REVOKED')
    const currentSource = team.publicChat?.messages.find(row => row.id === source.id)
    if (currentSource === undefined || !isPublicMessageV3(currentSource) || !isDeepStrictEqual(currentSource.content, source.content))
      throw new TeamDomainError('Original image mapping changed during read', 'TEAM_VISUAL_PERMISSION_REVOKED')
    return await runtime.domain.requestVisualAssistance(scope, team.id, agent.id, input, team.revision)
  }) } finally { runtime.kickPublicMessages(scope, initial.team.id) }
}

export async function completeVisualAssistance(ctx: Context, runtime: AgentSwarmRuntime, exec: ToolExecutionAuthority,
  input: CompleteVisualAssistanceInput) {
  const agent = requireAgent(exec), scope = runtime.scopeOf(agent), initial = await runtime.domain.requireMembership(scope, agent.id)
  try { return await runtime.withPublicAdmissionFence(scope, initial.team.id, exec.signal, async signal => {
    await runtime.domain.reconcileVisualAssistance(scope, initial.team.id)
    const current = await runtime.domain.requireMembership(scope, agent.id)
    signal.throwIfAborted()
    if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session || current.team.id !== initial.team.id)
      throw new TeamDomainError('Visual completion caller changed', 'TEAM_VISUAL_PERMISSION_REVOKED')
    return await runtime.domain.completeVisualAssistance(scope, current.team.id, agent.id, input)
  }) } finally { runtime.kickPublicMessages(scope, initial.team.id) }
}

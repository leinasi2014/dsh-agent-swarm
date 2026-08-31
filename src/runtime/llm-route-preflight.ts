import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { TeamDomainError } from '../domain/error.js'

export interface LlmRouteCandidate {
  readonly provider: string | undefined
  readonly model: string | undefined
}

/** Validate an exact LLM provider/model route before committing Team state. */
export async function assertLlmRouteAvailable(
  ctx: Context,
  route: LlmRouteCandidate,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  if (route.provider === undefined || route.model === undefined) return
  try {
    await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new TeamDomainError(
      `${label} LLM route "${route.provider}" / "${route.model}" is unavailable: ${detail}`,
      'TEAM_LLM_ROUTE_INVALID',
      { cause: error },
    )
  }
}

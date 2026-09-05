/** Optional SkillRegistry access inside the plugin context (inject-safe lookup). */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'

/**
 * Resolve the optional `skills` service WITHOUT declaring it as a required
 * plugin inject: `ctx.inject` schedules the callback only when the service is
 * available, so deployments without a Skill registry keep every non-Skill path
 * working and Skill paths fail closed with an explicit diagnostic.
 */
export function injectedSkills(ctx: Context): () => SkillRegistry | undefined {
  let registry: SkillRegistry | undefined
  ctx.inject(['skills'], skillsCtx => {
    registry = skillsCtx.get('skills') as SkillRegistry | undefined
  })
  return () => registry
}

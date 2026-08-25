import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import { TeamDomainError } from '../domain/error.js'

/** Validate a persisted member Skill assignment against the official registry. */
export async function resolveAssignedSkills(
  ctx: Context,
  captain: Agent,
  signal: AbortSignal,
  requested: readonly string[],
  maximumMessage: string,
): Promise<string[]> {
  const assigned = [...new Set(requested)]
  for (const name of assigned) {
    if (name.length > 128 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
      throw new TeamDomainError(`invalid Skill name "${name}"`, 'TEAM_INPUT_INVALID')
    }
  }
  if (assigned.length > 32) throw new TeamDomainError(maximumMessage, 'TEAM_INPUT_INVALID')
  if (assigned.length === 0) return assigned
  const skills = ctx.get('skills')
  if (skills === undefined) {
    throw new TeamDomainError('official DSH Skill Registry is unavailable', 'TEAM_INPUT_INVALID')
  }
  const available = new Set((await skills.list({
    cwd: captain.session.header.cwd,
    scope: captain,
    signal,
  })).map(skill => skill.name))
  const missing = assigned.filter(name => !available.has(name))
  if (missing.length > 0) {
    throw new TeamDomainError(`assigned Skills are unavailable: ${missing.join(', ')}`, 'TEAM_INPUT_INVALID')
  }
  return assigned
}

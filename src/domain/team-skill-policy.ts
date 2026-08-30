import { expectDomain } from './error.js'

/** Maximum number of Skills a Team may explicitly allow. */
export const MAX_TEAM_ALLOWED_SKILLS = 64

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Normalize a Team's immutable Skill allow-list at the domain boundary.
 * An omitted/empty list means the Team keeps the host's ordinary Skill
 * behavior; a non-empty list is the explicit restricted policy.
 */
export function normalizeAllowedSkills(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined || value.length === 0) return undefined
  expectDomain(value.length <= MAX_TEAM_ALLOWED_SKILLS, `allowed skills exceeds ${MAX_TEAM_ALLOWED_SKILLS}`, 'TEAM_INPUT_INVALID')
  const names: string[] = []
  for (const raw of value) {
    const name = raw.trim()
    expectDomain(SKILL_NAME.test(name), `invalid Skill name "${raw}"`, 'TEAM_INPUT_INVALID')
    expectDomain(!names.includes(name), `duplicate Skill name "${name}"`, 'TEAM_INPUT_INVALID')
    names.push(name)
  }
  return names.toSorted()
}

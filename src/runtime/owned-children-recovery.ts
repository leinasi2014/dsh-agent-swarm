/**
 * Restart recovery of the transient root -> dedicated-Captain (`ownedChildren`)
 * edges from the official Session persistence.
 *
 * Reads only the canonical persisted Session headers (`sessionPersistence.list()`);
 * a persisted Session counts as a managed child of its parent ONLY when an
 * authoritative StorageDomain Team aggregate in its own workspace scope
 * (derived from the header's `cwd`) names it as `captainSessionId`. Ordinary
 * sibling subagents, plain continuable children and Team members never
 * resurrect, so read-only enumeration/binding cannot fabricate a captain
 * relationship. No second authority; best-effort.
 * @module dsh-agent-swarm/runtime/owned-children-recovery
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { TeamState } from '../domain/types.js'

/** Rebuild the owned-children map: parent session id -> child captain ids. */
export async function recoverOwnedChildrenFromPersistence(
  ctx: Context,
  deps: {
    readonly store: { readonly list: (scope: TeamScope) => Promise<TeamState[]> }
    readonly rememberTeam: (team: TeamState) => void
  },
): Promise<Map<string, Set<string>>> {
  const persistence = ctx.sessionPersistence
  if (persistence === undefined) return new Map()
  let headers
  try {
    headers = await persistence.list()
  } catch {
    return new Map()
  }
  const owned = new Map<string, Set<string>>()
  const captainsByScope = new Map<TeamScope, ReadonlySet<string>>()
  for (const header of headers) {
    if (header.parentSession === undefined || header.cwd === undefined) continue
    const scope = resolve(header.cwd)
    let captains = captainsByScope.get(scope)
    if (captains === undefined) {
      try {
        const teams = await deps.store.list(scope)
        for (const team of teams) deps.rememberTeam(team)
        captains = new Set(teams.map(team => team.captainSessionId))
      } catch {
        continue
      }
      captainsByScope.set(scope, captains)
    }
    if (!captains.has(header.id)) continue
    const children = owned.get(header.parentSession) ?? new Set<string>()
    children.add(header.id)
    owned.set(header.parentSession, children)
  }
  return owned
}

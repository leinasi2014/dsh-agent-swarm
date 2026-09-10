/** Official durable lineage and continuation evidence for public delivery. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { TeamState } from '../domain/types.js'
import { publicManagedParent } from '../domain/public-message.js'
import { readPersistedSession } from './persisted-session.js'

export type PublicAppendEligibility = { state: 'available' } | { state: 'unavailable'; reason: 'not-managed' | 'not-active' | 'lineage-unavailable' }

export async function publicAppendEligibility(ctx: Context, scope: string, team: TeamState, signal: AbortSignal): Promise<PublicAppendEligibility> {
  const parent = publicManagedParent(team.managedOrigin)
  if (parent === undefined) return { state: 'unavailable', reason: 'not-managed' }
  if (team.phase !== 'active') return { state: 'unavailable', reason: 'not-active' }
  try {
    const [captain, main, children] = await Promise.all([
      readPersistedSession(ctx.sessionPersistence, SessionId(team.captainSessionId), signal),
      readPersistedSession(ctx.sessionPersistence, SessionId(parent), signal),
      ctx.subagents.listChildren(SessionId(parent), signal),
    ])
    if (captain.meta.parentSession !== parent || main.meta.parentSession !== undefined
      || captain.meta.cwd === undefined || resolve(captain.meta.cwd) !== scope
      || main.meta.cwd === undefined || resolve(main.meta.cwd) !== scope
      || !children.some(child => child.kind === 'child' && child.mode === 'continuable' && child.id === team.captainSessionId)) {
      return { state: 'unavailable', reason: 'lineage-unavailable' }
    }
    return { state: 'available' }
  } catch {
    signal.throwIfAborted()
    return { state: 'unavailable', reason: 'lineage-unavailable' }
  }
}

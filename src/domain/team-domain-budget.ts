/**
 * Team budget and usage accounting of the Team protocol core.
 *
 * Owns budget limit configuration, token consumption and the replay-safe
 * per-session usage fold (idempotent by event sequence through one usage
 * cursor per session), plus the budget admission check task claiming must
 * pass. Usage arrives as coalesced per-session batches (M1C write
 * coalescing) that fold under the same cursor semantics in one transaction.
 * Budget semantics stay in one module so the M4 `ctx.tokenMeter`
 * adapter has a single seam to replace.
 */
import { expectDomain, TeamDomainError } from './error.js'
import { actorMembership, type TeamDomainDeps } from './team-domain-shared.js'
import type { TeamBudget, TeamId } from './types.js'
import type { TeamScope } from './team-domain-port.js'

export function budgetAvailable(budget: TeamBudget, now: number): void {
  if (budget.deadlineAt !== undefined && now >= budget.deadlineAt) {
    throw new TeamDomainError('team deadline has expired', 'TEAM_BUDGET_DEADLINE')
  }
  if (budget.requestLimit !== undefined && budget.usedRequests >= budget.requestLimit) {
    throw new TeamDomainError('team request budget exhausted', 'TEAM_BUDGET_REQUESTS')
  }
  if (budget.tokenLimit !== undefined && budget.usedTokens >= budget.tokenLimit) {
    throw new TeamDomainError('team token budget exhausted', 'TEAM_BUDGET_TOKENS')
  }
  if (budget.retryLimit !== undefined && budget.usedRetries >= budget.retryLimit) {
    throw new TeamDomainError('team retry budget exhausted', 'TEAM_BUDGET_RETRIES')
  }
}

export async function setBudget(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  limits: Pick<TeamBudget, 'tokenLimit' | 'requestLimit' | 'retryLimit' | 'deadlineAt'>,
): Promise<TeamBudget> {
  let committed!: TeamBudget
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can configure budget', 'TEAM_CAPTAIN_REQUIRED')
    for (const [name, value] of Object.entries(limits)) {
      if (value !== undefined) expectDomain(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`, 'TEAM_BUDGET_INVALID')
    }
    if (limits.tokenLimit !== undefined) expectDomain(limits.tokenLimit >= team.budget.usedTokens, 'tokenLimit is below current usage', 'TEAM_BUDGET_INVALID')
    if (limits.requestLimit !== undefined) expectDomain(limits.requestLimit >= team.budget.usedRequests, 'requestLimit is below current usage', 'TEAM_BUDGET_INVALID')
    if (limits.retryLimit !== undefined) expectDomain(limits.retryLimit >= team.budget.usedRetries, 'retryLimit is below current usage', 'TEAM_BUDGET_INVALID')
    committed = { ...team.budget, ...limits }
    Object.assign(team, { budget: committed })
  })
  return structuredClone(committed)
}

export async function consumeTokens(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, tokens: number): Promise<TeamBudget> {
  let committed!: TeamBudget
  await deps.store.transact(scope, teamId, team => {
    expectDomain(Number.isSafeInteger(tokens) && tokens >= 0, 'tokens must be a non-negative safe integer', 'TEAM_BUDGET_INVALID')
    const next = team.budget.usedTokens + tokens
    expectDomain(team.budget.tokenLimit === undefined || next <= team.budget.tokenLimit, 'team token budget exceeded', 'TEAM_BUDGET_TOKENS')
    committed = { ...team.budget, usedTokens: next }
    Object.assign(team, { budget: committed })
  })
  return structuredClone(committed)
}

export async function recordSessionUsage(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  sessionId: string,
  eventSeq: number,
  tokens: number,
): Promise<TeamBudget> {
  return await recordSessionUsageBatch(deps, scope, teamId, sessionId, [{ eventSeq, tokens }])
}

/**
 * Fold one coalesced batch of Session usage events in a single transaction
 * (M1C usage write coalescing): each entry only counts while its event seq
 * exceeds the session's durable usage cursor, and the cursor moves to the
 * highest folded seq, so replayed batches and reload recovery never
 * double-count — exactly the single-event semantics, folded at once.
 */
export async function recordSessionUsageBatch(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  sessionId: string,
  entries: readonly { readonly eventSeq: number; readonly tokens: number }[],
): Promise<TeamBudget> {
  expectDomain(entries.length > 0, 'usage batch must not be empty', 'TEAM_BUDGET_INVALID')
  let committed!: TeamBudget
  await deps.store.transact(scope, teamId, team => {
    for (const entry of entries) {
      expectDomain(Number.isSafeInteger(entry.eventSeq) && entry.eventSeq >= 0, 'event seq must be a non-negative safe integer', 'TEAM_BUDGET_INVALID')
      expectDomain(Number.isSafeInteger(entry.tokens) && entry.tokens >= 0, 'tokens must be a non-negative safe integer', 'TEAM_BUDGET_INVALID')
    }
    const known = team.captainSessionId === sessionId || team.members.some(member => member.sessionId === sessionId)
    expectDomain(known, 'usage session is not a Team participant', 'TEAM_UNAUTHORIZED')
    const previous = team.usageCursors[sessionId] ?? -1
    let usedTokens = team.budget.usedTokens
    let cursor = previous
    for (const entry of entries) {
      if (entry.eventSeq <= cursor) continue
      usedTokens += entry.tokens
      cursor = entry.eventSeq
    }
    if (cursor === previous) {
      committed = team.budget
      return
    }
    committed = { ...team.budget, usedTokens }
    Object.assign(team, {
      budget: committed,
      usageCursors: { ...team.usageCursors, [sessionId]: cursor },
    })
  })
  return structuredClone(committed)
}

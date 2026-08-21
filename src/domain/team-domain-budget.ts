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

/**
 * The budget error codes that mean "this Team can no longer admit new work"
 * (the structured exhaustion/deadline vocabulary of {@link budgetAvailable}),
 * as opposed to `TEAM_BUDGET_INVALID` (a rejected caller input). Consumers
 * that watch admission failures — e.g. the run convergence signal of the
 * workflow bridge (M2-5, issue #79) — key on exactly this set.
 */
export const BUDGET_EXHAUSTION_CODES = new Set([
  'TEAM_BUDGET_DEADLINE',
  'TEAM_BUDGET_REQUESTS',
  'TEAM_BUDGET_TOKENS',
  'TEAM_BUDGET_RETRIES',
])

/** Whether one budget face is the untouched fresh-Team default. */
function isFreshBudget(budget: TeamBudget): boolean {
  return budget.usedTokens === 0 && budget.usedRequests === 0 && budget.usedRetries === 0
    && budget.tokenLimit === undefined && budget.requestLimit === undefined
    && budget.retryLimit === undefined && budget.deadlineAt === undefined
}

/**
 * Seed one fresh Team's budget with a prior Team's final budget face (M2-5,
 * issue #79: the budget lifecycle is decoupled from the workflow run —
 * `set_budget` once, sequential runs of the same captain consume one carried
 * ledger). One transaction: limits and used counters adopt together, limits
 * revalidated exactly like {@link setBudget} input and checked against the
 * carried usage. This is a fresh-ledger seed, not a usage write: it never
 * touches the per-session usage cursors or the M1B fold semantics, and it
 * refuses a target ledger that is no longer fresh, so adoption can never
 * overwrite an in-flight Team's accounting. Like `setBudget`, it does not
 * bump the revision (budget configuration is not a board transition).
 */
export async function adoptBudget(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  captainSessionId: string,
  carried: TeamBudget,
): Promise<TeamBudget> {
  let committed!: TeamBudget
  await deps.store.transact(scope, teamId, team => {
    const authority = actorMembership(team, captainSessionId)
    expectDomain(authority.role === 'captain', 'only the captain can adopt a carried budget', 'TEAM_CAPTAIN_REQUIRED')
    expectDomain(isFreshBudget(team.budget), 'budget adoption targets a fresh ledger (use set_budget to reconfigure a live one)', 'TEAM_BUDGET_INVALID')
    for (const name of ['tokenLimit', 'requestLimit', 'retryLimit', 'deadlineAt'] as const) {
      const value = carried[name]
      if (value === undefined) continue
      expectDomain(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`, 'TEAM_BUDGET_INVALID')
    }
    for (const name of ['usedTokens', 'usedRequests', 'usedRetries'] as const) {
      const value = carried[name]
      expectDomain(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative safe integer`, 'TEAM_BUDGET_INVALID')
    }
    expectDomain(carried.tokenLimit === undefined || carried.tokenLimit >= carried.usedTokens, 'carried tokenLimit is below carried usage', 'TEAM_BUDGET_INVALID')
    expectDomain(carried.requestLimit === undefined || carried.requestLimit >= carried.usedRequests, 'carried requestLimit is below carried usage', 'TEAM_BUDGET_INVALID')
    expectDomain(carried.retryLimit === undefined || carried.retryLimit >= carried.usedRetries, 'carried retryLimit is below carried usage', 'TEAM_BUDGET_INVALID')
    committed = { ...carried }
    Object.assign(team, { budget: committed })
  })
  return structuredClone(committed)
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
 * (M1C usage write coalescing): entries are folded in ascending event-seq
 * order regardless of submission order (P2-3), each entry only counts while
 * its event seq exceeds the session's durable usage cursor, and the cursor
 * moves to the highest folded seq, so replayed batches, out-of-order
 * batches and reload recovery never drop or double-count — exactly the
 * single-event semantics, folded at once.
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
    for (const entry of entries.toSorted((left, right) => left.eventSeq - right.eventSeq)) {
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

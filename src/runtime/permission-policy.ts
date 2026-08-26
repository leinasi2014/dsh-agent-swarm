/**
 * SW-I1a tiered allow/ask/deny permission decision model.
 *
 * The official DSH tool pipeline (`tools/pre-execute` → monotonic guards) owns
 * the real execution gate, and `ctx.approval` is serviced by the official
 * ToolRuntime for exactly one concrete tool call inside an open captain turn:
 * a pre-execute `{ kind: 'ask' }` decision is routed through the mounted
 * approval service, and every non-grant outcome (including an absent
 * service) denies. This module therefore stays a project-owned policy
 * overlay: it validates captain-declared tiers, merges them monotone
 * (deny > ask > allow, no widening path), classifies one tool call, and maps
 * the decision onto the official `PreToolDecision` shape consumed by that
 * seam (design note `docs/development/2026-08-22-m5b-permission-family-design.md`,
 * docs/04 §8o/§8p).
 *
 * The Team overlay inherits the official downstream tool preset for an
 * unlisted tool; an `ask` decision is
 * granted only when the caller is the live root captain, the call is a
 * concrete same-turn tool call inside an open turn, and an approval seam is
 * available. Delegated members are pinned to approval `'never'` by the
 * official delegation boundary, so `ask` resolves to `deny` for them and the
 * provisioning-time filter maps every asked tool into the deny list.
 */
import { TeamDomainError } from '../domain/error.js'
import { CAPTAIN_ONLY_TOOLS } from './prompts.js'
import { MAX_DENY_TOOLS, TOOL_NAME_PATTERN } from './tool-policy.js'

/**
 * The complete model-facing `agent_swarm_*` tool surface (19 tools). The
 * effective policy keeps the plugin protocol and Code Mode transport visible.
 * Other unlisted host tools inherit the official downstream preset and its
 * guards; this overlay only narrows explicit/captain-only cases.
 */
const PLUGIN_TOOL_NAMES = [
  // Code Mode dispatches its inner calls back through pre-execute.  Keeping
  // this transport visible therefore does not widen the inner tool decision.
  'run_code',
  ...CAPTAIN_ONLY_TOOLS,
  'agent_swarm_claim_task',
  'agent_swarm_create_task',
  'agent_swarm_submit_task',
  'agent_swarm_send_message',
  'agent_swarm_add_memory',
  'agent_swarm_status',
  'agent_swarm_list_tasks',
  'agent_swarm_list_jobs',
  'agent_swarm_wait',
  'agent_swarm_list_memory',
  'agent_swarm_list_members',
] as const

/** Default effective policy: the plugin's own tool surface is allowed. */
export const DEFAULT_TOOL_POLICY: ToolPolicyDeclaration = { allow: [...PLUGIN_TOOL_NAMES] }

/** One tool-classification decision. */
export type ToolPermissionDecision = 'allow' | 'ask' | 'deny'

/** Caller identity the policy model derives from `exec.agent`, never text. */
export type ToolCallerRole = 'captain' | 'delegated-member' | 'unrelated'

/**
 * Captain-declared tiered tool policy. `allow`/`ask`/`deny` lists must be
 * structurally valid and disjoint: one tool in two tiers is an ambiguous
 * declaration and is rejected loud (`TEAM_TOOL_POLICY_INVALID`).
 */
export interface ToolPolicyDeclaration {
  readonly allow?: readonly string[]
  readonly ask?: readonly string[]
  readonly deny?: readonly string[]
}

/** What the policy knows about the call before it decides. */
export interface ToolPermissionContext {
  readonly callerRole: ToolCallerRole
  /** The call is a concrete tool call in the caller's current open turn. */
  readonly sameTurnConcreteToolCall: boolean
  /** The caller's session currently has an open turn (official approval precondition). */
  readonly openTurn: boolean
  /** An official approval seam is actually mounted in this deployment. */
  readonly approvalSeamAvailable: boolean
}

/** Unlisted tools inherit the official downstream preset and guards. */
export const DEFAULT_TOOL_PERMISSION: ToolPermissionDecision = 'allow'

/** Global bound for every tier (same as the existing deny declaration bound). */
export const MAX_TOOL_POLICY_NAMES = MAX_DENY_TOOLS

/** Monotone order: deny > ask > allow; merging never widens a stricter tier. */
export function mostRestrictiveToolDecision(
  left: ToolPermissionDecision,
  right: ToolPermissionDecision,
): ToolPermissionDecision {
  const rank: Record<ToolPermissionDecision, number> = { allow: 0, ask: 1, deny: 2 }
  return rank[left] >= rank[right] ? left : right
}

function validateNames(tier: 'allow' | 'ask' | 'deny', names: readonly string[] | undefined): void {
  if (names === undefined) return
  if (names.length > MAX_TOOL_POLICY_NAMES) {
    throw new TeamDomainError(
      `tool policy ${tier} must name at most ${MAX_TOOL_POLICY_NAMES} tools (got ${names.length})`,
      'TEAM_TOOL_POLICY_INVALID',
    )
  }
  const seen = new Set<string>()
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '' || !TOOL_NAME_PATTERN.test(name)) {
      throw new TeamDomainError(
        `tool policy ${tier} entries must be non-empty tool names matching ${String(TOOL_NAME_PATTERN)} (got ${JSON.stringify(name)})`,
        'TEAM_TOOL_POLICY_INVALID',
      )
    }
    if (seen.has(name)) {
      throw new TeamDomainError(`tool policy ${tier} must not repeat a tool name (${JSON.stringify(name)})`, 'TEAM_TOOL_POLICY_INVALID')
    }
    seen.add(name)
  }
}

/** Structural validation; returns a readonly-safe copy of the declaration. */
export function validateToolPolicyDeclaration(declaration?: ToolPolicyDeclaration): ToolPolicyDeclaration {
  if (declaration === undefined) return {}
  validateNames('allow', declaration.allow)
  validateNames('ask', declaration.ask)
  validateNames('deny', declaration.deny)
  const seen = new Map<string, ToolPermissionDecision>()
  for (const tier of ['allow', 'ask', 'deny'] as const) {
    for (const name of declaration[tier] ?? []) {
      const previous = seen.get(name)
      if (previous !== undefined && previous !== tier) {
        throw new TeamDomainError(
          `tool policy declares "${name}" in both "${previous}" and "${tier}"; ambiguous tiers are forbidden`,
          'TEAM_TOOL_POLICY_INVALID',
        )
      }
      seen.set(name, tier)
    }
  }
  return declaration
}

function decisionFor(policy: ToolPolicyDeclaration, toolName: string): ToolPermissionDecision | undefined {
  if ((policy.deny ?? []).includes(toolName)) return 'deny'
  if ((policy.ask ?? []).includes(toolName)) return 'ask'
  if ((policy.allow ?? []).includes(toolName)) return 'allow'
  return undefined
}

/**
 * Merge two validated declarations monotone: for every tool named by either
 * side, the merged tier is the stricter of the two; a tool absent from the
 * overlay keeps its base tier. No merge path ever widens a deny or an ask.
 */
export function mergeToolPolicy(
  base: ToolPolicyDeclaration,
  overlay: ToolPolicyDeclaration,
): ToolPolicyDeclaration {
  validateToolPolicyDeclaration(base)
  validateToolPolicyDeclaration(overlay)
  const merged = new Map<string, ToolPermissionDecision>()
  for (const tier of ['allow', 'ask', 'deny'] as const) {
    for (const name of base[tier] ?? []) {
      const current = merged.get(name)
      merged.set(name, current === undefined ? tier : mostRestrictiveToolDecision(current, tier))
    }
  }
  for (const tier of ['allow', 'ask', 'deny'] as const) {
    for (const name of overlay[tier] ?? []) {
      const current = merged.get(name)
      merged.set(name, current === undefined ? tier : mostRestrictiveToolDecision(current, tier))
    }
  }
  const lists: Record<ToolPermissionDecision, string[]> = { allow: [], ask: [], deny: [] }
  for (const [name, tier] of merged) {
    lists[tier].push(name)
  }
  return {
    ...(lists.allow.length === 0 ? {} : { allow: lists.allow }),
    ...(lists.ask.length === 0 ? {} : { ask: lists.ask }),
    ...(lists.deny.length === 0 ? {} : { deny: lists.deny }),
  }
}

/** The Team-overlay decision; downstream official policy remains authoritative. */
export function decideToolPermission(
  declaration: ToolPolicyDeclaration,
  toolName: string,
  context: ToolPermissionContext,
): ToolPermissionDecision {
  validateToolPolicyDeclaration(declaration)
  // Only a verified child-scoped report transport may bypass this classifier
  // (in permission-surface). A global/root same-name tool is never a Team
  // return channel.
  if (toolName === 'report') return 'deny'
  if (context.callerRole === 'delegated-member' && (CAPTAIN_ONLY_TOOLS as readonly string[]).includes(toolName)) return 'deny'
  const declared = decisionFor(declaration, toolName) ?? DEFAULT_TOOL_PERMISSION
  if (declared === 'deny') return 'deny'
  if (declared === 'allow') return 'allow'
  if (context.callerRole !== 'captain') return 'deny'
  if (!context.sameTurnConcreteToolCall) return 'deny'
  if (!context.openTurn) return 'deny'
  if (!context.approvalSeamAvailable) return 'deny'
  return 'ask'
}

/**
 * Map a decision onto the official `PreToolDecision` shape. `ask` is
 * intentionally returned to the official ToolRuntime, which composes
 * `ctx.approval` inside the same open turn; we never call the approval
 * service from an asynchronous review, a free-text message, or a delegated
 * member path.
 */
export function toPreToolDecision(decision: ToolPermissionDecision, toolName: string):
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string } {
  if (decision === 'allow') return { kind: 'allow' }
  if (decision === 'ask') return { kind: 'ask', reason: `tool "${toolName}" requires captain approval for this concrete turn` }
  return { kind: 'deny', reason: `tool "${toolName}" is denied by the Team tool policy (fail closed)` }
}

/**
 * The provisioning-time official `toolFilter` for a delegated member:
 * baseline captain-only tools, declared deny names, AND every asked name
 * (a delegated child is pinned to approval `'never'`, so an ask degenerates
 * to deny). `allow` names have no filter effect: unlisted host tools are
 * already visible by default, and this model never widens the official mask.
 */
export function memberToolPolicyFilter(declaration?: ToolPolicyDeclaration): { readonly deny: readonly string[] } {
  const validated = validateToolPolicyDeclaration(declaration)
  const deny = [...CAPTAIN_ONLY_TOOLS, ...(validated.deny ?? []), ...(validated.ask ?? [])]
  return { deny: [...new Set(deny)] }
}

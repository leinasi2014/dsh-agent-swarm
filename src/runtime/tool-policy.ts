/**
 * Member tool-permission policy composition (M5-2, issue #136 / F17).
 *
 * The official toolFilter seam scopes a continuable child's tools in its
 * creation window only (`applyChildComposition` → scoped `tools.restrict()`,
 * snapshotted into the durable descriptor, replayed on cold resume) — the
 * followup face carries no composition, so a member's host-tool policy is
 * declared once, by the captain, at provisioning (docs/04-core-protocol.md).
 *
 * This module composes that declaration with the M1A static baseline. The
 * composition is DENY-ONLY and monotone: the captain-only administration
 * tools stay mandatorily denied, a declaration can only narrow further, and
 * there is deliberately no `allow` surface — a corrupted or injected
 * declaration can lock a member out (loud, recoverable by provisioning a new
 * member), never escalate it. Structural validation is plugin-side; tool-name
 * EXISTENCE stays with the official seam: `tools.restrict()` rejects unknown
 * global names inside the child's creation window, `startContinuable` fails,
 * and the provisioning record settles failed (fail-loud, no silent member
 * without its declared policy).
 */
import { TeamDomainError } from '../domain/error.js'
import { MEMBER_HIDDEN_TOOLS } from './prompts.js'

/** Bound on one declaration: a deny list longer than every global tool set is a mistake. */
export const MAX_DENY_TOOLS = 64

/** Mandatory deny baseline for delegated members. */
export const MEMBER_DENY_BASELINE: readonly string[] = MEMBER_HIDDEN_TOOLS

/**
 * The immutable member-protocol floor (issue #186): every delegated member
 * must always be able to submit task results and message the captain, so
 * these tools can never be denied for a member. Both the per-recruit
 * deny_tools declaration and the global toolPolicy deny/ask tiers share this
 * one floor; any declaration that intersects it is an impossible-protocol
 * rejection (`TEAM_TOOL_POLICY_INVALID`).
 */
export const MEMBER_PROTOCOL_TOOLS: readonly string[] = ['agent_swarm_submit_task', 'agent_swarm_send_message']

/**
 * Structural tool-name shape. Deliberately permissive toward real tool names
 * (`agent_swarm_send_message`, `bash`, …) while rejecting whitespace,
 * control characters, fences and path-shaped strings — existence remains the
 * official seam's authority.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/**
 * Reject a deny/ask declaration that names a mandatory member-protocol tool.
 * A member must never be stripped of the surface it needs to submit results
 * and message the captain, so any declared name intersecting
 * {@link MEMBER_PROTOCOL_TOOLS} throws an impossible-protocol
 * `TEAM_TOOL_POLICY_INVALID` before a record or runtime side effect.
 *
 * @param names - the declared deny/ask tool names being validated.
 * @param context - human-readable label for the declaration in the error.
 */
export function assertProtocolFloorNotDenied(names: readonly string[], context: string): void {
  const floor = MEMBER_PROTOCOL_TOOLS.filter(tool => names.includes(tool))
  if (floor.length > 0) {
    throw new TeamDomainError(
      `${context} must not deny mandatory member-protocol tool(s): ${floor.join(', ')}`,
      'TEAM_TOOL_POLICY_INVALID',
    )
  }
}

/**
 * Compose one member's provisioning-time tool deny list: the mandatory
 * captain-only baseline plus the captain-declared narrowing names, deduped,
 * baseline-first for a stable order.
 *
 * @param declared - optional captain-declared deny names (`deny_tools`).
 * @returns the deny list for the official `toolFilter`.
 * @throws `TEAM_TOOL_POLICY_INVALID` on any structurally invalid declaration.
 */
export function memberToolDeny(declared?: readonly string[]): string[] {
  if (declared === undefined) return [...MEMBER_DENY_BASELINE]
  if (declared.length > MAX_DENY_TOOLS) {
    throw new TeamDomainError(`deny_tools must name at most ${MAX_DENY_TOOLS} tools (got ${declared.length})`, 'TEAM_TOOL_POLICY_INVALID')
  }
  // Issue #186: a per-recruit deny of a mandatory member-protocol tool is an
  // impossible-protocol declaration and must fail loud, before provisioning.
  assertProtocolFloorNotDenied(declared, 'deny_tools')
  const seen = new Set<string>()
  for (const name of declared) {
    if (typeof name !== 'string' || name.trim() === '' || !TOOL_NAME_PATTERN.test(name)) {
      throw new TeamDomainError(`deny_tools entries must be non-empty tool names matching ${String(TOOL_NAME_PATTERN)} (got ${JSON.stringify(name)})`, 'TEAM_TOOL_POLICY_INVALID')
    }
    if (seen.has(name)) {
      throw new TeamDomainError(`deny_tools must not repeat a tool name (${JSON.stringify(name)})`, 'TEAM_TOOL_POLICY_INVALID')
    }
    seen.add(name)
  }
  // Union with the mandatory baseline: declaring a hidden name is an
  // idempotent no-op the union absorbs — there is no widening path.
  return [...new Set([...MEMBER_DENY_BASELINE, ...declared])]
}

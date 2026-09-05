/** Team-scoped Skill loader composition for newly provisioned continuable agents. */

import type { Context } from '@deepseek-ai/cordis'
import { injectedSkills } from './injected-skills.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { escapeText, isModelInvocable, isSkillName, isUserInvocable, renderSkillContent, type SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-skill'
import type { TeamState } from '../domain/types.js'

/** Description bound applied to the restricted catalog entries (matches the host catalog). */
const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500

/** Sentinel recorded for a Team whose `allowedSkills` is explicitly absent (keeps host defaults). */
const UNRESTRICTED = Symbol('team-skill-surface:unrestricted')

/** One model-facing catalog entry for the restricted Team skill catalog. */
interface RestrictedCatalogEntry {
  readonly name: string
  readonly description: string
}

/**
 * `/name` gesture tokens in a user message, bounded by a non-name character or
 * end-of-text. The host gesture grammar stops at whitespace/end, which misses a
 * gesture followed by punctuation (`/alpha.`), so a governed child recomputes
 * its own set from a slightly looser boundary; over-matches are harmless
 * because only allow-listed names are injected.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=[^a-z0-9-]|$)/g

/**
 * Installs an exact `skill` tool shadow only for Team sessions carrying an
 * explicit allow-list (or, when the policy cannot be resolved on cold resume,
 * a deny-all shadow). The tool reads the normal scoped Skill registry but
 * refuses names outside the Team's own immutable list. An explicitly
 * unrestricted Team keeps the host `skill` loader and the host catalog, and an
 * unresolved (no-record) child fails closed rather than silently inheriting the
 * host loader.
 */
export class TeamSkillSurface {
  private readonly policies = new Map<string, readonly string[] | typeof UNRESTRICTED>()
  /** Session ids that currently carry a governing `skill` shadow (restricted or deny-all). */
  private readonly governed = new Set<string>()
  /**
   * Durable enforcement allow-list by session id, populated when a governing
   * shadow is installed. The continuation manager settles (disposes) an idle
   * continuable child once its first turn completes, which tears down the
   * child's scoped context and with it the `skill` shadow it held 鈥?but the
   * Team policy still governs that session. This record survives the child
   * release, and the execute guard below reads it so a first-turn `skill`
   * execute after the child settles is still denied for a non-allowed name.
   */
  private readonly controlled = new Map<string, ReadonlySet<string>>()

  private readonly skillsOf: () => SkillRegistry | undefined

  constructor(private readonly ctx: Context) {
    this.skillsOf = injectedSkills(ctx)
    // Enforce the allow-list at the EXECUTE boundary, independent of whether the
    // child's scoped shadow is still registered. (The scoped shadow supplies the
    // model schema; this guard supplies the denial after the child settles.)
    ctx.tools.guard(exec => {
      if (exec.name !== 'skill') return undefined
      if (exec.agent === undefined) return undefined
      const allowed = this.controlled.get(String(exec.agent.id))
      if (allowed === undefined) return undefined
      const arg = exec.arguments as { name?: unknown } | undefined
      const name = typeof arg?.name === 'string' ? arg.name : ''
      if (allowed.has(name)) return undefined
      return `Skill "${name}" is not allowed for this Team`
    })

    ctx.subagents.registerContinuableSetup(childCtx => {
      const childAgent = childCtx.agent
      // The child agent is materialized before the setup contribution runs; the
      // guard keeps the narrowly-scoped type honest without changing behavior.
      if (childAgent === undefined) return () => {}
      const childId = String(childAgent.id)
      const entry = this.policies.get(childId)
      // No record (cold resume before the policy resolved) fails closed; an
      // explicit unrestricted Team keeps the host loader; otherwise restrict.
      if (entry === UNRESTRICTED) return () => this.prune(childId)
      const allowed = new Set(entry === undefined ? [] : entry)
      this.governed.add(childId)
      // Record the governing allow-list for the execute guard. It survives the
      // child's disposal so a first-turn execute after the child settles is
      // still denied for a non-allowed name.
      this.controlled.set(childId, allowed)
      childCtx.tools.register(restrictedSkillTool(allowed, this.skillsOf))
      childCtx.systemPrompt.section({
        name: 'agent-swarm:team-skills',
        order: 121,
        text: allowed.size === 0
          ? 'This Team may not load any Skill. Do not request or load a Skill.'
          : `This Team may load only these Skills: ${[...allowed].map(name => `\`${name}\``).join(', ')}. Do not request or load any other Skill.`,
      })
      return () => this.prune(childId)
    })

    // Prepend places this listener OUTERMOST, so the post-`next()` governing
    // runs after the official @deepseek-ai/dsh-tool-skill gesture and catalog
    // listeners have injected their messages. It removes the official
    // `skill-invocation` and `skill-catalog` messages for a governed child and
    // re-injects the allowed invocations plus the restricted catalog, so the
    // Team's policy governs the whole skill face. It only acts on children
    // carrying a governing shadow (the `governed` set), so unrestricted Teams
    // and unrelated agents keep the official behavior.
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const childId = String(agent.id)
      if (!this.governed.has(childId)) return decision
      const entry = this.policies.get(childId)
      const allowed = new Set(entry === undefined || entry === UNRESTRICTED ? [] : entry)
      const retained: UserMessage[] = []
      for (const message of decision.messages) {
        const source = message.source as { kind?: string } | undefined
        if (source?.kind === 'skill-invocation' || source?.kind === 'skill-catalog') continue
        retained.push(message)
      }
      const injections = await this.allowedSkillInvocations(agent, messages, allowed, signal)
      let nextMessages: UserMessage[] = [...retained, ...injections]
      if (allowed.size !== 0 && !hasPublishedRestrictedCatalog(agent)) {
        const entries = await this.restrictedCatalogEntries(agent, allowed, signal)
        if (entries.length !== 0) {
          nextMessages = [...nextMessages, createUserMessage({
            content: [{ type: 'text', text: renderRestrictedCatalog(entries) }],
            source: { kind: 'skill-catalog', form: 'catalog', entries },
          })]
        }
      }
      return { kind: 'enter', messages: nextMessages }
    }, { prepend: true })
  }

  /** Bind the durable Team policy to its Captain and every current member. */
  rememberTeam(team: TeamState): void {
    const policy = team.allowedSkills === undefined ? UNRESTRICTED : team.allowedSkills
    this.policies.set(team.captainSessionId, policy)
    // Issue #184: a member's assigned subset (persisted in the aggregate and
    // reconstructed on restart) narrows the Team policy for that member.
    for (const member of team.members) this.policies.set(member.sessionId, effectivePolicy(policy, member.assignedSkills))
  }

  /** Bind a just-created child before its continuable Session is published. */
  rememberChild(team: TeamState, sessionId: string, assignedSkills?: readonly string[]): void {
    const policy = team.allowedSkills === undefined ? UNRESTRICTED : team.allowedSkills
    this.policies.set(sessionId, effectivePolicy(policy, assignedSkills))
  }

  /**
   * Test-intent observation of the transient policy table. Issue #183's
   * teardown contract requires every logged session id to be pruned when its
   * continuable child is released, so this is exposed for the regression that
   * proves a released session no longer receives a restriction.
   */
  policyEntryCount(): number {
    return this.policies.size
  }

  /** Test-intent: whether one session id currently holds a remembered policy. */
  hasPolicy(sessionId: string): boolean {
    return this.policies.has(sessionId)
  }

  /** Drop one released child's transient policy and governing-shadow records. */
  private prune(childId: string): void {
    this.governed.delete(childId)
    this.policies.delete(childId)
  }

  /** Inject the user-gesture skill-invocations the Team may load. */
  private async allowedSkillInvocations(
    agent: Agent,
    messages: readonly UserMessage[],
    allowed: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<UserMessage[]> {
    const names = invokedSkillNames(messages)
    const injections: UserMessage[] = []
    for (const name of names) {
      if (!allowed.has(name)) continue
      const skill = await this.ctx.skills.get(name, { cwd: agent.session.header.cwd, signal, scope: agent })
      if (skill === undefined || !isUserInvocable(skill)) continue
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source: { kind: 'skill-invocation', name, form: 'instructions' },
      }))
    }
    return injections
  }

  /** Project the restricted catalog entries (allowed + model-invocable) with normalized descriptions. */
  private async restrictedCatalogEntries(
    agent: Agent,
    allowed: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<RestrictedCatalogEntry[]> {
    const skills = this.skillsOf()
    if (skills === undefined) return []
    const snapshot = await skills.snapshot({
      cwd: agent.session.header.cwd,
      signal,
      scope: agent,
    })
    return snapshot.skills
      .filter(skill => allowed.has(skill.name) && isModelInvocable(skill))
      .map(skill => ({ name: skill.name, description: catalogDescription(skill.description) }))
  }
}

function restrictedSkillTool(allowed: ReadonlySet<string>, skillsOf: () => SkillRegistry | undefined) {
  return defineTool({
    name: 'skill',
    description: 'Load the full instructions for one Skill that this Team is allowed to use.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact allowed Skill name.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true }, provider: { type: 'string', required: true },
          resourceBase: { oneOf: [
            {
              type: 'object', additionalProperties: false,
              properties: { kind: { type: 'string', required: true, const: 'directory' }, path: { type: 'string', required: true } },
            },
            {
              type: 'object', additionalProperties: false,
              properties: { kind: { type: 'string', required: true, const: 'url' }, url: { type: 'string', required: true } },
            },
            {
              type: 'object', additionalProperties: false,
              properties: { kind: { type: 'string', required: true, const: 'opaque' }, description: { type: 'string', required: true } },
            },
          ] },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) throw new Error(`invalid Skill name "${args.name}"`)
      if (!allowed.has(args.name)) throw new Error(`Skill "${args.name}" is not allowed for this Team`)
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const skills = skillsOf()
      if (skills === undefined) throw new Error('Skill registry is unavailable in this host; the Team allow-list cannot be served')
      const skill = await skills.get(args.name, lookup)
      if (skill === undefined || !isModelInvocable(skill)) throw new Error(`Skill "${args.name}" is unavailable for model invocation`)
      return {
        name: skill.name,
        provider: skill.provider,
        ...(skill.resourceBase !== undefined ? { resourceBase: { ...skill.resourceBase } } : {}),
        content: skill.content,
      }
    },
    presentCall(args) { return { card: 'generic', title: `Load Skill ${args.name}`, kind: 'read', rawInput: args.name } },
  })
}

/** Whether the agent's session already carries any durable skill-catalog message. */
function hasPublishedRestrictedCatalog(agent: Agent): boolean {
  return agent.session.events.some(
    event => event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'skill-catalog',
  )
}

/** `/name` gesture tokens from the claimed user messages, deduplicated in first-seen order. */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: string }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}

/** Model-facing catalog prose for the restricted Team catalog (mirrors the host catalog). */
function renderRestrictedCatalog(entries: RestrictedCatalogEntry[]): string {
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    ...entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`),
    '</available_skills>',
    '',
    'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill\'s instructions until it has been loaded.',
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>',
  ].join('\n')
}

/** Normalized, length-bounded description exactly as the catalog publishes it (unescaped). */
function catalogDescription(value: string, maxLength = DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/** One member's effective Skill policy: assigned subset narrows the Team list (issue #184). */
function effectivePolicy(
  policy: readonly string[] | typeof UNRESTRICTED,
  assignedSkills: readonly string[] | undefined,
): readonly string[] | typeof UNRESTRICTED {
  // Issue #184: `undefined` (recruiter did not declare a subset) keeps the Team
  // policy. An EXPLICIT empty subset narrows to NO Skill (fail-closed, never a
  // privilege expansion); a non-empty subset intersects the Team allow-list.
  if (assignedSkills === undefined) return policy
  if (assignedSkills.length === 0) return []
  if (policy === UNRESTRICTED) return [...assignedSkills]
  const allowed = new Set(policy)
  return [...new Set(assignedSkills.filter(name => allowed.has(name)))]
}

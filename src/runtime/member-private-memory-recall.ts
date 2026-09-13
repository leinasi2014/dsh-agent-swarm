/**
 * M2 active-task private-memory AUTO RECALL installer (task-6, first slice).
 * Fixed contract: docs/04-core-protocol.md §7.1 at pinned commit
 * 32884365c65251fea3b17cbf5d63129898016593.
 *
 * The automatic path is granted ONLY by the Host config
 * `privateMemoryRecall: 'active-task'` (omitted = disabled); Captain, member,
 * tool-allow or a one-call approval can never enable it, and the current
 * applicable explicit deny/ask of `agent_swarm_list_private_memory` only
 * narrows further (an `ask` SKIPS the automatic path — it never creates an
 * approval or consumes a one-shot). Eligibility is the M1 owning-member
 * partition: the exact live Agent + official Session + scope + active Team +
 * the member's UNIQUE own in-progress Task whose `currentAttemptId` matches a
 * RUNNING attempt owned by this member. Old task provenance grants nothing.
 *
 * Selection runs at the OFFICIAL `system-prompt/assemble` waterfall for the
 * very request being assembled (the AgentLoop awaits assembly BEFORE the
 * `agent/pre-step` dispatch, so pre-step could only ever serve a stale
 * turn); EVERY official model call is then re-verified at the public
 * `llm/stream` delegation boundary right before reaching `next()` —
 * authority, exact identity, Task/attempt and the selected notes' active
 * status and memoryId/headSeq, covering request configuration, adapter
 * preparation and retries. Admission binds to the contribution the FROZEN
 * REQUEST ITSELF carries (its final injected context message), so a deleted
 * server-side cache entry or a newer assembly can never launder a stale
 * request; a failed re-verification REFUSES this delegation with an
 * OBSERVABLE middleware throw (never a fabricated successful stop; the loop
 * contains it as a turn error) without ever invoking `next()`. The frozen
 * official request is never rewritten, no Team lock is held across a model
 * stream, and there is no autonomous retry or wake. Disabling, exit, unload,
 * note changes, compaction and cold recovery clear or rebuild the
 * contribution by recomputation per assembly — already-persisted Session
 * history and already-delegated requests are never claimably rolled back.
 *
 * @module dsh-agent-swarm/runtime/member-private-memory-recall
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamTask } from '../domain/types.js'
import { MemberPrivateMemoryService, uniqueRunningAttemptTask } from './member-private-memory-service.js'
import { effectiveToolPolicy } from './permission-surface.js'
import { decideToolPermission, type ToolPolicyDeclaration } from './permission-policy.js'
import { RECALL_MAX_CANDIDATES, selectRecallNotes, type RecallNoteCandidate } from './member-private-memory-recall-selection.js'
import { renderRecallContribution } from './member-private-memory-recall-render.js'

/** What the frozen request ACTUALLY carries as its private contribution. */
interface RequestedRecall {
  readonly taskId: string
  readonly attemptId: string
  readonly notes: readonly { memoryId: string; headSeq: number }[]
}

/** Tri-state read of the frozen request's private contribution. */
type Requested =
  | { readonly kind: 'none' }
  | { readonly kind: 'refuse' }
  | { readonly kind: 'requested'; readonly value: RequestedRecall }

const RECALL_OPEN = /<private-memory-recall task="([^"]+)" attempt="([^"]+)">/
const RECALL_NOTE = /data-memory-id="([^"]+)" data-head-seq="(\d+)"/g
const RECALL_CONTEXT_NAME = 'agent-swarm:private-memory-recall'
const RECALL_VARIABLE = 'agent_swarm_private_memory_recall'

/**
 * Read the contribution bound to THIS request. The plugin contributes ONE
 * named assembly context (`agent-swarm:private-memory-recall`) whose text is
 * a single variable indirection; the official loop renders contexts
 * (`renderContextSections` interpolates each context once — substituted
 * values are NEVER rescanned, dsh-system-prompt lib/index.js:144-175) and
 * projects the CURRENT runtime-context user message carrying
 * `source.form:"snapshot"` + the rendered `source.sections` (dsh-agent-loop
 * lib/index.js:336-354/:890-900). Admission binds to the LATEST such message
 * in the frozen request — never a backwards search for an older snapshot; a
 * fully cleared run projects the official CLEARED message with NO
 * form/sections, which carries no private contribution. A named section
 * whose tuple cannot be parsed exactly (OPEN or a valid note entry) is
 * MALFORMED and refuses the delegation: attribution follows the official
 * contribution NAME, so persona/section/user quotes of the tag never
 * participate.
 */
const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

function requestedRecall(options: GenerateOptions): Requested {
  const latest = (options.messages ?? []).findLast(message => message.role === 'user'
    && message.source?.kind === 'plugin' && message.source.plugin === SYSTEM_PROMPT_PLUGIN)
  if (latest === undefined) return { kind: 'none' }
  const source = latest.source
  if (source === undefined || source.kind !== 'plugin') return { kind: 'none' }
  // Absence of the EXACT name is always `none` — CLEARED, other producers,
  // and undeclared forms carry no private contribution, and requests with no
  // private contribution are never additionally vetoed.
  const named = 'sections' in source
    ? (source as { readonly sections: ReadonlyArray<{ name: string; text: string }> })
      .sections.filter(section => section.name === RECALL_CONTEXT_NAME)
    : []
  if (named.length === 0) return { kind: 'none' }
  // Only an actually-present exact-named contribution is judged: it must be
  // unique (never concatenated into one mixed tuple) and declared on the
  // official snapshot form — the only carrier of named sections.
  if (named.length > 1) return { kind: 'refuse' }
  if (!('form' in source) || source.form !== 'snapshot') return { kind: 'refuse' }
  const text = named[0]!.text
  const open = RECALL_OPEN.exec(text)
  if (open === null) return { kind: 'refuse' }
  const notes = [...text.matchAll(RECALL_NOTE)].map(match => ({ memoryId: match[1]!, headSeq: Number(match[2]) }))
  if (notes.length === 0) return { kind: 'refuse' }
  return { kind: 'requested', value: { taskId: open[1]!, attemptId: open[2]!, notes } }
}

export interface MemberPrivateMemoryRecallDeps {
  ctx: Context
  /** The Host grant (`privateMemoryRecall === 'active-task'`); Host-owned only. */
  activeTaskRecall: boolean
  domain: () => TeamDomainPort
  scopeOf: (agent: Agent) => TeamScope
  /** The CURRENT private-memory service (apply owns open/close). */
  service: () => MemberPrivateMemoryService | undefined
  /** Raw operator tool policy; the list-tool's explicit deny/ask narrows recall. */
  toolPolicy?: ToolPolicyDeclaration
}

/** The member's UNIQUE in-progress task with a matching RUNNING current attempt. */
type EligibleTask = Omit<TeamTask, 'currentAttemptId'> & { readonly currentAttemptId: string }

/** The one legitimate eligibility tuple resolved per assembly and at the boundary. */
interface Eligible {
  readonly agent: Agent
  readonly scope: TeamScope
  readonly teamId: TeamId
  readonly task: EligibleTask
}

/** The list-tool's CURRENT applicable explicit decision narrowing the auto path. */
function listToolNarrowing(toolPolicy: ToolPolicyDeclaration | undefined): 'allow' | 'ask' | 'deny' {
  // The most permissive member context is used on purpose: this reports only
  // what an EXPLICIT tier can narrow. An unlisted tool keeps the plugin
  // default (allow); ask/deny come solely from the operator's explicit tier.
  return decideToolPermission(effectiveToolPolicy(toolPolicy), 'agent_swarm_list_private_memory', {
    callerRole: 'delegated-member', sameTurnConcreteToolCall: true, openTurn: true, approvalSeamAvailable: false,
  })
}

function eligibleTask(team: Parameters<typeof uniqueRunningAttemptTask>[0], memberSessionId: string): EligibleTask | undefined {
  const task = uniqueRunningAttemptTask(team, memberSessionId)
  if (task === undefined || task.currentAttemptId === undefined) return undefined
  return { ...task, currentAttemptId: String(task.currentAttemptId) }
}

/** Resolve exact live identity + official Session + active membership + unique eligible Task, or undefined. */
async function resolveEligible(deps: MemberPrivateMemoryRecallDeps, agent: Agent): Promise<Eligible | undefined> {
  if (deps.ctx.agents.get(agent.id) !== agent) return undefined
  // The official Session store must still hold THIS Agent's exact Session
  // object: a same-ID unregistered/stand-in Agent+Session is not the live
  // member this eligibility oracle may serve. (Public-assembly negative in
  // the tests/identity-context.spec.ts:38-45 precedent; normal
  // dispose/resume recovery is covered by the attempt-authority binding at
  // the boundary, not by this check.)
  if (deps.ctx.sessions.get(agent.id) !== agent.session) return undefined
  if (deps.service() === undefined) return undefined
  if (listToolNarrowing(deps.toolPolicy) !== 'allow') return undefined
  try {
    const scope = deps.scopeOf(agent)
    const membership = await deps.domain().requireMembership(scope, agent.id)
    if (membership.role !== 'member') return undefined
    const task = eligibleTask(membership.team, agent.id)
    if (task === undefined) return undefined
    // Awaiting the membership read is a boundary: before the eligibility is
    // handed out, the exact Agent, its official Session and the scope must
    // STILL be current (the public-API re-check pattern of
    // identity-context.ts:54-57 — no epoch caches, no new mechanisms).
    if (deps.ctx.agents.get(agent.id) !== agent || deps.ctx.sessions.get(agent.id) !== agent.session || deps.scopeOf(agent) !== scope) return undefined
    return { agent, scope, teamId: membership.team.id, task }
  } catch {
    return undefined // no Team / inactive roster / forged handle → no eligibility
  }
}

function notesStillCurrent(service: MemberPrivateMemoryService, eligible: Eligible, requested: RequestedRecall): boolean {
  const versions = service.recallNoteVersions(eligible.scope, eligible.teamId, eligible.agent.id)
  return requested.notes.every(note => {
    const current = versions.get(note.memoryId)
    return current !== undefined && current.status === 'active' && current.headSeq === note.headSeq
  })
}

/**
 * FINAL boundary verification of one delegation. Admission binds to the
 * contribution THIS REQUEST ACTUALLY CARRIES — never to a cache entry that
 * a refusal deleted or a newer assembly replaced. Verification completes
 * after request configuration and adapter preparation and before any chunk
 * is pulled; a stale or unverifiable contribution REFUSES this delegation by
 * THROWING at the public `llm/stream` middleware boundary (the official
 * contract keeps middleware failures thrown — never a fabricated successful
 * stop; the AgentLoop contains it as a turn error, lib/index.js:976-991) and
 * never invokes `next()`, so no retry of the same frozen request can ever
 * reach the adapter. The frozen request is never rewritten, no Team lock is
 * held across a model stream, and there is no autonomous retry or wake.
 */
async function * guardStream(
  deps: MemberPrivateMemoryRecallDeps,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const requested = requestedRecall(options)
  if (requested.kind === 'refuse') {
    // The LATEST official runtime-context message declares this plugin's
    // exact private contribution NAME with a tuple that cannot be parsed
    // exactly — refuse this delegation observably BEFORE any next(), so a
    // malformed contribution never reaches any adapter.
    throw new Error('agent-swarm: private-memory recall contribution malformed (the exact-name runtime-context contribution carries an invalid task/attempt/note tuple)')
  }
  if (requested.kind === 'none') {
    yield * next()
    return
  }
  const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
  const agent = sessionId === undefined ? undefined : deps.ctx.agents.get(SessionId(sessionId))
  const eligible = agent === undefined ? undefined : await resolveEligible(deps, agent)
  const service = deps.service()
  const current = eligible !== undefined && service !== undefined && deps.activeTaskRecall
    && eligible.task.id === requested.value.taskId
    && eligible.task.currentAttemptId === requested.value.attemptId
    && notesStillCurrent(service, eligible, requested.value)
  if (!current) {
    throw new Error('agent-swarm: private-memory recall delegation refused (the frozen request carries a stale or unverified private contribution)')
  }
  yield * next()
}

/**
 * Install the active-task recall surface. Returns a disposer removing every
 * listener (unload/disable clear the CURRENT named private contribution by
 * recomputation). Honest durability: the private contribution now reaches
 * the model through the runtime-context `user/message` (an earlier build
 * used the `system/message` projection); BOTH projection forms are official
 * durable Session events. Clearing the current contribution never deletes
 * persisted history, and neither history nor already-delegated requests can
 * be rolled back. No implementation injects the contribution at both places.
 */
export function installMemberPrivateMemoryRecall(deps: MemberPrivateMemoryRecallDeps): () => void {
  const select = async (agent: Agent): Promise<string | undefined> => {
    if (!deps.activeTaskRecall) return undefined
    const eligible = await resolveEligible(deps, agent)
    if (eligible === undefined) return undefined
    const service = deps.service()
    if (service === undefined) return undefined
    const candidates: readonly RecallNoteCandidate[] = service.recallCandidates(
      eligible.scope, eligible.teamId, eligible.agent.id, RECALL_MAX_CANDIDATES,
    )
    const ranked = selectRecallNotes(candidates, {
      subject: eligible.task.subject,
      description: eligible.task.description,
      acceptanceCriteria: eligible.task.acceptanceCriteria,
    })
    return renderRecallContribution({ taskId: eligible.task.id, attemptId: eligible.task.currentAttemptId }, ranked)
  }

  // Selection contributes to the VERY request being assembled: the official
  // AgentLoop awaits `system-prompt/assemble` before freezing the request and
  // dispatching `agent/pre-step` (dsh-agent-loop lib/index.js:890-903), so
  // this waterfall is the only per-assembly point that can inject this turn's
  // selection. The contribution recomputes on every assembly, which is how
  // note changes / task changes / disable / compaction / cold recovery clear
  // or rebuild it — no stale snapshot is ever reused, and the boundary
  // guard verifies the contribution THIS request carries rather than any
  // server-side cache.
  const offAssemble = deps.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const resolved = await next()
    const agent = context.agent
    if (agent === undefined || !deps.activeTaskRecall) return resolved
    let text: string | undefined
    try {
      text = await select(agent)
    } catch {
      text = undefined // any lookup failure → NO contribution
    }
    if (text === undefined) return resolved
    // Contribute ONE named runtime-context through a single variable
    // indirection: the official renderer substitutes the whole rendered
    // contribution exactly once and NEVER rescans the substituted value
    // (dsh-system-prompt lib/index.js:151-175), so `{{...}}` shapes inside
    // private note bodies stay literal data and unknown-variable failures
    // cannot occur for the contribution. Final rendered size stays ≤4096
    // UTF-8 bytes by the render budget.
    return {
      ...resolved,
      contexts: [...resolved.contexts, { name: RECALL_CONTEXT_NAME, text: `{{${RECALL_VARIABLE}}}` }],
      variables: { ...resolved.variables, [RECALL_VARIABLE]: text },
    }
  })

  // Every official model call is re-verified at the public delegation boundary
  // against the contribution its frozen body actually carries.
  const offStream = deps.ctx.on('llm/stream', (options, next) => guardStream(deps, options, next))

  return () => {
    offAssemble()
    offStream()
  }
}

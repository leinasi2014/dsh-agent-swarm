/**
 * M3 evidence segment (task-10) — result observation: an experience note may
 * cite ONE real tool call from the member's OWN official Session, and the
 * Host witnesses the ACTUAL call/result pair (not just that a task existed).
 * tests-only RED over the CURRENT product (plus the captain-authorized
 * applicability-truncation render fix); the declaration segment (77/77)
 * stays untouched.
 *
 * CONTRACT (per captain rules ③④⑤, narrowed to the one real-result path
 * that exists today):
 * - A maintenance add/revise may carry `observation: { call_id }`. The Host
 *   witnesses ONLY inside the member's CURRENT registered Agent's own
 *   Session window — never the fork-inherited prefix (`inheritedEventCount`
 *   boundary is public on rc.2 Sessions; parent/Captain calls must not be
 *   laundered into "own results" by a full-history scan), and an ambiguous
 *   callId with multiple possible pairings rejects rather than guessing.
 *   A verified pair yields the Host's OWN durable block
 *   `{ kind: 'observed_result', tool, call_id, call_seq, result_seq,
 *   is_error, result_digest, team_revision, observed_at }` — the exact
 *   public-log coordinates plus a bounded digest of the result identity
 *   (never large raw outputs). Durable rows with an observation land as
 *   schemaVersion 4 (2/3 byte shapes and tamper rejections unchanged); the
 *   observation participates in the normal retry payload comparison and CAS
 *   like every other cited field.
 * - What is witnessed is exactly "the tool really returned this result" —
 *   a bounded OBSERVATION fact (rule ⑤). Recall renders it as
 *   `data-observed-result="tool-returned|tool-error"` (tool-layer meaning,
 *   never implying technical validation) inside the absolute 4096 bound.
 *   The note's model text and claim stay DECLARED; an unrelated failure
 *   never invalidates other experience, and a successful tool return never
 *   raises generic confidence — there is no Host-side generic body validator
 *   and none is invented here.
 * - Rule ④ is executed through EXISTING legal operations only: after
 *   witnessing a real counterexample under a concrete verifiable condition
 *   (a denied `agent_swarm_status` call under this mount's explicit
 *   toolPolicyDeny), the member may invalidate the contradicted suggestion
 *   and record the counterexample (full payload + bounded real reference).
 *   Task existence, accepted tasks and text quotes are never result
 *   evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentSwarm from '../src/index.js'
import { RECALL_TOTAL_BYTES, utf8Length } from '../src/runtime/member-private-memory-recall-selection.js'
import { witnessObservation } from '../src/runtime/member-private-memory-witness.js'
import { PassiveAdapter, boundSetup, dispose, invalidateNote, latestNamedContribution, memberRequests, mount, runMemberTurn, tool, type Mounted } from './helpers/private-memory-composition.js'

const RECALL_NAME = 'agent-swarm:private-memory-recall'
const DRIVE_TEXT = 'resultprobe drive turn'
const REPLAY_TEXT = 'resultprobe replay turn'
const PARENT_TEXT = 'resultprobe parent witness turn'
const OK_CALL_ID = 'ro-probe-add'
const DENIED_CALL_ID = 'ro-probe-denied'
const PARENT_CALL_ID = 'parent-witness-call'
const OK_CONTENT = 'recallprobe lesson: own maintenance add succeeds under this team config'

/** Real member turns emit REAL tool calls that land as tool/call +
 *  tool/result on the member's official Session: one successful
 *  private-memory add (a REAL successful experience under this mount's
 *  configuration), one DENIED status call (toolPolicyDeny — a real failing
 *  tool result, not a narrated one), and on the replay turn the SAME add
 *  callId again (the ambiguity premise). The Captain branch emits one real
 *  list_memory call used by the official-fork witness boundary unit. */
class ResultProbeAdapter extends PassiveAdapter {
  memberId: string | undefined
  leadId: string | undefined
  private probeRounds = 0
  private leadRounds = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = (options.messages ?? []).flatMap(m => [...m.content]).map(b => b.type === 'text' ? b.text : '').join('\n')
    if (options.sessionId !== undefined && options.sessionId === this.leadId
      && text.includes(PARENT_TEXT) && this.leadRounds === 0) {
      this.leadRounds += 1
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(PARENT_CALL_ID), name: 'agent_swarm_list_memory', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(PARENT_CALL_ID), name: 'agent_swarm_list_memory', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const isMine = options.sessionId !== undefined && options.sessionId === this.memberId
    // MEASUREMENT FIX (defect 1): the original gate matched DRIVE_TEXT/
    // REPLAY_TEXT against the FULL request history, so EVERY later model
    // step of the SAME turn (step 2 after the tool results land still sees
    // DRIVE_TEXT) re-fired the probe and re-sent the SAME callId — the
    // "ambiguity premise" was manufactured by the measurement, not by the
    // replay. Count the member's own user-issued turns carrying a probe
    // marker instead: each marker turn fires EXACTLY ONE probe (the replay
    // is the second marker turn — the intended ambiguity), and in-turn
    // re-entry is naturally deduplicated.
    const markerTurns = (options.messages ?? [])
      .filter(message => message.role === 'user' && message.source?.kind === 'user')
      .map(message => [...message.content].filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n'))
      .filter(turnText => turnText.includes(DRIVE_TEXT) || turnText.includes(REPLAY_TEXT))
      .length
    if (!isMine || this.probeRounds >= markerTurns) {
      for await (const chunk of super.stream(options)) yield chunk
      return
    }
    this.probeRounds += 1
    // Replay the EXACT same operation (same callId, same canonical payload):
    // an idempotent retry that still lands a second real call/result pair
    // under the SAME callId — the ambiguity premise.
    const okArgs = JSON.stringify({ operation: 'add', operation_id: 'ro-probe-op', content: OK_CONTENT, evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection', claim: { environment: 'win-x64', version: 'node-24', outcome: 'reported_pass' } })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId(OK_CALL_ID), name: 'agent_swarm_maintain_private_memory', argumentsDelta: okArgs }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(OK_CALL_ID), name: 'agent_swarm_maintain_private_memory', arguments: okArgs } }
    if (this.probeRounds === 1) {
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: ToolCallId(DENIED_CALL_ID), name: 'agent_swarm_status', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId(DENIED_CALL_ID), name: 'agent_swarm_status', arguments: '{}' } }
    }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 9 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

interface ListRow {
  readonly memory_id: string
  readonly content: string
  readonly status?: string
  readonly observation?: {
    kind?: string; tool?: string; call_id?: string; is_error?: boolean
    call_seq?: number; result_seq?: number; result_digest?: string
    team_revision?: number; observed_at?: number
  }
}

interface Fixture {
  readonly mounted: Mounted
  readonly adapter: ResultProbeAdapter
  readonly agent: Agent
  readonly memberId: string
  readonly lead: Agent
  readonly teamId: string
}

/**
 * MEASUREMENT FIX (defect 3, composition): a raw domain claim seats the
 * attempt in `assignmentPhase: 'reserved'` (team-domain-board.ts:153) — a
 * delivery DEBT the product's designed convergence settles or rolls back:
 * the first member idle edge drives the reserved fold
 * (scheduling.ts settleReservedAssignment L324-343 → frameVisibility
 * 'absent' → dispatchAssignment → rollbackUndeliveredAssignment
 * cancelAttempt L382-400), and within ~200ms of the drive turn the task is
 * legitimately requeued to pending (measured: rev 2→5 within 200ms; NOT the
 * 60s stranded heal, which this grace rules out). A pending task is NOT an
 * eligible active task, so every LATER member turn honestly carries NO
 * recall contribution — E2/E3 asserted on the third turn and raced this
 * convergence. The product behavior is the contract (delivery debt must be
 * resolved); the fixture omitted the production delivery step. Settling the
 * claim through the PUBLIC domain port acknowledgeAssignment
 * (team-domain-port.ts:285; idempotent, requires current+running only) puts
 * the aggregate in the SAME state production reaches after the member
 * claims the assignment frame — no product change, no synthetic frame text,
 * no scheduler race left in the measurement.
 */
async function settleClaimDelivery(f: Fixture): Promise<void> {
  const domain = f.mounted.ctx.agentSwarm.domain
  const scope = f.mounted.ctx.agentSwarm.scopeOf(f.lead)
  const teamId = AgentSwarm.TeamId(f.teamId)
  const snap = await domain.snapshot(scope, teamId, f.lead.id)
  const task = snap.team.tasks.find(candidate => candidate.status === 'in_progress' && candidate.ownerSessionId === f.memberId)
  expect(task?.currentAttemptId, 'premise: the member really holds the claimed task').toBeDefined()
  await domain.acknowledgeAssignment(scope, teamId, task!.id, task!.currentAttemptId!)
}

async function rows(f: Fixture, callId: string): Promise<ListRow[]> {
  const listed = await tool(f.mounted.ctx, f.agent, callId, 'agent_swarm_list_private_memory', {})
  expect(listed.isError, 'own list stays allowed').toBe(false)
  return (listed.value as unknown as { memories: ListRow[] }).memories
}

/** Events of the member's OWN window only, read through the public typed
 *  boundary: snapshotEvents(inheritedEventCount) — the durable fork cut. */
function ownEvents(agent: Agent) {
  return agent.session.snapshotEvents(agent.session.inheritedEventCount)
}

interface PairFact {
  readonly callSeq: number
  readonly resultSeq: number
  readonly callName?: string | undefined
  readonly isError?: boolean | undefined
  readonly errorName?: string | undefined
  readonly errorCode?: string | undefined
  /** Full result content as JSON — the durable carrier of the OFFICIAL
   *  denial identity (measured premise fix, see driveProbeTurn). */
  readonly contentJson?: string | undefined
  readonly digest?: string | undefined
}

/** ALL real call/result pairs under one callId in the member's own window,
 *  paired in seq order, each with its OWN facts.
 *
 *  MEASUREMENT FIX (defect 2): the previous countPaired collapsed every
 *  non-unique pairing to counts-only (callName/isError undefined), so a
 *  legitimate replay (two pairs, one callId) could never be asserted on —
 *  the pre-replay premise demanded a UNIQUE pair while the helper returned
 *  only counts. Per-pair facts make "exactly one NEW pair landed THIS turn"
 *  assertable regardless of how many pairs already exist. */
function pairsOf(agent: Agent, callId: string): PairFact[] {
  const events = ownEvents(agent)
  const calls = events.filter(event => event.type === 'tool/call'
    && (event.data as { callId?: string }).callId === callId)
  const results = events.filter(event => event.type === 'tool/result'
    && (event.data as { message?: { source?: { callId?: string } } }).message?.source?.callId === callId)
  const pairs: PairFact[] = []
  for (let i = 0; i < Math.min(calls.length, results.length); i++) {
    const call = calls[i]!
    const result = results[i]!
    const data = result.data as { message: { content: unknown[] }; error?: { name?: string; code?: string } }
    const content = data.message.content
    const first = content[0] as { isError?: boolean }
    pairs.push({
      callSeq: call.seq,
      resultSeq: result.seq,
      callName: (call.data as { name?: string }).name,
      isError: first?.isError === true,
      errorName: data.error?.name,
      errorCode: data.error?.code,
      contentJson: JSON.stringify(content),
      digest: createHash('sha256').update(JSON.stringify([content, data.error ?? null]), 'utf8').digest('hex'),
    })
  }
  return pairs
}

/** Drive one real probe turn and verify the ACTUAL witness facts (rule ①):
 *  real tool names, real isError, the official error identity for the denial
 *  (rule ③: the policy rejection is identifiable, not any isError), in the
 *  member's own typed window. The premise is now "exactly one NEW add pair
 *  landed this turn" — assertable on the drive turn AND on the replay. */
async function driveProbeTurn(f: Fixture, driveText = DRIVE_TEXT, expectDenied = true): Promise<void> {
  const pairsBefore = pairsOf(f.agent, OK_CALL_ID).length
  await runMemberTurn(f.agent, driveText)
  const okPairs = pairsOf(f.agent, OK_CALL_ID)
  expect(okPairs.length - pairsBefore, 'premise: exactly one NEW real add pair landed on the own window this turn').toBe(1)
  const ok = okPairs.at(-1)!
  expect(ok.callName, 'premise: the real add call/result pair is on the own window').toBe('agent_swarm_maintain_private_memory')
  expect(ok.isError, 'premise: the add call really returned a successful tool result').toBe(false)
  if (!expectDenied) return
  const deniedPairs = pairsOf(f.agent, DENIED_CALL_ID)
  expect(deniedPairs.length, 'premise: the denied-status pair landed exactly once').toBe(1)
  const denied = deniedPairs[0]!
  expect(denied.callName, 'premise: the denied-status call really happened').toBe('agent_swarm_status')
  expect(denied.isError, 'premise: the denial really returned a failing tool result').toBe(true)
  // MEASUREMENT PREMISE FIX (3rd, evidence-based against the installed rc.2):
  // a GATE denial (the Team tool policy returns {kind:'deny',reason} from
  // tools/pre-execute) is materialized by dsh-tools as
  // `error: { message }` WITHOUT info (lib/index.js:3131-3138), and
  // dsh-agent-loop only appends the event-level error{name,code} when
  // `result.error.info` exists (lib/index.js:707 — contrast the abort path
  // at 675-683 that carries info). So on rc.2 a policy denial persists its
  // official identity as the failing content text `Error: <reason>` with
  // isError, NOT as event error{name,code}. Assert the identity the official
  // log actually carries: the committed-base denial reason
  // (src/runtime/permission-policy.ts:214) inside the durable content.
  expect(denied.contentJson, 'premise: the denial carries the official policy-rejection identity').toContain('is denied by the Team tool policy')
}

describe('M3 evidence: result observation witnesses one real own-window call/result pair', () => {
  // U1 uses the SAME plugin ctx type as the composition helper provides;
  // keep the store-diagnostics entry type identical to avoid a second
  // structural ctx spelling.
  const mountedList: Mounted[] = []
  const dirs: string[] = []
  afterEach(async () => {
    for (const mounted of mountedList.splice(0)) await dispose(mounted)
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  async function setup(tag: string): Promise<Fixture> {
    const sandbox = await mkdtemp(join(tmpdir(), `dsh-result-obs-${tag}-`))
    dirs.push(sandbox)
    const mounted = await mount(sandbox, { privateMemoryRecall: 'active-task', toolPolicyDeny: ['agent_swarm_status'] })
    mountedList.push(mounted)
    const adapter = new ResultProbeAdapter()
    mounted.ctx.llm.registerAdapter(['mock'], adapter)
    const { setup: bound, resolved } = await boundSetup(mounted, tag, join(sandbox, 'workspace'))
    adapter.memberId = bound.memberId
    adapter.leadId = bound.lead.id
    return { mounted, adapter, agent: resolved.agent, memberId: bound.memberId, lead: bound.lead, teamId: bound.teamId }
  }

  it('U1 the official fork boundary: a real parent call in the inherited prefix is never an own result', async () => {
    const f = await setup('rou1')
    await runMemberTurn(f.lead, PARENT_TEXT)
    // Typed empty fallback: the premise assertion below demands callName; an
    // untyped {} collapsed the union to a property-less type (channel TS2339,
    // reproducible at aef18ade). Assertion, order and messages unchanged.
    const parentPair = pairsOf(f.lead, PARENT_CALL_ID).at(-1) ?? ({} as Partial<PairFact>)
    expect(parentPair.callName, 'premise: the parent AgentLoop really produced the call/result pair').toBe('agent_swarm_list_memory')
    // Public official fork of the parent's real canonical log.
    const child = f.mounted.ctx.sessions.fork(f.lead.session)
    expect(child.inheritedEventCount, 'premise: the fork really inherited the parent prefix').toBeGreaterThan(0)
    const inheritedWindow = child.snapshotEvents().slice(0, child.inheritedEventCount)
    expect(inheritedWindow.some(event => event.type === 'tool/call'
      && (event.data as { callId?: string }).callId === PARENT_CALL_ID),
    'premise: the real parent pair sits in the durable inherited prefix').toBe(true)
    // The M-owned witness must exclude the inherited prefix (public fork
    // boundary unit — NOT a claim that this M spawn inherits; spawn itself
    // carries zero parent context).
    const rejected = await Promise.resolve().then(() => {
      try {
        witnessObservation(child, PARENT_CALL_ID, reason => { throw new Error(reason) })
        return undefined
      }
      catch (error) {
        return (error as Error).message
      }
    })
    expect(rejected, 'an inherited-prefix call is not an own-window result').toContain('own session window')
    const unknown = await Promise.resolve().then(() => {
      try {
        witnessObservation(child, 'call-never-made-by-anyone', reason => { throw new Error(reason) })
        return undefined
      }
      catch (error) {
        return (error as Error).message
      }
    })
    expect(unknown).toContain('own session window')
  }, 120_000)

  it('E1 citing an own real successful call persists a Host witness block with the result identity', async () => {
    const f = await setup('roe1')
    await driveProbeTurn(f)
    const before = pairsOf(f.agent, OK_CALL_ID).at(-1) ?? ({} as Partial<PairFact>)
    const add = await tool(f.mounted.ctx, f.agent, 'e1-add', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'e1-op', content: 'recallprobe lesson cites own call',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      observation: { call_id: OK_CALL_ID },
    })
    expect(add.isError, 'a citation of a real paired own call must be accepted').toBe(false)
    const mine = (await rows(f, 'e1-list')).find(row => row.content === 'recallprobe lesson cites own call')
    // The durable block is the HOST's witness (exact log coordinates +
    // bounded digest + snapshot revision), never the citation echoed back.
    expect(mine?.observation?.kind, 'the Host recorded the witnessed result').toBe('observed_result')
    expect(mine?.observation?.tool, 'the actual tool identity is recorded').toBe('agent_swarm_maintain_private_memory')
    expect(mine?.observation?.call_id).toBe(OK_CALL_ID)
    expect(mine?.observation?.is_error).toBe(false)
    expect(typeof mine?.observation?.call_seq).toBe('number')
    expect(mine?.observation?.result_seq).toBe(before.resultSeq)
    // The digest RE-MATCHES the actual official result payload (rule ③: the
    // note can be re-checked against WHICH result was witnessed).
    expect(mine?.observation?.result_digest, 'bounded digest of the result identity').toMatch(/^[0-9a-f]{16,64}$/)
    expect(mine?.observation?.result_digest).toBe(before.digest)
    expect(typeof mine?.observation?.team_revision).toBe('number')
    expect(typeof mine?.observation?.observed_at).toBe('number')
  }, 120_000)

  it('E2 the real denial is witnessed as-is; unknown and ambiguous callIds reject and write nothing', async () => {
    const f = await setup('roe2')
    await settleClaimDelivery(f)
    await driveProbeTurn(f)
    const before = (await rows(f, 'e2-list-a')).length
    const spun = await tool(f.mounted.ctx, f.agent, 'e2-add', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'e2-op', content: 'recallprobe lesson spins a failure',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      claim: { environment: 'win-x64', version: 'node-24', outcome: 'reported_pass' },
      observation: { call_id: DENIED_CALL_ID },
    })
    expect(spun.isError, 'citing an own real (failing) call is still accepted').toBe(false)
    const mine = (await rows(f, 'e2-list-b')).find(row => row.content === 'recallprobe lesson spins a failure')
    // The witness records the RESULT's real identity, not the model's spin:
    // recording false here would launder a denial into "pass".
    expect(mine?.observation?.kind).toBe('observed_result')
    expect(mine?.observation?.tool).toBe('agent_swarm_status')
    expect(mine?.observation?.is_error, 'the real denial is witnessed, never the claim').toBe(true)
    // The bounded digest also covers the official denial error identity
    // (rule ③: the witnessed failure is identifiable as the real denial).
    expect(mine?.observation?.result_digest).toBe((pairsOf(f.agent, DENIED_CALL_ID).at(-1) ?? {}).digest)
    // Negative: a callId the official Session log cannot pair at all.
    const unknown = await tool(f.mounted.ctx, f.agent, 'e2-unknown', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'e2-u-op', content: 'recallprobe lesson forged call',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      observation: { call_id: 'call-never-made-by-anyone' },
    })
    expect(unknown.isError, 'a callId with no own-window pair must reject').toBe(true)
    // Replay produces a SECOND real pair under the SAME callId — verified as
    // actually present (not just narrated), then the citation must reject.
    await driveProbeTurn(f, REPLAY_TEXT, false)
    const replayed = pairsOf(f.agent, OK_CALL_ID)
    expect(replayed.length, 'premise: two real paired call/results under one callId landed in the own window').toBe(2)
    const ambiguous = await tool(f.mounted.ctx, f.agent, 'e2-amb', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'e2-a-op', content: 'recallprobe lesson ambiguous pair',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      observation: { call_id: OK_CALL_ID },
    })
    expect(ambiguous.isError, 'multiple real pairings under one callId must reject, not guess').toBe(true)
    expect((await rows(f, 'e2-list-d')).length, 'the rejections wrote nothing durable').toBe(before + 1)
    // Recall labels the witnessed result with tool-layer meaning; the
    // quality tier stays DECLARED — the dimensions never merge.
    await runMemberTurn(f.agent, 'recallprobe selection exercise turn')
    const named = latestNamedContribution(memberRequests(f.adapter, f.memberId).at(-1)!.options, RECALL_NAME)
    const line = named.split('<note ').find(entry => entry.includes(`data-memory-id="${mine?.memory_id ?? ''}"`))
    expect(line, 'premise: the spun note is recalled').toBeDefined()
    expect(line).toContain('data-observed-result="tool-error"')
    expect(line).toContain('data-quality="declared:reported-pass"')
    // EXACT tier check: no quality tier may equal or START with a
    // confirmed/verified token. A substring regex would wrongly match the
    // legitimate plain "unverified" values, so test the tier token itself.
    const tiers = [...named.matchAll(/data-quality="([^"]*)"/g)].map(match => match[1]!)
    expect(tiers.filter(tier => /^(confirmed|verified)([_:-]|$)/i.test(tier))).toEqual([])
  }, 120_000)

  it('E3 a witnessed counterexample under the concrete deny condition lets the member invalidate the contradicted rule while other knowledge persists', async () => {
    const f = await setup('roe3')
    await settleClaimDelivery(f)
    // The concrete, verifiable condition is this mount's real configuration:
    // agent_swarm_status is policy-denied here — no invented environment.
    const rule = await tool(f.mounted.ctx, f.agent, 'e3-rule', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'e3-rule-op', content: 'recallprobe rule: agent_swarm_status stays callable under this team config',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      claim: { environment: 'win-x64', version: 'node-24', outcome: 'hypothesis' },
    })
    expect(rule.isError).toBe(false)
    const ruleNote = rule.value as unknown as { result_memory_id: string; head_seq: number }
    await driveProbeTurn(f) // the REAL denial: a tool-error under this condition
    const counter = await tool(f.mounted.ctx, f.agent, 'e3-contra', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'e3-contra-op',
      content: 'recallprobe counterexample: the real agent_swarm_status call returned a tool-error under this team config, contradicting the callable rule',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      claim: { environment: 'win-x64', version: 'node-24', outcome: 'declared_observed' },
      observation: { call_id: DENIED_CALL_ID },
    })
    expect(counter.isError).toBe(false)
    // Rule ④ through EXISTING legal operations only: the member invalidates
    // the contradicted suggestion — no Host-side body validator invented.
    await invalidateNote(f.mounted, f.agent, { memoryId: ruleNote.result_memory_id, headSeq: ruleNote.head_seq })
    const after = await rows(f, 'e3-list')
    expect(after.find(row => row.memory_id === ruleNote.result_memory_id)?.status, 'the contradicted rule is durably invalidated').toBe('invalidated')
    await runMemberTurn(f.agent, 'recallprobe selection exercise turn')
    const named = latestNamedContribution(memberRequests(f.adapter, f.memberId).at(-1)!.options, RECALL_NAME)
    expect(named, 'the invalidated rule leaves the current named recall').not.toContain('agent_swarm_status stays callable')
    const counterLine = named.split('<note ').find(entry => entry.includes('recallprobe counterexample'))
    expect(counterLine, 'the counterexample fact stays recallable with its witness').toBeDefined()
    expect(counterLine).toContain('data-observed-result="tool-error"')
    // Unrelated knowledge under OTHER conditions persists (no blanket
    // invalidation from an unrelated failure) — here, THIS round's real
    // successful experience: the member's own maintenance add under the
    // probe turn actually succeeded and stays recallable.
    expect(named).toContain('own maintenance add succeeds')
    expect(utf8Length(named)).toBeLessThanOrEqual(RECALL_TOTAL_BYTES)
  }, 120_000)
})

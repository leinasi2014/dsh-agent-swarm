/**
 * Real-queue membership race evidence (QA plan public-6e14e2a0; scenarios and
 * semantics fixed by Root; queue observation corrected per the 15:07 precheck).
 *
 * Fixed definitions:
 *  - R = the canonical aggregate snapshot the SECOND membership scan obtains
 *    for the target Team INSIDE that Team's own store lock (identity and
 *    public content together) — `store.list` serializes each Team through
 *    `withLock(teamLocks, id)` + `readAndUpgrade` and clones the result.
 *  - W = a real captain `removeMember` that SUCCEEDS and is proven through a
 *    canonical store read-back showing the member removed (a putRecord
 *    return alone is not durability proof).
 *
 * Pinned semantics:
 *  - A (W before R): both `agent_swarm_public_history` and the exact-ID
 *    reader must reject with TEAM_NOT_JOINED — never an empty success, never
 *    the played public text.
 *  - B (R before W): the already-linearized read may settle with the page
 *    exactly as approved at R; it must NOT mix in text appended after W, and
 *    the NEXT read must reject. A settle later than W alone is not a leak.
 *
 * Everything goes through the REAL official stack (`openFaultableStack`: real
 * Storage Domain + production StorageDomainTeamStore/TeamDomain; in-memory
 * medium). Ordering uses only public mechanisms and explicit events: real
 * `store.transact` holders whose entry is an ordinary deferred resolved in
 * the operation body, `removeMember` whose store-chain enqueue is the call
 * itself (its first statement awaits `store.transact`), one macrotask drain
 * (the in-memory store chain is microtask-only, so a timer boundary
 * deterministically postdates "second scan linearized R and now waits on the
 * held blocker"), and the official `domain.table('teams').get` read
 * SYNCHRONOUSLY (no await added) to show durability before the settle. No
 * private fields, no queue-tail casting, no microtask-count guessing. Every
 * holder/gate release and every unsettled read is drained in `finally`.
 * Seeding uses the local-operator (Captain public) author: the domain
 * rejects un-replied v1 Agent originals (TEAM_PUBLIC_REPLY_INVALID), and the
 * post-W marker is appended by the still-authoritative Captain, never by the
 * removed member. (`as Agent`/Map-ctx stand in only for the identity seam
 * already proven by the real-composition spec; membership is read exactly
 * twice per read with no third or unbounded probe.)
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createPublicChatReadSurface } from '../src/runtime/public-chat-read.js'
import type { ToolExecutionAuthority } from '../src/runtime/authority.js'
import type { TeamDomainPort } from '../src/domain/team-domain-port.js'
import { TeamId, type TeamState } from '../src/domain/types.js'
import { FaultableBackend, openFaultableStack, type StorageStack } from './helpers/storage-stack.js'

const SCOPE = 'scope-public-read-race'
const CAPTAIN = 'captain-race'
const R_TEXT = 'B 场景 R 时正文：交付页只允许含这条。'
const POST_W_TEXT = 'B 场景 W 后追加：绝不得混入旧页。'

type Reader = 'history' | 'exact'

/** Fixed-id managed aggregate (public append requires a managed origin). */
function aggregate(id: string, captain: string): TeamState {
  return {
    schemaVersion: 2, id: TeamId(id), revision: 1, name: `race-${id}`, description: 'race fixture',
    captainSessionId: captain, managedOrigin: 'managed:race-parent:turn:t3',
    phase: 'active', members: [], tasks: [], attempts: [],
    messages: [], interactionEffects: [], budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: { [captain]: -1 }, memory: [], nextTaskNumber: 1, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
  }
}

interface Row { message_id: string; text: string }
interface Page extends Row { entries?: Row[]; total_count?: number }

interface Fixture {
  stack: StorageStack
  memberSession: string
  exec: ToolExecutionAuthority
  usePort(port: TeamDomainPort): void
  run(reader: Reader, messageId: string): Promise<unknown>
}

/** One scenario = one fresh stack and one fresh team/member identity. */
async function fixture(memberSession: string): Promise<Fixture> {
  const stack = await openFaultableStack(new FaultableBackend(), () => 1_700_000_000_000)
  const agent = { id: memberSession, session: { header: {} } } as unknown as Agent
  const ctx = {
    agents: new Map([[agent.id, agent]]),
    sessions: new Map([[agent.id, agent.session]]),
  } as unknown as Context
  const exec: ToolExecutionAuthority = { signal: new AbortController().signal, agent }
  let port = stack.port
  const surface = () => createPublicChatReadSurface({
    ctx,
    domain: () => port,
    scopeOf: () => SCOPE,
    closingSignal: () => new AbortController().signal,
  })
  return {
    stack, memberSession, exec,
    usePort(next) { port = next },
    run: (reader, messageId) => reader === 'history'
      ? surface().history(exec, { limit: 10, maxBytes: 32_768 })
      : surface().message(exec, { messageId, offset: 0, maxChars: 20_000 }),
  }
}

function rowsOf(reader: Reader, value: unknown): Row[] {
  const page = value as Page
  return reader === 'history' ? page.entries! : [{ message_id: page.message_id, text: page.text }]
}

/** Trigger seam: delays ISSUING the second real membership read only. */
function gatedSecondRead(base: TeamDomainPort, gate: () => Promise<void>): TeamDomainPort {
  let reads = 0
  return {
    requireMembership: async (scope: string, sessionId: string) => {
      reads += 1
      if (reads === 2) await gate()
      return await base.requireMembership(scope, sessionId)
    },
  } as unknown as TeamDomainPort
}

async function provisioned(f: Fixture, teamId: TeamId, name: string, sessionId: string): Promise<void> {
  await f.stack.port.provisionMember(SCOPE, teamId, CAPTAIN, { name, role: 'racer', sessionId, provider: 'p' })
  await f.stack.port.settleMember(SCOPE, teamId, sessionId, { active: true })
}

async function seeded(f: Fixture, teamId: TeamId, text: string, requestId: string): Promise<string> {
  const { message } = await f.stack.port.appendPublicMessage(SCOPE, teamId, {
    author: { kind: 'local-operator' }, requestId, text,
  })
  return message.id
}

/** Hold one Team's real transaction lock while changing nothing. Entry is an
 * explicit deferred resolved in the public transact operation body. */
async function holdLock(f: Fixture, teamId: TeamId): Promise<() => void> {
  let entered!: () => void
  const enteredP = new Promise<void>(resolve => { entered = resolve })
  let openGate!: () => void
  const gateP = new Promise<void>(resolve => { openGate = resolve })
  const holding = f.stack.store.transact(SCOPE, teamId, async () => { entered(); await gateP })
  holding.catch(() => undefined)
  await enteredP
  return () => openGate()
}

/** W = real removal + canonical read-back showing the member removed. */
async function removeAndProve(f: Fixture, teamId: TeamId, name: string, reason: string): Promise<void> {
  await f.stack.port.removeMember(SCOPE, teamId, CAPTAIN, name, reason)
  const back = await f.stack.store.read(SCOPE, teamId)
  expect(back?.members.find(member => member.name === name)?.phase).toBe('removed')
}

/** The in-memory store chain is microtask-only: one timer boundary is a
 * deterministic "all pending queue microtasks have run" event. */
function drainMacrotask(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

function signals() {
  let issued!: () => void
  let arranged!: () => void
  const issuedP = new Promise<void>(resolve => { issued = resolve })
  const arrangedP = new Promise<void>(resolve => { arranged = resolve })
  return { issued, issuedP, arranged, arrangedP }
}

describe('public read membership races on the real store queues', () => {
  for (const reader of ['history', 'exact'] satisfies readonly Reader[]) {
    it(`A/${reader}: W before R — removal linearized before the second scan rejects the reader`, async () => {
      const f = await fixture(`member-racer-a-${reader}`)
      let releaseHolder: (() => void) | undefined
      let removing: Promise<void> | undefined
      let reading: Promise<unknown> | undefined
      try {
        const teamId = TeamId(`team-a-target-${reader}`)
        await f.stack.store.createUniqueForCaptain(SCOPE, aggregate(teamId, CAPTAIN))
        await provisioned(f, teamId, `mate-a-${reader}`, f.memberSession)
        const seedId = await seeded(f, teamId, 'A 场景公开原文：撤权后不得出现在任何读取里。', `seed-a-${reader}`)

        const s = signals()
        // The gate runs when the SECOND membership read is about to be issued
        // (the first has fully returned). Real chain order arranged there:
        // holder -> removeMember (its enqueue IS the call) -> second scan.
        f.usePort(gatedSecondRead(f.stack.port, async () => {
          releaseHolder = await holdLock(f, teamId)
          removing = removeAndProve(f, teamId, `mate-a-${reader}`, 'A revocation inside the holder window')
          releaseHolder()
          s.arranged()
        }))
        reading = f.run(reader, seedId)
        await s.arrangedP
        await removing
        await expect(reading).rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
        // A fresh read after the durable revocation rejects the same way.
        await expect(f.run(reader, seedId)).rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
      } finally {
        releaseHolder?.()
        await removing?.catch(() => undefined)
        await reading?.catch(() => undefined)
        await f.stack.close()
      }
    })

    it(`B/${reader}: R before W — settles exactly as linearized at R, never mixing post-W text`, async () => {
      const f = await fixture(`member-racer-b-${reader}`)
      let releaseHolder: (() => void) | undefined
      let reading: Promise<unknown> | undefined
      try {
        // Deterministic scan order: target sorts before blocker; the blocker
        // Team has its own independent Captain.
        const targetId = TeamId(`team-b-target-${reader}`)
        const blockerId = TeamId(`team-b-zblocker-${reader}`)
        expect(targetId.localeCompare(blockerId)).toBeLessThan(0)
        await f.stack.store.createUniqueForCaptain(SCOPE, aggregate(targetId, CAPTAIN))
        await f.stack.store.createUniqueForCaptain(SCOPE, aggregate(blockerId, 'captain-blocker'))
        await provisioned(f, targetId, `mate-b-${reader}`, f.memberSession)
        const seedId = await seeded(f, targetId, R_TEXT, `seed-b-${reader}`)

        const s = signals()
        // The gate runs after the FIRST membership fully returned (it crossed
        // both Team locks): the holder takes the BLOCKER lock exactly then,
        // and the second real scan starts afterwards — it linearizes R on the
        // target inside the target's own lock and then waits on the held
        // blocker. The post-W removal is issued only after a macrotask drain,
        // which deterministically postdates that enqueue (microtask-only
        // chain), so the removal can never cut in before R.
        f.usePort(gatedSecondRead(f.stack.port, async () => {
          releaseHolder = await holdLock(f, blockerId)
          s.issued()
        }))
        reading = f.run(reader, seedId)
        await s.issuedP
        await drainMacrotask()

        // W strictly after R linearized: real removal + canonical read-back.
        await removeAndProve(f, targetId, `mate-b-${reader}`, 'B revocation after R linearized')
        // Official in-memory table read SYNCHRONOUSLY (no await added, value
        // untouched): durability already predates the still-pending settle.
        const tableSawRemoval = f.stack.domain.table('teams').get(targetId)?.team.members
          .some(member => member.name === `mate-b-${reader}` && member.phase === 'removed') ?? false
        // Post-W marker appended by the still-authoritative Captain (the
        // removed member must not be able to write).
        const markerAfterW = await seeded(f, targetId, POST_W_TEXT, `after-w-b-${reader}`)
        releaseHolder?.()

        const settled = await reading
        const dump = JSON.stringify(settled)
        expect(tableSawRemoval, `official table must show the removal before the settle; settled=${dump}`).toBe(true)
        // Settles with EXACTLY the R-approved content: the seed only.
        expect(rowsOf(reader, settled).map(row => row.message_id), dump).toEqual([seedId])
        expect(rowsOf(reader, settled).map(row => row.text), dump).toEqual([R_TEXT])
        if (reader === 'history') expect((settled as Page).total_count, dump).toBe(1)
        expect(dump).not.toContain(POST_W_TEXT)
        expect(markerAfterW).not.toBe(seedId)
        // The NEXT read (fresh scans, no gate) is refused under every semantics.
        await expect(f.run(reader, seedId)).rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
      } finally {
        releaseHolder?.()
        await reading?.catch(() => undefined)
        await f.stack.close()
      }
    })
  }
})

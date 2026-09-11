import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryService from '@deepseek-ai/dsh-session-query-sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { MemberProfileReader } from '../src/runtime/member-profile-reader.js'
import type { TeamState } from '../src/domain/types.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).toReversed()) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'swarm-observation-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  cleanups.push(async () => { await persistence.dispose() })
  const query = await ctx.plugin(SessionQueryService, { path: ':memory:', openAt: 'never' })
  cleanups.push(async () => { await query.dispose() })
  expect(ctx.get('sessionQuery')).toBeDefined()
  const session = Session.create(SessionId('member'), [], { version: SESSION_FORMAT_VERSION, id: SessionId('member'), createdAt: 1, isSeeded: false, cwd: root, origin: 'subagent', parentSession: SessionId('captain') })
  session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'Performance · writer' })
  const handle = await ctx.sessionPersistence.create(session.header)
  await handle.append(session.snapshotEvents()); await handle.close()
  const member = { name: 'writer', sessionId: session.id, phase: 'active', role: 'Writer', provider: 'spawn', createdAt: 1 } as const
  const team = { id: 'team', name: 'Performance', captainSessionId: 'captain', members: [member], phase: 'active', revision: 1, tasks: [], attempts: [] } as unknown as TeamState
  return { ctx, query, session, member, team }
}

it('keeps the bounded cold fallback current after a persisted catalog revision changes', async () => {
  const f = await fixture(), open = vi.spyOn(f.ctx.sessionPersistence, 'open')
  await f.query.dispose()
  expect(f.ctx.get('sessionQuery')).toBeUndefined()
  const reader = new MemberProfileReader(f.ctx), signal = new AbortController().signal
  expect((await reader.list(f.team, [f.member], signal))[0]?.profileState).toBe('available')
  expect((await reader.list(f.team, [f.member], signal))[0]?.profileState).toBe('available')
  // Fixed alpha.2 did not cache these cold reads in the real Cordis fixture;
  // that failed optimization is retained in Issue 268's RED evidence.
  expect(open.mock.calls.filter(([, access]) => access === 'read')).toHaveLength(2)
  const before = await f.ctx.sessionPersistence.stat(f.session.id)
  const event = f.session.append('user/message', createUserMessage({ content: [], source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'fresh-skill', description: 'New persisted catalog' }] } }), { surfaceOp: 'append' })
  const handle = await f.ctx.sessionPersistence.open(f.session.id, 'write')
  try { await handle.append([event]); await handle.flush() } finally { await handle.close() }
  expect((await f.ctx.sessionPersistence.stat(f.session.id))!.revision).not.toBe(before!.revision)
  expect((await reader.list(f.team, [f.member], signal))[0]?.skills).toEqual(['fresh-skill'])
})

it('reads exact live member cuts with no disk reads and sees a replacement Session immediately', async () => {
  const f = await fixture(), open = vi.spyOn(f.ctx.sessionPersistence, 'open'), reader = new MemberProfileReader(f.ctx), signal = new AbortController().signal
  const live = f.ctx.sessions.prepare(f.session.id, { meta: f.session.header, seed: f.session.snapshotEvents() })
  const detach = f.ctx.sessions.enter(live)
  try { expect((await reader.list(f.team, [f.member], signal))[0]).toMatchObject({ profileState: 'available', personaConfigured: false }) } finally { detach() }
  const replacement = f.ctx.sessions.prepare(f.session.id, { meta: f.session.header })
  replacement.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'Performance · writer', persona: 'replacement' })
  const detachReplacement = f.ctx.sessions.enter(replacement)
  try { expect((await reader.list(f.team, [f.member], signal))[0]).toMatchObject({ profileState: 'available', personaConfigured: true }) } finally { detachReplacement() }
  expect(open).not.toHaveBeenCalled()
})

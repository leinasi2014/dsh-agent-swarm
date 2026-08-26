/**
 * Unit tests for the owning-member oracle in `MemberPrivateMemoryService`
 * (2026-08-26): independent of the Team/storage stack, proves the live-Agent
 * identity check is fail-closed — a forged or stale handle that merely carries a
 * valid member id must be rejected before any membership resolution or storage write.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  MemberPrivateMemoryService,
  type MemberPrivateMemoryServiceDeps,
} from '../src/runtime/member-private-memory-service.js'
import type { ToolExecutionAuthority } from '../src/runtime/orchestrator-runtime.js'
import type { MemberPrivateMemoryStore } from '../src/storage/member-private-memory.js'

const SIGNAL = new AbortController().signal

function fakeAgent(id: string): Agent {
  return { id } as unknown as Agent
}

function service(opts: {
  liveAgentMap: Map<string, Agent>
  requireMembershipRole?: 'captain' | 'member'
  store: MemberPrivateMemoryStore
}) {
  const liveAgent = vi.fn((id: string) => opts.liveAgentMap.get(id))
  const requireMembership = vi.fn(async () => ({ team: { id: 'team-x' }, role: opts.requireMembershipRole ?? 'member', name: 'member' }))
  const deps = {
    domain: () => ({ requireMembership }),
    scopeOf: () => 'scope',
    store: () => opts.store,
    liveAgent,
  } as unknown as MemberPrivateMemoryServiceDeps
  const serviceInstance = new MemberPrivateMemoryService(deps)
  return { serviceInstance, liveAgent, requireMembership }
}

function fakeStore(): MemberPrivateMemoryStore {
  const calls: unknown[][] = []
  return {
    append: vi.fn(async (...args: unknown[]) => {
      calls.push(args)
      return { schemaVersion: 1, scope: 'scope', teamId: 'team-x', memberSessionId: 'member-1', seq: 1, memoryId: 'private-memory-1', content: String(args[3]), evidenceRefs: [], createdAt: 1 }
    }),
    listPage: vi.fn(() => ({ rows: [], nextCursor: undefined })),
    close: () => {},
  } as unknown as MemberPrivateMemoryStore
}

describe('MemberPrivateMemoryService owning-member oracle', () => {
  it('rejects a stale or forged handle that reuses the live member id, before membership or storage', async () => {
    const live = fakeAgent('member-1')
    const forged = fakeAgent('member-1') // same id, NOT the registered object
    const { serviceInstance, requireMembership } = service({ liveAgentMap: new Map([['member-1', live]]), store: fakeStore() })
    const exec: ToolExecutionAuthority = { agent: forged, signal: SIGNAL }
    await expect(serviceInstance.add(exec, 'x', [])).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
    await expect(serviceInstance.list(exec, { cursor: 0, limit: 10 })).rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
    expect(requireMembership).not.toHaveBeenCalled()
  })

  it('rejects when no live agent is registered for the given id', async () => {
    const { serviceInstance, requireMembership } = service({ liveAgentMap: new Map(), store: fakeStore() })
    await expect(serviceInstance.add({ agent: fakeAgent('ghost'), signal: SIGNAL }, 'x', []))
      .rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
    expect(requireMembership).not.toHaveBeenCalled()
  })

  it('accepts the exact live registered member handle and appends', async () => {
    const live = fakeAgent('member-1')
    const store = fakeStore()
    const { serviceInstance } = service({ liveAgentMap: new Map([['member-1', live]]), store })
    const record = await serviceInstance.add({ agent: live, signal: SIGNAL }, 'note', ['ev-1'])
    expect(record).toMatchObject({ memoryId: 'private-memory-1', memberSessionId: 'member-1' })
    expect(store.append).toHaveBeenCalledTimes(1)
  })

  it('still rejects the exact live handle when it is not an active owning member (captain)', async () => {
    const live = fakeAgent('captain-1')
    const { serviceInstance } = service({ liveAgentMap: new Map([['captain-1', live]]), requireMembershipRole: 'captain', store: fakeStore() })
    await expect(serviceInstance.add({ agent: live, signal: SIGNAL }, 'x', []))
      .rejects.toMatchObject({ code: 'TEAM_PRIVATE_MEMORY_UNAUTHORIZED' })
  })
})

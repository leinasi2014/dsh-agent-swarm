import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { queryMemory } from '../src/runtime/memory-query.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('M7-A memory and member profile', () => {
  let sandbox: string
  let scope: string
  let stack: StorageStack
  let domain: TeamDomain
  let tick: number

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-memory-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function fixture() {
    const team = await domain.createTeam(scope, 'captain', 'Memory team', 'M7-A')
    await domain.provisionMember(scope, team.id, 'captain', {
      name: 'researcher', role: 'research', sessionId: 'member-1', provider: 'spawn',
      llmProvider: 'deepseek', model: 'deepseek-v4-flash', modelSource: 'explicit',
      deniedTools: ['shell'], assignedSkills: ['research-skill'],
    })
    await domain.settleMember(scope, team.id, 'member-1', { active: true })
    await domain.provisionMember(scope, team.id, 'captain', {
      name: 'reviewer', role: 'review', sessionId: 'member-2', provider: 'spawn',
    })
    await domain.settleMember(scope, team.id, 'member-2', { active: true })
    return team
  }

  it('persists additive member selection/tool/Skill facts across a full reopen', async () => {
    const team = await fixture()
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    const member = (await domain.snapshot(scope, team.id, 'captain')).team.members[0]
    expect(member).toMatchObject({
      provider: 'spawn', llmProvider: 'deepseek', model: 'deepseek-v4-flash', modelSource: 'explicit',
      deniedTools: ['shell'], assignedSkills: ['research-skill'],
    })
  })

  it('isolates personal memory, preserves shared memory and reloads both scopes', async () => {
    const team = await fixture()
    await domain.addMemory(scope, team.id, 'member-1', 'decision', 'Use a bounded index.', ['task-1'])
    await domain.addMemory(scope, team.id, 'member-1', 'lesson', 'My private retry note.', [], {
      scope: 'member', ownerSessionId: 'member-1',
    })
    await expect(domain.addMemory(scope, team.id, 'member-2', 'lesson', 'Cross write.', [], {
      scope: 'member', ownerSessionId: 'member-1',
    })).rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })

    const settings = { semanticEnabled: false, maxCandidates: 32, timeoutMs: 1_000 }
    const memberOne = await queryMemory({} as Context, domain, scope, team.id, 'member-1', settings, {
      scope: 'all', limit: 8,
    }, new AbortController().signal)
    expect(memberOne.entries.map(entry => entry.content)).toEqual(['My private retry note.', 'Use a bounded index.'])
    const memberTwo = await queryMemory({} as Context, domain, scope, team.id, 'member-2', settings, {
      scope: 'all', limit: 8,
    }, new AbortController().signal)
    expect(memberTwo.entries.map(entry => entry.content)).toEqual(['Use a bounded index.'])

    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
    const captain = await queryMemory({} as Context, domain, scope, team.id, 'captain', settings, {
      scope: 'all', ownerName: 'researcher', query: 'retry', limit: 8,
    }, new AbortController().signal)
    expect(captain.entries).toHaveLength(2)
    expect(captain.entries[0]).toMatchObject({ scope: 'member', ownerSessionId: 'member-1', authorSessionId: 'member-1' })
    await expect(queryMemory({} as Context, domain, scope, team.id, 'captain', settings, {
      scope: 'personal', ownerName: 'missing-member', limit: 8,
    }, new AbortController().signal)).rejects.toThrow('not found')
    await expect(queryMemory({} as Context, domain, scope, team.id, 'member-1', settings, {
      scope: 'personal', ownerName: 'reviewer', limit: 8,
    }, new AbortController().signal)).rejects.toThrow('only the captain')
  })

  it('returns an explicit deterministic fallback when semantic ranking is disabled', async () => {
    const team = await fixture()
    await domain.addMemory(scope, team.id, 'member-1', 'context', 'alpha beta', [])
    const result = await queryMemory({} as Context, domain, scope, team.id, 'member-1', {
      semanticEnabled: false, maxCandidates: 32, timeoutMs: 1_000,
    }, { scope: 'team', query: 'alpha', semantic: true, limit: 8 }, new AbortController().signal)
    expect(result).toMatchObject({ strategy: 'fallback', degraded: 'semantic search is disabled' })
    expect(result.entries.map(entry => entry.content)).toEqual(['alpha beta'])
  })

  it('accepts only candidate ids from the configured official LLM ranking route', async () => {
    const team = await fixture()
    await domain.addMemory(scope, team.id, 'member-1', 'context', 'first record', [])
    await domain.addMemory(scope, team.id, 'member-1', 'context', 'second record', [])
    const text = JSON.stringify({ ids: ['memory-1', 'invented-id', 'memory-2'] })
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const ctx = { llm: { stream: async function* () { yield* chunks } } } as unknown as Context
    const result = await queryMemory(ctx, domain, scope, team.id, 'member-1', {
      semanticEnabled: true, semanticProvider: 'configured', semanticModel: 'configured-model',
      maxCandidates: 32, timeoutMs: 1_000,
    }, { scope: 'team', query: 'record', semantic: true, limit: 8 }, new AbortController().signal)
    expect(result.strategy).toBe('semantic')
    expect(result.entries.map(entry => entry.id)).toEqual(['memory-1', 'memory-2'])
  })

  it('does not expose raw semantic Provider failures', async () => {
    const team = await fixture()
    await domain.addMemory(scope, team.id, 'member-1', 'context', 'bounded record', [])
    const ctx = {
      llm: { stream: async function* () { yield await Promise.reject(new Error('Authorization: Bearer secret-token')) } },
    } as unknown as Context
    const result = await queryMemory(ctx, domain, scope, team.id, 'member-1', {
      semanticEnabled: true, semanticProvider: 'configured', semanticModel: 'configured-model',
      maxCandidates: 32, timeoutMs: 1_000,
    }, { scope: 'team', query: 'record', semantic: true, limit: 8 }, new AbortController().signal)
    expect(result).toMatchObject({
      strategy: 'fallback',
      degraded: 'semantic provider unavailable, timed out, or returned invalid output',
    })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
})

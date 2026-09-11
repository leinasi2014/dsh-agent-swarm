/** Real registry/Session sources, stable pages, official tool output and context. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Skills from '@deepseek-ai/dsh-skill'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { expect, it, vi } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { mountNodeComposition, setUpTeam, SIGNAL } from './helpers/node-composition.js'

it('keeps full revisioned sources in explicit reads and only core identities in automatic context', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-directory-'))
  const f = await mountNodeComposition(sandbox)
  try {
    f.fibers.push(await f.ctx.plugin(Skills))
    const registerSkill = (description: string) => f.ctx.skills.register({ name: 'directory-alpha', description, content: 'PRIVATE SKILL BODY MUST NOT LEAK', source: 'runtime' })
    let disposeSkill = registerSkill('First public purpose')
    const teamId = TeamId(await setUpTeam(f, []))
    const add = await f.ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('directory-add'), name: 'agent_swarm_add_member',
      arguments: { name: 'writer', role: 'Write stories', skills: ['directory-alpha'] }, agent: f.lead })
    expect(add.isError, JSON.stringify(add)).toBe(false)
    let team = (await f.domain.snapshot(f.scope, teamId, f.lead.id)).team
    const member = team.members[0]!, agent = f.ctx.agents.get(SessionId(member.sessionId))!
    team = await f.domain.setMemberProfile(f.scope, teamId, member.sessionId, team.revision, member.name,
      { displayName: '同名', profession: '编剧', personality: '谨慎', biography: '公开简介' })
    team = await f.domain.setCaptainProfile(f.scope, teamId, f.lead.id, team.revision,
      { displayName: '同名', profession: '统筹', personality: '果断', biography: '公开负责人' })
    const read = (input: { cursor?: string; limit?: number } = {}) => f.ctx.agentSwarm.directory.read(f.scope, teamId, input, SIGNAL)
    const full = await read()
    expect(full.entries.map(row => [row.memberId, row.label])).toEqual([[f.lead.id, '同名'], [member.sessionId, '同名']])
    expect(full.page).toMatchObject({ returnedCount: 2, totalCount: 2, unreadRanges: [] })
    const writer = full.entries[1]!
    expect(writer.skills.assigned).toMatchObject({ state: 'available', entries: [{ name: 'directory-alpha', description: 'First public purpose' }] })
    expect(writer.skills.catalog).toMatchObject({ state: 'available', entries: [{ name: 'directory-alpha' }] })
    expect(writer.currentTasks).toEqual([])
    expect(writer.tools.complete).toBe(false)
    expect(writer.tools.entries.find(row => row.name === 'agent_swarm_directory')).toMatchObject({ teamPolicy: 'allow', state: 'unknown' })
    expect(JSON.stringify(full)).not.toContain('PRIVATE SKILL BODY')
    expect(writer.profile.updatedAt).toBeUndefined()
    expect((await read()).directoryRevision).toBe(full.directoryRevision)
    const page1 = await read({ limit: 1 })
    const page2 = await read({ limit: 1, cursor: page1.page.nextCursor! })
    expect(page2.directoryRevision).toBe(page1.directoryRevision)
    expect(page1.page.unreadRanges).toEqual([{ offset: 1, count: 1 }])
    expect(page2.entries[0]?.memberId).toBe(member.sessionId)
    expect(page2.page.unreadRanges).toEqual([{ offset: 0, count: 1 }])
    const result = await f.ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('directory-read'), name: 'agent_swarm_directory', arguments: {}, agent })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(result.value).toMatchObject({ directoryRevision: full.directoryRevision, entries: full.entries.map(row => ({ memberId: row.memberId })) })
    const richReads = vi.spyOn(f.ctx.agentSwarm.directory, 'read')
    const context = renderContextSnapshot(await f.ctx.systemPrompt.assemble(assembleContextFor(agent)))
    expect(richReads).not.toHaveBeenCalled()
    richReads.mockRestore()
    expect(context).toContain('Current public Team overview')
    expect(context).toContain(member.sessionId)
    expect(context).toContain('Write stories')
    expect(context).not.toContain('First public purpose')
    expect(context).not.toContain('公开负责人')
    expect(result.value).toMatchObject({ entries: [{ biography: '公开负责人' }, { biography: '公开简介' }] })

    const revision = (await f.domain.snapshot(f.scope, teamId, f.lead.id)).team.revision
    disposeSkill(); disposeSkill = registerSkill('Second public purpose ' + '字'.repeat(600))
    const changed = await read()
    expect(changed.directoryRevision).not.toBe(full.directoryRevision)
    expect(changed.entries[1]?.skills.catalog.entries[0]).toMatchObject({ descriptionTruncated: true })
    expect((await f.domain.snapshot(f.scope, teamId, f.lead.id)).team.revision).toBe(revision)
    await expect(read({ cursor: page1.page.nextCursor! })).rejects.toMatchObject({ code: 'SWARM_DIRECTORY_STALE' })
    disposeSkill()

    const unregister = f.ctx.tools.register({ name: 'directory_probe', description: 'Public test tool', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] }, execute: async () => null })
    const toolsChanged = await read()
    expect(toolsChanged.entries[1]?.tools.entries.some(row => row.name === 'directory_probe')).toBe(true)
    const unrestrict = agent.ctx.tools.restrict({ deny: ['directory_probe'] })
    const restricted = await read()
    expect(restricted.directoryRevision).not.toBe(toolsChanged.directoryRevision)
    expect(restricted.entries[1]?.tools.entries.some(row => row.name === 'directory_probe')).toBe(false)
    unrestrict(); unregister()
    expect((await f.domain.snapshot(f.scope, teamId, f.lead.id)).team.revision).toBe(revision)

    const model = vi.spyOn(f.adapter, 'resolveModel').mockImplementation(async (provider, id) => ({ provider, id, name: id, inputModalities: ['text', 'image'] }))
    const supportsImages = await read()
    expect(supportsImages.entries[1]?.model.imageInput).toBe('supported')
    model.mockImplementation(async (provider, id) => ({ provider, id, name: id, inputModalities: ['text'] }))
    const textOnly = await read()
    expect(textOnly.entries[1]?.model.imageInput).toBe('unsupported')
    expect(textOnly.directoryRevision).not.toBe(supportsImages.directoryRevision)
    expect((await f.domain.snapshot(f.scope, teamId, f.lead.id)).team.revision).toBe(revision)
    model.mockRestore()

    const snapshot = f.ctx.skills.snapshot.bind(f.ctx.skills)
    let changedDuringRead = false, restoreSkill: (() => void) | undefined
    const discovery = vi.spyOn(f.ctx.skills, 'snapshot').mockImplementation(async options => {
      const observation = await snapshot(options)
      if (!changedDuringRead) { changedDuringRead = true; restoreSkill = registerSkill('Changed during the multi-source read') }
      return observation
    })
    try { await expect(read()).rejects.toMatchObject({ code: 'SWARM_DIRECTORY_STALE' }) }
    finally { discovery.mockRestore(); restoreSkill?.() }
  } finally {
    f.adapter.open()
    for (const fiber of f.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

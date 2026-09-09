import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TeamDashboardController } from '../src/client/team-dashboard-controller.js'
import { queueCommunicationChange } from '../src/client/team-communication-command.js'

function fixture() {
  let current = 'viewer'
  let ready = true
  const list = () => ({ current, byId: { captain: { origin: 'subagent', parentId: 'main' } }, subagentsByParent: { main: {
    state: ready ? 'ready' : 'loading', entries: [{ kind: 'child', id: 'captain', mode: 'continuable' }],
  } } })
  const sessions = { list: { getSnapshot: list }, refreshSubagents: vi.fn(async () => {}) } as unknown as ISessions
  const controller = {
    getSnapshot: () => ({ phase: 'ready', targetSessionId: 'viewer', data: { projection: { team: { id: 'team-a' } } } }),
    openCaptainChat: async (callback: (id: string, signal: AbortSignal) => Promise<void>) => callback('captain', new AbortController().signal),
  } as unknown as TeamDashboardController
  return { sessions, controller, send: vi.fn(async () => {}), changeViewer: () => { current = 'other' }, invalidateCatalog: () => { ready = false } }
}

it('queues exactly one human request to the fresh official direct-child address', async () => {
  const f = fixture()
  await queueCommunicationChange({ ...f, choice: 'quiet' })
  expect(f.sessions.refreshSubagents).toHaveBeenCalledExactlyOnceWith('main')
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.send).toHaveBeenCalledWith({ sessionId: 'captain', parentSessionId: 'main', text: expect.stringContaining('intensity: "quiet"') }, expect.any(AbortSignal))
})

it.each(['navigation', 'catalog'] as const)('rejects a changed %s before sending the user request', async kind => {
  const f = fixture()
  vi.mocked(f.sessions.refreshSubagents).mockImplementation(async () => { if (kind === 'navigation') f.changeViewer(); else f.invalidateCatalog() })
  await expect(queueCommunicationChange({ ...f, choice: 'balanced' })).rejects.toThrow()
  expect(f.send).not.toHaveBeenCalled()
})

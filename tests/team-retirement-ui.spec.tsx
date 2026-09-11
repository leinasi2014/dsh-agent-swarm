// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { render, tZh } from './helpers/dashboard-ui.js'
import { RetirementClient } from '../src/client/retirement-client.js'
import { TeamRetirementPanel } from '../src/client/TeamRetirementPanel.js'
import { TeamRetirementMenu } from '../src/client/TeamRetirementMenu.js'
import { TeamRetirementRequests } from '../src/client/TeamRetirementRequests.js'
import type { RetirementPreview, RetirementRequest } from '../src/shared/team-retirement.js'

const target = { rootSessionId: 'main-root', teamId: 'team-one' }
const translate = tZh as ComponentProps<typeof TeamRetirementPanel>['t']
const preview: RetirementPreview = { schemaVersion: 1, target, teamName: '美术制作团队', teamRevision: 4, phase: 'active', previewDigest: 'a'.repeat(64), deletion: { available: true },
  counts: { sessions: 3, memories: 2, humanInteractions: 1, workflowRuns: 1, protectedSessions: 1, unfinishedTasks: 2, activeAttempts: 1 } }
const request: RetirementRequest = { schemaVersion: 1, target, requestId: 'same-request', action: 'archive', expectedTeamRevision: 4 }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
async function click(text: string) { await act(async () => { button(text).click() }) }
function clientWith(call: (...args: unknown[]) => Promise<unknown>) { return new RetirementClient({ call } as never, window.sessionStorage) }
function panel(client: RetirementClient, action: 'archive' | 'delete' = 'delete') {
  return <TeamRetirementPanel client={client} target={target} action={action} t={translate} close={vi.fn()} completed={vi.fn(async () => {})} />
}
async function name(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[data-retirement-confirm-name]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each(['TEAM_RETIREMENT_PREVIEW_CHANGED', 'TEAM_REVISION_CONFLICT'])('allows a new preview after a definite unaccepted %s result', async code => {
  window.sessionStorage.clear()
  const rpc = vi.fn(async (_channel, method) => method === 'team/v1/preview' ? { ok: true, value: preview } : { ok: false, error: { code, message: '请重新预览' } })
  const client = clientWith(rpc)
  await render(panel(client))
  expect(document.querySelector('dl')?.textContent).toContain('3')
  expect(button(tZh('retirement.delete')).disabled).toBe(true)
  await name('错误团队')
  expect(button(tZh('retirement.delete')).disabled).toBe(true)
  await name(preview.teamName)
  await click(tZh('retirement.delete'))
  expect(client.pending(target)).toBeUndefined()
  expect(button(tZh('retirement.query'))).toBeUndefined()
  await click(tZh('retirement.refresh'))
  expect(document.querySelector<HTMLInputElement>('[data-retirement-confirm-name]')?.value).toBe('')
  expect(rpc.mock.calls.filter(([, method]) => method === 'team/v1/preview')).toHaveLength(2)
})

it('retains the original request and action after network uncertainty, including not-found query', async () => {
  window.sessionStorage.clear()
  const rpc = vi.fn(async (_channel, method, _value: unknown) => {
    if (method === 'team/v1/requestResult') return { ok: true, value: { state: 'not-found' } }
    throw new Error('连接中断，结果未知')
  })
  const client = clientWith(rpc)
  await expect(client.execute(request)).rejects.toThrow('结果未知')
  await render(panel(client, 'delete'))
  expect(document.querySelector('h2')?.textContent).toBe(tZh('retirement.archive'))
  expect(document.querySelector('[data-retirement-confirm-name]')).toBeNull()
  expect(client.pending(target)).toEqual(request)
  await click(tZh('retirement.continue'))
  expect(rpc.mock.calls.filter(([, method]) => method === 'team/v1/execute')).toHaveLength(2)
  expect(rpc.mock.calls.filter(([, method]) => method === 'team/v1/execute').every(([, , value]) => (value as RetirementRequest).requestId === request.requestId)).toBe(true)
  expect(client.pending(target)).toEqual(request)
})

it('renders archived history as messages and keeps auxiliary tool text collapsed', async () => {
  const rpc = vi.fn(async () => ({ ok: true, value: { schemaVersion: 1, target, teamName: preview.teamName, readonly: true,
    sessionId: 'captain-one', sessions: [{ id: 'captain-one', label: '团队队长', role: 'captain', available: true }], cursor: 0,
    entries: [{ sequence: 1, role: 'assistant', content: '已完成脸部对照。下一步检查侧面。', truncated: false }, { sequence: 2, role: 'tool', content: '↳ read_file\n详细工具结果', truncated: false }] } }))
  await render(<TeamRetirementPanel client={clientWith(rpc)} target={target} action="history" initialSessionId="captain-one" t={translate} close={vi.fn()} completed={vi.fn(async () => {})} />)
  expect(document.querySelector('[data-history-role=assistant]')?.textContent).toContain('已完成脸部对照')
  expect(document.querySelector('pre')).toBeNull()
  expect(document.querySelector('details')?.open).toBe(false)
  expect(rpc).toHaveBeenCalledExactlyOnceWith('/swarm-public', 'team/v1/history', expect.objectContaining({ sessionId: 'captain-one' }), undefined)
})

it('lists saved requests independently of Team state and forbids replacing an uncertain operation', async () => {
  window.sessionStorage.clear()
  const client = clientWith(vi.fn(async () => { throw new Error('connection lost') }))
  await expect(client.execute(request)).rejects.toThrow('connection lost')
  await expect(client.execute({ ...request, requestId: 'replacement-request' })).rejects.toThrow('saved retirement request')
  window.sessionStorage.setItem('swarm.retirement.v1:invalid', '{broken')
  const open = vi.fn()
  await render(<TeamRetirementRequests client={client} t={translate} open={open} />)
  expect(document.querySelector('[data-retirement-requests]')?.textContent).toContain('待确认操作 (1)')
  expect(document.querySelector('[role=alert]')?.textContent).toContain('记录已保留')
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-retirement-saved-request]')!.click() })
  expect(open).toHaveBeenCalledWith(request)
  expect(client.pending(target)).toEqual(request)
})

it('opens a portal menu with keyboard navigation and restores trigger focus', async () => {
  const trigger = document.body.appendChild(document.createElement('button'))
  trigger.focus()
  const close = vi.fn(), choose = vi.fn()
  await render(<TeamRetirementMenu x={100} y={100} archived={false} close={close} choose={choose} t={translate} />)
  expect(document.activeElement?.textContent).toBe(tZh('retirement.archive'))
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
  expect(document.activeElement?.textContent).toBe(tZh('retirement.delete'))
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(close).toHaveBeenCalledOnce()
})

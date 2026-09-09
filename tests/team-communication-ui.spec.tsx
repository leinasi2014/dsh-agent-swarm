// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { TeamCommunicationControl, type TeamCommunicationValue } from '../src/client/TeamCommunicationControl.js'
import { mounted, t, render } from './helpers/dashboard-ui.js'
const translate = t as TranslateNS<'swarm.team-dashboard'>

it('shows pending until a newer canonical setting confirms the requested change', async () => {
  let release!: () => void
  const onRequest = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  mounted.push(root)
  const show = async (value: TeamCommunicationValue, revision: number) => act(async () => {
    root.render(<TeamCommunicationControl value={value} revision={revision} disabled={false} onRequest={onRequest} t={translate} />)
  })
  await show({ intensity: 'active', source: 'plugin', peerWakeupsPerMinute: 12 }, 9)
  const select = document.querySelector('select')!
  await act(async () => { select.value = 'quiet'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { document.querySelector('button')!.click() })
  expect(onRequest).toHaveBeenCalledExactlyOnceWith('quiet')
  expect(document.body.textContent).toContain('Sending request')
  await act(async () => { release() })
  expect(document.body.textContent).toContain('Request queued')
  expect(document.body.textContent).not.toContain('Setting confirmed')
  await show({ intensity: 'active', source: 'plugin', peerWakeupsPerMinute: 12 }, 10)
  expect(document.body.textContent).toContain('Request queued')
  await show({ intensity: 'quiet', source: 'team', peerWakeupsPerMinute: 1 }, 11)
  expect(document.body.textContent).toContain('Setting confirmed by Team readback')
  expect(document.querySelector('[data-swarm-communication-current]')?.textContent).toContain('Quiet · Team setting · 1')
})

it('reports rejected requests and does not invent a successful or missing setting', async () => {
  const onRequest = vi.fn(async () => { throw new Error('Captain is unavailable') })
  await render(<TeamCommunicationControl value={{ intensity: 'active', source: 'plugin', peerWakeupsPerMinute: 12 }} revision={1} disabled={false} onRequest={onRequest} t={translate} />)
  await act(async () => { const select = document.querySelector('select')!; select.value = 'balanced'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { document.querySelector('button')!.click() })
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Captain is unavailable')
  expect(document.body.textContent).not.toContain('Setting confirmed')
})

// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamSkillSettingsCard } from '../src/client/TeamSkillSettingsCard.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted: Root[] = []
const t = (key: string): string => ({
  title: 'Team Skills', description: 'Choose Skills.', allowedSkills: 'Allowed Skills', hint: 'One per line.',
  save: 'Save', saving: 'Saving…', saved: 'Saved.', invalid: 'Invalid.', unavailable: 'Unavailable.',
}[key] ?? key)

async function render(node: ReactNode): Promise<void> {
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  mounted.push(root)
  await act(async () => { root.render(node) })
}

afterEach(async () => {
  while (mounted.length) await act(async () => { mounted.pop()?.unmount() })
  document.body.replaceChildren()
})

describe('TeamSkillSettingsCard', () => {
  it('renders with a SettingsScope whose methods require their controller receiver', async () => {
    class Scope {
      private readonly value = { allowedSkills: ['frontend-review'] }
      private readonly snapshot = { status: 'ready' as const, writable: true, value: this.value }
      subscribe(_listener: () => void): () => void { return () => {} }
      getSnapshot() { return this.snapshot }
      async set(): Promise<void> {}
    }
    const scope = new Scope()

    await render(<TeamSkillSettingsCard {...({ scope, t } as any)} />)

    expect(document.body.textContent).toContain('Team Skills')
    expect(document.querySelector<HTMLTextAreaElement>('#agent-swarm-allowed-skills')?.value).toBe('frontend-review')
  })
})

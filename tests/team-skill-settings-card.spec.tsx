// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamSkillSettingsCard } from '../src/client/TeamSkillSettingsCard.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted: Root[] = []
const copy: Record<string, string> = {
  title: 'Agent Teams', description: 'Team defaults.', open: 'Show settings', close: 'Hide settings',
  readOnly: 'Read-only.', overview: 'Team defaults', skills: 'Skills', execution: 'Execution limits',
  captainRoute: 'Captain model route', memberRoute: 'Member model route', inheritRoute: 'Inherit route',
  routesLoading: 'Loading routes.', routesUnavailable: 'No routes.', maxMembers: 'Maximum members per Team',
  maxTasks: 'Maximum tasks per Team', memberDepth: 'Member subagent depth', pendingMessages: 'Pending messages per member',
  skillsMode: 'Skill policy', inheritSkills: 'Do not restrict Skills', restrictSkills: 'Restrict to selected Skills',
  skillsHint: 'Read from DSH.', selectWorkspace: 'Open a workspace session.', skillsLoading: 'Loading Skills.',
  skillsUnavailable: 'Skills unavailable.', noModelSkills: 'No Skills.', userOnly: 'User-only',
  noSkillsSelected: 'Choose one.', orchestrationMode: 'Orchestration mode', adaptive: 'Adaptive scheduling',
  workflow: 'Workflow bridge', workflowBridge: 'Enable workflow bridge', jobsBridge: 'Expose Team jobs to DSH',
  executionRoots: 'Create isolated execution roots', executionHint: 'Only new Teams.', invalidNumber: 'Invalid number.',
  save: 'Save Team settings', saving: 'Saving…', saved: 'Saved.', saveFailed: 'Save failed.',
}
const t = (key: string): string => copy[key] ?? key

async function render(node: ReactNode): Promise<void> {
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  mounted.push(root)
  await act(async () => { root.render(node) })
}

async function flush(): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }

afterEach(async () => {
  while (mounted.length) await act(async () => { mounted.pop()?.unmount() })
  document.body.replaceChildren()
})

describe('TeamSkillSettingsCard', () => {
  it('starts as a named plugin entry and opens a complete configuration surface', async () => {
    class Scope {
      private readonly snapshot = { status: 'ready' as const, writable: true, value: { maxMembers: 5, maxTasks: 24, memberMaxDepth: 1, maxPendingMessagesPerMember: 16 }, revision: 1, base: {}, user: {}, mode: 'host' as const }
      subscribe(_listener: () => void): () => void { return () => {} }
      getSnapshot() { return this.snapshot }
      async set(): Promise<void> {}
      async unset(): Promise<void> {}
    }
    const scope = new Scope()
    const catalog = {
      currentSessionId: () => 'session-1', subscribe: (_listener: () => void) => () => {},
      listSkills: async () => [{ name: 'frontend-review', description: 'Review a frontend.', whenToUse: 'Before UI release.', modelInvocable: true }],
      listModelRoutes: async () => [{ provider: 'dsv4f-local', providerName: 'DSV4 Flash', model: 'DeepSeek-V4-Flash-0731', modelName: 'DeepSeek V4 Flash' }],
    }

    await render(<TeamSkillSettingsCard {...({ scope, catalog, t } as any)} />)
    expect(document.body.textContent).toContain('Agent Teams')
    expect(document.querySelector('[aria-label="Show settings: Agent Teams"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Captain model route"]')).toBeNull()

    await act(async () => { (document.querySelector('[aria-label="Show settings: Agent Teams"]') as HTMLButtonElement).click() })
    await flush()
    expect(document.querySelector('[aria-label="Captain model route"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Captain model route"]')?.textContent).toContain('DeepSeek V4 Flash')
    expect(document.body.textContent).toContain('Maximum members per Team')
  })

  it('reads real Skill rows and saves a selected allow-list without free text', async () => {
    class Scope {
      readonly writes: Array<[string, unknown]> = []
      private readonly snapshot = { status: 'ready' as const, writable: true, value: { maxMembers: 5, maxTasks: 24, memberMaxDepth: 1, maxPendingMessagesPerMember: 16 }, revision: 1, base: {}, user: {}, mode: 'host' as const }
      subscribe(_listener: () => void): () => void { return () => {} }
      getSnapshot() { return this.snapshot }
      async set(field: string, value: unknown): Promise<void> { this.writes.push([field, value]) }
      async unset(field: string): Promise<void> { this.writes.push([field, 'unset']) }
    }
    const scope = new Scope()
    const catalog = {
      currentSessionId: () => 'session-1', subscribe: (_listener: () => void) => () => {},
      listSkills: async () => [
        { name: 'frontend-review', description: 'Review a frontend.', modelInvocable: true },
        { name: 'user-only', description: 'User-only helper.', modelInvocable: false },
      ],
      listModelRoutes: async () => [],
    }
    await render(<TeamSkillSettingsCard {...({ scope, catalog, t } as any)} />)
    await act(async () => { (document.querySelector('[aria-label="Show settings: Agent Teams"]') as HTMLButtonElement).click() })
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Skills')?.click() })
    await flush()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector<HTMLInputElement>('[aria-label="frontend-review"]')).not.toBeNull()
    expect(document.querySelector<HTMLInputElement>('[aria-label="user-only"]')?.disabled).toBe(true)

    await act(async () => { (document.querySelector<HTMLInputElement>('input[type="radio"][value=""]') ?? document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!).click() })
    await act(async () => { (document.querySelector<HTMLInputElement>('[aria-label="frontend-review"]')!).click() })
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Save Team settings')?.click() })
    await flush()
    expect(scope.writes).toContainEqual(['allowedSkills', ['frontend-review']])
  })
})

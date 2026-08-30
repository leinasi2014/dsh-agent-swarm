// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TeamSkillSettingsCard,
  teamSkillSettingsEn,
  type TeamPluginSettings,
  type TeamSettingsCatalog,
  type TeamSkillSettingsProps,
} from '../src/client/TeamSkillSettingsCard.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Write =
  | { readonly op: 'set'; readonly field: string; readonly value: unknown }
  | { readonly op: 'unset'; readonly field: string }

const mounted: Root[] = []
const t: TeamSkillSettingsProps['t'] = key => teamSkillSettingsEn[key as keyof typeof teamSkillSettingsEn] ?? String(key)

const modelSkills = [
  { name: 'frontend-review', description: 'Review a frontend.', whenToUse: 'Before UI release.', modelInvocable: true },
  { name: 'backend-audit', description: 'Audit a backend.', whenToUse: 'Before service release.', modelInvocable: true },
  { name: 'user-only-helper', description: 'Only a user may invoke this.', modelInvocable: false },
] as const

const catalog: TeamSettingsCatalog = {
  currentSessionId: () => 'session-1',
  subscribe: () => () => {},
  listSkills: () => Promise.resolve(modelSkills),
  listModelRoutes: () => Promise.resolve([
    { provider: 'dsv4f-local', providerName: 'DSV4 Flash', model: 'DeepSeek-V4-Flash-0731', modelName: 'DeepSeek V4 Flash' },
  ]),
}

class TestScope implements SettingsScope<TeamPluginSettings> {
  readonly writes: Write[] = []
  private snapshot: SettingsScopeSnapshot<TeamPluginSettings>
  private readonly listeners = new Set<() => void>()

  constructor(value: TeamPluginSettings = {}, private readonly acceptWrites = true) {
    this.snapshot = {
      status: 'ready',
      writable: true,
      value,
      revision: 1,
      base: {},
      user: {},
      mode: 'host',
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): SettingsScopeSnapshot<TeamPluginSettings> {
    return this.snapshot
  }

  set(field: string, value: unknown): Promise<void> {
    this.writes.push({ op: 'set', field, value })
    if (this.acceptWrites) this.publish({ ...(this.snapshot.user as Record<string, unknown>), [field]: structuredClone(value) })
    return Promise.resolve()
  }

  unset(field: string): Promise<void> {
    this.writes.push({ op: 'unset', field })
    if (this.acceptWrites) {
      const { [field]: _removed, ...user } = this.snapshot.user as Record<string, unknown>
      this.publish(user)
    }
    return Promise.resolve()
  }

  private publish(user: Record<string, unknown>): void {
    this.snapshot = {
      ...this.snapshot,
      user,
      value: { ...(this.snapshot.base as TeamPluginSettings), ...user },
      revision: (this.snapshot.revision ?? 0) + 1,
    }
    for (const listener of this.listeners) listener()
  }
}

function card(scope: TestScope, skillCatalog: TeamSettingsCatalog = catalog): ReactNode {
  const props = { scope, catalog: skillCatalog, t } as TeamSkillSettingsProps
  return <TeamSkillSettingsCard {...props} />
}

async function render(node: ReactNode): Promise<void> {
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  mounted.push(root)
  await act(async () => { root.render(node) })
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}

function entryButton(): HTMLButtonElement {
  const value = document.querySelector<HTMLButtonElement>('[data-agent-swarm-settings-entry] > button')
  if (value === null) throw new Error('Agent Swarm settings entry was not rendered')
  return value
}

function button(text: string): HTMLButtonElement {
  const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === text)
  if (value === undefined) throw new Error(`Button not found: ${text}`)
  return value
}

function labeledControl<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(text: string): T {
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.trim().startsWith(text) === true)
  const value = label?.querySelector<T>('input, select, textarea')
  if (value === null || value === undefined) throw new Error(`Control not found: ${text}`)
  return value
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click() })
}

async function changeValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
    descriptor?.set?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function openSettings(): Promise<void> {
  await click(entryButton())
  await flush()
}

async function selectTab(text: string): Promise<void> {
  await click(button(text))
  await flush()
}

afterEach(async () => {
  while (mounted.length > 0) await act(async () => { mounted.pop()?.unmount() })
  document.body.replaceChildren()
})

describe('TeamSkillSettingsCard', () => {
  it('presents Agent Swarm as one plugin entry with five complete configuration groups', async () => {
    await render(card(new TestScope()))

    expect(document.querySelector('[data-agent-swarm-settings-entry]')).not.toBeNull()
    expect(entryButton().getAttribute('aria-label')).toBe('Configure plugin: Agent Swarm Intelligent Agent Teams')
    expect(entryButton().textContent).toContain('Agent Swarm · Intelligent Agent Teams')
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0)

    await openSettings()

    expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual([
      'Team',
      'Skills',
      'Orchestration & review',
      'Tool permissions',
      'Execution & limits',
    ])
    expect(labeledControl<HTMLInputElement>('Enable Agent Swarm').checked).toBe(true)
    expect([...labeledControl<HTMLSelectElement>('Captain model route').options].map(option => option.text)).toEqual([
      'Inherit the model selected when the Team is created',
      'DSV4 Flash · DeepSeek V4 Flash',
    ])
    expect(document.body.textContent).toContain('Identity and avatar policy')

    await selectTab('Skills')
    expect(document.querySelector('[aria-label="Search Skills"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Skill policy for newly created Teams')

    await selectTab('Orchestration & review')
    for (const field of [
      'Scheduler Provider',
      'Review Provider',
      'Review execution-root Provider',
      'Orchestration mode',
      'Enable workflow bridge',
      'Expose Team tasks in DSH Jobs',
      'Retry stranded ownership after (ms)',
      'Workflow total-agent ceiling',
      'Workflow disposal grace (ms)',
    ]) expect(document.body.textContent).toContain(field)

    await selectTab('Tool permissions')
    for (const field of ['Always allow', 'Ask Captain for approval', 'Always deny']) {
      expect(labeledControl<HTMLTextAreaElement>(field)).not.toBeNull()
    }

    await selectTab('Execution & limits')
    for (const field of [
      'Create isolated execution roots',
      'Execution-root Provider',
      'Execution-root base directory',
      'Retained message receipts',
      'Retained attempts per task',
      'Maximum message bytes',
      'Maximum task bytes',
      'Maximum task dependencies',
      'Maximum shared memories',
      'Maximum interaction effects',
      'Verification commands per task',
      'Verification command timeout (ms)',
      'Maximum Host contexts',
      'Host context lifetime (ms)',
      'Disposal timeout (ms)',
      'System-prompt section order',
    ]) expect(document.body.textContent).toContain(field)
    expect(document.body.textContent).toContain('Restart DSH after saving to apply runtime changes.')
  })

  it('loads model-invocable Skills, enforces a non-empty restriction, and can remove the restriction', async () => {
    const scope = new TestScope({ allowedSkills: ['frontend-review'] })
    await render(card(scope))
    await openSettings()
    await selectTab('Skills')

    const frontend = document.querySelector<HTMLInputElement>('[aria-label="frontend-review"]')
    const backend = document.querySelector<HTMLInputElement>('[aria-label="backend-audit"]')
    expect(frontend?.checked).toBe(true)
    expect(backend?.checked).toBe(false)
    expect(document.querySelector('[aria-label="user-only-helper"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Only a user may invoke this.')

    await click(button('Select visible'))
    expect(frontend?.checked).toBe(true)
    expect(backend?.checked).toBe(true)

    await click(button('Clear selection'))
    expect(frontend?.checked).toBe(false)
    expect(backend?.checked).toBe(false)
    expect(button('Save plugin settings').disabled).toBe(true)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Choose at least one Skill')

    await click(backend!)
    expect(button('Save plugin settings').disabled).toBe(false)
    await click(button('Save plugin settings'))
    await flush()
    expect(scope.writes).toContainEqual({ op: 'set', field: 'allowedSkills', value: ['backend-audit'] })

    await click(labeledControl<HTMLInputElement>('Use every Skill exposed by DSH'))
    await click(button('Save plugin settings'))
    await flush()
    expect(scope.writes.at(-1)).toEqual({ op: 'unset', field: 'allowedSkills' })
  })

  it('saves orchestration, tool permissions, and resource limits as one valid draft', async () => {
    const scope = new TestScope()
    await render(card(scope))
    await openSettings()

    await selectTab('Orchestration & review')
    await changeValue(labeledControl<HTMLInputElement>('Scheduler Provider'), 'round-robin')
    await changeValue(document.querySelector<HTMLSelectElement>('[aria-label="Orchestration mode"]')!, 'workflow')
    await click(labeledControl<HTMLInputElement>('Expose Team tasks in DSH Jobs'))

    await selectTab('Tool permissions')
    await changeValue(labeledControl<HTMLTextAreaElement>('Always allow'), 'team.write, team.read\nteam.write')
    await changeValue(labeledControl<HTMLTextAreaElement>('Ask Captain for approval'), 'team.review')
    await changeValue(labeledControl<HTMLTextAreaElement>('Always deny'), 'shell.exec')

    await selectTab('Execution & limits')
    await click(labeledControl<HTMLInputElement>('Create isolated execution roots'))
    await changeValue(labeledControl<HTMLInputElement>('Execution-root Provider'), 'sandbox')
    await changeValue(labeledControl<HTMLInputElement>('Retained message receipts'), '2048')

    await click(button('Save plugin settings'))
    await flush()

    const workflowBridge = scope.writes.findIndex(write => write.op === 'set' && write.field === 'workflowBridge')
    const orchestrationMode = scope.writes.findIndex(write => write.op === 'set' && write.field === 'orchestrationMode')
    expect(workflowBridge).toBeGreaterThanOrEqual(0)
    expect(orchestrationMode).toBeGreaterThan(workflowBridge)
    expect(scope.writes).toContainEqual({ op: 'set', field: 'workflowBridge', value: true })
    expect(scope.writes).toContainEqual({ op: 'set', field: 'orchestrationMode', value: 'workflow' })
    expect(scope.writes).toContainEqual({ op: 'set', field: 'schedulerProvider', value: 'round-robin' })
    expect(scope.writes).toContainEqual({ op: 'set', field: 'jobsBridge', value: true })
    expect(scope.writes.filter(write => write.op === 'set' && write.field === 'toolPolicy')).toEqual([
      {
        op: 'set',
        field: 'toolPolicy',
        value: { allow: ['team.read', 'team.write'], ask: ['team.review'], deny: ['shell.exec'] },
      },
    ])
    expect(scope.writes).toContainEqual({ op: 'set', field: 'executionRoots', value: true })
    expect(scope.writes).toContainEqual({ op: 'set', field: 'executionRootProvider', value: 'sandbox' })
    expect(scope.writes).toContainEqual({ op: 'set', field: 'maxRetainedMessages', value: 2048 })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Restart DSH after saving')
  })

  it('keeps the draft dirty and reports failure when Host restores state after rejecting a write', async () => {
    const scope = new TestScope({}, false)
    await render(card(scope))
    await openSettings()

    await changeValue(labeledControl<HTMLInputElement>('Member runtime Provider'), 'rejected-provider')
    await click(button('Save plugin settings'))
    await flush()

    expect(scope.writes).toEqual([{ op: 'set', field: 'memberProvider', value: 'rejected-provider' }])
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('DSH did not accept the complete configuration')
    expect(document.body.textContent).not.toContain('Saved. Restart DSH')
    expect(button('Save plugin settings').disabled).toBe(false)
  })
})

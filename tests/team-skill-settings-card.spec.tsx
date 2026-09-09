// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TeamSkillSettingsCard,
  teamSkillSettingsEn,
  teamSkillSettingsZh,
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
  listTools: () => Promise.resolve(['team.read', 'team.write', 'team.review', 'shell.exec', 'agent_swarm_submit_task', 'agent_swarm_send_message'].map(name => ({ name, description: `Description of ${name}` }))),
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

  mutate(operations: Parameters<SettingsScope<TeamPluginSettings>['mutate']>[0]): Promise<void> {
    const user = { ...(this.snapshot.user as Record<string, unknown>) }
    for (const op of operations) {
      const field = op.path.join('.')
      if (op.op === 'set') { this.writes.push({ op: 'set', field, value: op.value }); user[field] = structuredClone(op.value) }
      else { this.writes.push({ op: 'unset', field }); delete user[field] }
    }
    if (this.acceptWrites) this.publish(user)
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

async function chooseTool(name: string, tier: string): Promise<void> {
  const control = document.querySelector<HTMLInputElement>(`[data-tool-name="${name}"] input[value="${tier}"]`)
  expect(control, `Missing ${name} ${tier} radio`).not.toBeNull()
  await click(control!)
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
  it('defaults communication intensity to Active and explains the wakeup allowance', async () => {
    const scope = new TestScope()
    await render(card(scope))
    await openSettings()

    const control = labeledControl<HTMLSelectElement>('Default communication intensity')
    expect(control.value).toBe('active')
    expect([...control.options].map(option => [option.value, option.text])).toEqual([
      ['quiet', 'Quiet'], ['balanced', 'Balanced'], ['active', 'Active'],
    ])
    expect(document.body.textContent).toContain('1 / 4 / 12 proactive peer wakeups per minute')
    expect(document.body.textContent).toContain('Excess messages queue quietly; no resend is needed.')
    expect(document.body.textContent).toContain('The first valid reply is exempt from this allowance.')
    expect(document.body.textContent).toContain('Captain-to-member and member-to-Captain communication and task submissions are exempt.')
    expect(document.body.textContent).toContain('The Captain assigns only the profession and responsibilities.')
    expect(document.body.textContent).toContain('Members choose their own name, personality and biography.')
    expect(document.body.textContent).toContain('Save and read back the four text fields before creating')
    expect(scope.writes).toEqual([])
  })

  it.each(['quiet', 'balanced', 'active'] as const)('saves and reads back %s communication intensity after remount', async intensity => {
    const scope = new TestScope({ communicationIntensity: intensity === 'quiet' ? 'balanced' : 'quiet' })
    await render(card(scope))
    await openSettings()
    await changeValue(labeledControl<HTMLSelectElement>('Default communication intensity'), intensity)
    await click(button('Save plugin settings'))
    await flush()

    expect(scope.writes).toEqual([{ op: 'set', field: 'communicationIntensity', value: intensity }])
    expect(scope.getSnapshot().user).toMatchObject({ communicationIntensity: intensity })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Saved. Restart DSH after saving')
    await act(async () => { mounted.pop()?.unmount() })
    document.body.replaceChildren()
    await render(card(scope))
    await openSettings()
    expect(labeledControl<HTMLSelectElement>('Default communication intensity').value).toBe(intensity)
    expect(scope.writes).toHaveLength(1)
  })

  it('keeps a communication draft when the Host does not read back its write', async () => {
    const scope = new TestScope({}, false)
    await render(card(scope))
    await openSettings()
    await changeValue(labeledControl<HTMLSelectElement>('Default communication intensity'), 'quiet')
    await click(button('Save plugin settings'))
    await flush()
    expect(scope.writes).toEqual([{ op: 'set', field: 'communicationIntensity', value: 'quiet' }])
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('DSH did not accept the complete configuration')
    expect(document.body.textContent).not.toContain('Saved. Restart DSH')
    expect(labeledControl<HTMLSelectElement>('Default communication intensity').value).toBe('quiet')
    expect(button('Save plugin settings').disabled).toBe(false)
  })

  it('renders Chinese communication choices and member-owned identity guidance', async () => {
    const props = { scope: new TestScope(), catalog, t: (key: keyof typeof teamSkillSettingsZh) => teamSkillSettingsZh[key] } as TeamSkillSettingsProps
    await render(<TeamSkillSettingsCard {...props} />)
    await openSettings()
    expect([...labeledControl<HTMLSelectElement>('默认通信强度').options].map(option => option.text)).toEqual(['安静', '适中', '积极'])
    expect(document.body.textContent).toContain('每名成员每分钟分别可主动唤醒同伴 1 / 4 / 12 次')
    expect(document.body.textContent).toContain('超额消息安静排队，无需重发')
    expect(document.body.textContent).toContain('首次合法回复不受该额度限制')
    expect(document.body.textContent).toContain('队长上下行通信和任务提交不受限')
    expect(document.body.textContent).toContain('队长只指定职业与职责')
    expect(document.body.textContent).toContain('成员自行决定姓名、性格和简介')
    expect(document.body.textContent).toContain('先保存并读回四项文字资料，最后按喜好生成')
  })

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
    for (const field of ['Allow', 'Ask Captain for approval', 'Deny']) {
      expect(document.body.textContent).toContain(field)
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
    await chooseTool('team.write', 'allow')
    await chooseTool('team.read', 'allow')
    await chooseTool('team.review', 'ask')
    await chooseTool('shell.exec', 'deny')

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

  it('retains unavailable tools, changes one mutually exclusive tier, and reads back saved choices', async () => {
    const scope = new TestScope({ toolPolicy: { allow: ['shell.exec'], ask: ['missing.tool'], deny: [] } })
    await render(card(scope))
    await openSettings()
    await selectTab('Tool permissions')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    expect(scope.writes).toEqual([])
    expect(document.querySelector('[data-tool-name="missing.tool"]')?.textContent).toContain('Currently unavailable')
    await chooseTool('shell.exec', 'ask')
    await chooseTool('team.read', 'deny')
    await chooseTool('team.read', 'inherit')
    await click(button('Save plugin settings'))
    await flush()
    expect(scope.writes).toEqual([{ op: 'set', field: 'toolPolicy', value: { allow: [], ask: ['missing.tool', 'shell.exec'], deny: [] } }])
    expect(document.querySelector<HTMLInputElement>('[data-tool-name="shell.exec"] input[value="ask"]')?.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('[data-tool-name="shell.exec"] input[value="allow"]')?.checked).toBe(false)
    for (const name of ['agent_swarm_submit_task', 'agent_swarm_send_message']) {
      for (const tier of ['deny', 'ask']) expect(document.querySelector<HTMLInputElement>(`[data-tool-name="${name}"] input[value="${tier}"]`)?.disabled).toBe(true)
    }
    await changeValue(document.querySelector<HTMLInputElement>('[aria-label="Search tools"]')!, 'missing')
    expect(document.querySelectorAll('[data-tool-name]')).toHaveLength(1)
  })

  it('shows catalog unavailability without deleting configured choices or writing on open', async () => {
    const scope = new TestScope({ toolPolicy: { deny: ['offline.tool'] } })
    await render(card(scope, { ...catalog, listTools: async () => { throw new Error('Session is cold') } }))
    await openSettings()
    await selectTab('Tool permissions')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('tool catalog is unavailable')
    expect(document.querySelector<HTMLInputElement>('[data-tool-name="offline.tool"] input[value="deny"]')?.checked).toBe(true)
    expect(scope.writes).toEqual([])
    expect(button('Save plugin settings').disabled).toBe(true)
  })

  it('refreshes the same Session, ignores the earlier response, and preserves a dirty policy', async () => {
    const scope = new TestScope()
    const requests: { session: string; resolve: (value: { name: string; description: string }[]) => void }[] = []
    const refreshingCatalog = { ...catalog, listTools: (session: string) => new Promise<{ name: string; description: string }[]>(resolve => { requests.push({ session, resolve }) }) }
    await render(card(scope, refreshingCatalog))
    await openSettings()
    await selectTab('Tool permissions')
    await act(async () => { requests[0]!.resolve([{ name: 'removed.tool', description: 'Before uninstall' }]) })
    await chooseTool('removed.tool', 'deny')
    await click(button('Refresh tools'))
    await click(button('Refresh tools'))
    expect(requests.map(request => request.session)).toEqual(['session-1', 'session-1', 'session-1'])
    await act(async () => { requests[2]!.resolve([{ name: 'installed.tool', description: 'After install' }]) })
    await act(async () => { requests[1]!.resolve([{ name: 'stale.tool', description: 'Earlier refresh' }]) })
    expect(document.querySelector('[data-tool-name="installed.tool"]')).not.toBeNull()
    expect(document.querySelector('[data-tool-name="stale.tool"]')).toBeNull()
    expect(document.querySelector('[data-tool-name="removed.tool"]')?.textContent).toContain('Currently unavailable')
    expect(document.querySelector<HTMLInputElement>('[data-tool-name="removed.tool"] input[value="deny"]')?.checked).toBe(true)
    expect(scope.writes).toEqual([])
    await changeValue(document.querySelector<HTMLInputElement>('[aria-label="Search tools"]')!, 'nothing-matches')
    expect(document.querySelectorAll('[data-tool-name]')).toHaveLength(0)
    expect(document.body.textContent).toContain('No matching tools.')
    await click(button('Save plugin settings'))
    await flush()
    expect(scope.writes).toEqual([{ op: 'set', field: 'toolPolicy', value: { allow: [], ask: [], deny: ['removed.tool'] } }])
  })

  it('ignores an old tool catalog after the current Session changes', async () => {
    let sessionId = 'old'
    let listener: (() => void) | undefined
    let resolveOld!: (value: { name: string; description: string }[]) => void
    const changingCatalog = { ...catalog, currentSessionId: () => sessionId,
      subscribe: (next: () => void) => { listener = next; return () => {} },
      listTools: (id: string) => id === 'old' ? new Promise<{ name: string; description: string }[]>(resolve => { resolveOld = resolve }) : Promise.resolve([{ name: 'current.tool', description: 'Current' }]),
    }
    await render(card(new TestScope(), changingCatalog))
    await openSettings()
    await selectTab('Tool permissions')
    await act(async () => { sessionId = 'new'; listener?.() })
    await flush()
    await act(async () => { resolveOld([{ name: 'stale.tool', description: 'Stale' }]) })
    expect(document.querySelector('[data-tool-name="current.tool"]')).not.toBeNull()
    expect(document.querySelector('[data-tool-name="stale.tool"]')).toBeNull()
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

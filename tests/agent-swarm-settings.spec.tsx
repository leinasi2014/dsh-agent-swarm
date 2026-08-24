// @vitest-environment jsdom
import { act, type ReactNode, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentSwarmSettingsCard, type AgentSwarmSettingsCardProps } from '../src/client/AgentSwarmSettingsCard.js'
import {
  AgentSwarmSettingsController,
  type AgentSwarmSettingsDocument,
  type AgentSwarmSettingsFace,
  type AgentSwarmSettingsState,
} from '../src/client/agent-swarm-settings-controller.js'
import {
  agentSwarmSettingsEn,
  agentSwarmSettingsZh,
  type AgentSwarmSettingsLocaleKey,
} from '../src/client/agent-swarm-settings-locales.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted: Root[] = []

class FakeSettingsScope implements SettingsScope<AgentSwarmSettingsDocument> {
  readonly writes: string[] = []
  private readonly listeners = new Set<() => void>()
  private readonly base: AgentSwarmSettingsDocument = {
    memorySemanticEnabled: false,
    memoryQueryMaxCandidates: 32,
    memoryQueryTimeoutMs: 15_000,
    memberProvider: 'spawn',
    memberDenyTools: [],
    memberSkills: [],
  }
  private user: AgentSwarmSettingsDocument = {}
  private revision = 1

  getSnapshot = (): SettingsScopeSnapshot<AgentSwarmSettingsDocument> => ({
    status: 'ready',
    value: { ...this.base, ...this.user },
    base: this.base,
    user: this.user,
    revision: this.revision,
    writable: true,
    mode: 'host',
  })

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set = async (field: string, value: unknown): Promise<void> => {
    this.writes.push(`set:${field}`)
    const next = { ...this.user, [field]: value }
    if (!validSemantic({ ...this.base, ...next })) return
    this.user = next
    this.revision += 1
    this.emit()
  }

  unset = async (field: string): Promise<void> => {
    this.writes.push(`unset:${field}`)
    const next = { ...this.user }
    delete (next as Record<string, unknown>)[field]
    if (!validSemantic({ ...this.base, ...next })) return
    this.user = next
    this.revision += 1
    this.emit()
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

function validSemantic(value: AgentSwarmSettingsDocument): boolean {
  if (value.memorySemanticEnabled !== true) return true
  return (value.memorySemanticProvider?.trim().length ?? 0) > 0
    && (value.memorySemanticModel?.trim().length ?? 0) > 0
}

function t(dictionary: Record<AgentSwarmSettingsLocaleKey, string>) {
  return (key: AgentSwarmSettingsLocaleKey): string => dictionary[key]
}

function propsOf(face: AgentSwarmSettingsFace, dictionary = agentSwarmSettingsEn): AgentSwarmSettingsCardProps {
  const useAgentSwarmSettings = <T,>(selector: (value: AgentSwarmSettingsState) => T): T => useSyncExternalStore(
    face.hooks.agentSwarmSettings.subscribe,
    () => selector(face.hooks.agentSwarmSettings.getSnapshot()),
  )
  return {
    t: t(dictionary),
    useAgentSwarmSettings,
    edit: face.edit,
    resetField: face.resetField,
    save: face.save,
    discard: face.discard,
  } as unknown as AgentSwarmSettingsCardProps
}

async function render(node: ReactNode): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push(root)
  await act(async () => { root.render(node) })
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label)
  if (match === undefined) throw new Error(`button not found: ${label}`)
  return match
}

function labelledButton(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (match === null) throw new Error(`labelled button not found: ${label}`)
  return match
}

async function waitForSaved(face: AgentSwarmSettingsFace): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!face.hooks.agentSwarmSettings.getSnapshot().saving) return
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error('settings save did not settle')
}

afterEach(async () => {
  while (mounted.length > 0) {
    const root = mounted.pop()
    if (root !== undefined) await act(async () => { root.unmount() })
  }
  document.body.replaceChildren()
})

describe('Agent Swarm official Plugins settings contribution', () => {
  it('persists semantic routing before enabling it and preserves array fields', async () => {
    const scope = new FakeSettingsScope()
    const face = new AgentSwarmSettingsController(scope).inject()
    face.edit('memorySemanticProvider', 'official-llm')
    face.edit('memorySemanticModel', 'reasoning-model')
    face.edit('memorySemanticEnabled', 'true')
    face.edit('memberDenyTools', 'shell, browser, shell')
    face.edit('memberSkills', 'review-code\nverify-ui')
    face.save()
    await waitForSaved(face)

    const snapshot = scope.getSnapshot()
    expect(scope.writes.indexOf('set:memorySemanticProvider')).toBeLessThan(scope.writes.indexOf('set:memorySemanticEnabled'))
    expect(scope.writes.indexOf('set:memorySemanticModel')).toBeLessThan(scope.writes.indexOf('set:memorySemanticEnabled'))
    expect(snapshot.value).toMatchObject({
      memorySemanticEnabled: true,
      memorySemanticProvider: 'official-llm',
      memorySemanticModel: 'reasoning-model',
      memberDenyTools: ['shell', 'browser'],
      memberSkills: ['review-code', 'verify-ui'],
    })
    expect(face.hooks.agentSwarmSettings.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('blocks a semantic enable without both DSH routing fields', () => {
    const face = new AgentSwarmSettingsController(new FakeSettingsScope()).inject()
    face.edit('memorySemanticEnabled', 'true')
    const state = face.hooks.agentSwarmSettings.getSnapshot()
    expect(state.invalid).toBe(true)
    expect(state.fields.memorySemanticProvider.invalid).toBe(true)
    expect(state.fields.memorySemanticModel.invalid).toBe(true)
  })

  it('renders a Chinese card that edits through the durable settings scope', async () => {
    const scope = new FakeSettingsScope()
    const face = new AgentSwarmSettingsController(scope).inject()
    await render(<AgentSwarmSettingsCard {...propsOf(face, agentSwarmSettingsZh)} />)
    expect(document.body.textContent).toContain('配置团队记忆检索')
    await act(async () => { labelledButton('展开 Agent Swarm 设置').click() })
    expect(document.body.textContent).toContain('团队记忆检索')
    expect(document.body.textContent).toContain('未来成员默认值')

    const provider = document.querySelector<HTMLInputElement>('#swarm-settings-memberProvider')
    expect(provider?.value).toBe('spawn')
    await act(async () => {
      if (provider === null) throw new Error('member Provider field missing')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(provider, 'in-process')
      provider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('保存').disabled).toBe(false)
    await act(async () => {
      button('保存').click()
      await waitForSaved(face)
    })
    expect(scope.getSnapshot().value?.memberProvider).toBe('in-process')
  })
})

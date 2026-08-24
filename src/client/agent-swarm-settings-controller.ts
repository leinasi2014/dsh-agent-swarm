import type {
  SettingsScope,
  SettingsScopeSnapshot,
  SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

export const AGENT_SWARM_CLIENT_SETTINGS_NAMESPACE = 'agent-swarm'

export type AgentSwarmSettingsField =
  | 'memorySemanticEnabled'
  | 'memorySemanticProvider'
  | 'memorySemanticModel'
  | 'memoryQueryMaxCandidates'
  | 'memoryQueryTimeoutMs'
  | 'memberProvider'
  | 'memberLlmProvider'
  | 'memberModel'
  | 'memberDenyTools'
  | 'memberSkills'

export interface AgentSwarmSettingsDocument {
  memorySemanticEnabled?: boolean
  memorySemanticProvider?: string
  memorySemanticModel?: string
  memoryQueryMaxCandidates?: number
  memoryQueryTimeoutMs?: number
  memberProvider?: string
  memberLlmProvider?: string
  memberModel?: string
  memberDenyTools?: string[]
  memberSkills?: string[]
}

export interface AgentSwarmSettingsFieldState {
  readonly text: string
  readonly overridden: boolean
  readonly invalid: boolean
}

export interface AgentSwarmSettingsState {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly fields: Readonly<Record<AgentSwarmSettingsField, AgentSwarmSettingsFieldState>>
}

export interface AgentSwarmSettingsFace {
  readonly hooks: {
    readonly agentSwarmSettings: SnapshotStore<AgentSwarmSettingsState>
  }
  readonly edit: (field: AgentSwarmSettingsField, text: string) => void
  readonly resetField: (field: AgentSwarmSettingsField) => void
  readonly save: () => void
  readonly discard: () => void
}

type ParsedWrite = { readonly kind: 'set'; readonly value: unknown } | { readonly kind: 'clear' }

interface FieldSpec {
  readonly field: AgentSwarmSettingsField
  readonly format: (value: unknown) => string
  readonly parse: (text: string) => ParsedWrite | undefined
  readonly fallback: unknown
}

interface Draft {
  readonly text: string
  readonly clear: boolean
}

interface PlannedWrite {
  readonly field: AgentSwarmSettingsField
  readonly write: ParsedWrite | undefined
}

const textSpec = (field: AgentSwarmSettingsField, fallback?: string): FieldSpec => ({
  field,
  fallback,
  format: value => typeof value === 'string' ? value : '',
  parse: (text) => {
    const value = text.trim()
    return value === '' ? { kind: 'clear' } : { kind: 'set', value }
  },
})

const numberSpec = (field: AgentSwarmSettingsField, min: number, max: number, fallback: number): FieldSpec => ({
  field,
  fallback,
  format: value => typeof value === 'number' ? String(value) : '',
  parse: (text) => {
    const value = text.trim()
    if (value === '') return { kind: 'clear' }
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
      ? { kind: 'set', value: parsed }
      : undefined
  },
})

const listSpec = (field: AgentSwarmSettingsField): FieldSpec => ({
  field,
  fallback: [],
  format: value => Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value.join(', ')
    : '',
  parse: (text) => {
    const values = [...new Set(text.split(/[\n,，]+/u).map(value => value.trim()).filter(Boolean))]
    return values.length === 0 ? { kind: 'clear' } : { kind: 'set', value: values }
  },
})

const specs: readonly FieldSpec[] = [
  {
    field: 'memorySemanticEnabled',
    fallback: false,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
  },
  textSpec('memorySemanticProvider'),
  textSpec('memorySemanticModel'),
  numberSpec('memoryQueryMaxCandidates', 1, 128, 32),
  numberSpec('memoryQueryTimeoutMs', 1_000, 120_000, 15_000),
  textSpec('memberProvider', 'spawn'),
  textSpec('memberLlmProvider'),
  textSpec('memberModel'),
  listSpec('memberDenyTools'),
  listSpec('memberSkills'),
]

const specByField = new Map(specs.map(spec => [spec.field, spec]))

/** Staged editor for the Host-owned `agent-swarm` settings section. */
export class AgentSwarmSettingsController {
  private readonly drafts = new Map<AgentSwarmSettingsField, Draft>()
  private readonly listeners = new Set<() => void>()
  private readonly store: SnapshotStore<AgentSwarmSettingsState>
  private saving = false
  private failed = false

  constructor(private readonly scope: SettingsScope<AgentSwarmSettingsDocument>) {
    this.store = createLocalSnapshotStore(this.project())
    this.listeners.add(() => { this.store.set(this.project()) })
    scope.subscribe(() => { this.publish() })
  }

  inject(): AgentSwarmSettingsFace {
    return {
      hooks: { agentSwarmSettings: this.store },
      edit: (field, text) => { this.edit(field, text) },
      resetField: field => { this.resetField(field) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private edit(field: AgentSwarmSettingsField, text: string): void {
    this.expectSpec(field)
    this.drafts.set(field, { text, clear: false })
    this.failed = false
    this.publish()
  }

  private resetField(field: AgentSwarmSettingsField): void {
    const spec = this.expectSpec(field)
    this.drafts.set(field, { text: spec.format(this.baseValue(spec)), clear: true })
    this.failed = false
    this.publish()
  }

  private discard(): void {
    this.drafts.clear()
    this.failed = false
    this.publish()
  }

  private async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || this.project().invalid) return
    this.saving = true
    this.failed = false
    this.publish()

    const semanticTarget = this.targetValue('memorySemanticEnabled') === true
    const ordered = plan.toSorted((left, right) => writeOrder(left.field, semanticTarget) - writeOrder(right.field, semanticTarget))
    for (const item of ordered) {
      if (item.write === undefined) continue
      if (item.write.kind === 'clear') await this.scope.unset(item.field)
      else await this.scope.set(item.field, item.write.value)
    }

    const landed = plan.every(item => item.write !== undefined && this.matchesUserLayer(item.field, item.write))
    if (landed) this.drafts.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private project(): AgentSwarmSettingsState {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    const semanticEnabled = this.targetValue('memorySemanticEnabled') === true
    const missingProvider = semanticEnabled && String(this.targetValue('memorySemanticProvider') ?? '').trim() === ''
    const missingModel = semanticEnabled && String(this.targetValue('memorySemanticModel') ?? '').trim() === ''
    const fields = Object.fromEntries(specs.map((spec) => {
      const draft = this.drafts.get(spec.field)
      const write = draft === undefined ? undefined : draft.clear ? { kind: 'clear' as const } : spec.parse(draft.text)
      const crossInvalid = spec.field === 'memorySemanticProvider' ? missingProvider
        : spec.field === 'memorySemanticModel' ? missingModel
          : false
      return [spec.field, {
        text: draft?.text ?? spec.format(this.sectionValue(spec.field)),
        overridden: write?.kind === 'set' || (write === undefined && draft === undefined && this.hasUserField(spec.field)),
        invalid: (draft !== undefined && write === undefined) || crossInvalid,
      }]
    })) as unknown as Record<AgentSwarmSettingsField, AgentSwarmSettingsFieldState>
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.write === undefined) || missingProvider || missingModel,
      saving: this.saving,
      failed: this.failed,
      fields,
    }
  }

  private plan(): PlannedWrite[] {
    const result: PlannedWrite[] = []
    for (const [field, draft] of this.drafts) {
      const spec = this.expectSpec(field)
      const write = draft.clear ? { kind: 'clear' as const } : spec.parse(draft.text)
      if (write?.kind === 'clear' && !this.hasUserField(field)) continue
      if (write?.kind === 'set' && valuesEqual(write.value, this.sectionValue(field))) continue
      result.push({ field, write })
    }
    return result
  }

  private targetValue(field: AgentSwarmSettingsField): unknown {
    const spec = this.expectSpec(field)
    const draft = this.drafts.get(field)
    if (draft === undefined) return this.sectionValue(field) ?? spec.fallback
    const write = draft.clear ? { kind: 'clear' as const } : spec.parse(draft.text)
    if (write?.kind === 'set') return write.value
    if (write?.kind === 'clear') return this.baseValue(spec)
    return undefined
  }

  private sectionValue(field: AgentSwarmSettingsField): unknown {
    return (this.snapshot().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(spec: FieldSpec): unknown {
    return (this.snapshot().base as Record<string, unknown> | undefined)?.[spec.field] ?? spec.fallback
  }

  private hasUserField(field: AgentSwarmSettingsField): boolean {
    const user = this.snapshot().user as Record<string, unknown> | undefined
    return user !== undefined && Object.hasOwn(user, field)
  }

  private matchesUserLayer(field: AgentSwarmSettingsField, write: ParsedWrite): boolean {
    const user = this.snapshot().user as Record<string, unknown> | undefined
    if (write.kind === 'clear') return user === undefined || !Object.hasOwn(user, field)
    return user !== undefined && Object.hasOwn(user, field) && valuesEqual(user[field], write.value)
  }

  private snapshot(): SettingsScopeSnapshot<AgentSwarmSettingsDocument> {
    return this.scope.getSnapshot()
  }

  private expectSpec(field: AgentSwarmSettingsField): FieldSpec {
    const spec = specByField.get(field)
    if (spec === undefined) throw new Error(`Agent Swarm settings has no field ${field}`)
    return spec
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

function createLocalSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      snapshot = next
      publish()
    },
    update: (mutator) => {
      const next = structuredClone(snapshot)
      mutator(next)
      snapshot = next
      publish()
    },
  }
}

function writeOrder(field: AgentSwarmSettingsField, semanticTarget: boolean): number {
  if (!semanticTarget && field === 'memorySemanticEnabled') return -1
  if (semanticTarget && field === 'memorySemanticEnabled') return 1
  return 0
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  return left === right
}

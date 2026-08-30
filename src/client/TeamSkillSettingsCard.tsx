import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** The Host configuration namespace owned by this plugin. */
export const TEAM_SKILL_SETTINGS_NS = 'agent-swarm' as const

/** One server-reported Skill; this mirrors the official `skill.list` projection. */
export interface TeamSkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

/** One selectable route from the official DSH model directory. */
export interface TeamModelRoute {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
}

/**
 * Client-only catalog access. The Host remains authoritative: the card reads
 * real entries on demand and never asks the user to type a Skill or route id.
 */
export interface TeamSettingsCatalog {
  currentSessionId(): string | undefined
  subscribe(listener: () => void): () => void
  listSkills(sessionId: string): Promise<readonly TeamSkillCatalogEntry[]>
  listModelRoutes(): Promise<readonly TeamModelRoute[]>
}

/** The safe, user-facing subset of the plugin's actual Host configuration. */
export interface TeamPluginSettings {
  captainLlmProvider?: string
  captainModel?: string
  memberLlmProvider?: string
  memberModel?: string
  memberMaxDepth?: number
  maxMembers?: number
  maxTasks?: number
  maxPendingMessagesPerMember?: number
  orchestrationMode?: 'adaptive' | 'workflow'
  workflowBridge?: boolean
  jobsBridge?: boolean
  executionRoots?: boolean
  allowedSkills?: string[]
}

export const teamSkillSettingsEn = {
  title: 'Agent Teams',
  description: 'Defaults, capabilities, and execution limits for newly created Teams.',
  open: 'Show settings', close: 'Hide settings',
  readOnly: 'This deployment stores plugin settings read-only.',
  overview: 'Team defaults', skills: 'Skills', execution: 'Execution limits',
  captainRoute: 'Captain model route', memberRoute: 'Member model route',
  inheritRoute: 'Inherit the model selected when the Team is created',
  routesLoading: 'Loading configured DSH model routes…',
  routesUnavailable: 'No configured model route is available yet. Add one in DSH Model settings.',
  maxMembers: 'Maximum members per Team', maxTasks: 'Maximum tasks per Team',
  memberDepth: 'Member subagent depth', pendingMessages: 'Pending messages per member',
  skillsMode: 'Skill policy for newly created Teams',
  inheritSkills: 'Do not restrict Skills', restrictSkills: 'Restrict to selected Skills',
  skillsHint: 'The list is read from the active DSH session. Existing Teams keep their immutable policy.',
  selectWorkspace: 'Open a workspace session to load its real Skill catalog.',
  skillsLoading: 'Loading Skills from DSH…', skillsUnavailable: 'The DSH Skill catalog could not be loaded.',
  noModelSkills: 'This session exposes no model-invocable Skills.', userOnly: 'User-only',
  noSkillsSelected: 'Choose at least one Skill, or use the unrestricted policy.',
  orchestrationMode: 'Orchestration mode', adaptive: 'Adaptive scheduling', workflow: 'Workflow bridge',
  workflowBridge: 'Enable workflow bridge', jobsBridge: 'Expose Team jobs to DSH',
  executionRoots: 'Create isolated execution roots',
  executionHint: 'These settings affect Teams created after saving. They do not mutate existing Teams.',
  invalidNumber: 'Enter a whole number greater than zero.',
  save: 'Save Team settings', saving: 'Saving…', saved: 'Saved. New Teams will use these defaults.',
  saveFailed: 'DSH did not accept these values. Your draft was kept.',
} as const

export const teamSkillSettingsZh: Record<keyof typeof teamSkillSettingsEn, string> = {
  title: '智能体团队',
  description: '为新建团队配置默认模型、可用 Skills 与执行限制。',
  open: '展开设置', close: '收起设置',
  readOnly: '当前部署的插件设置为只读。',
  overview: '团队默认值', skills: 'Skills', execution: '执行与限制',
  captainRoute: '队长模型路由', memberRoute: '队员模型路由',
  inheritRoute: '继承创建团队时主会话选择的模型',
  routesLoading: '正在读取 DSH 已配置的模型路由…',
  routesUnavailable: '尚无可用模型路由；请先在 DSH 的“模型”设置中配置。',
  maxMembers: '每个团队最多成员数', maxTasks: '每个团队最多任务数',
  memberDepth: '队员子智能体层级', pendingMessages: '每名队员待处理消息上限',
  skillsMode: '新建团队的 Skill 策略',
  inheritSkills: '不限制 Skills', restrictSkills: '仅允许已选择的 Skills',
  skillsHint: '列表从当前 DSH 会话实时读取；已创建团队继续保留其不可变策略。',
  selectWorkspace: '请先打开一个工作区会话，以读取它真实可用的 Skill 列表。',
  skillsLoading: '正在从 DSH 读取 Skills…', skillsUnavailable: '无法读取 DSH Skill 列表。',
  noModelSkills: '当前会话没有可供智能体调用的 Skills。', userOnly: '仅用户可用',
  noSkillsSelected: '至少选择一个 Skill，或改为“不限制 Skills”。',
  orchestrationMode: '编排模式', adaptive: '自适应调度', workflow: '工作流桥接',
  workflowBridge: '启用工作流桥接', jobsBridge: '将团队任务展示到 DSH Jobs',
  executionRoots: '为任务创建隔离执行目录',
  executionHint: '这些设置只影响保存后新建的团队，不会悄悄改变现有团队。',
  invalidNumber: '请输入大于 0 的整数。',
  save: '保存团队设置', saving: '保存中…', saved: '已保存；之后新建的团队会使用这些默认值。',
  saveFailed: 'DSH 没有接受这些值，已保留你的草稿。',
}

export type TeamSkillSettingsKey = keyof typeof teamSkillSettingsEn

export interface TeamSkillSettingsFace {
  readonly scope: SettingsScope<TeamPluginSettings>
  readonly catalog: TeamSettingsCatalog
}

export type TeamSkillSettingsProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof TEAM_SKILL_SETTINGS_NS>
  & InjectFace<TeamSkillSettingsFace>

type Tab = 'overview' | 'skills' | 'execution'
type LoadState<T> = { readonly state: 'idle' | 'loading' } | { readonly state: 'ready'; readonly value: readonly T[] } | { readonly state: 'failed' }

interface Draft {
  readonly captainRoute: string
  readonly memberRoute: string
  readonly maxMembers: string
  readonly maxTasks: string
  readonly memberMaxDepth: string
  readonly maxPendingMessages: string
  readonly orchestrationMode: 'adaptive' | 'workflow'
  readonly workflowBridge: boolean
  readonly jobsBridge: boolean
  readonly executionRoots: boolean
  readonly restrictSkills: boolean
  readonly allowedSkills: readonly string[]
}

const layout: Record<string, CSSProperties> = {
  card: { listStyle: 'none', border: '1px solid var(--dsh-color-border, #555)', borderRadius: 16, marginBottom: 16, overflow: 'hidden' },
  header: { width: '100%', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', padding: '18px 20px', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' },
  title: { display: 'block', fontWeight: 700, fontSize: 18 }, description: { display: 'block', marginTop: 4, opacity: 0.72 },
  body: { padding: '0 20px 20px', borderTop: '1px solid var(--dsh-color-border, #555)' },
  tabs: { display: 'flex', gap: 8, borderBottom: '1px solid var(--dsh-color-border, #555)', marginBottom: 20 },
  tab: { padding: '14px 10px', border: 0, borderBottomWidth: 2, borderBottomStyle: 'solid', borderBottomColor: 'transparent', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  tabActive: { borderBottomColor: 'var(--dsh-color-primary, #7187ff)', fontWeight: 700 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 },
  field: { display: 'grid', gap: 6 }, input: { width: '100%', boxSizing: 'border-box', minHeight: 36 },
  hint: { margin: '10px 0', opacity: 0.72, fontSize: 13 },
  skillList: { display: 'grid', gap: 8, maxHeight: 360, overflowY: 'auto', paddingRight: 4 },
  skill: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, padding: 10, border: '1px solid var(--dsh-color-border, #555)', borderRadius: 10 },
  footer: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--dsh-color-border, #555)' },
}

/** Full, staged settings card for the Team plugin. */
export function TeamSkillSettingsCard(props: TeamSkillSettingsProps) {
  const subscribe = useCallback((listener: () => void) => props.scope.subscribe(listener), [props.scope])
  const getSnapshot = useCallback(() => props.scope.getSnapshot(), [props.scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const subscribeCatalog = useCallback((listener: () => void) => props.catalog.subscribe(listener), [props.catalog])
  const getCurrentSession = useCallback(() => props.catalog.currentSessionId(), [props.catalog])
  const sessionId = useSyncExternalStore(subscribeCatalog, getCurrentSession, getCurrentSession)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const [draft, setDraft] = useState<Draft>(() => fromSettings(undefined))
  const [dirty, setDirty] = useState<ReadonlySet<keyof Draft>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failed, setFailed] = useState(false)
  const [skills, setSkills] = useState<LoadState<TeamSkillCatalogEntry>>({ state: 'idle' })
  const [routes, setRoutes] = useState<LoadState<TeamModelRoute>>({ state: 'idle' })

  useEffect(() => {
    if (snapshot.status === 'ready' && dirty.size === 0) setDraft(fromSettings(snapshot.value))
  }, [snapshot.status, snapshot.revision, snapshot.value, dirty.size])

  useEffect(() => {
    if (!open || routes.state !== 'idle') return
    let cancelled = false
    setRoutes({ state: 'loading' })
    void props.catalog.listModelRoutes().then(value => { if (!cancelled) setRoutes({ state: 'ready', value }) }, () => { if (!cancelled) setRoutes({ state: 'failed' }) })
    return () => { cancelled = true }
  }, [open, props.catalog])

  useEffect(() => {
    if (!open || tab !== 'skills') return
    if (sessionId === undefined) { setSkills({ state: 'idle' }); return }
    let cancelled = false
    setSkills({ state: 'loading' })
    void props.catalog.listSkills(sessionId).then(value => { if (!cancelled) setSkills({ state: 'ready', value }) }, () => { if (!cancelled) setSkills({ state: 'failed' }) })
    return () => { cancelled = true }
  }, [open, props.catalog, sessionId, tab])

  const editable = snapshot.status === 'ready' && snapshot.writable && !saving
  const invalidNumbers = !positiveInteger(draft.maxMembers) || !positiveInteger(draft.maxTasks) || !positiveInteger(draft.memberMaxDepth) || !positiveInteger(draft.maxPendingMessages)
  const invalidSkills = draft.restrictSkills && draft.allowedSkills.length === 0
  const routesByValue = useMemo(() => new Set(routes.state === 'ready' ? routes.value.map(routeValue) : []), [routes])
  const routeInvalid = (dirty.has('captainRoute') && draft.captainRoute !== '' && routes.state === 'ready' && !routesByValue.has(draft.captainRoute))
    || (dirty.has('memberRoute') && draft.memberRoute !== '' && routes.state === 'ready' && !routesByValue.has(draft.memberRoute))
  const canSave = editable && dirty.size > 0 && !invalidNumbers && !invalidSkills && !routeInvalid
  const edit = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft(current => ({ ...current, [field]: value }))
    setDirty(current => new Set(current).add(field))
    setSaved(false); setFailed(false)
  }
  const toggleSkill = (name: string, checked: boolean) => {
    const next = checked ? [...new Set([...draft.allowedSkills, name])].toSorted() : draft.allowedSkills.filter(skill => skill !== name)
    edit('allowedSkills', next)
  }
  const save = () => {
    if (!canSave) return
    void (async () => {
      setSaving(true); setFailed(false)
      try {
        for (const field of dirty) {
          // Both the policy-mode radio and a checkbox edit describe one
          // durable value. Publish it once, never briefly write an empty
          // allow-list before the selected entries follow.
          if (field === 'restrictSkills' && dirty.has('allowedSkills')) continue
          await persistField(props.scope, field, draft)
        }
        setDirty(new Set()); setSaved(true)
      } catch { setFailed(true) } finally { setSaving(false) }
    })()
  }

  if (snapshot.status === 'unavailable') return null
  return <li style={layout.card}>
    <button type="button" style={layout.header} aria-expanded={open} aria-label={`${props.t(open ? 'close' : 'open')}: ${props.t('title')}`} onClick={() => { setOpen(value => !value) }}>
      <span style={{ flex: 1 }}><span style={layout.title}>{props.t('title')}</span><span style={layout.description}>{props.t('description')}</span></span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>
    {open ? <div style={layout.body}>
      {!editable ? <p role="status" style={layout.hint}>{props.t('readOnly')}</p> : null}
      <nav aria-label={props.t('title')} style={layout.tabs}>
        <TabButton current={tab} value="overview" onSelect={setTab}>{props.t('overview')}</TabButton>
        <TabButton current={tab} value="skills" onSelect={setTab}>{props.t('skills')}</TabButton>
        <TabButton current={tab} value="execution" onSelect={setTab}>{props.t('execution')}</TabButton>
      </nav>
      {tab === 'overview' ? <Overview draft={draft} routes={routes} editable={editable} t={props.t} onEdit={edit} /> : null}
      {tab === 'skills' ? <Skills draft={draft} skills={skills} sessionId={sessionId} editable={editable} t={props.t} onEdit={edit} onToggle={toggleSkill} /> : null}
      {tab === 'execution' ? <Execution draft={draft} editable={editable} t={props.t} onEdit={edit} /> : null}
      <p role={invalidNumbers || invalidSkills || routeInvalid ? 'alert' : undefined} style={{ ...layout.hint, color: invalidNumbers || invalidSkills || routeInvalid ? 'var(--dsh-color-danger, #d44)' : undefined }}>
        {invalidNumbers ? props.t('invalidNumber') : invalidSkills ? props.t('noSkillsSelected') : routeInvalid ? props.t('routesUnavailable') : props.t('executionHint')}
      </p>
      <div style={layout.footer}>{saved ? <span role="status">{props.t('saved')}</span> : null}{failed ? <span role="alert">{props.t('saveFailed')}</span> : null}<button type="button" disabled={!canSave} onClick={save}>{props.t(saving ? 'saving' : 'save')}</button></div>
    </div> : null}
  </li>
}

function TabButton(props: { readonly current: Tab; readonly value: Tab; readonly onSelect: (tab: Tab) => void; readonly children: string }) {
  return <button type="button" role="tab" aria-selected={props.current === props.value} style={{ ...layout.tab, ...(props.current === props.value ? layout.tabActive : {}) }} onClick={() => { props.onSelect(props.value) }}>{props.children}</button>
}

function Overview(props: { readonly draft: Draft; readonly routes: LoadState<TeamModelRoute>; readonly editable: boolean; readonly t: TeamSkillSettingsProps['t']; readonly onEdit: <K extends keyof Draft>(field: K, value: Draft[K]) => void }) {
  const selectRoute = (field: 'captainRoute' | 'memberRoute') => <select aria-label={props.t(field === 'captainRoute' ? 'captainRoute' : 'memberRoute')} style={layout.input} value={props.draft[field]} disabled={!props.editable || props.routes.state !== 'ready'} onChange={event => { props.onEdit(field, event.target.value) }}><option value="">{props.t('inheritRoute')}</option>{props.routes.state === 'ready' ? props.routes.value.map(route => <option key={routeValue(route)} value={routeValue(route)}>{route.providerName} · {route.modelName}</option>) : null}</select>
  return <section><div style={layout.grid}>
    <label style={layout.field}>{props.t('captainRoute')}{selectRoute('captainRoute')}</label>
    <label style={layout.field}>{props.t('memberRoute')}{selectRoute('memberRoute')}</label>
    <NumberInput label={props.t('maxMembers')} value={props.draft.maxMembers} disabled={!props.editable} onChange={value => { props.onEdit('maxMembers', value) }} />
    <NumberInput label={props.t('maxTasks')} value={props.draft.maxTasks} disabled={!props.editable} onChange={value => { props.onEdit('maxTasks', value) }} />
    <NumberInput label={props.t('memberDepth')} value={props.draft.memberMaxDepth} disabled={!props.editable} onChange={value => { props.onEdit('memberMaxDepth', value) }} />
    <NumberInput label={props.t('pendingMessages')} value={props.draft.maxPendingMessages} disabled={!props.editable} onChange={value => { props.onEdit('maxPendingMessages', value) }} />
  </div>{props.routes.state === 'loading' ? <p style={layout.hint}>{props.t('routesLoading')}</p> : null}{props.routes.state === 'failed' || (props.routes.state === 'ready' && props.routes.value.length === 0) ? <p role="status" style={layout.hint}>{props.t('routesUnavailable')}</p> : null}</section>
}

function Skills(props: { readonly draft: Draft; readonly skills: LoadState<TeamSkillCatalogEntry>; readonly sessionId: string | undefined; readonly editable: boolean; readonly t: TeamSkillSettingsProps['t']; readonly onEdit: <K extends keyof Draft>(field: K, value: Draft[K]) => void; readonly onToggle: (name: string, checked: boolean) => void }) {
  const modelSkills = props.skills.state === 'ready' ? props.skills.value.filter(skill => skill.modelInvocable) : []
  return <section><fieldset disabled={!props.editable} style={{ border: 0, padding: 0, margin: 0 }}><legend style={{ fontWeight: 700 }}>{props.t('skillsMode')}</legend><label><input type="radio" name="agent-swarm-skills-mode" checked={!props.draft.restrictSkills} onChange={() => { props.onEdit('restrictSkills', false) }} /> {props.t('inheritSkills')}</label><label style={{ marginLeft: 16 }}><input type="radio" name="agent-swarm-skills-mode" checked={props.draft.restrictSkills} onChange={() => { props.onEdit('restrictSkills', true) }} /> {props.t('restrictSkills')}</label></fieldset>
    <p style={layout.hint}>{props.t('skillsHint')}</p>{props.sessionId === undefined ? <p role="status">{props.t('selectWorkspace')}</p> : null}{props.skills.state === 'loading' ? <p>{props.t('skillsLoading')}</p> : null}{props.skills.state === 'failed' ? <p role="alert">{props.t('skillsUnavailable')}</p> : null}{props.skills.state === 'ready' && modelSkills.length === 0 ? <p role="status">{props.t('noModelSkills')}</p> : null}
    {props.skills.state === 'ready' ? <div style={layout.skillList}>{props.skills.value.map(skill => <label key={skill.name} style={{ ...layout.skill, opacity: skill.modelInvocable ? 1 : 0.58 }}><input type="checkbox" aria-label={skill.name} checked={props.draft.allowedSkills.includes(skill.name)} disabled={!props.editable || !props.draft.restrictSkills || !skill.modelInvocable} onChange={event => { props.onToggle(skill.name, event.target.checked) }} /><span><strong>{skill.name}</strong>{!skill.modelInvocable ? <em style={{ marginLeft: 8 }}>({props.t('userOnly')})</em> : null}<br /><span style={layout.hint}>{skill.description}{skill.whenToUse === undefined ? '' : ` · ${skill.whenToUse}`}</span></span></label>)}</div> : null}
  </section>
}

function Execution(props: { readonly draft: Draft; readonly editable: boolean; readonly t: TeamSkillSettingsProps['t']; readonly onEdit: <K extends keyof Draft>(field: K, value: Draft[K]) => void }) {
  return <section style={layout.grid}><label style={layout.field}>{props.t('orchestrationMode')}<select aria-label={props.t('orchestrationMode')} style={layout.input} value={props.draft.orchestrationMode} disabled={!props.editable} onChange={event => { const mode = event.target.value as Draft['orchestrationMode']; props.onEdit('orchestrationMode', mode); if (mode === 'workflow') props.onEdit('workflowBridge', true) }}><option value="adaptive">{props.t('adaptive')}</option><option value="workflow">{props.t('workflow')}</option></select></label><Toggle label={props.t('workflowBridge')} checked={props.draft.workflowBridge} disabled={!props.editable || props.draft.orchestrationMode === 'workflow'} onChange={value => { props.onEdit('workflowBridge', value) }} /><Toggle label={props.t('jobsBridge')} checked={props.draft.jobsBridge} disabled={!props.editable} onChange={value => { props.onEdit('jobsBridge', value) }} /><Toggle label={props.t('executionRoots')} checked={props.draft.executionRoots} disabled={!props.editable} onChange={value => { props.onEdit('executionRoots', value) }} /></section>
}

function NumberInput(props: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly onChange: (value: string) => void }) { return <label style={layout.field}>{props.label}<input type="number" min="1" step="1" style={layout.input} value={props.value} disabled={props.disabled} onChange={event => { props.onChange(event.target.value) }} /></label> }
function Toggle(props: { readonly label: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (value: boolean) => void }) { return <label><input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={event => { props.onChange(event.target.checked) }} /> {props.label}</label> }

function fromSettings(settings: TeamPluginSettings | undefined): Draft { return { captainRoute: routeKey(settings?.captainLlmProvider, settings?.captainModel), memberRoute: routeKey(settings?.memberLlmProvider, settings?.memberModel), maxMembers: String(settings?.maxMembers ?? 5), maxTasks: String(settings?.maxTasks ?? 24), memberMaxDepth: String(settings?.memberMaxDepth ?? 1), maxPendingMessages: String(settings?.maxPendingMessagesPerMember ?? 16), orchestrationMode: settings?.orchestrationMode ?? 'adaptive', workflowBridge: settings?.workflowBridge ?? false, jobsBridge: settings?.jobsBridge ?? false, executionRoots: settings?.executionRoots ?? false, restrictSkills: (settings?.allowedSkills?.length ?? 0) > 0, allowedSkills: settings?.allowedSkills ?? [] } }
function routeKey(provider: string | undefined, model: string | undefined): string { return provider === undefined || model === undefined || provider === '' || model === '' ? '' : JSON.stringify([provider, model]) }
function routeValue(route: TeamModelRoute): string { return routeKey(route.provider, route.model) }
function parseRoute(value: string): readonly [string, string] | undefined { if (value === '') return undefined; try { const parsed = JSON.parse(value); return Array.isArray(parsed) && parsed.length === 2 && parsed.every(part => typeof part === 'string' && part.trim() !== '') ? [parsed[0], parsed[1]] : undefined } catch { return undefined } }
function positiveInteger(value: string): boolean { return /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) }

async function persistField(scope: SettingsScope<TeamPluginSettings>, field: keyof Draft, draft: Draft): Promise<void> {
  switch (field) {
    case 'captainRoute': return await persistRoute(scope, 'captainLlmProvider', 'captainModel', draft.captainRoute)
    case 'memberRoute': return await persistRoute(scope, 'memberLlmProvider', 'memberModel', draft.memberRoute)
    case 'maxMembers': return await scope.set('maxMembers', Number(draft.maxMembers))
    case 'maxTasks': return await scope.set('maxTasks', Number(draft.maxTasks))
    case 'memberMaxDepth': return await scope.set('memberMaxDepth', Number(draft.memberMaxDepth))
    case 'maxPendingMessages': return await scope.set('maxPendingMessagesPerMember', Number(draft.maxPendingMessages))
    case 'orchestrationMode': return await scope.set('orchestrationMode', draft.orchestrationMode)
    case 'workflowBridge': return await scope.set('workflowBridge', draft.workflowBridge)
    case 'jobsBridge': return await scope.set('jobsBridge', draft.jobsBridge)
    case 'executionRoots': return await scope.set('executionRoots', draft.executionRoots)
    case 'restrictSkills':
    case 'allowedSkills': return draft.restrictSkills ? await scope.set('allowedSkills', [...draft.allowedSkills].toSorted()) : await scope.unset('allowedSkills')
  }
}

async function persistRoute(scope: SettingsScope<TeamPluginSettings>, providerField: string, modelField: string, value: string): Promise<void> { const route = parseRoute(value); if (route === undefined) { await scope.unset(providerField); await scope.unset(modelField); return }; await scope.set(providerField, route[0]); await scope.set(modelField, route[1]) }

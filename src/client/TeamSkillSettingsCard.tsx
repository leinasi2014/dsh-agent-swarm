import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export const TEAM_SKILL_SETTINGS_NS = 'agent-swarm' as const

export interface TeamSkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

export interface TeamModelRoute {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
}

export interface TeamSettingsCatalog {
  currentSessionId(): string | undefined
  subscribe(listener: () => void): () => void
  listSkills(sessionId: string): Promise<readonly TeamSkillCatalogEntry[]>
  listModelRoutes(): Promise<readonly TeamModelRoute[]>
}

export interface TeamPluginSettings {
  enabled?: boolean
  memberProvider?: string
  captainLlmProvider?: string
  captainModel?: string
  memberLlmProvider?: string
  memberModel?: string
  memberMaxDepth?: number
  schedulerProvider?: string
  reviewProvider?: string
  reviewRootProvider?: string
  maxMembers?: number
  maxTasks?: number
  maxPendingMessagesPerMember?: number
  maxRetainedMessages?: number
  maxRetainedAttempts?: number
  maxMessageBytes?: number
  maxTaskBytes?: number
  maxDependencies?: number
  maxMemories?: number
  maxInteractionEffects?: number
  maxVerificationCommands?: number
  maxVerificationCommandMs?: number
  maxHostContexts?: number
  hostContextTtlMs?: number
  disposalTimeoutMs?: number
  strandedAfterMs?: number
  orchestrationMode?: 'adaptive' | 'workflow'
  workflowBridge?: boolean
  workflowMaxTotalAgents?: number
  workflowDisposeGraceMs?: number
  jobsBridge?: boolean
  executionRoots?: boolean
  executionRootProvider?: string
  executionRootsBase?: string
  toolPolicy?: { allow?: string[]; ask?: string[]; deny?: string[] }
  allowedSkills?: string[]
  promptSectionOrder?: number
}

export const teamSkillSettingsEn = {
  title: 'Agent Swarm', subtitle: 'Intelligent Agent Teams', description: 'Captain-led Teams, Skills, review, permissions, and execution defaults.', open: 'Configure plugin', close: 'Close configuration', active: 'Configured', enabled: 'Enable Agent Swarm',
  readOnly: 'This deployment stores plugin settings read-only.', restart: 'Restart DSH after saving to apply runtime changes. Existing Teams keep their durable state.',
  overview: 'Team', skills: 'Skills', governance: 'Orchestration & review', permissions: 'Tool permissions', resources: 'Execution & limits',
  captainRoute: 'Captain model route', memberRoute: 'Member model route', inheritRoute: 'Inherit the model selected when the Team is created', routesLoading: 'Loading configured DSH model routes…', routesUnavailable: 'No configured model route is available. Add one in DSH Model settings.',
  memberProvider: 'Member runtime Provider', maxMembers: 'Maximum members per Team', maxTasks: 'Maximum tasks per Team', memberDepth: 'Member subagent depth', pendingMessages: 'Pending messages per member', identityPolicy: 'Identity and avatar policy', identityPolicyValue: 'Captain supplies every member name, profession, personality, biography, and safe pixel SVG avatar during recruitment.',
  skillsMode: 'Skill policy for newly created Teams', inheritSkills: 'Use every Skill exposed by DSH', restrictSkills: 'Allow only selected Skills', skillsHint: 'The catalog is read from the active workspace Session. Existing Teams retain their creation-time policy.', selectWorkspace: 'Open a workspace Session to load its real Skill catalog.', skillsLoading: 'Loading Skills from DSH…', skillsUnavailable: 'The DSH Skill catalog could not be loaded.', noModelSkills: 'This Session exposes no model-invocable Skills.', noSkillsSelected: 'Choose at least one Skill, or use all DSH Skills.', searchSkills: 'Search Skills', selectVisible: 'Select visible', clearSkills: 'Clear selection', selectedCount: 'selected',
  orchestrationMode: 'Orchestration mode', adaptive: 'Adaptive scheduling', workflow: 'Workflow bridge', workflowBridge: 'Enable workflow bridge', jobsBridge: 'Expose Team tasks in DSH Jobs', schedulerProvider: 'Scheduler Provider', reviewProvider: 'Review Provider', reviewRootProvider: 'Review execution-root Provider', strandedAfterMs: 'Retry stranded ownership after (ms)', workflowMaxTotalAgents: 'Workflow total-agent ceiling', workflowDisposeGraceMs: 'Workflow disposal grace (ms)',
  toolsHint: 'Unlisted tools inherit DSH permissions. One exact tool name may appear in only one tier. Ask is Captain-only and becomes deny for members.', allowTools: 'Always allow', askTools: 'Ask Captain for approval', denyTools: 'Always deny', toolNamesHint: 'One exact tool name per line or comma-separated. Leave empty to inherit.', invalidTools: 'Tool names must be unique, valid, and appear in only one tier.',
  executionRoots: 'Create isolated execution roots', executionRootProvider: 'Execution-root Provider', executionRootsBase: 'Execution-root base directory', maxRetainedMessages: 'Retained message receipts', maxRetainedAttempts: 'Retained attempts per task', maxMessageBytes: 'Maximum message bytes', maxTaskBytes: 'Maximum task bytes', maxDependencies: 'Maximum task dependencies', maxMemories: 'Maximum shared memories', maxInteractionEffects: 'Maximum interaction effects', maxVerificationCommands: 'Verification commands per task', maxVerificationCommandMs: 'Verification command timeout (ms)', maxHostContexts: 'Maximum Host contexts', hostContextTtlMs: 'Host context lifetime (ms)', disposalTimeoutMs: 'Disposal timeout (ms)', promptSectionOrder: 'System-prompt section order',
  invalidNumber: 'Enter valid whole-number limits.', invalidProvider: 'Provider names cannot be empty.', save: 'Save plugin settings', saving: 'Saving…', saved: 'Saved.', saveFailed: 'DSH did not accept the complete configuration. Your draft was kept.',
} as const

export const teamSkillSettingsZh: Record<keyof typeof teamSkillSettingsEn, string> = {
  title: 'Agent Swarm', subtitle: '智能体团队', description: '配置队长制团队、Skills、审查、权限与执行默认值。', open: '配置插件', close: '关闭配置', active: '已配置', enabled: '启用 Agent Swarm',
  readOnly: '当前部署的插件设置为只读。', restart: '保存后请重启 DSH 以应用运行时变更；已创建团队继续保留其持久状态。',
  overview: '团队', skills: 'Skills', governance: '调度与审查', permissions: '工具权限', resources: '执行与限制',
  captainRoute: '队长模型路由', memberRoute: '队员模型路由', inheritRoute: '继承创建团队时主会话选择的模型', routesLoading: '正在读取 DSH 已配置的模型路由…', routesUnavailable: '尚无可用模型路由；请先在 DSH 的“模型”设置中配置。',
  memberProvider: '队员运行 Provider', maxMembers: '每个团队最多成员数', maxTasks: '每个团队最多任务数', memberDepth: '队员子智能体层级', pendingMessages: '每名队员待处理消息上限', identityPolicy: '身份与头像策略', identityPolicyValue: '队长招募时为每位成员生成姓名、职业、性格、个人简介和安全像素 SVG 头像。',
  skillsMode: '新建团队的 Skill 策略', inheritSkills: '使用 DSH 暴露的全部 Skills', restrictSkills: '仅允许已选择的 Skills', skillsHint: '列表从当前工作区 Session 实时读取；已创建团队保留创建时冻结的策略。', selectWorkspace: '请先打开一个工作区 Session，以读取真实 Skill 列表。', skillsLoading: '正在从 DSH 读取 Skills…', skillsUnavailable: '无法读取 DSH Skill 列表。', noModelSkills: '当前 Session 没有可供智能体调用的 Skills。', noSkillsSelected: '至少选择一个 Skill，或改为使用全部 DSH Skills。', searchSkills: '搜索 Skills', selectVisible: '选择当前结果', clearSkills: '清空选择', selectedCount: '个已选择',
  orchestrationMode: '编排模式', adaptive: '自适应调度', workflow: '工作流桥接', workflowBridge: '启用工作流桥接', jobsBridge: '在 DSH Jobs 中展示团队任务', schedulerProvider: '调度 Provider', reviewProvider: '审查 Provider', reviewRootProvider: '审查执行目录 Provider', strandedAfterMs: '任务失联后重试时间（毫秒）', workflowMaxTotalAgents: '工作流智能体总上限', workflowDisposeGraceMs: '工作流释放宽限（毫秒）',
  toolsHint: '未列出的工具继承 DSH 权限。一个工具只能位于一个级别；“需批准”仅适用于在线队长，对队员会收紧为禁止。', allowTools: '始终允许', askTools: '需队长批准', denyTools: '始终禁止', toolNamesHint: '每行或用逗号填写一个精确工具名；留空即继承。', invalidTools: '工具名必须合法、唯一，且不能同时出现在多个级别。',
  executionRoots: '为任务创建隔离执行目录', executionRootProvider: '执行目录 Provider', executionRootsBase: '执行目录根路径', maxRetainedMessages: '保留消息回执数', maxRetainedAttempts: '每项任务保留尝试数', maxMessageBytes: '单条消息最大字节数', maxTaskBytes: '单项任务最大字节数', maxDependencies: '任务最大依赖数', maxMemories: '团队共享记忆上限', maxInteractionEffects: '交互效果记录上限', maxVerificationCommands: '每项任务验证命令数', maxVerificationCommandMs: '验证命令超时（毫秒）', maxHostContexts: 'Host 上下文上限', hostContextTtlMs: 'Host 上下文寿命（毫秒）', disposalTimeoutMs: '资源释放超时（毫秒）', promptSectionOrder: '系统提示段落顺序',
  invalidNumber: '请输入有效的整数限制。', invalidProvider: 'Provider 名称不能为空。', save: '保存插件配置', saving: '保存中…', saved: '已保存。', saveFailed: 'DSH 未接受完整配置，已保留你的草稿。',
}

export type TeamSkillSettingsKey = keyof typeof teamSkillSettingsEn
export interface TeamSkillSettingsFace { readonly scope: SettingsScope<TeamPluginSettings>; readonly catalog: TeamSettingsCatalog }
export type TeamSkillSettingsProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<typeof TEAM_SKILL_SETTINGS_NS> & InjectFace<TeamSkillSettingsFace>
type Tab = 'overview' | 'skills' | 'governance' | 'permissions' | 'resources'
type LoadState<T> = { readonly state: 'idle' | 'loading' } | { readonly state: 'ready'; readonly value: readonly T[] } | { readonly state: 'failed' }

interface Draft {
  readonly enabled: boolean; readonly captainRoute: string; readonly memberRoute: string; readonly memberProvider: string
  readonly maxMembers: string; readonly maxTasks: string; readonly memberMaxDepth: string; readonly maxPendingMessages: string
  readonly restrictSkills: boolean; readonly allowedSkills: readonly string[]
  readonly schedulerProvider: string; readonly reviewProvider: string; readonly reviewRootProvider: string; readonly orchestrationMode: 'adaptive' | 'workflow'; readonly workflowBridge: boolean; readonly jobsBridge: boolean
  readonly strandedAfterMs: string; readonly workflowMaxTotalAgents: string; readonly workflowDisposeGraceMs: string
  readonly allowTools: string; readonly askTools: string; readonly denyTools: string
  readonly executionRoots: boolean; readonly executionRootProvider: string; readonly executionRootsBase: string
  readonly maxRetainedMessages: string; readonly maxRetainedAttempts: string; readonly maxMessageBytes: string; readonly maxTaskBytes: string; readonly maxDependencies: string; readonly maxMemories: string; readonly maxInteractionEffects: string; readonly maxVerificationCommands: string; readonly maxVerificationCommandMs: string; readonly maxHostContexts: string; readonly hostContextTtlMs: string; readonly disposalTimeoutMs: string; readonly promptSectionOrder: string
}

const layout: Record<string, CSSProperties> = {
  card: { listStyle: 'none', border: '1px solid var(--dsh-color-border, #555)', borderRadius: 16, marginBottom: 16, overflow: 'hidden' }, header: { width: '100%', display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', padding: '18px 20px', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' }, mark: { width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', fontWeight: 800, color: '#dbe2ff', background: 'linear-gradient(145deg, #6677ef, #3541a3)' }, title: { display: 'block', fontWeight: 750, fontSize: 18 }, description: { display: 'block', marginTop: 4, opacity: 0.72 }, badge: { border: '1px solid var(--dsh-color-border, #555)', borderRadius: 999, padding: '3px 9px', fontSize: 12, opacity: 0.8 }, body: { padding: '0 20px 20px', borderTop: '1px solid var(--dsh-color-border, #555)' }, tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid var(--dsh-color-border, #555)', marginBottom: 20 }, tab: { padding: '13px 10px', border: 0, borderBottomWidth: 2, borderBottomStyle: 'solid', borderBottomColor: 'transparent', background: 'transparent', color: 'inherit', cursor: 'pointer' }, tabActive: { borderBottomColor: 'var(--dsh-color-primary, #7187ff)', fontWeight: 700 }, grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }, field: { display: 'grid', gap: 6 }, input: { width: '100%', boxSizing: 'border-box', minHeight: 38 }, hint: { margin: '10px 0', opacity: 0.72, fontSize: 13 }, panel: { padding: 14, border: '1px solid var(--dsh-color-border, #555)', borderRadius: 12 }, skillBar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }, skillList: { display: 'grid', gap: 8, maxHeight: 380, overflowY: 'auto', paddingRight: 4 }, skill: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, padding: 10, border: '1px solid var(--dsh-color-border, #555)', borderRadius: 10 }, footer: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'flex-end', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--dsh-color-border, #555)' },
}

const positiveFields: readonly (keyof Draft)[] = ['maxMembers', 'maxTasks', 'memberMaxDepth', 'maxPendingMessages', 'workflowMaxTotalAgents', 'workflowDisposeGraceMs', 'maxRetainedMessages', 'maxRetainedAttempts', 'maxMessageBytes', 'maxTaskBytes', 'maxDependencies', 'maxMemories', 'maxInteractionEffects', 'maxVerificationCommands', 'maxVerificationCommandMs', 'maxHostContexts', 'hostContextTtlMs', 'disposalTimeoutMs', 'promptSectionOrder']

export function TeamSkillSettingsCard(props: TeamSkillSettingsProps) {
  const snapshot = useSyncExternalStore(useCallback(listener => props.scope.subscribe(listener), [props.scope]), useCallback(() => props.scope.getSnapshot(), [props.scope]), useCallback(() => props.scope.getSnapshot(), [props.scope]))
  const sessionId = useSyncExternalStore(useCallback(listener => props.catalog.subscribe(listener), [props.catalog]), useCallback(() => props.catalog.currentSessionId(), [props.catalog]), useCallback(() => props.catalog.currentSessionId(), [props.catalog]))
  const [open, setOpen] = useState(false); const [tab, setTab] = useState<Tab>('overview'); const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft>(() => fromSettings(undefined)); const [dirty, setDirty] = useState<ReadonlySet<keyof Draft>>(new Set())
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false); const [failed, setFailed] = useState(false)
  const [skills, setSkills] = useState<LoadState<TeamSkillCatalogEntry>>({ state: 'idle' }); const [routes, setRoutes] = useState<LoadState<TeamModelRoute>>({ state: 'idle' })
  useEffect(() => { if (snapshot.status === 'ready' && dirty.size === 0) setDraft(fromSettings(snapshot.value)) }, [snapshot.status, snapshot.revision, snapshot.value, dirty.size])
  useEffect(() => { if (!open) return; let live = true; setRoutes({ state: 'loading' }); void props.catalog.listModelRoutes().then(value => { if (live) setRoutes({ state: 'ready', value }) }, () => { if (live) setRoutes({ state: 'failed' }) }); return () => { live = false } }, [open, props.catalog, sessionId])
  useEffect(() => { if (!open || tab !== 'skills') return; if (sessionId === undefined) { setSkills({ state: 'idle' }); return }; let live = true; setSkills({ state: 'loading' }); void props.catalog.listSkills(sessionId).then(value => { if (live) setSkills({ state: 'ready', value }) }, () => { if (live) setSkills({ state: 'failed' }) }); return () => { live = false } }, [open, props.catalog, sessionId, tab])
  const edit = <K extends keyof Draft>(field: K, value: Draft[K]) => { setDraft(current => ({ ...current, [field]: value })); setDirty(current => new Set(current).add(field)); setSaved(false); setFailed(false) }
  const editable = snapshot.status === 'ready' && snapshot.writable && !saving
  const invalidNumbers = positiveFields.some(field => !positiveInteger(String(draft[field]))) || !nonNegativeInteger(draft.strandedAfterMs)
  const invalidSkills = draft.restrictSkills && draft.allowedSkills.length === 0
  const invalidProviders = [draft.memberProvider, draft.schedulerProvider, draft.reviewProvider, draft.reviewRootProvider, draft.executionRootProvider].some(value => value.trim() === '')
  const invalidTools = !validToolPolicy(draft.allowTools, draft.askTools, draft.denyTools)
  const routesByValue = useMemo(() => new Set(routes.state === 'ready' ? routes.value.map(routeValue) : []), [routes])
  const routeInvalid = (dirty.has('captainRoute') && draft.captainRoute !== '' && routes.state === 'ready' && !routesByValue.has(draft.captainRoute)) || (dirty.has('memberRoute') && draft.memberRoute !== '' && routes.state === 'ready' && !routesByValue.has(draft.memberRoute))
  const canSave = editable && dirty.size > 0 && !invalidNumbers && !invalidSkills && !invalidProviders && !invalidTools && !routeInvalid
  const modelSkills = skills.state === 'ready' ? skills.value.filter(skill => skill.modelInvocable) : []
  const visibleSkills = modelSkills.filter(skill => `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const save = () => { if (!canSave) return; void (async () => { setSaving(true); setFailed(false); try { for (const field of orderFields(dirty, draft)) await persistField(props.scope, field, draft); setDirty(new Set()); setSaved(true) } catch { setFailed(true) } finally { setSaving(false) } })() }
  if (snapshot.status === 'unavailable') return null
  const error = invalidNumbers ? props.t('invalidNumber') : invalidSkills ? props.t('noSkillsSelected') : invalidProviders ? props.t('invalidProvider') : invalidTools ? props.t('invalidTools') : routeInvalid ? props.t('routesUnavailable') : undefined
  return <li style={layout.card} data-agent-swarm-settings-entry>
    <button type="button" style={layout.header} aria-expanded={open} aria-label={`${props.t(open ? 'close' : 'open')}: ${props.t('title')} ${props.t('subtitle')}`} onClick={() => { setOpen(value => !value) }}><span aria-hidden="true" style={layout.mark}>AS</span><span style={{ flex: 1 }}><span style={layout.title}>{props.t('title')} · {props.t('subtitle')}</span><span style={layout.description}>{props.t('description')}</span></span><span style={layout.badge}>{props.t('active')}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button>
    {open ? <div style={layout.body}>{!editable ? <p role="status" style={layout.hint}>{props.t('readOnly')}</p> : null}<nav aria-label={props.t('title')} style={layout.tabs}>{(['overview', 'skills', 'governance', 'permissions', 'resources'] as const).map(value => <TabButton key={value} current={tab} value={value} onSelect={setTab}>{props.t(value)}</TabButton>)}</nav>
      {tab === 'overview' ? <Overview draft={draft} routes={routes} editable={editable} t={props.t} onEdit={edit} /> : null}{tab === 'skills' ? <Skills draft={draft} skills={skills} sessionId={sessionId} query={query} visibleSkills={visibleSkills} editable={editable} t={props.t} onQuery={setQuery} onEdit={edit} /> : null}{tab === 'governance' ? <Governance draft={draft} editable={editable} t={props.t} onEdit={edit} /> : null}{tab === 'permissions' ? <Permissions draft={draft} editable={editable} t={props.t} onEdit={edit} /> : null}{tab === 'resources' ? <Resources draft={draft} editable={editable} t={props.t} onEdit={edit} /> : null}
      <p role={error === undefined ? undefined : 'alert'} style={{ ...layout.hint, color: error === undefined ? undefined : 'var(--dsh-color-danger, #d44)' }}>{error ?? props.t('restart')}</p><div style={layout.footer}>{saved ? <span role="status">{props.t('saved')} {props.t('restart')}</span> : null}{failed ? <span role="alert">{props.t('saveFailed')}</span> : null}<button type="button" disabled={!canSave} onClick={save}>{props.t(saving ? 'saving' : 'save')}</button></div>
    </div> : null}
  </li>
}

function TabButton(props: { readonly current: Tab; readonly value: Tab; readonly onSelect: (tab: Tab) => void; readonly children: string }) {
  return <button type="button" role="tab" aria-selected={props.current === props.value} style={{ ...layout.tab, ...(props.current === props.value ? layout.tabActive : {}) }} onClick={() => { props.onSelect(props.value) }}>{props.children}</button>
}

type EditorProps = { readonly draft: Draft; readonly editable: boolean; readonly t: TeamSkillSettingsProps['t']; readonly onEdit: <K extends keyof Draft>(field: K, value: Draft[K]) => void }

function Overview(props: EditorProps & { readonly routes: LoadState<TeamModelRoute> }) {
  const routeSelect = (field: 'captainRoute' | 'memberRoute') => <select aria-label={props.t(field)} style={layout.input} value={props.draft[field]} disabled={!props.editable || props.routes.state !== 'ready'} onChange={event => { props.onEdit(field, event.target.value) }}><option value="">{props.t('inheritRoute')}</option>{props.routes.state === 'ready' ? props.routes.value.map(route => <option key={routeValue(route)} value={routeValue(route)}>{route.providerName} · {route.modelName}</option>) : null}</select>
  return <section><div style={{ ...layout.panel, marginBottom: 14 }}><Toggle label={props.t('enabled')} checked={props.draft.enabled} disabled={!props.editable} onChange={value => { props.onEdit('enabled', value) }} /></div><div style={layout.grid}>
    <label style={layout.field}>{props.t('captainRoute')}{routeSelect('captainRoute')}</label><label style={layout.field}>{props.t('memberRoute')}{routeSelect('memberRoute')}</label>
    <TextInput label={props.t('memberProvider')} value={props.draft.memberProvider} disabled={!props.editable} onChange={value => { props.onEdit('memberProvider', value) }} />
    <NumberInput label={props.t('maxMembers')} value={props.draft.maxMembers} disabled={!props.editable} onChange={value => { props.onEdit('maxMembers', value) }} /><NumberInput label={props.t('maxTasks')} value={props.draft.maxTasks} disabled={!props.editable} onChange={value => { props.onEdit('maxTasks', value) }} /><NumberInput label={props.t('memberDepth')} value={props.draft.memberMaxDepth} disabled={!props.editable} onChange={value => { props.onEdit('memberMaxDepth', value) }} /><NumberInput label={props.t('pendingMessages')} value={props.draft.maxPendingMessages} disabled={!props.editable} onChange={value => { props.onEdit('maxPendingMessages', value) }} />
  </div><div style={{ ...layout.panel, marginTop: 14 }}><strong>{props.t('identityPolicy')}</strong><p style={layout.hint}>{props.t('identityPolicyValue')}</p></div>{props.routes.state === 'loading' ? <p style={layout.hint}>{props.t('routesLoading')}</p> : null}{props.routes.state === 'failed' || (props.routes.state === 'ready' && props.routes.value.length === 0) ? <p role="status" style={layout.hint}>{props.t('routesUnavailable')}</p> : null}</section>
}

function Skills(props: EditorProps & { readonly skills: LoadState<TeamSkillCatalogEntry>; readonly sessionId: string | undefined; readonly query: string; readonly visibleSkills: readonly TeamSkillCatalogEntry[]; readonly onQuery: (value: string) => void }) {
  return <section><fieldset disabled={!props.editable} style={{ border: 0, padding: 0, margin: 0 }}><legend style={{ fontWeight: 700 }}>{props.t('skillsMode')}</legend><label><input type="radio" name="agent-swarm-skills-mode" checked={!props.draft.restrictSkills} onChange={() => { props.onEdit('restrictSkills', false) }} /> {props.t('inheritSkills')}</label><label style={{ marginLeft: 16 }}><input type="radio" name="agent-swarm-skills-mode" checked={props.draft.restrictSkills} onChange={() => { props.onEdit('restrictSkills', true) }} /> {props.t('restrictSkills')}</label></fieldset><p style={layout.hint}>{props.t('skillsHint')}</p>
    {props.sessionId === undefined ? <p role="status">{props.t('selectWorkspace')}</p> : null}{props.skills.state === 'loading' ? <p>{props.t('skillsLoading')}</p> : null}{props.skills.state === 'failed' ? <p role="alert">{props.t('skillsUnavailable')}</p> : null}
    {props.skills.state === 'ready' ? <><div style={layout.skillBar}><input aria-label={props.t('searchSkills')} placeholder={props.t('searchSkills')} value={props.query} onChange={event => { props.onQuery(event.target.value) }} /><button type="button" disabled={!props.editable || !props.draft.restrictSkills || props.visibleSkills.length === 0} onClick={() => { props.onEdit('allowedSkills', [...new Set([...props.draft.allowedSkills, ...props.visibleSkills.map(skill => skill.name)])].toSorted()) }}>{props.t('selectVisible')}</button><button type="button" disabled={!props.editable || !props.draft.restrictSkills || props.draft.allowedSkills.length === 0} onClick={() => { props.onEdit('allowedSkills', []) }}>{props.t('clearSkills')}</button><span>{props.draft.allowedSkills.length} {props.t('selectedCount')}</span></div>{props.visibleSkills.length === 0 ? <p role="status">{props.t('noModelSkills')}</p> : <div style={layout.skillList}>{props.visibleSkills.map(skill => <label key={skill.name} style={layout.skill}><input type="checkbox" aria-label={skill.name} checked={props.draft.allowedSkills.includes(skill.name)} disabled={!props.editable || !props.draft.restrictSkills} onChange={event => { props.onEdit('allowedSkills', event.target.checked ? [...new Set([...props.draft.allowedSkills, skill.name])].toSorted() : props.draft.allowedSkills.filter(name => name !== skill.name)) }} /><span><strong>{skill.name}</strong><br /><span style={layout.hint}>{skill.description}{skill.whenToUse === undefined ? '' : ` · ${skill.whenToUse}`}</span></span></label>)}</div>}</> : null}
  </section>
}

function Governance(props: EditorProps) {
  return <section style={layout.grid}><TextInput label={props.t('schedulerProvider')} value={props.draft.schedulerProvider} disabled={!props.editable} onChange={value => { props.onEdit('schedulerProvider', value) }} /><TextInput label={props.t('reviewProvider')} value={props.draft.reviewProvider} disabled={!props.editable} onChange={value => { props.onEdit('reviewProvider', value) }} /><TextInput label={props.t('reviewRootProvider')} value={props.draft.reviewRootProvider} disabled={!props.editable} onChange={value => { props.onEdit('reviewRootProvider', value) }} />
    <label style={layout.field}>{props.t('orchestrationMode')}<select aria-label={props.t('orchestrationMode')} style={layout.input} value={props.draft.orchestrationMode} disabled={!props.editable} onChange={event => { const mode = event.target.value as Draft['orchestrationMode']; if (mode === 'workflow') props.onEdit('workflowBridge', true); props.onEdit('orchestrationMode', mode) }}><option value="adaptive">{props.t('adaptive')}</option><option value="workflow">{props.t('workflow')}</option></select></label><Toggle label={props.t('workflowBridge')} checked={props.draft.workflowBridge} disabled={!props.editable || props.draft.orchestrationMode === 'workflow'} onChange={value => { props.onEdit('workflowBridge', value) }} /><Toggle label={props.t('jobsBridge')} checked={props.draft.jobsBridge} disabled={!props.editable} onChange={value => { props.onEdit('jobsBridge', value) }} />
    <NumberInput label={props.t('strandedAfterMs')} value={props.draft.strandedAfterMs} min="0" disabled={!props.editable} onChange={value => { props.onEdit('strandedAfterMs', value) }} /><NumberInput label={props.t('workflowMaxTotalAgents')} value={props.draft.workflowMaxTotalAgents} disabled={!props.editable} onChange={value => { props.onEdit('workflowMaxTotalAgents', value) }} /><NumberInput label={props.t('workflowDisposeGraceMs')} value={props.draft.workflowDisposeGraceMs} disabled={!props.editable} onChange={value => { props.onEdit('workflowDisposeGraceMs', value) }} />
  </section>
}

function Permissions(props: EditorProps) {
  return <section><p style={layout.hint}>{props.t('toolsHint')}</p><div style={layout.grid}><ToolNames label={props.t('allowTools')} hint={props.t('toolNamesHint')} value={props.draft.allowTools} disabled={!props.editable} onChange={value => { props.onEdit('allowTools', value) }} /><ToolNames label={props.t('askTools')} hint={props.t('toolNamesHint')} value={props.draft.askTools} disabled={!props.editable} onChange={value => { props.onEdit('askTools', value) }} /><ToolNames label={props.t('denyTools')} hint={props.t('toolNamesHint')} value={props.draft.denyTools} disabled={!props.editable} onChange={value => { props.onEdit('denyTools', value) }} /></div></section>
}

const resourceNumbers = [['maxRetainedMessages', 'maxRetainedMessages'], ['maxRetainedAttempts', 'maxRetainedAttempts'], ['maxMessageBytes', 'maxMessageBytes'], ['maxTaskBytes', 'maxTaskBytes'], ['maxDependencies', 'maxDependencies'], ['maxMemories', 'maxMemories'], ['maxInteractionEffects', 'maxInteractionEffects'], ['maxVerificationCommands', 'maxVerificationCommands'], ['maxVerificationCommandMs', 'maxVerificationCommandMs'], ['maxHostContexts', 'maxHostContexts'], ['hostContextTtlMs', 'hostContextTtlMs'], ['disposalTimeoutMs', 'disposalTimeoutMs'], ['promptSectionOrder', 'promptSectionOrder']] as const satisfies readonly (readonly [keyof Draft, TeamSkillSettingsKey])[]

function Resources(props: EditorProps) {
  return <section><div style={{ ...layout.panel, marginBottom: 14 }}><Toggle label={props.t('executionRoots')} checked={props.draft.executionRoots} disabled={!props.editable} onChange={value => { props.onEdit('executionRoots', value) }} /></div><div style={layout.grid}><TextInput label={props.t('executionRootProvider')} value={props.draft.executionRootProvider} disabled={!props.editable} onChange={value => { props.onEdit('executionRootProvider', value) }} /><TextInput label={props.t('executionRootsBase')} value={props.draft.executionRootsBase} disabled={!props.editable} onChange={value => { props.onEdit('executionRootsBase', value) }} />{resourceNumbers.map(([field, key]) => <NumberInput key={field} label={props.t(key)} value={props.draft[field]} disabled={!props.editable} onChange={value => { props.onEdit(field, value) }} />)}</div></section>
}

function NumberInput(props: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly min?: string; readonly onChange: (value: string) => void }) { return <label style={layout.field}>{props.label}<input type="number" min={props.min ?? '1'} step="1" style={layout.input} value={props.value} disabled={props.disabled} onChange={event => { props.onChange(event.target.value) }} /></label> }
function TextInput(props: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly onChange: (value: string) => void }) { return <label style={layout.field}>{props.label}<input type="text" style={layout.input} value={props.value} disabled={props.disabled} onChange={event => { props.onChange(event.target.value) }} /></label> }
function Toggle(props: { readonly label: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (value: boolean) => void }) { return <label><input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={event => { props.onChange(event.target.checked) }} /> {props.label}</label> }
function ToolNames(props: { readonly label: string; readonly hint: string; readonly value: string; readonly disabled: boolean; readonly onChange: (value: string) => void }) { return <label style={layout.field}>{props.label}<textarea rows={8} value={props.value} disabled={props.disabled} onChange={event => { props.onChange(event.target.value) }} /><span style={layout.hint}>{props.hint}</span></label> }

function fromSettings(settings: TeamPluginSettings | undefined): Draft {
  return { enabled: settings?.enabled ?? true, captainRoute: routeKey(settings?.captainLlmProvider, settings?.captainModel), memberRoute: routeKey(settings?.memberLlmProvider, settings?.memberModel), memberProvider: settings?.memberProvider ?? 'spawn', maxMembers: String(settings?.maxMembers ?? 8), maxTasks: String(settings?.maxTasks ?? 256), memberMaxDepth: String(settings?.memberMaxDepth ?? 1), maxPendingMessages: String(settings?.maxPendingMessagesPerMember ?? 64), restrictSkills: (settings?.allowedSkills?.length ?? 0) > 0, allowedSkills: settings?.allowedSkills ?? [], schedulerProvider: settings?.schedulerProvider ?? 'priority-ready', reviewProvider: settings?.reviewProvider ?? 'manual', reviewRootProvider: settings?.reviewRootProvider ?? 'temp', orchestrationMode: settings?.orchestrationMode ?? 'adaptive', workflowBridge: settings?.workflowBridge ?? false, jobsBridge: settings?.jobsBridge ?? false, strandedAfterMs: String(settings?.strandedAfterMs ?? 60_000), workflowMaxTotalAgents: String(settings?.workflowMaxTotalAgents ?? 1_000), workflowDisposeGraceMs: String(settings?.workflowDisposeGraceMs ?? 5_000), allowTools: renderNames(settings?.toolPolicy?.allow), askTools: renderNames(settings?.toolPolicy?.ask), denyTools: renderNames(settings?.toolPolicy?.deny), executionRoots: settings?.executionRoots ?? false, executionRootProvider: settings?.executionRootProvider ?? 'git-worktree', executionRootsBase: settings?.executionRootsBase ?? '', maxRetainedMessages: String(settings?.maxRetainedMessages ?? 256), maxRetainedAttempts: String(settings?.maxRetainedAttempts ?? 64), maxMessageBytes: String(settings?.maxMessageBytes ?? 65_536), maxTaskBytes: String(settings?.maxTaskBytes ?? 65_536), maxDependencies: String(settings?.maxDependencies ?? 64), maxMemories: String(settings?.maxMemories ?? 512), maxInteractionEffects: String(settings?.maxInteractionEffects ?? 1_024), maxVerificationCommands: String(settings?.maxVerificationCommands ?? 16), maxVerificationCommandMs: String(settings?.maxVerificationCommandMs ?? 600_000), maxHostContexts: String(settings?.maxHostContexts ?? 64), hostContextTtlMs: String(settings?.hostContextTtlMs ?? 300_000), disposalTimeoutMs: String(settings?.disposalTimeoutMs ?? 5_000), promptSectionOrder: String(settings?.promptSectionOrder ?? 118) }
}

function orderFields(dirty: ReadonlySet<keyof Draft>, draft: Draft): readonly (keyof Draft)[] {
  const priority = (field: keyof Draft) => draft.orchestrationMode === 'workflow' ? field === 'workflowBridge' ? 0 : field === 'orchestrationMode' ? 1 : 2 : field === 'orchestrationMode' ? 0 : field === 'workflowBridge' ? 1 : 2
  return [...dirty].filter(field => !(field === 'restrictSkills' && dirty.has('allowedSkills')) && !(field === 'askTools' && dirty.has('allowTools')) && !(field === 'denyTools' && (dirty.has('allowTools') || dirty.has('askTools')))).toSorted((left, right) => priority(left) - priority(right))
}

async function persistField(scope: SettingsScope<TeamPluginSettings>, field: keyof Draft, draft: Draft): Promise<void> {
  switch (field) {
    case 'captainRoute': return await persistRoute(scope, 'captainLlmProvider', 'captainModel', draft.captainRoute)
    case 'memberRoute': return await persistRoute(scope, 'memberLlmProvider', 'memberModel', draft.memberRoute)
    case 'maxPendingMessages': return await setVerified(scope, 'maxPendingMessagesPerMember', Number(draft.maxPendingMessages))
    case 'restrictSkills': case 'allowedSkills': return draft.restrictSkills ? await setVerified(scope, 'allowedSkills', [...draft.allowedSkills].toSorted()) : await unsetVerified(scope, 'allowedSkills')
    case 'allowTools': case 'askTools': case 'denyTools': return await setVerified(scope, 'toolPolicy', { allow: parseNames(draft.allowTools), ask: parseNames(draft.askTools), deny: parseNames(draft.denyTools) })
    default: return await persistSimple(scope, field, draft[field])
  }
}

async function persistSimple(scope: SettingsScope<TeamPluginSettings>, field: keyof Draft, value: Draft[keyof Draft]): Promise<void> { if (new Set<keyof Draft>([...positiveFields, 'strandedAfterMs']).has(field)) return await setVerified(scope, field, Number(value)); if (field === 'executionRootsBase' && String(value).trim() === '') return await unsetVerified(scope, field); return await setVerified(scope, field, value) }
async function persistRoute(scope: SettingsScope<TeamPluginSettings>, providerField: string, modelField: string, value: string): Promise<void> { const route = parseRoute(value); if (route === undefined) { await unsetVerified(scope, providerField); await unsetVerified(scope, modelField); return }; await setVerified(scope, providerField, route[0]); await setVerified(scope, modelField, route[1]) }
async function setVerified(scope: SettingsScope<TeamPluginSettings>, field: string, value: unknown): Promise<void> { await scope.set(field, value); const user = record(scope.getSnapshot().user); if (user === undefined || !Object.hasOwn(user, field) || !equalJson(user[field], value)) throw new Error(`settings write was not accepted: ${field}`) }
async function unsetVerified(scope: SettingsScope<TeamPluginSettings>, field: string): Promise<void> { await scope.unset(field); const user = record(scope.getSnapshot().user); if (user !== undefined && Object.hasOwn(user, field)) throw new Error(`settings clear was not accepted: ${field}`) }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function equalJson(left: unknown, right: unknown): boolean { if (left === right) return true; if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => equalJson(entry, right[index])); const a = record(left); const b = record(right); if (a === undefined || b === undefined) return false; const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key])) }
function routeKey(provider: string | undefined, model: string | undefined): string { return provider === undefined || model === undefined || provider === '' || model === '' ? '' : JSON.stringify([provider, model]) }
function routeValue(route: TeamModelRoute): string { return routeKey(route.provider, route.model) }
function parseRoute(value: string): readonly [string, string] | undefined { if (value === '') return undefined; try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.length === 2 && parsed.every(part => typeof part === 'string' && part.trim() !== '') ? [parsed[0], parsed[1]] : undefined } catch { return undefined } }
function positiveInteger(value: string): boolean { return /^\d+$/u.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) }
function nonNegativeInteger(value: string): boolean { return /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) }
function parseNames(value: string): string[] { return [...new Set(value.split(/[\s,]+/u).map(name => name.trim()).filter(Boolean))].toSorted() }
function renderNames(names: readonly string[] | undefined): string { return names?.join('\n') ?? '' }
function validToolPolicy(...tiers: readonly string[]): boolean { const lists = tiers.map(parseNames); const all = lists.flat(); return all.every(name => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)) && all.length === new Set(all).size && lists.every(list => list.length <= 64) }

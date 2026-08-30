import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export const TEAM_SKILL_SETTINGS_NS = 'agent-swarm' as const

export const teamSkillSettingsEn = {
  title: 'Team Skills',
  description: 'Choose the Skills new Team Captains and members may load.',
  allowedSkills: 'Allowed Skills',
  hint: 'One Skill name per line. This is copied into newly created Teams; existing Teams do not change.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved. Create a new Team for this policy to take effect.',
  invalid: 'Skill names use lowercase letters, digits, and hyphens only.',
  unavailable: 'This plugin configuration is not available from the Host.',
} as const

export const teamSkillSettingsZh: Record<keyof typeof teamSkillSettingsEn, string> = {
  title: '团队可用 Skills',
  description: '指定新建团队的队长和成员可加载哪些 Skills。',
  allowedSkills: '允许使用的 Skills',
  hint: '每行一个 Skill 名称。保存后只会写入新建团队，现有团队不会被悄悄改变。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存；新建团队后生效。',
  invalid: 'Skill 名称只能由小写字母、数字和连字符组成。',
  unavailable: 'Host 尚未提供此插件的配置。',
}

export type TeamSkillSettingsKey = keyof typeof teamSkillSettingsEn

export interface TeamSkillSettingsFace {
  readonly scope: SettingsScope<{ allowedSkills?: string[] }>
}

export type TeamSkillSettingsProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof TEAM_SKILL_SETTINGS_NS>
  & InjectFace<TeamSkillSettingsFace>

export function TeamSkillSettingsCard(props: TeamSkillSettingsProps) {
  // SettingsScopeController methods rely on their instance state. React calls the
  // external-store callbacks as plain functions, so keep the controller receiver
  // intact instead of handing its methods to React unbound.
  const subscribe = useCallback((listener: () => void) => props.scope.subscribe(listener), [props.scope])
  const getSnapshot = useCallback(() => props.scope.getSnapshot(), [props.scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const initial = useMemo(() => ((snapshot.value?.allowedSkills ?? []).join('\n')), [snapshot.value?.allowedSkills])
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const names = draft.split(/[\n,]/).map(value => value.trim()).filter(Boolean)
  const valid = names.every(name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) && new Set(names).size === names.length
  if (snapshot.status !== 'ready') return null
  return (
    <li style={{ listStyle: 'none', border: '1px solid var(--dsh-color-border, #555)', borderRadius: 16, padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: 0 }}>{props.t('title')}</h3>
      <p style={{ marginTop: 6, opacity: 0.75 }}>{props.t('description')}</p>
      <label htmlFor="agent-swarm-allowed-skills" style={{ display: 'block', fontWeight: 600 }}>{props.t('allowedSkills')}</label>
      <textarea
        id="agent-swarm-allowed-skills"
        rows={6}
        value={draft}
        disabled={!snapshot.writable || saving}
        onChange={event => { setDraft(event.target.value); setSaved(false) }}
        style={{ width: '100%', marginTop: 8, boxSizing: 'border-box' }}
      />
      <p role={valid ? undefined : 'alert'} style={{ margin: '8px 0', color: valid ? undefined : 'var(--dsh-color-danger, #d44)' }}>
        {valid ? props.t('hint') : props.t('invalid')}
      </p>
      <button
        type="button"
        disabled={!snapshot.writable || saving || !valid}
        onClick={() => {
          void (async () => {
            setSaving(true)
            try {
              await props.scope.set('allowedSkills', names)
              setSaved(true)
            } finally { setSaving(false) }
          })()
        }}
      >{props.t(saving ? 'saving' : 'save')}</button>
      {saved ? <span role="status" style={{ marginLeft: 10 }}>{props.t('saved')}</span> : null}
    </li>
  )
}

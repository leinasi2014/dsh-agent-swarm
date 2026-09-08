import { useEffect, useId, useState } from 'react'
import type { TeamSettingsCatalog, TeamSkillSettingsProps } from './TeamSkillSettingsCard.js'

export interface TeamToolCatalogEntry { readonly name: string; readonly description: string }
export interface TeamToolPolicy { readonly allow: readonly string[]; readonly ask: readonly string[]; readonly deny: readonly string[] }
type Tier = 'inherit' | keyof TeamToolPolicy
const memberProtocol = new Set(['agent_swarm_submit_task', 'agent_swarm_send_message'])
const labels = { inherit: 'inheritTools', allow: 'allowTools', deny: 'denyTools', ask: 'askTools' } as const

export function validToolPolicy(policy: TeamToolPolicy): boolean {
  const lists = [policy.allow, policy.ask, policy.deny]
  const all = lists.flat()
  return all.every(name => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)) && all.length === new Set(all).size
    && lists.every(list => list.length <= 64) && [...policy.ask, ...policy.deny].every(name => !memberProtocol.has(name))
}

export function TeamToolPermissions(props: { readonly catalog: TeamSettingsCatalog; readonly sessionId: string | undefined; readonly policy: TeamToolPolicy; readonly editable: boolean; readonly t: TeamSkillSettingsProps['t']; readonly onChange: (policy: TeamToolPolicy) => void }) {
  const groupId = useId()
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [load, setLoad] = useState<{ sessionId: string; tools?: readonly TeamToolCatalogEntry[]; failed?: boolean }>()
  useEffect(() => {
    if (props.sessionId === undefined) return
    const sessionId = props.sessionId
    let live = true
    setLoad({ sessionId })
    void props.catalog.listTools(sessionId).then(tools => { if (live) setLoad({ sessionId, tools }) }, () => { if (live) setLoad({ sessionId, failed: true }) })
    return () => { live = false }
  }, [props.catalog, props.sessionId, refresh])
  const current = props.sessionId === load?.sessionId ? load : undefined
  const catalog = new Map((current?.tools ?? []).map(tool => [tool.name, tool]))
  const names = [...new Set([...catalog.keys(), ...props.policy.allow, ...props.policy.ask, ...props.policy.deny])].toSorted((a, b) => a.localeCompare(b))
  const visible = names.filter(name => `${name} ${catalog.get(name)?.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const select = (name: string, tier: Tier) => {
    const values = (key: keyof TeamToolPolicy) => [...props.policy[key].filter(value => value !== name), ...(tier === key ? [name] : [])].toSorted()
    props.onChange({ allow: values('allow'), ask: values('ask'), deny: values('deny') })
  }
  return <section>
    <p>{props.t('toolsHint')}</p>
    {props.sessionId === undefined ? <p role="status">{props.t('selectToolWorkspace')}</p> : current?.failed ? <p role="alert">{props.t('toolsUnavailable')}</p> : current?.tools === undefined ? <p role="status">{props.t('toolsLoading')}</p> : null}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}><input aria-label={props.t('searchTools')} placeholder={props.t('searchTools')} value={query} onChange={event => { setQuery(event.target.value) }} /><button type="button" disabled={props.sessionId === undefined} onClick={() => { setRefresh(value => value + 1) }}>{props.t('refreshTools')}</button></div>
    {query.trim() !== '' && visible.length === 0 && (current?.tools !== undefined || names.length > 0) ? <p role="status">{props.t('noMatchingTools')}</p> : null}
    {query.trim() === '' && current?.tools?.length === 0 && names.length === 0 ? <p role="status">{props.t('noTools')}</p> : null}
    <div style={{ display: 'grid', gap: 10, maxHeight: 420, overflowY: 'auto', marginTop: 12 }}>
      {visible.map(name => {
        const entry = catalog.get(name)
        const tier: Tier = props.policy.deny.includes(name) ? 'deny' : props.policy.ask.includes(name) ? 'ask' : props.policy.allow.includes(name) ? 'allow' : 'inherit'
        return <fieldset key={name} data-tool-name={name} style={{ border: '1px solid var(--dsh-color-border, #555)', borderRadius: 10, padding: 12 }}>
          <legend>{name}</legend>
          <p style={{ margin: '0 0 10px', opacity: 0.72 }}>{entry?.description ?? props.t('toolMissing')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>{(['inherit', 'allow', 'deny', 'ask'] as const).map(value => <label key={value}><input type="radio" name={`${groupId}-${name}`} value={value} checked={tier === value} disabled={!props.editable || (memberProtocol.has(name) && (value === 'deny' || value === 'ask'))} onChange={() => { select(name, value) }} /> {props.t(labels[value])}</label>)}</div>
          {memberProtocol.has(name) ? <small>{props.t('protocolToolsHint')}</small> : null}
        </fieldset>
      })}
    </div>
  </section>
}

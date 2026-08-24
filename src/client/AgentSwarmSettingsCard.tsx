import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  AgentSwarmSettingsFace,
  AgentSwarmSettingsField,
  AgentSwarmSettingsFieldState,
} from './agent-swarm-settings-controller.js'
import type { AgentSwarmSettingsLocaleKey } from './agent-swarm-settings-locales.js'
import AGENT_SWARM_SETTINGS_STYLES from './agent-swarm-settings-styles.js'

export type AgentSwarmSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'swarm.settings'>
  & InjectFace<AgentSwarmSettingsFace>

/** Official Plugins configurable-tab contribution for Agent Swarm. */
export function AgentSwarmSettingsCard(props: AgentSwarmSettingsCardProps) {
  const [open, setOpen] = useState(false)
  const state = props.useAgentSwarmSettings(value => value)
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  return (
    <li data-swarm-settings-card data-open={open ? 'true' : undefined}>
      <style>{AGENT_SWARM_SETTINGS_STYLES}</style>
      <button
        type="button"
        data-swarm-settings-header
        aria-expanded={open}
        aria-label={props.t(open ? 'collapse' : 'expand')}
        onClick={() => { setOpen(!open) }}
      >
        <span data-swarm-settings-head-copy>
          <span data-swarm-settings-title>{props.t('title')}</span>
          <span data-swarm-settings-description>{props.t('description')}</span>
        </span>
        {state.dirty ? <span data-swarm-settings-pending>{props.t('unsaved')}</span> : null}
        <span data-swarm-settings-chevron aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div data-swarm-settings-body>
          {!state.writable ? <p data-swarm-settings-readonly role="status">{props.t('readOnly')}</p> : null}
          <fieldset data-swarm-settings-group>
            <legend data-swarm-settings-legend>{props.t('memoryGroup')}</legend>
            <BooleanField
              field="memorySemanticEnabled"
              label={props.t('semanticEnabled')}
              hint={props.t('semanticEnabledHint')}
              value={state.fields.memorySemanticEnabled}
              disabled={disabled}
              onEdit={props.edit}
              onReset={props.resetField}
              t={props.t}
            />
            <TextField field="memorySemanticProvider" label={props.t('semanticProvider')} hint={props.t('semanticProviderHint')} invalidHint={props.t('semanticRouteRequired')} value={state.fields.memorySemanticProvider} disabled={disabled} {...props} />
            <TextField field="memorySemanticModel" label={props.t('semanticModel')} hint={props.t('semanticModelHint')} invalidHint={props.t('semanticRouteRequired')} value={state.fields.memorySemanticModel} disabled={disabled} {...props} />
            <TextField field="memoryQueryMaxCandidates" label={props.t('queryCandidates')} hint={props.t('queryCandidatesHint')} invalidHint={props.t('invalidNumber')} value={state.fields.memoryQueryMaxCandidates} numeric disabled={disabled} {...props} />
            <TextField field="memoryQueryTimeoutMs" label={props.t('queryTimeout')} hint={props.t('queryTimeoutHint')} invalidHint={props.t('invalidNumber')} value={state.fields.memoryQueryTimeoutMs} numeric disabled={disabled} {...props} />
          </fieldset>
          <fieldset data-swarm-settings-group>
            <legend data-swarm-settings-legend>{props.t('memberGroup')}</legend>
            <TextField field="memberProvider" label={props.t('memberProvider')} hint={props.t('memberProviderHint')} value={state.fields.memberProvider} disabled={disabled} {...props} />
            <TextField field="memberLlmProvider" label={props.t('memberLlmProvider')} hint={props.t('memberLlmProviderHint')} value={state.fields.memberLlmProvider} disabled={disabled} {...props} />
            <TextField field="memberModel" label={props.t('memberModel')} hint={props.t('memberModelHint')} value={state.fields.memberModel} disabled={disabled} {...props} />
            <TextField field="memberDenyTools" label={props.t('denyTools')} hint={props.t('denyToolsHint')} value={state.fields.memberDenyTools} disabled={disabled} {...props} />
            <TextField field="memberSkills" label={props.t('skills')} hint={props.t('skillsHint')} value={state.fields.memberSkills} disabled={disabled} {...props} />
          </fieldset>
          <div data-swarm-settings-footer>
            {state.failed ? <p data-swarm-settings-failed role="status">{props.t('saveFailed')}</p> : null}
            <button type="button" data-swarm-settings-action="discard" disabled={!state.dirty || state.saving} onClick={props.discard}>{props.t('discard')}</button>
            <button type="button" data-swarm-settings-action="save" disabled={!state.dirty || state.invalid || state.saving} onClick={props.save}>{props.t(state.saving ? 'saving' : 'save')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function BooleanField(props: {
  field: AgentSwarmSettingsField
  label: string
  hint: string
  value: AgentSwarmSettingsFieldState
  disabled: boolean
  onEdit: (field: AgentSwarmSettingsField, text: string) => void
  onReset: (field: AgentSwarmSettingsField) => void
  t: (key: AgentSwarmSettingsLocaleKey) => string
}) {
  return (
    <div data-swarm-settings-field>
      <div data-swarm-settings-field-head>
        <label data-swarm-settings-toggle>
          <input type="checkbox" checked={props.value.text === 'true'} disabled={props.disabled} onChange={event => { props.onEdit(props.field, event.target.checked ? 'true' : 'false') }} />
          <span>{props.label}</span>
        </label>
        {props.value.overridden ? <span data-swarm-settings-badge>{props.t('overridden')}</span> : null}
        {props.value.overridden ? <button type="button" data-swarm-settings-reset disabled={props.disabled} onClick={() => { props.onReset(props.field) }}>{props.t('reset')}</button> : null}
      </div>
      <p data-swarm-settings-hint>{props.hint}</p>
    </div>
  )
}

function TextField(props: {
  field: AgentSwarmSettingsField
  label: string
  hint: string
  invalidHint?: string
  value: AgentSwarmSettingsFieldState
  numeric?: boolean
  disabled: boolean
  t: (key: AgentSwarmSettingsLocaleKey) => string
  edit: (field: AgentSwarmSettingsField, text: string) => void
  resetField: (field: AgentSwarmSettingsField) => void
}) {
  return (
    <div data-swarm-settings-field>
      <div data-swarm-settings-field-head>
        <label data-swarm-settings-label htmlFor={`swarm-settings-${props.field}`}>{props.label}</label>
        {props.value.overridden ? <span data-swarm-settings-badge>{props.t('overridden')}</span> : null}
        {props.value.overridden ? <button type="button" data-swarm-settings-reset disabled={props.disabled} onClick={() => { props.resetField(props.field) }}>{props.t('reset')}</button> : null}
      </div>
      <input
        id={`swarm-settings-${props.field}`}
        data-swarm-settings-input
        type="text"
        inputMode={props.numeric === true ? 'numeric' : undefined}
        aria-invalid={props.value.invalid || undefined}
        value={props.value.text}
        disabled={props.disabled}
        onChange={event => { props.edit(props.field, event.target.value) }}
      />
      <p data-swarm-settings-hint data-invalid={props.value.invalid ? 'true' : undefined}>{props.value.invalid ? props.invalidHint ?? props.t('invalidNumber') : props.hint}</p>
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'swarm.settings': AgentSwarmSettingsLocaleKey
  }
}

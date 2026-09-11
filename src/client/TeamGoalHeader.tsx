import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { GoalController, GoalState } from './goal-controller.js'
import { goalDefinitionFromDraft } from './goal-draft-store.js'
import { goalDefinitionSchema, GOAL_INTERVAL_MIN_MS, GOAL_INTERVAL_MAX_MS } from '../shared/goal-lifecycle.js'

type Translation = TranslateNS<typeof TEAM_DASHBOARD_NS>
interface Props { readonly goal: GoalController; readonly teamId: string; readonly t: Translation }

/** One authoritative goal snapshot, with local drafts kept distinct from committed coordination. */
export function TeamGoalHeader({ goal, teamId, t }: Props) {
  const state = useSyncExternalStore(goal.subscribe, goal.getSnapshot, goal.getSnapshot)
  const id = useId(), toggle = useRef<HTMLButtonElement>(null), modalBox = useRef<HTMLDivElement>(null), closing = useRef(false)
  const sameTeam = state.selection?.team === teamId, snapshot = sameTeam ? state.response?.snapshot : undefined
  const lifecycle = snapshot?.lifecycle
  const available = sameTeam && state.verified && snapshot?.eligibility.state === 'available'
  const canOperate = available && !state.pending && !state.sending && ['ready', 'saving'].includes(state.draftStatus)
  const action = lifecycle?.phase === 'paused' ? 'resume' : lifecycle?.phase === 'draft' ? 'start' : lifecycle?.phase === 'running' || lifecycle?.phase === 'waiting' ? 'pause' : undefined
  const close = (): void => { closing.current = true; goal.closeEditor(); goal.setExpanded(false); toggle.current?.focus() }
  // primitives.Modal ships no focus trap, auto-focus, or focus restore (verified against the installed lib): supply exactly that, in the PublicImages sample pattern. Focus lands on the goal textarea (legacy editor-focus semantics), first control as fallback.
  useEffect(() => {
    if (!sameTeam || !state.expanded) return
    closing.current = false
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () => [...(modalBox.current?.querySelectorAll<HTMLElement>('button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled])') ?? [])]
    const first = () => modalBox.current?.querySelector<HTMLTextAreaElement>('[data-goal-field="text"]') ?? focusables()[0]
    first()?.focus()
    // While open, nothing escapes the ring (Shift+Tab onto the background toggle included); the post-close restore focuses explicitly via close() and is exempt through the closing flag.
    const contain = (event: FocusEvent): void => { const box = modalBox.current; if (!closing.current && box !== null && event.target instanceof Node && !box.contains(event.target)) first()?.focus() }
    document.addEventListener('focusin', contain)
    return () => { document.removeEventListener('focusin', contain); if (previous !== null && previous.isConnected) previous.focus() }
  }, [sameTeam, state.expanded])
  return <section data-swarm-goal>
    <style>{`
      [data-swarm-goal] { min-width:0; font-size:12px; }
      [data-swarm-goal] button { font:inherit; color:inherit; cursor:pointer; padding:5px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-1); }
      [data-swarm-goal] button:disabled { opacity:.5; cursor:default; }
      [data-swarm-goal] [data-goal-toggle] { display:block; max-width:min(36cqi,320px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; }
      .swarm-goal-modal { box-sizing:border-box; width:min(560px,94vw); }
      [data-goal-modal] { display:grid; gap:8px; max-height:min(70dvh,70vh); overflow:auto; overscroll-behavior:contain; box-sizing:border-box; padding:20px; font:13px system-ui; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); border-radius:12px; box-shadow:0 8px 22px #0002; }
      [data-goal-modal]>header { display:flex; justify-content:space-between; align-items:center; gap:12px; }
      [data-goal-modal]>header strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      [data-goal-modal] [data-goal-details], [data-goal-modal] form { display:grid; gap:8px; }
      [data-goal-modal] button { font:inherit; color:inherit; cursor:pointer; padding:6px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
      [data-goal-modal] button:disabled { opacity:.5; cursor:default; }
      [data-goal-modal] label { display:grid; gap:4px; }
      [data-goal-modal] textarea, [data-goal-modal] input, [data-goal-modal] select { box-sizing:border-box; width:100%; min-width:0; font:inherit; padding:6px; color:inherit; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:5px; }
      [data-goal-modal] textarea { resize:vertical; }
      [data-goal-modal] p, [data-goal-modal] dd { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
      [data-goal-modal] dl { display:grid; gap:4px; margin:0; } [data-goal-modal] dt { font-weight:600; }
      [data-goal-modal] small { color:var(--dsw-alias-label-secondary); }
    `}</style>
    <button ref={toggle} type="button" data-goal-toggle aria-expanded={sameTeam && state.expanded} aria-controls={id}
      title={snapshot?.text || t(state.expanded ? 'goal.collapse' : 'goal.expand')} disabled={!sameTeam}
      onClick={() => { if (state.expanded) close(); else { goal.setExpanded(true); goal.beginEdit() } }}>{t('goal.entry')}{lifecycle ? ` · ${t(`goal.${lifecycle.phase}`)}` : ''}</button>
    {sameTeam && state.expanded ? <Modal open headless title={t('goal.edit')} onClose={close} className="swarm-goal-modal">
      <div ref={modalBox} id={id} data-goal-modal>
        <header><strong>{t('goal.edit')}</strong><button type="button" data-goal-close onClick={close}>{t('goal.close')}</button></header>
        {state.editing ? <GoalEditor goal={goal} state={state} t={t} close={close} /> : null}
        <div data-goal-details>
          {!state.verified ? <p role="status">{t('reconnecting')}</p> : null}
          {snapshot ? <>
            <p data-goal-text>{snapshot.text || t('public.goalEmpty')}</p>
            {lifecycle ? <dl>
              <dt>{t('goal.criteria')}</dt><dd>{lifecycle.acceptanceCriteria || '—'}</dd>
              <dt>{t('goal.constraints')}</dt><dd>{lifecycle.constraints || '—'}</dd>
              <dt>{t('goal.mode')}</dt><dd>{t(`goal.${lifecycle.mode}`)}{lifecycle.mode === 'maintenance' ? ` · ${(lifecycle.intervalMs ?? 0) / 1000}s` : ''}</dd>
              {lifecycle.nextAction ? <><dt>{t('goal.nextAction')}</dt><dd>{lifecycle.nextAction}</dd></> : null}
              {lifecycle.nextDueAt !== undefined ? <><dt>{t('goal.nextDue')}</dt><dd><time dateTime={new Date(lifecycle.nextDueAt).toISOString()}>{new Date(lifecycle.nextDueAt).toLocaleString()}</time></dd></> : null}
              {lifecycle.lastCoordination ? <><dt>{t('goal.coordinated')}</dt><dd data-goal-coordinated>{lifecycle.lastCoordination.summary}</dd></> : null}
              {lifecycle.completion ? <><dt>{t('goal.completion')}</dt><dd data-goal-completion>{lifecycle.completion.summary}</dd></> : null}
            </dl> : null}
            {lifecycle?.currentTrigger ? <p role="status">{t('goal.coordinationPending')}</p> : null}
            <p data-goal-budget>{t('goal.used')}: {snapshot.budget.usedTokens} · {t('goal.remaining')}: {snapshot.budget.tokenLimit === undefined ? t('goal.unlimited') : Math.max(0, snapshot.budget.tokenLimit - snapshot.budget.usedTokens)}</p>
            <p data-goal-cleanup>{t('goal.cleanup', { tasks: snapshot.remainingActiveTasks, attempts: snapshot.remainingActiveAttempts })}</p>
            {snapshot.waitingReason ? <p role="status">{t(`goal.wait.${snapshot.waitingReason}`)}</p> : null}
            {!available ? <p role="status">{t('goal.unavailable')}</p> : null}
            <div>{action ? <button type="button" data-goal-primary disabled={!canOperate || (action !== 'pause' && snapshot.waitingReason === 'unsupported')}
              onClick={() => { void goal.control(action) }}>{t(`goal.${action}`)}</button> : null} <button type="button" data-goal-edit disabled={!available || !['ready', 'saving'].includes(state.draftStatus)} onClick={() => { goal.beginEdit() }}>{t('goal.edit')}</button></div>
          </> : <p role="status">{t('loading')}</p>}
          {state.pending ? <p role="status" data-goal-pending>{t('goal.unknown')} <button type="button" disabled={!state.verified || state.sending} onClick={() => { void goal.recover() }}>{t('goal.recover')}</button></p> : null}
          {state.outcome?.state === 'committed' ? <p role="status" data-goal-saved>{t('goal.saved')}</p> : state.outcome?.state === 'expired' ? <p role="alert" data-goal-expired>{t('goal.expired')}</p> : null}
          {state.error ? <p role="alert">{state.error}</p> : null}
          {state.draftStatus !== 'ready' ? <p data-goal-draft-state role={['conflict', 'unavailable'].includes(state.draftStatus) ? 'alert' : 'status'}>{t(state.draftStatus === 'loading' ? 'public.draftLoading' : state.draftStatus === 'saving' ? 'public.draftSaving' : state.draftStatus === 'conflict' ? 'public.draftConflict' : 'public.draftUnavailable')}
            {state.draftStatus === 'unavailable' ? <button type="button" onClick={() => { void goal.retryStorage() }}>{t('public.retryDraft')}</button> : state.draftStatus === 'conflict' ? <button type="button" onClick={() => { void goal.useStoredDraft() }}>{t('public.useStoredDraft')}</button> : null}</p> : null}
        </div>
      </div>
    </Modal> : null}
  </section>
}

function GoalEditor({ goal, state, t, close }: { goal: GoalController; state: GoalState; t: Translation; close: () => void }) {
  const text = useRef<HTMLTextAreaElement>(null), draft = state.draft, snapshot = state.response?.snapshot
  useEffect(() => { text.current?.focus() }, [state.selection?.key]) // 编辑迟到开启（先开窗后 beginEdit）时焦点同样进目标输入框
  const budget = draft.tokenLimit.trim(), validBudget = budget === '' || (Number.isSafeInteger(Number(budget)) && Number(budget) > 0)
  const valid = validBudget && goalDefinitionSchema.safeParse(goalDefinitionFromDraft(draft)).success
  const stale = draft.baseLifecycleRevision !== (snapshot?.lifecycle?.revision ?? 0)
  const canSave = valid && !stale && state.verified && snapshot?.eligibility.state === 'available' && !state.pending && !state.sending && ['ready', 'saving'].includes(state.draftStatus)
  const phase = snapshot?.lifecycle?.phase
  const canStart = canSave && snapshot?.waitingReason !== 'unsupported' && (draft.mode !== 'maintenance' || (budget !== '' && Number(budget) > (snapshot?.budget.usedTokens ?? 0)))
  return <form data-goal-form aria-label={t('goal.edit')} onSubmit={event => { event.preventDefault(); if (canSave) void goal.save(false) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    {(['text', 'acceptanceCriteria', 'constraints'] as const).map(field => <label key={field}>{t(field === 'text' ? 'goal.text' : field === 'constraints' ? 'goal.constraints' : 'goal.criteria')}
      <textarea ref={field === 'text' ? text : undefined} data-goal-field={field} required={field === 'text'} rows={field === 'text' ? 3 : 2} value={draft[field]} disabled={state.draftStatus === 'loading'} onChange={event => { goal.edit(field, event.currentTarget.value) }} />
      <small>{[...draft[field].trim()].length}/4096</small></label>)}
    <label>{t('goal.mode')}<select data-goal-mode value={draft.mode} onChange={event => { goal.edit('mode', event.currentTarget.value) }}><option value="finite">{t('goal.finite')}</option><option value="maintenance">{t('goal.maintenance')}</option></select></label>
    {draft.mode === 'maintenance' ? <label>{t('goal.interval')}<input data-goal-interval type="number" min={GOAL_INTERVAL_MIN_MS / 1000} max={GOAL_INTERVAL_MAX_MS / 1000} step="any" value={draft.intervalSeconds} onChange={event => { goal.edit('intervalSeconds', event.currentTarget.value) }} /></label> : null}
    <label>{t('goal.tokenLimit')}<input data-goal-token-limit type="number" min={1} step={1} value={draft.tokenLimit} onChange={event => { goal.edit('tokenLimit', event.currentTarget.value) }} /><small>{t('goal.budgetHint')}</small></label>
    {!valid ? <p role="alert">{t('goal.invalid')}</p> : null}
    {stale ? <p role="alert">{t('goal.staleDraft')}</p> : null}
    <button type="button" disabled={!state.verified || !!state.pending || state.sending} onClick={() => { goal.beginEdit(true) }}>{t('goal.latest')}</button>
    <div><button type="submit" data-goal-save disabled={!canSave}>{t('goal.save')}</button> {phase === undefined || phase === 'draft' || phase === 'paused' || phase === 'achieved' ? <button type="button" data-goal-save-start disabled={!canStart} onClick={() => { void goal.save(true) }}>{t(phase === 'paused' ? 'goal.saveResume' : 'goal.saveStart')}</button> : null} <button type="button" onClick={close}>{t('goal.close')}</button></div>
  </form>
}

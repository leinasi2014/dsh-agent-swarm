import { useEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export function TeamRetirementMenu({ x, y, archived, close, choose, t }: {
  x: number; y: number; archived: boolean; close(): void; choose(action: 'archive' | 'delete' | 'history'): void;
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>;
}) {
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { trigger?.focus() }
  }, [])
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')]
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[index]?.focus()
  }
  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 9999 }} onMouseDown={close} onContextMenu={event => { event.preventDefault(); close() }}>
    <style>{`.swarm-team-menu{position:fixed;box-sizing:border-box;width:210px;padding:5px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202124);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:10px;box-shadow:0 8px 32px #0003;font:13px/1.4 sans-serif}.swarm-team-menu button{display:block;width:100%;padding:10px 12px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer}.swarm-team-menu button:hover,.swarm-team-menu button:focus-visible{background:color-mix(in srgb,currentColor 8%,transparent);outline:none}.swarm-team-menu [data-danger]{color:#bf3933}`}</style>
    <div ref={menu} className="swarm-team-menu" role="menu" aria-label={t('retirement.more')} data-team-retirement-menu
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 218)), top: Math.max(8, Math.min(y, window.innerHeight - 160)) }} onMouseDown={event => { event.stopPropagation() }} onKeyDown={key}>
      {archived ? <button type="button" role="menuitem" onClick={() => { choose('history') }}>{t('retirement.history')}</button>
        : <button type="button" role="menuitem" onClick={() => { choose('archive') }}>{t('retirement.archive')}</button>}
      <button type="button" role="menuitem" data-danger onClick={() => { choose('delete') }}>{t('retirement.delete')}</button>
    </div>
  </div>, document.body)
}

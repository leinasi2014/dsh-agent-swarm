import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

/** Full text is independent of the message fold and reachable without hover. */
export function PublicQuote({ text, targetId, t }: { text: string; targetId?: string | undefined; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false), [placement, setPlacement] = useState({ above: false, height: 240, left: 0, edge: 0, width: 280 })
  const pinned = useRef(false), skipFocus = useRef(false)
  const show = () => {
    const rect = root.current?.getBoundingClientRect(), box = root.current?.closest('.swarm-public')?.getBoundingClientRect()
    if (rect && box) {
      const above = rect.top - Math.max(8, box.top), below = Math.min(innerHeight - 8, box.bottom) - rect.bottom
      setPlacement({ above: above > below, height: Math.max(64, Math.min(240, Math.max(above, below) - 84)), left: Math.max(8, rect.left), edge: above > below ? innerHeight - rect.top : rect.bottom, width: Math.min(600, rect.width, innerWidth - 16) })
    }
    setOpen(true)
  }
  const close = () => { pinned.current = false; setOpen(false); skipFocus.current = true; trigger.current?.focus({ preventScroll: true }); skipFocus.current = false }
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && (panel.current?.contains(event.target)
        || (event.type === 'scroll' && !event.target.contains(root.current)))) return
      pinned.current = false; setOpen(false)
    }
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', dismiss, true)
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true) }
  }, [open])
  return <div className="swarm-public__quote" ref={root}
    onPointerEnter={event => { if (event.pointerType !== 'touch') show() }}
    onPointerLeave={() => { if (!pinned.current && !root.current?.contains(document.activeElement) && !panel.current?.contains(document.activeElement)) setOpen(false) }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !panel.current?.contains(event.relatedTarget)) { pinned.current = false; setOpen(false) } }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button type="button" ref={trigger} data-public-quote-trigger aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onKeyDown={event => { if (event.key === 'Tab' && open && !event.shiftKey) { event.preventDefault(); panel.current?.querySelector<HTMLElement>('a,button')?.focus({ preventScroll: true }) } }}
      onFocus={() => { if (!skipFocus.current) show() }} onClick={() => { pinned.current = !pinned.current; if (pinned.current) show(); else setOpen(false) }}>{text}</button>
    {open ? createPortal(<div id={id} ref={panel} role="dialog" aria-label={t('public.reply')} className="swarm-public__quote-pop" style={{ position: 'fixed', left: placement.left, width: placement.width, top: placement.above ? 'auto' : placement.edge, bottom: placement.above ? placement.edge : 'auto' }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('a,button,[tabindex="0"]')]
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); trigger.current?.focus({ preventScroll: true }) }
        else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); close() }
      }}>
      <div className="swarm-public__quote-actions">{targetId === undefined ? <span>{t('public.replyOutside')}</span> : <a href={`#swarm-message-${targetId}`} onClick={event => {
        event.preventDefault(); const box = root.current?.closest('.swarm-public')?.querySelector<HTMLElement>('.swarm-public__messages')
        const target = [...box?.querySelectorAll<HTMLElement>('[data-public-message]') ?? []].find(row => row.dataset['publicMessage'] === targetId)
        close(); if (box && target) { box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top; box.dispatchEvent(new Event('scroll')); target.focus({ preventScroll: true }) }
      }}>{t('public.openOriginal')}</a>}<button type="button" onClick={close}>{t('public.closeQuote')}</button></div>
      <div data-public-quote-full tabIndex={0} style={{ maxHeight: placement.height }}>{text}</div>
    </div>, document.body) : null}
  </div>
}

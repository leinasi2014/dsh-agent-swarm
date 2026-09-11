import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export function PublicTextFold({ children, folds, foldKey, t }: { children: ReactNode; folds?: Map<string, boolean> | undefined; foldKey: string; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const id = useId(), body = useRef<HTMLDivElement>(null), [expanded, setExpanded] = useState(folds?.get(foldKey) ?? false), [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const node = body.current!
    const measure = () => { setLong(node.scrollHeight > parseFloat(getComputedStyle(node).lineHeight) * 6 + 1) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => { observer?.disconnect() }
  }, [children])
  return <>
    <div ref={body} id={id} className="swarm-public__text" data-public-text={foldKey} data-expanded={expanded}>{children}</div>
    {long ? <button type="button" className="swarm-public__fold" data-public-expand aria-expanded={expanded} aria-controls={id} onClick={() => {
      const article = body.current?.closest<HTMLElement>('[data-public-message]'), box = article?.closest<HTMLElement>('.swarm-public__messages')
      if (expanded && article && box && article.getBoundingClientRect().top < box.getBoundingClientRect().top) {
        // A long expanded message may put its fold control far below its heading.
        // Clamp the saved anchor to the heading before the body becomes shorter.
        box.scrollTop += article.getBoundingClientRect().top - box.getBoundingClientRect().top
        box.dispatchEvent(new Event('scroll'))
      }
      folds?.set(foldKey, !expanded); setExpanded(value => !value)
    }}>{t(expanded ? 'public.collapseText' : 'public.expandText')}</button> : null}
  </>
}

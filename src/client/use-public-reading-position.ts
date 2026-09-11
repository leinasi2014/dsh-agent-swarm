import { useLayoutEffect, useRef } from 'react'

interface Position { top: number; anchor?: string | undefined; offset?: number | undefined }
const rows = '[data-public-message], [data-public-text], [data-work-event], [data-work-heading]'
const identity = (node: HTMLElement): string => node.dataset['publicText'] !== undefined ? `text:${node.dataset['publicText']}` : node.dataset['publicMessage'] !== undefined ? `message:${node.dataset['publicMessage']}` : node.dataset['workEvent'] !== undefined ? `work:${node.dataset['workEvent']}` : 'activity'

/** Ephemeral reading preferences only; no history cache and no automatic tail following. */
export function usePublicReadingPosition(key: string | undefined, enabled: boolean) {
  const box = useRef<HTMLDivElement>(null), saved = useRef(new Map<string, Position>())
  const restore = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    const node = box.current
    if (!node || !enabled || key === undefined) return
    let appliedTop: number | undefined
    const capture = (event?: Event) => {
      // A native scroll event from our restoration may arrive after another
      // image layout. It must not replace the original reading offset.
      if (event?.isTrusted && appliedTop !== undefined && Math.abs(node.scrollTop - appliedTop) < 0.5) return
      appliedTop = undefined
      const viewport = node.getBoundingClientRect(), top = viewport.top
      const visible = [...node.querySelectorAll<HTMLElement>(rows)].filter(row => { const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.bottom > top + 1 && rect.top < viewport.bottom })
      // Prefer the text being read over its whole article: a preceding image can
      // finish loading inside that same article without moving the article top.
      const anchor = visible.find(row => !visible.some(child => child !== row && row.contains(child)))
      saved.current.set(key, { top: node.scrollTop, anchor: anchor && identity(anchor), offset: anchor && anchor.getBoundingClientRect().top - top })
    }
    const apply = () => {
      const position = saved.current.get(key)
      if (position === undefined) { node.scrollTop = 0; capture(); return }
      const anchor = [...node.querySelectorAll<HTMLElement>(rows)].find(row => identity(row) === position.anchor)
      node.scrollTop = anchor === undefined ? position.top : node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - (position.offset ?? 0)
      appliedTop = node.scrollTop
    }
    restore.current = apply
    apply()
    node.addEventListener('scroll', capture, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { apply() })
    const observe = () => { resize?.disconnect(); resize?.observe(node); for (const child of node.children) resize?.observe(child) }
    observe()
    const mutations = new MutationObserver(() => { observe(); apply() })
    mutations.observe(node, { childList: true, subtree: true })
    return () => { node.removeEventListener('scroll', capture); resize?.disconnect(); mutations.disconnect(); restore.current = undefined }
  }, [key, enabled])
  useLayoutEffect(() => { restore.current?.() })
  return box
}

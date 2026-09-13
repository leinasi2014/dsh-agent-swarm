import { useLayoutEffect, useRef } from 'react'

interface Position { top: number; anchor?: string | undefined; offset?: number | undefined }
interface ReadingPosition { position?: Position; followTail: boolean }
export type PublicReadingPositions = Map<string, ReadingPosition>
const rows = '[data-public-message], [data-public-text]'
const identity = (node: HTMLElement): string => node.dataset['publicText'] !== undefined ? `text:${node.dataset['publicText']}` : `message:${node.dataset['publicMessage']}`

/** A new reading key starts at the tail; revisiting it retains its reading anchor. */
export function usePublicReadingPosition(key: string | undefined, enabled: boolean, retained?: PublicReadingPositions) {
  const box = useRef<HTMLDivElement>(null)
  const restore = useRef<(() => void) | undefined>(undefined)
  const local = useRef(new Map<string, ReadingPosition>())
  const positions = retained ?? local.current
  useLayoutEffect(() => {
    const node = box.current
    if (!node || !enabled || key === undefined) return
    let appliedTop: number | undefined
    const reading = positions.get(key) ?? { followTail: true }
    positions.set(key, reading)
    const capture = (event?: Event) => {
      // A native scroll event from our restoration may arrive after another
      // image layout. It must not replace the original reading offset.
      if (event?.isTrusted && appliedTop !== undefined && Math.abs(node.scrollTop - appliedTop) < 0.5) return
      appliedTop = undefined
      if (node.querySelector(rows) === null) return
      reading.followTail = node.scrollHeight - node.clientHeight - node.scrollTop < 2
      const viewport = node.getBoundingClientRect(), top = viewport.top
      const visible = [...node.querySelectorAll<HTMLElement>(rows)].filter(row => { const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.bottom > top + 1 && rect.top < viewport.bottom })
      // Prefer the text being read over its whole article: a preceding image can
      // finish loading inside that same article without moving the article top.
      const anchor = visible.find(row => !visible.some(child => child !== row && row.contains(child)))
      reading.position = { top: node.scrollTop, anchor: anchor && identity(anchor), offset: anchor && anchor.getBoundingClientRect().top - top }
    }
    const apply = () => {
      // Pending switches and asynchronous latest responses can render no rows.
      // Keep the reading key's tail preference or manual anchor until rows return.
      if (node.querySelector(rows) === null) return
      if (reading.followTail) { node.scrollTop = node.scrollHeight; appliedTop = node.scrollTop; return }
      if (reading.position === undefined) { capture(); return }
      const current = reading.position
      const anchor = [...node.querySelectorAll<HTMLElement>(rows)].find(row => identity(row) === current.anchor)
      node.scrollTop = anchor === undefined ? current.top : node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - (current.offset ?? 0)
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
  }, [key, enabled, positions])
  useLayoutEffect(() => { restore.current?.() })
  return box
}

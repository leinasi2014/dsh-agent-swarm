import { Modal, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Click-owned profile layer. The directory remains the only selection authority. */
export function MemberProfileSurface({ anchorRef, rootRef, close, title, children }: {
  anchorRef: RefObject<HTMLButtonElement | null>; rootRef: RefObject<HTMLDivElement>; close: (restore: boolean) => void; title: string; children: (close: () => void) => ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null), closing = useRef(false), anchorPointer = useRef(false)
  const dismiss = useCallback((restore: boolean): void => { closing.current = true; close(restore) }, [close])
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 640)
  const [side, setSide] = useState<'top' | 'bottom'>('bottom')
  const position = useAnchoredPosition({ open: !narrow, anchorRef, panelRef, side, gap: 8, margin: 12 })
  useDismissOnOutsidePointer(anchorRef, !narrow, () => { dismiss(false) }, panelRef)
  const positioned = narrow || position !== null
  useLayoutEffect(() => {
    if (!positioned) return
    const heading = (): HTMLElement | null => panelRef.current?.querySelector('[data-profile-heading]') ?? null
    heading()?.focus()
    const focus = (event: FocusEvent): void => {
      if (closing.current || !(event.target instanceof Node) || panelRef.current?.contains(event.target)) return
      if (narrow) heading()?.focus()
      else if (!(anchorPointer.current && anchorRef.current?.contains(event.target))) dismiss(false)
    }
    // A pointer activation must reach the trigger's click toggle before dismissal.
    // Keyboard focus leaving the portal has no trigger exemption.
    const pointer = (event: PointerEvent): void => { anchorPointer.current = event.target instanceof Node && anchorRef.current?.contains(event.target) === true }
    const release = (): void => { anchorPointer.current = false }
    document.addEventListener('focusin', focus)
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', release, true)
    document.addEventListener('keydown', release, true)
    return () => {
      release(); document.removeEventListener('focusin', focus)
      document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', release, true); document.removeEventListener('keydown', release, true)
    }
  }, [narrow, positioned, dismiss, anchorRef])
  useEffect(() => {
    const anchor = anchorRef.current
    const measure = (): void => {
      setNarrow(window.innerWidth <= 640)
      if (!anchor?.isConnected) { dismiss(false); return }
      const rect = anchor.getBoundingClientRect()
      const height = window.visualViewport?.height ?? window.innerHeight
      // A zero rect can occur before layout; do not turn it into a visibility claim.
      if (rect.width > 0 && rect.height > 0) {
        let top = 0, bottom = height, left = 0, right = window.innerWidth
        for (let node = anchor.parentElement; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (/(auto|scroll|hidden|clip)/u.test(`${style.overflow} ${style.overflowY} ${style.overflowX}`)) {
            const box = node.getBoundingClientRect()
            top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); left = Math.max(left, box.left); right = Math.min(right, box.right)
          }
        }
        if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) { dismiss(false); return }
      }
      const below = height - rect.bottom - 20, above = rect.top - 20
      setSide(below < (panelRef.current?.getBoundingClientRect().height ?? 0) && above > below ? 'top' : 'bottom')
    }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (anchor) resize?.observe(anchor)
    if (panelRef.current) resize?.observe(panelRef.current)
    const intersection = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => !entry.isIntersecting)) dismiss(false)
    })
    if (anchor) intersection?.observe(anchor)
    const mutation = new MutationObserver(() => { if (!anchor?.isConnected) dismiss(false) })
    if (rootRef.current) mutation.observe(rootRef.current, { childList: true, subtree: true })
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true)
    window.visualViewport?.addEventListener('resize', measure)
    return () => { resize?.disconnect(); intersection?.disconnect(); mutation.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); window.visualViewport?.removeEventListener('resize', measure) }
  }, [anchorRef, dismiss, rootRef, narrow])
  const content = <div ref={panelRef} className="swarm-profile" data-profile-surface={narrow ? 'sheet' : 'popover'} role={narrow ? undefined : 'dialog'} aria-modal={narrow ? undefined : false} aria-label={narrow ? undefined : title}
    style={narrow ? undefined : { position: 'fixed', ...position, visibility: position === null ? 'hidden' : undefined }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(true); return }
      if (!narrow || event.key !== 'Tab') return
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter(node => {
        for (let parent = node.parentElement; parent && parent !== panelRef.current; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open && parent.querySelector('summary') !== node) return false
        }
        return !node.hidden
      })
      const first = focusable[0], last = focusable.at(-1)
      if (first === undefined) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>{children(() => { dismiss(true) })}</div>
  return narrow ? <Modal open onClose={() => { dismiss(true) }} title={title} headless className="swarm-profile-modal">{content}</Modal> : createPortal(content, document.body)
}

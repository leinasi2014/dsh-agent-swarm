import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PublicImageHistorySegment } from '../shared/public-image-content.js'
import type { PublicDraftImage } from './public-draft.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

type Translator = TranslateNS<typeof TEAM_DASHBOARD_NS>
type ImageReader = (messageId: string, imageId: string, signal: AbortSignal) => Promise<Blob>
function useImageUrl(blob: Blob | undefined): string | undefined {
  const [value, setValue] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (blob === undefined) { setValue(undefined); return }
    const url = URL.createObjectURL(blob)
    setValue({ blob, url })
    return () => { URL.revokeObjectURL(url) }
  }, [blob])
  return value?.blob === blob ? value?.url : undefined
}

function LargeImage({ url, name, close, t }: { url: string; name: string; close: () => void; t: Translator }) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    button.current?.focus()
    const focus = (event: FocusEvent): void => { if (event.target !== button.current) button.current?.focus() }
    document.addEventListener('focusin', focus)
    return () => { document.removeEventListener('focusin', focus); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <Modal open headless title={`${t('public.viewImage')}: ${name}`} onClose={close} className="swarm-public-image-modal">
    <div className="swarm-public-image-viewer" onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); button.current?.focus() } }}>
      <header><span>{name}</span><button ref={button} type="button" onClick={close}>{t('public.closeImage')}</button></header>
      <img src={url} alt={name} />
    </div>
  </Modal>
}

export function DraftImage({ image, blob, remove, t }: { image: PublicDraftImage; blob: Blob | undefined; remove: (id: string) => void; t: Translator }) {
  const url = useImageUrl(image.status === 'ready' ? blob : undefined), [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const name = image.name || t('public.image')
  return <div className="swarm-public__draft-image" data-draft-image={image.blobId}>
    <button type="button" className="swarm-public__image-thumb" disabled={url === undefined} aria-label={`${t('public.viewImage')}: ${name}`} onClick={() => { setOpen(true) }}>
      {url === undefined ? <span>{t(image.status === 'invalid' ? `public.imageIssue.${image.error ?? 'decode'}` : 'public.imageIssue.checking')}</span> : <img src={url} alt={name} />}
    </button><span title={name}>{name}</span><small>{t('public.localImage')}</small>
    <button type="button" className="swarm-public__remove-image" aria-label={`${t('public.removeImage')}: ${name}`} onClick={() => { remove(image.blobId) }}>×</button>
    {open && url !== undefined ? <LargeImage url={url} name={name} close={close} t={t} /> : null}
  </div>
}

/** Each mounted thumbnail owns its authorized read and URL. Offscreen history stays unloaded. */
export function MessageImage({ messageId, image, read, t }: { messageId: string; image: PublicImageHistorySegment; read: ImageReader; t: Translator }) {
  const element = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false), [attempt, setAttempt] = useState(0)
  const [blob, setBlob] = useState<Blob>(), [failed, setFailed] = useState(false), [open, setOpen] = useState(false)
  const url = useImageUrl(blob), name = image.name || t('public.image')
  const close = useCallback(() => { setOpen(false) }, [])
  useEffect(() => {
    if (visible) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '200px' })
    if (element.current !== null) observer.observe(element.current)
    return () => { observer.disconnect() }
  }, [visible])
  useEffect(() => {
    if (!visible) return
    const abort = new AbortController()
    setBlob(undefined); setFailed(false)
    void read(messageId, image.imageId, abort.signal).then(value => { if (!abort.signal.aborted) setBlob(value) }, () => { if (!abort.signal.aborted) setFailed(true) })
    return () => { abort.abort() }
  }, [visible, attempt, messageId, image.imageId, read])
  return <div ref={element} className="swarm-public__history-image" data-public-image={image.imageId}>
    {failed ? <div role="alert"><span>{t('public.imageReadFailed')}</span><button type="button" onClick={() => { setAttempt(value => value + 1) }}>{t('public.retryImage')}</button></div>
      : <button type="button" className="swarm-public__image-thumb" aria-label={`${t('public.viewImage')}: ${name}`} onClick={() => { setVisible(true); if (url !== undefined) setOpen(true) }}>
        {url === undefined ? <span>{t('public.imageLoading')}</span> : <img src={url} alt={name} width={image.width} height={image.height} />}
      </button>}
    <small title={name}>{name}</small>
    {open && url !== undefined ? <LargeImage url={url} name={name} close={close} t={t} /> : null}
  </div>
}

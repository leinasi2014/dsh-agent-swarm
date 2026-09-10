import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PublicChatState } from './public-chat-controller.js'
import { renderPublicText } from '../shared/public-content.js'
import { MessageImage } from './PublicImages.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

type Message = PublicChatState['entries'][number]
export function PublicMessageContent({ message, entries, image, memberLabels = [], t }: {
  message: Message; entries: readonly Message[]; image: (messageId: string, imageId: string, signal: AbortSignal) => Promise<Blob>; t: TranslateNS<typeof TEAM_DASHBOARD_NS>;
  memberLabels?: readonly { memberId: string; label: string }[];
}) {
  const assistance = message.assistance
  const label = (id: string): string => message.mentionLabels.find(row => row.memberId === id)?.label ?? id
  const participant = (id: string): string => {
    const author = [message, ...entries].map(row => row.author).find(row => row.kind === 'agent' && row.sessionId === id)
    return message.mentionLabels.find(row => row.memberId === id)?.label
      ?? (author?.kind === 'agent' ? author.displayName || author.name : undefined)
      ?? memberLabels.find(row => row.memberId === id)?.label ?? id
  }
  return <>
    {assistance === undefined ? null : <aside className="swarm-public__assistance" data-public-assistance={assistance.kind}>
      <strong>{t('public.assistanceRequest', { requester: participant(assistance.requesterSessionId), helper: participant(assistance.helperSessionId) })}</strong>
      {entries.some(row => row.id === assistance.sourceMessageId)
        ? <a href={`#swarm-message-${assistance.sourceMessageId}`}>{t('public.assistanceSource')}</a>
        : <span>{t('public.assistanceOutside', { id: assistance.sourceMessageId })}</span>}
      {assistance.kind === 'result' ? <span>{t('public.assistanceResult')}{assistance.outcome.state === 'failed' ? ` · ${t(`public.assistanceFailed.${assistance.outcome.reason}`)}` : ''}</span> : null}
    </aside>}
    <div className="swarm-public__text" data-public-content>{message.content.map((segment, index) => segment.type === 'image'
      ? <MessageImage key={segment.imageId} messageId={message.id} image={segment} read={image} t={t} />
      : segment.type === 'mention' ? <span className="swarm-public__history-mention" data-public-mention={segment.memberId} title={segment.memberId} key={index}>@{label(segment.memberId)}</span>
        : <span key={index}>{message.formatVersion > 1 && message.author.kind === 'local-operator' ? renderPublicText(segment.text) : segment.text}</span>)}</div>
  </>
}

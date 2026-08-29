/** Honest Team identity card (name / role authoritative, profession / personality placeholder).
 *
 *  The authoritative Team/roster domain always carries the technical `name` and `role`, so those are
 *  shown verbatim. Profession and personality are profile fields with NO backend generation authority
 *  yet (the read contract reports `identityCard.not_generated` with reason
 *  `identity_backend_not_implemented`), so this card renders them as an explicit
 *  "not generated / unavailable" placeholder — it never invents a profession or personality.
 *  The safe pixel avatar reflects the same honest asset status. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmReadAssetStatusV1 } from '../rpc/read-rpc-contract.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { SafePixelAvatar } from './SafePixelAvatar.js'

export interface TeamIdentityCardProps {
  readonly name: string
  readonly role: string
  readonly avatar: SwarmReadAssetStatusV1
  readonly identityCard: SwarmReadAssetStatusV1
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly title?: string
  /** Optional authoritative profile values; only shown when the backend reports `generated`. */
  readonly profession?: string
  readonly personality?: string
}

export function TeamIdentityCard({ name, role, avatar, identityCard, t, title, profession, personality }: TeamIdentityCardProps) {
  const generated = identityCard.state === 'generated'
  const unavailable = identityCard.state === 'unavailable'
  const placeholder = (value: string | undefined): string => {
    if (generated && value !== undefined) return value
    return unavailable ? t('profileUnavailable') : t('profileNotGenerated')
  }
  return (
    <section className="swarm-team-workspace__identity-card" data-swarm-identity-card
      data-swarm-identity-state={identityCard.state} data-swarm-identity-reason={identityCard.reason}>
      <span className="swarm-team-workspace__roster-label" data-swarm-identity-card-title>
        <span>{title ?? t('identityCardTitle')}</span>
        <small data-swarm-identity-badge>{unavailable ? t('profileUnavailable') : t('profileNotGenerated')}</small>
      </span>
      <header className="swarm-team-workspace__identity-header">
        <span className="swarm-team-workspace__avatar"><SafePixelAvatar seed={name} asset={avatar} name={name} t={t} /></span>
        <span className="swarm-team-workspace__member-copy">
          <strong className="swarm-team-workspace__truncate" title={name}>{name}</strong>
          <small className="swarm-team-workspace__member-role swarm-team-workspace__truncate" title={role}>{role}</small>
        </span>
      </header>
      <dl className="swarm-team-workspace__identity-fields">
        <div><dt>{t('profileProfession')}</dt><dd data-swarm-identity-profession data-identity-field-state={identityCard.state}>{placeholder(profession)}</dd></div>
        <div><dt>{t('profilePersonality')}</dt><dd data-swarm-identity-personality data-identity-field-state={identityCard.state}>{placeholder(personality)}</dd></div>
      </dl>
      {generated ? null : <p className="swarm-team-workspace__muted" data-swarm-identity-unavailable-hint>{t('identityCardUnavailable')}</p>}
    </section>
  )
}

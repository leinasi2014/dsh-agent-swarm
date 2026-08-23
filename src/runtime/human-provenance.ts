/**
 * SW-I1a human provenance boundary.
 *
 * `authenticated-human` is admitted only from a HOST-attested opaque
 * principal. A captain may relay what the user said from its root session
 * (`captain-mediated`), but neither the captain nor any relay/delegated
 * Agent can mint an attested principal. Without a host-attested principal,
 * privileged direct controls fail closed to captain-mediated confirmation.
 *
 * This module owns the deterministic provenance classification only. It does
 * not implement durable interaction receipts, question routing or control
 * handlers: a relay or free-text path that
 * reaches this boundary is rejected loud before any mutation surface.
 */
import { TeamDomainError } from '../domain/error.js'
import type { HumanInteractionRequest } from '../human/human-interaction-contract.js'

/**
 * Optional host-supplied human principal verifier capability. Only the host
 * wiring may register one; the plugin never mints `authenticated-human`.
 * The verifier receives the opaque principal reference and the concrete
 * interaction request and returns a boolean. A missing verifier, a `false`
 * result, or a throwing verifier all fail closed at the gateway with
 * `TEAM_INTERACTION_NO_PRINCIPAL`.
 */
export interface HumanPrincipalVerifier {
  readonly kind: 'human-principal-verifier'
  readonly name: string
  verify(principalRef: string, request: HumanInteractionRequest): boolean | Promise<boolean>
}



/** Free-form Message text is advisory data; it cannot authorize a typed Control. */
export function assertFreeTextNotAuthorization(input: {
  readonly freeTextOnly: boolean
  readonly structuredControl: boolean
}): void {
  if (input.freeTextOnly && input.structuredControl) {
    throw new TeamDomainError(
      'free-text message content cannot become a structured control authorization; route through the captain/domain contract',
      'TEAM_HUMAN_FREE_TEXT_NOT_AUTHORIZATION',
    )
  }
}

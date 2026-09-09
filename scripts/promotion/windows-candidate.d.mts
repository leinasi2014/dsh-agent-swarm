/** Experimental Windows process boundary; freeze/accept do not activate it. */
export function allocatePrivateCandidateRoot(): Promise<string>
export function grantCandidateDirectories(identityRoot: string, directories: string[]): {
  sid: string
  dispose(): void
}

import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'

/** The dashboard remains the refresh owner; this subscription adds no timer. */
export function draftDashboardConnection(owner: { bind(state: TeamDashboardState): void; dispose(): void }):
(dashboard: Pick<TeamDashboardController, 'subscribe' | 'getSnapshot'>) => () => void {
  return dashboard => {
    const sync = (): void => { owner.bind(dashboard.getSnapshot()) }
    const off = dashboard.subscribe(sync); sync()
    return () => { off(); owner.dispose() }
  }
}

/** Adopt an acknowledged durable version while preserving edits made after that write began. */
export function adoptPersistedDraft<Draft extends { readonly version: number }>(
  saved: { draft: Draft; persisted: Draft; versionFloor: number; status: string }, value: Draft, submittedVersion: number,
): void {
  saved.persisted = value
  if (saved.draft.version === submittedVersion) saved.draft = value
  saved.versionFloor = Math.max(saved.versionFloor, value.version)
  saved.status = saved.draft.version === saved.persisted.version ? 'ready' : 'saving'
}

/**
 * Type declarations for the D2 hardening repair lane exported by
 * scripts/promotion/repair.mjs (issue #122 F3). Control-plane tooling, never
 * shipped plugin code — declarations exist for the contract suite, like
 * lib.d.mts.
 */

export interface RepairAction {
  action: string
  detail?: string
  fromGen?: number | null
  toGen?: number | null
  ledgerSeq?: number
  gen?: number
  outcome?: string
}

export interface RepairResult {
  confirmed: boolean
  actions: RepairAction[]
  divergences: {
    pointerGen: number | null
    ledgerGen: number | null
    pointerLedgerDiverged: boolean
    installedProfile: { checked: boolean; matches?: boolean; reason?: string }
  }
  ok: boolean
}

export function runRepair(args: {
  dogfoodRoot: string
  yes?: boolean
  reinstall?: boolean
  cli?: string
}): Promise<RepairResult>

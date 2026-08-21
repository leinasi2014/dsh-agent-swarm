/** Structured aggregation of root-produced executable-review evidence. */
import type { ReviewCommandEvidence } from './review-root.js'

/** One executed command with its selected root identity. */
export interface RoutedReviewCommandEvidence {
  /** Zero-based index in the frozen declared command list. */
  readonly index: number
  readonly family: string
  readonly capability: string
  readonly rootLabel: string
  readonly evidence: ReviewCommandEvidence
}

/** One root represented in a verification summary. */
export interface VerificationRootSummary {
  readonly family: string
  readonly capability: string
  readonly label: string
  readonly commandIndexes: readonly number[]
}

/** Root opened by the review operation, before commands are aggregated. */
export type OpenedVerificationRoot = Omit<VerificationRootSummary, 'commandIndexes'>

/** Complete bounded operation summary derived only from review-root evidence. */
export interface VerificationEvidenceSummary {
  readonly version: 1
  readonly status: 'passed' | 'failed'
  readonly requestedDecision: 'accept' | 'reject'
  readonly finalDecision: 'accept' | 'reject'
  readonly plannedCommands: number
  readonly executedCommands: number
  readonly skippedCommands: number
  readonly totalDurationMs: number
  readonly roots: readonly VerificationRootSummary[]
  readonly commands: readonly RoutedReviewCommandEvidence[]
  readonly failedCommandIndex?: number
  readonly provenance: 'review-root'
}

/** Aggregate one ordered fail-fast command run into a stable versioned summary. */
export function aggregateVerificationEvidence(input: {
  readonly requestedDecision: 'accept' | 'reject'
  readonly plannedCommands: number
  readonly commands: readonly RoutedReviewCommandEvidence[]
  readonly openedRoots?: readonly OpenedVerificationRoot[]
  readonly failedCommandIndex?: number
}): VerificationEvidenceSummary {
  const finalDecision = input.failedCommandIndex === undefined ? input.requestedDecision : 'reject'
  const roots = new Map<string, { family: string; capability: string; label: string; commandIndexes: number[] }>()
  for (const root of input.openedRoots ?? []) {
    roots.set(`${root.family}\0${root.capability}\0${root.label}`, { ...root, commandIndexes: [] })
  }
  for (const command of input.commands) {
    const key = `${command.family}\0${command.capability}\0${command.rootLabel}`
    const root = roots.get(key) ?? {
      family: command.family,
      capability: command.capability,
      label: command.rootLabel,
      commandIndexes: [],
    }
    root.commandIndexes.push(command.index)
    roots.set(key, root)
  }
  return {
    version: 1,
    status: input.failedCommandIndex === undefined ? 'passed' : 'failed',
    requestedDecision: input.requestedDecision,
    finalDecision,
    plannedCommands: input.plannedCommands,
    executedCommands: input.commands.length,
    skippedCommands: input.plannedCommands - input.commands.length,
    totalDurationMs: input.commands.reduce((total, command) => total + command.evidence.durationMs, 0),
    roots: [...roots.values()].map(root => ({ ...root, commandIndexes: [...root.commandIndexes] })),
    commands: input.commands.map(command => ({ ...command, evidence: { ...command.evidence } })),
    ...(input.failedCommandIndex === undefined ? {} : { failedCommandIndex: input.failedCommandIndex }),
    provenance: 'review-root',
  }
}

/**
 * `@dsh-agent-swarm/panel` public surface (S0+S1,
 * docs/development/2026-08-22-m9-ui-architecture-spec.md §5): the frozen
 * SwarmPanelSnapshot contract, the strings contract, and the pure React 18
 * presentational components. Host adapters (DSH ui-panel plugin, Canvas
 * Swarm tab) import components from `.` and the stylesheet from
 * `@dsh-agent-swarm/panel/panel.css`, then map host theme tokens onto the
 * --swarm-* contract variables on an ancestor element.
 */
export type {
  SwarmBudgetUsage,
  SwarmCounters,
  SwarmMemberPhase,
  SwarmMemberView,
  SwarmPanelSnapshot,
  SwarmReviewEntry,
  SwarmTaskStatus,
  SwarmTaskView,
  SwarmTeamRef,
} from './types.ts'
export { formatSwarmString, zh } from './strings.ts'
export type { StringsKey, SwarmStrings } from './strings.ts'
export { BudgetMeter } from './components/BudgetMeter.tsx'
export type { BudgetMeterProps } from './components/BudgetMeter.tsx'
export { StatusCounters } from './components/StatusCounters.tsx'
export type { StatusCountersProps } from './components/StatusCounters.tsx'
export { SwarmPanel } from './components/SwarmPanel.tsx'
export type { SwarmPanelProps } from './components/SwarmPanel.tsx'
export { TaskBoard } from './components/TaskBoard.tsx'
export type { TaskBoardProps } from './components/TaskBoard.tsx'
export { TeamSummaryCard } from './components/TeamSummaryCard.tsx'
export type { TeamSummaryCardProps } from './components/TeamSummaryCard.tsx'

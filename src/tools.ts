/**
 * Reassembly point for the model-facing `agent_swarm_*` tool Consumer
 * (issue #74): 19 default tools plus one experimental fresh-v2 continuation
 * tool live in cohesive `src/tools/` modules and this
 * thin shell preserves both the public export surface and the exact
 * registration order of the pre-split file, so `src/index.ts` and the
 * README-declared 17-tool surface observe zero change (issue #93 appended the
 * jobs reader to the read-surface module group).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'
import {
  registerAddMemberTool,
  registerArchiveTool,
  registerCreateTool,
  registerInterruptMemberTool,
  registerRemoveMemberTool,
} from './tools/team-lifecycle.js'
import {
  registerClaimTaskTool,
  registerCreateTaskTool,
  registerReassignTaskTool,
  registerReviewTaskTool,
  registerSubmitTaskTool,
} from './tools/task-board.js'
import { registerSendMessageTool, registerWaitTool } from './tools/mailbox.js'
import { registerAddMemoryTool, registerAddPersonalMemoryTool, registerListMemoryTool, registerSetBudgetTool } from './tools/budget-memory.js'
import { registerListJobsTool, registerListTasksTool, registerStatusTool } from './tools/read-surface.js'
import type { InitialTeamLifecycleRuntime } from './tools/team-lifecycle.js'
import type { InitialTaskBoardRuntime } from './tools/task-board.js'
import type { ReassignTaskRuntime, SubmitTaskRuntime } from './tools/task-board.js'
import { registerContinueTaskTool, type ContinuationRuntime } from './tools/continuation.js'

/** Register the unchanged public walking-skeleton tools shared by v1 and fresh-v2. */
function registerInitialAgentSwarmTools(
  ctx: Context,
  runtime: InitialTeamLifecycleRuntime & InitialTaskBoardRuntime & Partial<ContinuationRuntime>,
): void {
  registerCreateTool(ctx, runtime)
  registerAddMemberTool(ctx, runtime)
  registerCreateTaskTool(ctx, runtime)
  if (runtime.continueTask !== undefined) registerContinueTaskTool(ctx, runtime as ContinuationRuntime)
}

/** Register the currently implemented fresh-v2 model control surface. */
export function registerFreshV2AgentSwarmTools(
  ctx: Context,
  runtime: InitialTeamLifecycleRuntime & InitialTaskBoardRuntime & ContinuationRuntime & SubmitTaskRuntime & ReassignTaskRuntime,
): void {
  registerInitialAgentSwarmTools(ctx, runtime)
  registerSubmitTaskTool(ctx, runtime)
  registerReassignTaskTool(ctx, runtime)
}

/** Register the model-facing Consumer over the Team orchestrator runtime. */
export function registerAgentSwarmTools(ctx: Context, runtime: AgentSwarmRuntime): void {
  registerInitialAgentSwarmTools(ctx, runtime)
  registerRemoveMemberTool(ctx, runtime)
  registerArchiveTool(ctx, runtime)
  registerClaimTaskTool(ctx, runtime)
  registerSubmitTaskTool(ctx, runtime)
  registerReassignTaskTool(ctx, runtime)
  registerReviewTaskTool(ctx, runtime)
  registerInterruptMemberTool(ctx, runtime)
  registerSendMessageTool(ctx, runtime)
  registerSetBudgetTool(ctx, runtime)
  registerAddMemoryTool(ctx, runtime)
  registerAddPersonalMemoryTool(ctx, runtime)
  registerListMemoryTool(ctx, runtime)
  registerStatusTool(ctx, runtime)
  registerListTasksTool(ctx, runtime)
  registerListJobsTool(ctx, runtime)
  registerWaitTool(ctx, runtime)
}

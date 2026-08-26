/**
 * Reassembly point for the model-facing `agent_swarm_*` tool Consumer
 * (issue #74): the 17 tools live in cohesive `src/tools/` modules and this
 * thin shell preserves the pre-existing public registration order; the
 * README-declared 18th memory reader is appended after the established tools.
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
import { registerAddMemoryTool, registerSetBudgetTool } from './tools/budget-memory.js'
import { registerListJobsTool, registerListMemoryTool, registerListTasksTool, registerStatusTool } from './tools/read-surface.js'

/** Register the model-facing Consumer over the Team orchestrator runtime. */
export function registerAgentSwarmTools(ctx: Context, runtime: AgentSwarmRuntime): void {
  registerCreateTool(ctx, runtime)
  registerAddMemberTool(ctx, runtime)
  registerCreateTaskTool(ctx, runtime)
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
  registerStatusTool(ctx, runtime)
  registerListTasksTool(ctx, runtime)
  registerListJobsTool(ctx, runtime)
  registerWaitTool(ctx, runtime)
  registerListMemoryTool(ctx, runtime)
}

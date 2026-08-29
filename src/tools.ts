/**
 * Reassembly point for the model-facing `agent_swarm_*` tool Consumer
 * (issue #74): the 17 original tools live in cohesive `src/tools/` modules and this
 * thin shell preserves the pre-existing public registration order; the
 * memory reader, then the member-profile reader, and finally the two
 * member-private-memory tools (2026-08-26) are appended after the
 * established 17-tool surface.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'
import type { MemberPrivateMemoryService } from './runtime/member-private-memory-service.js'
import {
  registerAddMemberTool,
  registerArchiveTool,
  registerCreateTool,
  registerCreateManagedTool,
  registerInterruptMemberTool,
  registerPublishAnnouncementTool,
  registerRemoveMemberTool,
  registerSetCaptainProfileTool,
  registerSetPublicGoalTool,
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
import { registerListJobsTool, registerListMembersTool, registerListMemoryTool, registerListTasksTool, registerStatusTool } from './tools/read-surface.js'
import { registerAddPrivateMemoryTool, registerListPrivateMemoryTool } from './tools/private-memory.js'

/** Register the model-facing Consumer over the Team orchestrator runtime. */
export function registerAgentSwarmTools(ctx: Context, runtime: AgentSwarmRuntime, privateMemory?: MemberPrivateMemoryService): void {
  registerCreateTool(ctx, runtime)
  registerCreateManagedTool(ctx, runtime)
  registerAddMemberTool(ctx, runtime)
  registerSetCaptainProfileTool(ctx, runtime)
  registerPublishAnnouncementTool(ctx, runtime)
  registerSetPublicGoalTool(ctx, runtime)
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
  registerListMembersTool(ctx, runtime)
  registerAddPrivateMemoryTool(ctx, privateMemory)
  registerListPrivateMemoryTool(ctx, privateMemory)
}

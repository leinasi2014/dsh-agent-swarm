/** Model-facing Team tool registration. Each capability family owns its implementation file. */
import type { Context } from '@deepseek-ai/cordis'
import type { MemberPrivateMemoryService } from '../runtime/member-private-memory-service.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { registerAddMemoryTool, registerSetBudgetTool } from './budget-memory.js'
import { registerApprovePlanTool, registerDiscardPlanTool, registerSetPlanTool } from './plans.js'
import { registerSendMessageTool, registerWaitTool } from './mailbox.js'
import { registerAddPrivateMemoryTool, registerListPrivateMemoryTool } from './private-memory.js'
import {
  registerListJobsTool,
  registerListManagedTeamsTool,
  registerListMembersTool,
  registerListMemoryTool,
  registerListTasksTool,
  registerStatusTool,
} from './read-surface.js'
import {
  registerClaimTaskTool,
  registerCreateTaskTool,
  registerReassignTaskTool,
  registerReviewTaskTool,
  registerSubmitTaskTool,
} from './task-board.js'
import {
  registerAddMemberTool,
  registerArchiveTool,
  registerCreateManagedTool,
  registerCreateTool,
  registerInterruptMemberTool,
  registerPublishAnnouncementTool,
  registerRemoveMemberTool,
  registerSetCaptainProfileTool,
  registerSetPublicGoalTool,
} from './team-lifecycle.js'

export function registerAgentSwarmTools(
  ctx: Context,
  runtime: AgentSwarmRuntime,
  privateMemory?: MemberPrivateMemoryService,
): void {
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
  registerListManagedTeamsTool(ctx, runtime)
  registerAddPrivateMemoryTool(ctx, privateMemory)
  registerListPrivateMemoryTool(ctx, privateMemory)
  registerSetPlanTool(ctx, runtime)
  registerApprovePlanTool(ctx, runtime)
  registerDiscardPlanTool(ctx, runtime)
}


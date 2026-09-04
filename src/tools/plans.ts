/**
 * Plan-first tool surface (P0-2 S2): staged plan declaration, approval and
 * discard. Main Brain only; the domain stays the single write authority and
 * approval commits before any provisioning starts.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import type { TeamPlanDraft } from '../domain/types.js'
import { compactJsonOutput, register } from './shared.js'

const PLAN_MEMBER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    role: { type: 'string', required: true },
    llm_provider: { type: 'string', description: 'Optional member LLM provider override.' },
    model: { type: 'string', description: 'Optional member model override.' },
    deny_tools: { type: 'array', items: { type: 'string' }, description: 'Optional deny-only tool narrowing.' },
  },
} as const

const PLAN_TASK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    key: { type: 'string', required: true, description: 'Plan-local task key (lowercase letters/digits/dash, <=32).' },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    dependencies: { type: 'array', items: { type: 'string' }, description: 'Plan-local keys that must complete first.' },
    target_member_name: { type: 'string', description: 'Planned member that alone may claim this task.' },
    write_scopes: { type: 'array', items: { type: 'string' } },
  },
} as const

/** `agent_swarm_set_plan` — Main Brain only, bounded declaration. */
export function registerSetPlanTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_set_plan',
    description: 'Main Brain only. Store one bounded plan declaration on your staged Team (members with optional routes/deny lists, and a dependency-aware task graph with plan-local keys). Revises the draft atomically with expected_revision CAS; the Team stays staged.',
    parameters: {
      team_id: { type: 'string', required: true },
      expected_revision: { type: 'integer', required: true },
      members: { type: 'array', required: true, items: PLAN_MEMBER_SCHEMA },
      tasks: { type: 'array', required: true, items: PLAN_TASK_SCHEMA },
    },
    output: compactJsonOutput({
      type: 'object', additionalProperties: false,
      properties: {
        team_id: { type: 'string', required: true },
        phase: { type: 'string', required: true },
        revision: { type: 'number', required: true },
      },
    }),
    async execute(args, exec) {
      const draft: TeamPlanDraft = {
        members: (args.members ?? []).map(member => ({
          name: member.name, role: member.role,
          ...(member.llm_provider === undefined ? {} : { llmProvider: member.llm_provider }),
          ...(member.model === undefined ? {} : { model: member.model }),
          ...(member.deny_tools === undefined ? {} : { denyTools: member.deny_tools }),
        })),
        tasks: (args.tasks ?? []).map(task => ({
          key: task.key, subject: task.subject, description: task.description,
          ...(task.acceptance_criteria === undefined ? {} : { acceptanceCriteria: task.acceptance_criteria }),
          ...(task.dependencies === undefined ? {} : { dependencies: task.dependencies }),
          ...(task.target_member_name === undefined ? {} : { targetMemberName: task.target_member_name }),
          ...(task.write_scopes === undefined ? {} : { writeScopes: task.write_scopes }),
        })),
      }
      const team = await runtime.setPlan(exec, args.team_id, args.expected_revision, draft)
      return { team_id: team.id, phase: team.phase, revision: team.revision }
    },
  }), 'set-plan tool')
}

/** `agent_swarm_approve_plan` — Main Brain only. */
export function registerApprovePlanTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_approve_plan',
    description: 'Main Brain only. Approve the staged plan: the Team becomes active atomically and the dedicated Captain, planned members and planned task graph (dependencies + assignment targets) are provisioned. Failure after the activation commit leaves the Team active and recoverable; re-run after recovery rather than creating a duplicate plan.',
    parameters: {
      team_id: { type: 'string', required: true },
      expected_revision: { type: 'integer', required: true },
      llm_provider: { type: 'string', description: 'Optional dedicated Captain LLM provider override.' },
      model: { type: 'string', description: 'Optional dedicated Captain model override.' },
      ask_user: { type: 'boolean', default: false, description: 'Reserved human-approval gate; currently requires the userQuestions service and is otherwise fail-closed.' },
    },
    output: compactJsonOutput({
      type: 'object', additionalProperties: false,
      properties: {
        team_id: { type: 'string', required: true },
        phase: { type: 'string', required: true },
        captain_session_id: { type: 'string', required: true },
        revision: { type: 'number', required: true },
      },
    }),
    async execute(args, exec) {
      const team = await runtime.approvePlan(exec, args.team_id, args.expected_revision, {
        ...(args.llm_provider === undefined ? {} : { llmProvider: args.llm_provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.ask_user === true ? { askUser: true } : {}),
      })
      return { team_id: team.id, phase: team.phase, captain_session_id: team.captainSessionId, revision: team.revision }
    },
  }), 'approve-plan tool')
}

/** `agent_swarm_discard_plan` — Main Brain only. */
export function registerDiscardPlanTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_discard_plan',
    description: 'Main Brain only. Archive your staged plan without creating any Captain, member or task. Idempotent; the discarded Team cannot be resurrected implicitly — create a new staged Team explicitly if the goal returns.',
    parameters: {
      team_id: { type: 'string', required: true },
      expected_revision: { type: 'integer', required: true },
    },
    output: compactJsonOutput({
      type: 'object', additionalProperties: false,
      properties: {
        team_id: { type: 'string', required: true },
        phase: { type: 'string', required: true },
        revision: { type: 'number', required: true },
      },
    }),
    async execute(args, exec) {
      const team = await runtime.discardPlan(exec, args.team_id, args.expected_revision)
      return { team_id: team.id, phase: team.phase, revision: team.revision }
    },
  }), 'discard-plan tool')
}




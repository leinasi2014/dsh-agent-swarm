/**
 * Team and member lifecycle tools (issue #74 split of src/tools.ts): create
 * the durable Team, add continuable members, remove them with fenced
 * attempts, archive the Team, and interrupt one member's current turn.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { register } from './shared.js'

/** `agent_swarm_create`. */
export function registerCreateTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_create',
    description: 'Create one durable DSH Team. The calling Agent becomes captain; one captain may own one active Team per workspace.',
    parameters: {
      name: { type: 'string', required: true, description: 'Human-readable Team name.' },
      description: { type: 'string', required: true, description: 'Concrete goal and completion boundary.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          revision: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created Team "${value.name}" (${value.team_id}, revision ${value.revision}).` }],
    },
    async execute(args, exec) {
      const team = await runtime.create(exec, args.name, args.description)
      return { team_id: team.id, name: team.name, revision: team.revision }
    },
  }), 'create tool')
}

/** `agent_swarm_add_member`. */
export function registerAddMemberTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_add_member',
    description: 'Captain-only. Create a durable continuable DSH subagent member with an isolated persona and Team-safe tool permissions.',
    parameters: {
      name: { type: 'string', required: true, description: 'Immutable member name: NFC-normalized Unicode letters/digits with dash separators, at most 64 code points.' },
      role: { type: 'string', required: true, description: 'Member specialty and responsibility.' },
      provider: { type: 'string', description: 'Optional continuable subagent Provider; defaults to plugin config.' },
      llm_provider: { type: 'string', description: 'Optional official DSH LLM Provider route. This is distinct from the continuable subagent Provider.' },
      model: { type: 'string', description: 'Optional member model override.' },
      deny_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional additional tool names to hide from this member (deny-only narrowing on top of the mandatory captain-only tools; there is no allow surface). Invalid or unknown tool names fail provisioning loudly.',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional official DSH Skill names assigned at member creation. Names are validated before the roster commit; assignment does not mean loaded.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          session_id: { type: 'string', required: true },
          role: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          llm_provider: { type: 'string' },
          model: { type: 'string' },
          denied_tools: { type: 'array', items: { type: 'string' }, required: true },
          assigned_skills: { type: 'array', items: { type: 'string' }, required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Member ${value.name} (${value.session_id}) is ${value.phase} via ${value.provider}.` }],
    },
    async execute(args, exec) {
      const member = await runtime.addMember(exec, {
        name: args.name,
        role: args.role,
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.llm_provider === undefined ? {} : { llmProvider: args.llm_provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.deny_tools === undefined ? {} : { denyTools: args.deny_tools }),
        ...(args.skills === undefined ? {} : { skills: args.skills }),
      })
      return {
        name: member.name,
        session_id: member.sessionId,
        role: member.role,
        provider: member.provider,
        ...(member.llmProvider === undefined ? {} : { llm_provider: member.llmProvider }),
        ...(member.model === undefined ? {} : { model: member.model }),
        denied_tools: member.deniedTools ?? [],
        assigned_skills: member.assignedSkills ?? [],
        phase: member.phase,
      }
    },
  }), 'add-member tool')
}

/** `agent_swarm_remove_member`. */
export function registerRemoveMemberTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_remove_member',
    description: 'Captain-only. Fence all open attempts owned by one member, requeue their tasks, cancel queued mail to them, then interrupt and drain the continuable child.',
    parameters: {
      name: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          requeued_task_ids: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Removed ${value.name}; requeued=${value.requeued_task_ids.join(', ') || 'none'}.` }],
    },
    async execute(args, exec) {
      const removed = await runtime.removeMember(exec, args.name, args.reason)
      return {
        name: removed.member.name,
        phase: removed.member.phase,
        requeued_task_ids: removed.requeuedTaskIds,
      }
    },
  }), 'remove-member tool')
}

/** `agent_swarm_archive`. */
export function registerArchiveTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_archive',
    description: 'Captain-only. Irreversibly archive the active Team, cancel all unfinished tasks and queued messages, fence attempts, and drain every member.',
    parameters: {
      reason: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Archived Team ${value.team_id}; phase=${value.phase}.` }],
    },
    async execute(args, exec) {
      const team = await runtime.archive(exec, args.reason)
      return { team_id: team.id, phase: team.phase }
    },
  }), 'archive tool')
}

/** `agent_swarm_interrupt_member`. */
export function registerInterruptMemberTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_interrupt_member',
    description: 'Captain-only emergency control. Cancel one member\'s current turn while keeping its pending inbox, task ownership and roster membership. The Host admits this model tool only when the target current turn contains an unmatched tool call older than the safety threshold; model-written claims, silence, planning time, missing file changes, and wait returns are never evidence. Direct-user stops use authenticated Human Control instead.',
    parameters: {
      name: { type: 'string', required: true, description: 'Active member name.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          previous_status: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] },
          evidence: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              call_id: { type: 'string', required: true },
              tool_name: { type: 'string', required: true },
              age_ms: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Interrupted ${value.name}; previous_status=${value.previous_status}; host evidence=${value.evidence.tool_name}/${value.evidence.call_id} age_ms=${value.evidence.age_ms}. Inbox, ownership and membership are preserved.` }],
    },
    async execute(args, exec) {
      const interrupted = await runtime.interruptMember(exec, args.name, { source: 'model' })
      const evidence = interrupted.evidence
      if (evidence === undefined) throw new Error('model interrupt admitted without host evidence')
      return {
        name: interrupted.name,
        previous_status: interrupted.previousStatus,
        evidence: { call_id: evidence.callId, tool_name: evidence.toolName, age_ms: evidence.ageMs },
      }
    },
  }), 'interrupt-member tool')
}

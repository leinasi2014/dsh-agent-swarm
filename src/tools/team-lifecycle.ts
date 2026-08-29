/**
 * Team and member lifecycle tools (issue #74 split of src/tools.ts): create
 * the durable Team, add continuable members, remove them with fenced
 * attempts, archive the Team, and interrupt one member's current turn.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { TeamDomainError } from '../domain/error.js'
import { register } from './shared.js'

/** `agent_swarm_create`. */
export function registerCreateTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_create',
    description: 'Captain-only compatibility path. Create one durable DSH Team owned by the calling Agent.',
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

/** Main-brain entry: create a Team owned by a new dedicated Captain. */
export function registerCreateManagedTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_create_managed',
    description: 'Main-agent entry. Create a durable Team with a dedicated Captain Session. The caller stays outside the Team; the Captain analyzes the goal and recruits its own members.',
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
          captain_session_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created managed Team "${value.name}" (${value.team_id}) with Captain ${value.captain_session_id}.` }],
    },
    async execute(args, exec) {
      // The dedicated Captain's LLM route is plugin-configured only
      // (`captainLlmProvider` / `captainModel` on the runtime config); the
      // model can no longer steer it by co-passing `captain_llm_provider` /
      // `captain_model`, which are not part of this tool's parameter surface.
      const team = await runtime.createWithDedicatedCaptain(exec, args.name, args.description)
      return { team_id: team.id, name: team.name, revision: team.revision, captain_session_id: team.captainSessionId }
    },
  }), 'managed create tool')
}

/** `agent_swarm_add_member`. */
export function registerAddMemberTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_add_member',
    description: 'Captain-only. Create a durable continuable DSH subagent member with an isolated persona and Team-safe tool permissions.',
    parameters: {
      name: { type: 'string', required: true, description: 'Immutable member name: NFC-normalized Unicode letters/digits with dash separators, at most 64 code points.' },
      role: { type: 'string', required: true, description: 'Member specialty and responsibility.' },
      provider: { type: 'string', description: 'Optional continuable subagent Provider (the runtime that hosts the member child); defaults to plugin config.' },
      llm_provider: { type: 'string', description: 'Optional member LLM provider, passed as the child agent\'s agentOptions.provider and recorded in its durable descriptor; when omitted the member inherits the captain\'s LLM provider. Distinct from the continuable \'provider\'.' },
      model: { type: 'string', description: 'Optional member model override.' },
      deny_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional additional tool names to hide from this member (deny-only narrowing on top of the mandatory captain-only tools; there is no allow surface). Invalid or unknown tool names fail provisioning loudly.',
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
      })
      return {
        name: member.name,
        session_id: member.sessionId,
        role: member.role,
        provider: member.provider,
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
    description: 'Captain-only. Request cancellation of one member only when the Host independently confirms that its current visible tool call exceeded that tool\'s declared timeout. The member keeps its pending inbox, task ownership and roster membership.',
    parameters: {
      name: { type: 'string', required: true, description: 'Active member name.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          previous_status: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] },
          evidence_kind: { type: 'string', required: true, enum: ['host-confirmed-tool-timeout'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Cancellation requested for ${value.name}; evidence=${value.evidence_kind}; previous_status=${value.previous_status}.` }],
    },
    async execute(args, exec) {
      // Parameter shorthand is intentionally open in the official tool
      // registry. This model-only gate nevertheless admits exactly one
      // model-supplied fact: the member name. Evidence fields are Host-owned.
      if (Object.keys(args).some(key => key !== 'name')) {
        throw new TeamDomainError('Host-confirmed timeout evidence is required to interrupt a member', 'TEAM_INTERRUPT_EVIDENCE_REQUIRED')
      }
      const interrupted = await runtime.interruptMemberFromModel(exec, args.name)
      return { name: interrupted.name, previous_status: interrupted.previousStatus, evidence_kind: interrupted.evidenceKind }
    },
  }), 'interrupt-member tool')
}

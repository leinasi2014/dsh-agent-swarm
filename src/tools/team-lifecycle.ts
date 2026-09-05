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

/** Shared optional identity schema; both tools keep the same compiled fields. */
const optionalIdentityParameters = {
  display_name: { type: 'string', description: 'Optional display name, at most 128 code points; preserve user preference/language.' },
  profession: { type: 'string', description: 'Optional profession, at most 256 code points.' },
  personality: { type: 'string', description: 'Optional disposition, at most 1024 code points.' },
  pixel_avatar_svg: { type: 'string', description: 'Optional safe pixel-avatar SVG, at most 16KB. Omit freely; supplied values are validated.' },
  skills: { type: 'array', items: { type: 'string' }, description: 'Assigned Skill subset: validated before roster effects against Team allow-list and current model-invocable scoped catalog; persists across restart.' },
} as const

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
    description: 'Main Brain entry: create a dedicated Captain; remain outside the Team. Deliver the complete user objective in description, including public goal, announcement and Captain/member identity/avatar preferences. After creation, list managed Teams at most once, then end the turn. No wait/status/send_message, Shell sleep or polling; observe through the Host Team UI.',
    parameters: {
      name: { type: 'string', required: true, description: 'Human-readable Team name.' },
      description: { type: 'string', required: true, description: 'The Captain\'s only initial objective. Copy the user\'s complete requested outcome, constraints, and acceptance criteria verbatim; do not summarize or omit requirements because omitted requirements are not delivered automatically later.' },
      stage: { type: 'boolean', default: false, description: 'True: stage without Captain/member/task; set_plan then approve_plan or discard_plan. False: start immediately.' },
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
      render: (_args, value) => [{ type: 'text', text: value.captain_session_id === '' ? `Created STAGED managed Team "${value.name}" (${value.team_id}) with no Captain yet. Use agent_swarm_set_plan then agent_swarm_approve_plan to start, or agent_swarm_discard_plan to archive the draft.` : `Created managed Team "${value.name}" (${value.team_id}) with dedicated Captain ${value.captain_session_id}. The supplied description was delivered as the Captain's only initial objective; it must contain the user's complete requested outcome, constraints, and acceptance criteria verbatim because omitted requirements will not be delivered automatically. The Main Brain remains outside the Team: call agent_swarm_list_managed_teams at most once, then end this turn. Do not call agent_swarm_wait, agent_swarm_status, or agent_swarm_send_message, and do not use Shell sleep or polling; use the Host Team UI for later observation.` }],
    },
    async execute(args, exec) {
      // The dedicated Captain's LLM route is plugin-configured only
      // (`captainLlmProvider` / `captainModel` on the runtime config); the
      // model can no longer steer it by co-passing `captain_llm_provider` /
      // `captain_model`, which are not part of this tool's parameter surface.
      const team = args.stage === true
        ? await runtime.createStagedManaged(exec, args.name, args.description)
        : await runtime.createWithDedicatedCaptain(exec, args.name, args.description)
      return { team_id: team.id, name: team.name, revision: team.revision, captain_session_id: team.captainSessionId }
    },
  }), 'managed create tool')
}

/** `agent_swarm_add_member`. */
export function registerAddMemberTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_add_member',
    description: 'Captain-only: recruit a continuable member with isolated persona and mandatory Team tool restrictions. Identity fields are optional bounded context; absent profiles remain not_generated. Invalid supplied avatars fail before roster or Session effects; omit optional identity to continue recruitment.',
    parameters: {
      name: { type: 'string', required: true, description: 'Immutable member name: NFC-normalized Unicode letters/digits with dash separators, at most 64 code points.' },
      role: { type: 'string', required: true, description: 'Member specialty and responsibility.' },
      ...optionalIdentityParameters,
      provider: { type: 'string', description: 'Continuable runtime Provider; defaults to plugin config.' },
      llm_provider: { type: 'string', description: 'Child LLM provider, distinct from runtime provider; inherits Captain when omitted and is recorded durably.' },
      model: { type: 'string', description: 'Optional member model override.' },
      deny_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional deny-only tools beyond mandatory Captain restrictions. Invalid/unknown names fail; no allow override.',
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
        ...(args.display_name === undefined ? {} : { displayName: args.display_name }),
        ...(args.profession === undefined ? {} : { profession: args.profession }),
        ...(args.personality === undefined ? {} : { personality: args.personality }),
        ...(args.pixel_avatar_svg === undefined ? {} : { pixelAvatarSvg: args.pixel_avatar_svg }),
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
        phase: member.phase,
      }
    },
  }), 'add-member tool')
}

/** `agent_swarm_set_captain_profile`. */
export function registerSetCaptainProfileTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_set_captain_profile',
    description: 'Captain-only optional profile update, never a recruitment gate. Supply at least one identity field. Invalid avatars fail before mutation. Current expected_revision is required; concurrent mutation fails with TEAM_REVISION_CONFLICT.',
    parameters: {
      expected_revision: { type: 'number', required: true, description: 'Exact current Team revision; conflicts fail with TEAM_REVISION_CONFLICT.' },
      ...optionalIdentityParameters,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { revision: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Set Team profile (revision ${value.revision}).` }],
    },
    async execute(args, exec) {
      const team = await runtime.setCaptainProfile(exec, args.expected_revision, {
        ...(args.display_name === undefined ? {} : { displayName: args.display_name }),
        ...(args.profession === undefined ? {} : { profession: args.profession }),
        ...(args.personality === undefined ? {} : { personality: args.personality }),
        ...(args.pixel_avatar_svg === undefined ? {} : { pixelAvatarSvg: args.pixel_avatar_svg }),
      })
      return { revision: team.revision }
    },
  }), 'set-captain-profile tool')
}

/** `agent_swarm_publish_announcement`. */
export function registerPublishAnnouncementTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_publish_announcement',
    description: 'Captain-only. Publish one public announcement on this Team (bounded list, at most 4096 code points each). Uses expected_revision compare-and-swap: pass the Team\'s current revision (see agent_swarm_status) so a concurrent mutation fails loud instead of silently interleaving.',
    parameters: {
      expected_revision: { type: 'number', required: true, description: 'The exact current Team revision; publish fails with TEAM_REVISION_CONFLICT if it changed.' },
      text: { type: 'string', required: true, description: 'Announcement text (at most 4096 code points).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          announcement_id: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          announcement_count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Published announcement ${value.announcement_id} (revision ${value.revision}, ${value.announcement_count} total).` }],
    },
    async execute(args, exec) {
      const result = await runtime.publishAnnouncement(exec, args.expected_revision, args.text)
      return {
        announcement_id: result.announcement.id,
        revision: result.team.revision,
        announcement_count: (result.team.announcements ?? []).length,
      }
    },
  }), 'publish-announcement tool')
}

/** `agent_swarm_set_public_goal`. */
export function registerSetPublicGoalTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_set_public_goal',
    description: 'Captain-only. Set this Team\'s public goal (canonical bounded text, at most 4096 code points) with an expected_revision compare-and-swap. Pass the Team\'s current revision (see agent_swarm_status); a concurrent mutation fails with TEAM_REVISION_CONFLICT. Absent from the read as not_generated until set.',
    parameters: {
      expected_revision: { type: 'number', required: true, description: 'The exact current Team revision; fails with TEAM_REVISION_CONFLICT if it changed.' },
      text: { type: 'string', required: true, description: 'Public goal text (canonical, at most 4096 code points).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { revision: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Set public goal (revision ${value.revision}).` }],
    },
    async execute(args, exec) {
      const team = await runtime.setPublicGoal(exec, args.expected_revision, args.text)
      return { revision: team.revision }
    },
  }), 'set-public-goal tool')
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


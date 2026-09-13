/**
 * Captain-facing Skills tools. Identity/scope/Team are derived from the live
 * `exec.agent` (never arguments); the faces are Captain-only and active-Team
 * only, enforced inside the module. Registration is lifecycle-owned through
 * the shared effect wrapper. Constraints are enforced by the zod schemas in
 * `execute` — the official value-schema subset carries type + enum only.
 */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SkillsCallAuthority, SkillsManagementModule } from '../skills/module.js'
import { SKILLS_REQUEST_STATES } from '../storage/skills-management.js'
import { compactJsonOutput, register } from './shared.js'

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    request_id: { type: 'string', required: true },
    revision: { type: 'number', required: true },
    received: { type: 'boolean', required: true },
    replayed: { type: 'boolean', required: true },
    state: { type: 'string', required: true, enum: [...SKILLS_REQUEST_STATES] },
    accepted_at: { type: 'number', required: true },
    updated_at: { type: 'number', required: true },
  },
} as const

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    request_id: { type: 'string', required: true },
    revision: { type: 'number', required: true },
    state: { type: 'string', required: true, enum: [...SKILLS_REQUEST_STATES] },
    reason: { type: 'string' },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        availableVersion: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            version: { type: 'string', required: true },
          },
        },
        attribution: {
          type: 'object',
          additionalProperties: false,
          properties: {
            memberSessionId: { type: 'string', required: true },
            taskId: { type: 'string', required: true },
            attemptId: { type: 'string' },
            name: { type: 'string', required: true },
            version: { type: 'string', required: true },
            manifestHash: { type: 'string', required: true },
          },
        },
        evidenceStates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ref: { type: 'string', required: true },
              state: { type: 'string', required: true, enum: ['proven', 'referenced', 'needs_evidence'] },
              detail: { type: 'string' },
            },
          },
        },
        sourceRevision: { type: 'number' },
        activityCursorSequence: { type: 'number' },
      },
    },
    payload: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        question: { type: 'string', required: true },
        goal: { type: 'string' },
        taskId: { type: 'string' },
        attemptId: { type: 'string' },
        skillName: { type: 'string' },
        evidence: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ref: { type: 'string', required: true },
              external: { type: 'boolean', required: true },
              sha256: { type: 'string' },
            },
          },
        },
      },
    },
    created_at: { type: 'number', required: true },
    updated_at: { type: 'number', required: true },
  },
} as const

const intakeArgsSchema = z.object({
  request_id: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  question: z.string().min(1).max(8_192),
  goal: z.string().min(1).max(8_192).optional(),
  task_id: z.string().min(1).max(256).optional(),
  attempt_id: z.string().min(1).max(256).optional(),
  skill_name: z.string().min(1).max(256).optional(),
  evidence_refs: z.array(z.string().min(1).max(2_048)).max(64).optional(),
}).strict()

const ASSIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string', required: true },
    team_id: { type: 'string', required: true },
    member_session_id: { type: 'string', required: true },
    skill_name: { type: 'string', required: true },
    version: { type: 'string', required: true },
    release_manifest_hash: { type: 'string', required: true },
    revision: { type: 'number', required: true },
  },
} as const

/** Register the two Captain-facing Skills tools for one module instance. */
export function registerSkillsManagementTools(ctx: Context, module: SkillsManagementModule): void {
  register(ctx, defineTool({
    name: 'agent_swarm_skills_request',
    description: 'Request a managed Skills outcome for this Team (Captain-only). The request is durable BEFORE the accepted receipt returns: reuse one stable request_id per logical request; the same id+revision+payload replays the stored receipt, and a different payload at the same revision is rejected as a conflict. External evidence is only referenced — this face never reads files and never calls a model.',
    parameters: {
      request_id: { type: 'string', required: true, description: 'Stable per-logical-request id; reuse it unchanged for retries.' },
      revision: { type: 'integer', required: true, description: 'Positive revision; only the next revision while still received.' },
      question: { type: 'string', required: true, description: 'The skill question to investigate.' },
      goal: { type: 'string', description: 'Optional goal context.' },
      task_id: { type: 'string', description: 'Optional Team task binding for precise evidence.' },
      attempt_id: { type: 'string', description: 'Optional Team attempt binding for precise evidence.' },
      skill_name: { type: 'string', description: 'Optional adoption target: an approved release assigned to the proven task owner may only be answered for this exact skill name.' },
      evidence_refs: { type: 'array', items: { type: 'string' }, description: 'Optional references only (internal ids or file:<abs-path>#sha256:<hex>); files are never read here.' },
    },
    output: compactJsonOutput(RECEIPT_SCHEMA),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = intakeArgsSchema.parse(args)
      return await module.request({
        requestId: input.request_id,
        revision: input.revision,
        question: input.question,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
        ...(input.attempt_id === undefined ? {} : { attemptId: input.attempt_id }),
        ...(input.skill_name === undefined ? {} : { skillName: input.skill_name }),
        ...(input.evidence_refs === undefined ? {} : { evidenceRefs: input.evidence_refs }),
      }, exec as SkillsCallAuthority)
    },
  }), 'skills-management request tool')

  register(ctx, defineTool({
    name: 'agent_swarm_skills_status',
    description: 'Read the durable Skills request state for this Team (Captain-only). The read is served from the module storage only — it never invokes a model, including after a process restart. States: received/investigating/available/needs_evidence/unavailable/failed/cancelled; unavailable and needs_evidence always carry the reason.',
    parameters: {
      request_id: { type: 'string', required: true, description: 'The request id from the receipt.' },
    },
    output: compactJsonOutput(STATUS_SCHEMA),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = z.object({ request_id: z.string().min(1).max(128) }).strict().parse(args)
      const view = await module.status(input.request_id, exec as SkillsCallAuthority)
      // The durable zod inference may carry explicit-undefined optional keys;
      // the wire schema promises absent-or-value — normalize through JSON.
      return JSON.parse(JSON.stringify(view))
    },
  }), 'skills-management status tool')

  // Cancellation and host-side manifest revocation stay on the module
  // service face (ctx.agentSwarmSkills): they are Host/owner operations, not
  // model-facing surfaces, so no third tool widens the model boundary.

  register(ctx, defineTool({
    name: 'agent_swarm_skills_assign',
    description: 'Assign an APPROVED immutable skill release version to ONE member of this Team (Captain-only). Requires the release to exist (approved on the Host management face) and, when the Team has an explicit allow-list, the name to be on it. The assignment durably pins the release manifest hash and is the only thing that makes the official load paths assemble that pinned body for the member. CAS: expected_revision 0 creates; a differing live revision conflicts.',
    parameters: {
      skill_name: { type: 'string', required: true, description: 'The approved release name.' },
      version: { type: 'string', required: true, description: 'The exact approved version.' },
      member: { type: 'string', required: true, description: 'Member Session id in this Team.' },
      expected_revision: { type: 'integer', description: '0 (default) creates the assignment; the live revision + identical version/manifest replays idempotently. While an assignment stands, a version or manifest change is refused (REASSIGN_UNSUPPORTED): in-flight loads keep their pinned body.' },
    },
    output: compactJsonOutput(ASSIGN_SCHEMA),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await module.releases.assign(args, exec as SkillsCallAuthority)
    },
  }), 'skills-management assign tool')
}

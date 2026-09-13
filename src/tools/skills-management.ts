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
    loaded_held: { type: 'boolean' },
  },
} as const

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string', required: true },
    team_id: { type: 'string', required: true },
    skill_name: { type: 'string', required: true },
    version: { type: 'string', required: true },
    status: { type: 'string', required: true },
    author_session_id: { type: 'string', required: true },
    candidate_hash: { type: 'string', required: true },
    request_id: { type: 'string', required: true },
    base_version: { type: 'string' },
    provider: { type: 'string' },
    locator: { type: 'string' },
    body: { type: 'string' },
    content_sha256: { type: 'string' },
    applicability: { type: 'string' },
    verification: { type: 'string' },
  },
} as const

const CANDIDATES_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
  },
} as const

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    skill_name: { type: 'string', required: true },
    version: { type: 'string', required: true },
    status: { type: 'string', required: true },
    scope: { type: 'string' },
    team_id: { type: 'string' },
    provider: { type: 'string' },
    content_sha256: { type: 'string' },
    resources_sha256: { type: 'string' },
    manifest_hash: { type: 'string' },
    author_session_id: { type: 'string' },
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
    description: 'Assign an APPROVED immutable skill release version to ONE member of this Team (Captain-only) — this is also the controlled version CHOICE and rollback surface: with expected_revision equal to the live revision, re-assigning a DIFFERENT approved version re-pins atomically (revision +1). Requires the release to exist (approved on the Host management face) and, when the Team has an explicit allow-list, the name to be on it. The assignment durably pins the release manifest hash and is the only thing that makes the official load paths assemble that pinned body for the member. CAS: expected_revision 0 creates; the live revision + identical version/manifest replays idempotently. If the member already LOADED the pinned body in its current session, the live load is held (response carries loaded_held: true) and switches at the next cold continuation of the member; an unloaded assembly switches immediately; re-pinning a cold member updates the durable pin for its next cold continuation.',
    parameters: {
      skill_name: { type: 'string', required: true, description: 'The approved release name.' },
      version: { type: 'string', required: true, description: 'The exact approved version.' },
      member: { type: 'string', required: true, description: 'Member Session id in this Team.' },
      expected_revision: { type: 'integer', description: '0 (default) creates the assignment; the live revision + identical version/manifest replays idempotently; the live revision + a different APPROVED version re-pins (version choice / rollback). Any other revision conflicts (STALE) and writes nothing.' },
    },
    output: compactJsonOutput(ASSIGN_SCHEMA),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await module.releases.assign(args, exec as SkillsCallAuthority)
    },
  }), 'skills-management assign tool')

  register(ctx, defineTool({
    name: 'agent_swarm_skills_propose',
    description: 'Capture an immutable release candidate for a known Skills request of a Team this module manages (module-owned Skills manager Session ONLY; ordinary members and the Captain cannot capture). The AUTHOR is derived from your real calling identity and cannot be named, renamed, or hidden by any parameter; the candidate binds the request, the target version, an optional approved base version, and the SHA-256 of the exact captured body. The same version slot with a different body conflicts (captures never change in place). Proposing is NOT publishing: the body becomes assignable only after an independent Captain review.',
    parameters: {
      request_id: { type: 'string', required: true, description: 'A known Skills request id of the owning Team (audit + revision context).' },
      skill_name: { type: 'string', required: true, description: 'The skill name the candidate revises.' },
      version: { type: 'string', required: true, description: 'The NEW candidate version (immutable slot).' },
      base_version: { type: 'string', description: 'Optional approved version this candidate revises; must exist as an approved release.' },
      provider: { type: 'string', required: true, description: 'The Skill provider the body was captured from.' },
      locator: { type: 'string', required: true, description: 'The provider locator behind the captured body.' },
      body: { type: 'string', required: true, description: 'The exact captured body text (immutable once captured).' },
      applicability: { type: 'string', required: true, description: 'When this candidate applies.' },
      verification: { type: 'string', required: true, description: 'The verification evidence behind the proposal.' },
    },
    output: compactJsonOutput(CANDIDATE_SCHEMA),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await module.candidates.proposeCandidate(args, exec as SkillsCallAuthority)
    },
  }), 'skills-management candidate proposal tool')

  register(ctx, defineTool({
    name: 'agent_swarm_skills_review',
    description: 'Independently approve or reject one PENDING captured release candidate of this Team (Captain-only). The reviewing identity is derived from your real calling Captain Session — there is no approver parameter to forge or omit — and the candidate author can never decide its own capture. Approving the exact captured candidate durably materializes the assignable immutable release (approvedBy = your derived identity); rejecting closes the candidate. Re-deciding a decided candidate conflicts.',
    parameters: {
      skill_name: { type: 'string', required: true, description: 'The captured candidate name.' },
      version: { type: 'string', required: true, description: 'The captured candidate version.' },
      decision: { type: 'string', required: true, description: 'approve | reject this exact captured candidate.' },
    },
    output: compactJsonOutput(REVIEW_SCHEMA),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await module.candidates.reviewCandidate(args, exec as SkillsCallAuthority)
    },
  }), 'skills-management candidate review tool')

  register(ctx, defineTool({
    name: 'agent_swarm_skills_candidates',
    description: 'Read the captured release candidates of this Team (Captain-only): the ACTUAL bodies, content/candidate digests, base versions, derived author Sessions and request bindings — so a review decision is made on the exact capture, never blind on a name/version pair. Status is derived from the durable approval fact (an approved release row); pending_only narrows to undecided captures.',
    parameters: {
      pending_only: { type: 'boolean', description: 'Only candidates without a decision yet (default all).' },
      limit: { type: 'integer', description: 'Bounded result size (1-64, default 20).' },
    },
    output: compactJsonOutput(CANDIDATES_LIST_SCHEMA),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await module.candidates.listCandidates(args, exec as SkillsCallAuthority)
    },
  }), 'skills-management candidate read tool')
}

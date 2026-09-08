/** Immutable schema definitions; the artifact entry remains the consumer contract. */
import { deepFreezeJson } from '../host/frozen-json.js'
import {
  SWARM_READ_RPC_ENDPOINT,
  SWARM_READ_RPC_NAMESPACE,
  SWARM_READ_RPC_PROTOCOL,
  SWARM_READ_RPC_VERSION,
} from './read-rpc-contract.js'

const SWARM_READ_RPC_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const
export const SWARM_READ_RPC_CONTRACT_DIGEST_V1 = '2770961880caa0a382d2ec8e2efd7662232d78d118ebf3b7d80f28689f158813' as const

const boundedString = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' })
/** Member role is authoritative free-text (never truncated by the reader); the
 *  frozen consumer schema admits a bounded window that covers realistic role
 *  descriptions. Raise together with SWARM_READ_RPC_CONTRACT_DIGEST_V1. */
const ROSTER_ROLE_MAX_LENGTH = 2048
const nonNegativeInteger = { type: 'integer', minimum: 0 }
const cursor = { type: 'string', pattern: '^r1:[a-f0-9]{64}$' }
const target = {
  type: 'object', additionalProperties: false, required: ['rootSessionId'],
  properties: { rootSessionId: boundedString(256), teamId: boundedString(128) },
}
const requestBase = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'method', 'target'],
  properties: { schemaVersion: { const: 1 }, target, afterCursor: cursor },
}
const binding = {
  type: 'object', additionalProperties: false, required: ['rootSessionId', 'teamId'],
  properties: { rootSessionId: boundedString(256), teamId: boundedString(128) },
}
const team = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'phase', 'revision', 'createdAt', 'updatedAt'],
  properties: {
    id: boundedString(128), name: boundedString(128), phase: { enum: ['staged', 'active', 'archived'] },
    revision: nonNegativeInteger, createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
    plan: {
      type: 'object', additionalProperties: false, required: ['members', 'tasks'],
      properties: { members: nonNegativeInteger, tasks: nonNegativeInteger },
    },
  },
}
const assetStatus = {
  type: 'object', additionalProperties: false, required: ['state'],
  properties: {
    state: { enum: ['generated', 'not_generated', 'unavailable'] },
    reason: { enum: ['avatar_backend_not_implemented', 'identity_backend_not_implemented', 'notice_board_not_implemented'] },
    // Strictly allowlisted pixel-avatar SVG, present only when state === 'generated'.
    svg: boundedString(16384),
  },
}
const endpointRef = {
  type: 'object', additionalProperties: false, required: ['method', 'target'],
  properties: {
    method: { enum: ['captainMembers', 'captainAnnouncements', 'captainDiagnostics'] },
    target: {
      type: 'object', additionalProperties: false, required: ['rootSessionId', 'teamId'],
      properties: { rootSessionId: boundedString(256), teamId: boundedString(128) },
    },
  },
}
const teamGoal = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['state', 'text'],
      properties: { state: { const: 'generated' }, text: boundedString(4096) },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['state', 'reason'],
      properties: { state: { const: 'not_generated' }, reason: { const: 'goal_not_set' } },
    },
  ],
}
const teamDescriptor = {
  type: 'object', additionalProperties: false,
  required: ['teamId', 'name', 'phase', 'captainSessionId', 'avatar', 'identityCard', 'goal', 'endpoints'],
  properties: {
    teamId: boundedString(128), name: boundedString(128), phase: { enum: ['staged', 'active', 'archived'] },
    captainSessionId: boundedString(256),
    displayName: boundedString(128),
    profession: boundedString(256),
    personality: boundedString(1024),
    biography: boundedString(1024),
    avatar: assetStatus, identityCard: assetStatus,
    goal: teamGoal,
    endpoints: {
      type: 'object', additionalProperties: false,
      required: ['members', 'announcements', 'diagnostics'],
      properties: { members: endpointRef, announcements: endpointRef, diagnostics: endpointRef },
    },
  },
}
const memberGrowth = {
  type: 'object', additionalProperties: false,
  required: ['privateMemory', 'skills', 'capability'],
  properties: {
    privateMemory: { const: 'private_to_member' },
    skills: { const: 'not_implemented' },
    capability: { const: 'not_implemented' },
  },
}
/** Row-local member composition (captainMembers.composition.v1): state/reason are fixed
 *  diagnostics; `deniedTools` is the declared tool-denial restriction list, never an
 *  enumeration of permitted tools. A non-`available` row discloses only `runtimeProvider`. */
const memberComposition = {
  type: 'object', additionalProperties: false,
  required: ['state', 'reason', 'runtimeProvider'],
  properties: {
    state: { enum: ['available', 'pending', 'unavailable', 'invalid'] },
    reason: {
      enum: ['available', 'provisioning', 'startup_failed', 'removed', 'inspection_failed',
        'active_session_missing', 'binding_invalid', 'descriptor_invalid', 'not_continuable', 'tool_filter_invalid'],
    },
    runtimeProvider: boundedString(128),
    llmProvider: boundedString(128),
    model: boundedString(128),
    presetId: boundedString(128),
    personaConfigured: { type: 'boolean' },
    deniedTools: { type: 'array', items: boundedString(128) },
  },
}
const captainMemberRow = {
  type: 'object', additionalProperties: false,
  required: ['name', 'role', 'phase', 'createdAt', 'avatar', 'identityCard', 'growth', 'composition'],
  properties: {
    name: boundedString(64), role: boundedString(ROSTER_ROLE_MAX_LENGTH),
    phase: { enum: ['provisioning', 'active', 'failed', 'removed'] }, createdAt: nonNegativeInteger,
    displayName: boundedString(128),
    profession: boundedString(256),
    personality: boundedString(1024),
    biography: boundedString(1024),
    avatar: assetStatus, identityCard: assetStatus,
    growth: memberGrowth,
    composition: memberComposition,
    // Member-detail overlay fields (all optional, fail-closed when absent):
    // skills/callableTools are bounded enumerations (empty = declared none);
    // growthSummary is a bounded summary (empty allowed until a summary exists).
    skills: { type: 'array', maxItems: 64, items: boundedString(128) },
    // Issue #184 A5: the member-assigned subset, distinct from the Session-
    // visible catalog `skills`; empty = an explicit declared empty subset.
    assignedSkills: { type: 'array', maxItems: 64, items: boundedString(128) },
    callableTools: { type: 'array', maxItems: 128, items: boundedString(128) },
    growthSummary: { type: 'string', maxLength: 2048 },
    currentActivity: {
      type: 'object', additionalProperties: false,
      required: ['taskId', 'subject', 'status'],
      properties: {
        taskId: boundedString(128), subject: boundedString(256),
        status: { enum: ['pending', 'in_progress', 'submitted', 'verifying'] },
      },
    },
    recentOutcome: {
      type: 'object', additionalProperties: false,
      required: ['taskId', 'phase', 'at'],
      properties: { taskId: boundedString(128), phase: { enum: ['accepted', 'rejected'] }, at: nonNegativeInteger },
    },
  },
}
const sectionBinding = {
  type: 'object', additionalProperties: false, required: ['rootSessionId', 'teamId'],
  properties: { rootSessionId: boundedString(256), teamId: boundedString(128) },
}
const announcementEntry = {
  type: 'object', additionalProperties: false,
  required: ['id', 'text', 'createdAt'],
  properties: { id: boundedString(64), text: boundedString(4096), createdAt: nonNegativeInteger },
}
/** Captain-scoped read target: the caller must select exactly one Team to read a section. */
const sectionTarget = {
  type: 'object', additionalProperties: false, required: ['rootSessionId', 'teamId'],
  properties: { rootSessionId: boundedString(256), teamId: boundedString(128) },
}
const budget = {
  type: 'object', additionalProperties: false, required: ['usedTokens', 'usedRequests', 'usedRetries'],
  properties: {
    usedTokens: nonNegativeInteger, usedRequests: nonNegativeInteger, usedRetries: nonNegativeInteger,
    tokenLimit: { type: 'integer', minimum: 1 }, requestLimit: { type: 'integer', minimum: 1 },
    retryLimit: { type: 'integer', minimum: 1 }, deadlineAt: nonNegativeInteger,
  },
}
const totals = {
  type: 'object', additionalProperties: false,
  required: ['roster', 'tasks', 'attempts', 'pendingInteractions'],
  properties: {
    roster: nonNegativeInteger, tasks: nonNegativeInteger,
    attempts: nonNegativeInteger, pendingInteractions: nonNegativeInteger,
  },
}
const truncation = {
  type: 'object', additionalProperties: false,
  required: ['roster', 'tasks', 'attempts', 'pendingInteractions'],
  properties: {
    roster: { type: 'boolean' }, tasks: { type: 'boolean' },
    attempts: { type: 'boolean' }, pendingInteractions: { type: 'boolean' },
  },
}
const capability = {
  type: 'object', additionalProperties: false, required: ['capability', 'state'],
  properties: {
    capability: { enum: ['skillCatalog.read', 'teams.read', 'binding.read', 'status.read', 'snapshot.read', 'page.read', 'captainMembers.read', 'captainAnnouncements.read', 'captainDiagnostics.read', 'message.write', 'control.write', 'effect.cancel'] },
    state: { enum: ['available', 'unavailable'] },
    blocker: { enum: ['listener-not-loopback', 'i1b-effect-correlation'] },
  },
}
const producerCapability = {
  type: 'object', additionalProperties: false, required: ['capability', 'state'],
  properties: {
    capability: { enum: ['snapshot.read', 'receipt.read', 'message.write', 'control.write', 'effect.cancel'] },
    state: { enum: ['available', 'unavailable'] }, blocker: { const: 'i1b-effect-correlation' },
  },
}
const rosterRow = {
  type: 'object', additionalProperties: false, required: ['name', 'role', 'phase', 'createdAt'],
  properties: {
    provisioningAttempt: { type: 'integer', minimum: 1, maximum: 65 },
    name: boundedString(64), role: boundedString(ROSTER_ROLE_MAX_LENGTH),
    phase: { enum: ['provisioning', 'active', 'failed', 'removed'] }, createdAt: nonNegativeInteger,
  },
}
const taskRow = {
  type: 'object', additionalProperties: false,
  required: ['id', 'revision', 'subject', 'status', 'blockedBy', 'priority', 'createdAt', 'updatedAt'],
  properties: {
    id: boundedString(128), revision: nonNegativeInteger, subject: boundedString(256),
    status: { enum: ['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled'] },
    blockedBy: { type: 'array', maxItems: 100, items: boundedString(128) },
    priority: { type: 'integer' }, ownerName: boundedString(64), targetMemberName: boundedString(64), currentAttemptId: boundedString(128),
    createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
  },
}
const attemptRow = {
  type: 'object', additionalProperties: false,
  required: ['id', 'taskId', 'generation', 'phase', 'assignmentPhase', 'createdAt', 'updatedAt'],
  properties: {
    id: boundedString(128), taskId: boundedString(128), generation: { type: 'integer', minimum: 1 },
    memberName: boundedString(64),
    phase: { enum: ['running', 'submitted', 'verifying', 'accepted', 'rejected', 'cancelled', 'stale'] },
    assignmentPhase: { enum: ['reserved', 'delivered'] },
    createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
  },
}
const interactionRow = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'intent', 'targetKind', 'status', 'createdAt', 'updatedAt'],
  properties: {
    requestId: boundedString(96), intent: boundedString(64),
    targetKind: { enum: ['captain', 'team', 'member', 'task'] }, targetRef: boundedString(128),
    status: { enum: ['pending', 'acknowledged'] }, createdAt: nonNegativeInteger, updatedAt: nonNegativeInteger,
  },
}
export const pageRows = { tasks: taskRow, attempts: attemptRow, pendingInteractions: interactionRow } as const
const pageResultBase = {
  type: 'object', additionalProperties: false,
  required: [
    'kind', 'entries', 'offset', 'limit', 'visibleTotal', 'authoritativeTotal', 'projectionTruncated',
    'cursor', 'changed', 'resyncRequired', 'observedAt',
  ],
  properties: {
    offset: nonNegativeInteger,
    limit: { type: 'integer', minimum: 1, maximum: 50 }, visibleTotal: nonNegativeInteger,
    authoritativeTotal: nonNegativeInteger, nextOffset: nonNegativeInteger,
    projectionTruncated: { type: 'boolean' }, cursor, changed: { type: 'boolean' },
    resyncRequired: { type: 'boolean' }, observedAt: nonNegativeInteger,
  },
}
const pageResult = (kind: keyof typeof pageRows) => ({
  ...pageResultBase,
  properties: {
    ...pageResultBase.properties,
    kind: { const: kind }, entries: { type: 'array', maxItems: 50, items: pageRows[kind] },
  },
})
const resultBase = {
  type: 'object', additionalProperties: false,
  required: ['binding', 'team', 'cursor', 'changed', 'resyncRequired'],
  properties: {
    binding, team, cursor, changed: { type: 'boolean' }, resyncRequired: { type: 'boolean' },
  },
}

export const SWARM_READ_RPC_CONTRACT_V1 = deepFreezeJson({
  protocol: SWARM_READ_RPC_PROTOCOL,
  version: SWARM_READ_RPC_VERSION,
  namespace: SWARM_READ_RPC_NAMESPACE,
  endpoint: SWARM_READ_RPC_ENDPOINT,
  schemaDialect: SWARM_READ_RPC_SCHEMA_DIALECT,
  schemas: {
    request: {
      $schema: SWARM_READ_RPC_SCHEMA_DIALECT,
      oneOf: [
        {
          type: 'object', additionalProperties: false, required: ['schemaVersion', 'method'],
          properties: { schemaVersion: { const: 1 }, method: { const: 'capabilities' } },
        },
        {
          ...requestBase, properties: { ...requestBase.properties, method: { const: 'teams' } },
        },
        {
          ...requestBase, properties: { ...requestBase.properties, method: { const: 'skillCatalog' } },
        },
        ...(['captainMembers', 'captainAnnouncements', 'captainDiagnostics'] as const).map(method => ({
          type: 'object', additionalProperties: false,
          required: ['schemaVersion', 'method', 'target'],
          properties: {
            schemaVersion: { const: 1 }, method: { const: method },
            target: sectionTarget,
          },
        })),
        ...(['binding', 'status', 'snapshot'] as const).map(method => ({
          ...requestBase, properties: { ...requestBase.properties, method: { const: method } },
        })),
        {
          ...requestBase,
          required: [...requestBase.required, 'page'],
          properties: {
            ...requestBase.properties, method: { const: 'page' },
            page: {
              type: 'object', additionalProperties: false, required: ['kind'],
              properties: {
                kind: { enum: ['tasks', 'attempts', 'pendingInteractions'] },
                offset: nonNegativeInteger, limit: { type: 'integer', minimum: 1, maximum: 50 },
              },
            },
          },
        },
      ],
    },
    values: {
      capabilities: {
        type: 'object', additionalProperties: false,
        required: ['protocol', 'version', 'namespace', 'trust', 'capabilities'],
        properties: {
          protocol: { const: SWARM_READ_RPC_PROTOCOL }, version: { const: 1 }, namespace: { const: SWARM_READ_RPC_NAMESPACE },
          trust: {
            type: 'object', additionalProperties: false, required: ['mode', 'principalBound', 'listener'],
            properties: {
              mode: { const: 'local-single-user-target-bound' }, principalBound: { const: false },
              listener: { enum: ['loopback', 'non-loopback'] },
            },
          },
          capabilities: { type: 'array', minItems: 12, maxItems: 12, items: capability },
        },
      },
      skillCatalog: {
        type: 'object', additionalProperties: false,
        required: ['schemaVersion', 'binding', 'complete', 'skills', 'observedAt'],
        properties: {
          schemaVersion: { const: 1 },
          binding: {
            type: 'object', additionalProperties: false, required: ['rootSessionId'],
            properties: { rootSessionId: boundedString(256) },
          },
          complete: { type: 'boolean' }, skills: {
            type: 'array', maxItems: 512,
            items: {
              type: 'object', additionalProperties: false,
              required: ['name', 'description', 'modelInvocable'],
              properties: {
                name: boundedString(128), description: boundedString(4096),
                whenToUse: boundedString(4096), modelInvocable: { const: true },
              },
            },
          },
          observedAt: nonNegativeInteger,
        },
      },
      teams: {
        type: 'object', additionalProperties: false,
        required: ['schemaVersion', 'binding', 'teams', 'observedAt', 'complete'],
        properties: {
          schemaVersion: { const: 1 },
          binding: {
            type: 'object', additionalProperties: false, required: ['rootSessionId'],
            properties: { rootSessionId: boundedString(256) },
          },
          teams: { type: 'array', maxItems: 100, items: teamDescriptor },
          observedAt: nonNegativeInteger, complete: { type: 'boolean' },
        },
      },
      captainMembers: {
        type: 'object', additionalProperties: false,
        required: ['schemaVersion', 'binding', 'members', 'observedAt'],
        properties: {
          schemaVersion: { const: 1 }, binding: sectionBinding,
          members: { type: 'array', maxItems: 100, items: captainMemberRow }, observedAt: nonNegativeInteger,
          teamAllowedSkills: { type: 'array', maxItems: 64, items: boundedString(128) },
        },
      },
      captainAnnouncements: {
        type: 'object', additionalProperties: false,
        required: ['schemaVersion', 'binding', 'state', 'entries', 'observedAt'],
        properties: {
          schemaVersion: { const: 1 }, binding: sectionBinding,
          state: { const: 'available' },
          entries: { type: 'array', maxItems: 32, items: announcementEntry },
          // Optional legacy field retained for type/schema consistency (never
          // emitted by the live backend, whose announcements are always real).
          reason: { type: 'string' },
          observedAt: nonNegativeInteger,
        },
      },
      captainDiagnostics: {
        type: 'object', additionalProperties: false,
        required: ['schemaVersion', 'binding', 'diagnostics', 'observedAt'],
        properties: {
          schemaVersion: { const: 1 }, binding: sectionBinding,
          diagnostics: {
            type: 'object', additionalProperties: false,
            required: ['revision', 'phase', 'taskCount', 'attemptCount', 'memberCount', 'backend'],
            properties: {
              revision: nonNegativeInteger, phase: { enum: ['staged', 'active', 'archived'] },
              taskCount: nonNegativeInteger, attemptCount: nonNegativeInteger, memberCount: nonNegativeInteger,
              backend: { const: 'team-domain' },
            },
          },
          observedAt: nonNegativeInteger,
        },
      },
      binding: resultBase,
      status: {
        ...resultBase,
        required: [...resultBase.required, 'budget', 'totals', 'truncated', 'capabilities', 'observedAt'],
        properties: {
          ...resultBase.properties, budget, totals, truncated: truncation,
          capabilities: { type: 'array', maxItems: 5, items: producerCapability }, observedAt: nonNegativeInteger,
        },
      },
      snapshot: {
        type: 'object', additionalProperties: false,
        required: [
          'schemaVersion', 'binding', 'team', 'roster', 'tasks', 'attempts', 'budget', 'pendingInteractions',
          'totals', 'truncated', 'capabilities', 'cursor', 'changed', 'resyncRequired', 'observedAt',
        ],
        properties: {
          schemaVersion: { const: 1 }, binding, team,
          roster: { type: 'array', maxItems: 100, items: rosterRow },
          tasks: { type: 'array', maxItems: 100, items: taskRow },
          attempts: { type: 'array', maxItems: 200, items: attemptRow },
          budget,
          pendingInteractions: { type: 'array', maxItems: 100, items: interactionRow },
          totals, truncated: truncation, capabilities: { type: 'array', maxItems: 5, items: producerCapability },
          cursor, changed: { type: 'boolean' }, resyncRequired: { type: 'boolean' }, observedAt: nonNegativeInteger,
        },
      },
      page: { oneOf: [pageResult('tasks'), pageResult('attempts'), pageResult('pendingInteractions')] },
      failure: {
        type: 'object', additionalProperties: false, required: ['schemaVersion', 'ok', 'error'],
        properties: {
          schemaVersion: { const: 1 }, ok: { const: false },
          error: {
            type: 'object', additionalProperties: false, required: ['code', 'message'],
            properties: { code: boundedString(128), message: boundedString(256) },
          },
        },
      },
    },
  },
})

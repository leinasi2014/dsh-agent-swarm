/** Immutable R2 schema/fixture artifact shared by DSH and Canvas consumers. */
import { deepFreezeJson } from '../host/frozen-json.js'
import {
  SWARM_READ_RPC_ENDPOINT,
  SWARM_READ_RPC_NAMESPACE,
  SWARM_READ_RPC_PROTOCOL,
  SWARM_READ_RPC_VERSION,
} from './read-rpc-contract.js'

// Keep the browser RPC decoder independent from Host-only domain errors
// (`TeamDomainError` extends @deepseek-ai/dsh-llm's Node implementation).
// This is the same deliberately small pixel-SVG grammar enforced on write.
const CAPTAIN_ANNOUNCEMENT_ID_RE = /^ann-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PIXEL_NUMBER_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u
const PIXEL_FILL_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$|^currentColor$/u
const PIXEL_OPACITY_RE = /^(?:0|1|0(?:\.\d+)?|1(?:\.0+)?)$/u

function parsePixelAttrs(raw: string, allowed: ReadonlySet<string>): ReadonlyMap<string, string> | undefined {
  const out = new Map<string, string>()
  let index = 0
  while (index < raw.length) {
    while (/\s/u.test(raw[index] ?? '')) index += 1
    if (index >= raw.length) break
    const match = /^([a-z][a-zA-Z0-9-]*)\s*=\s*(["'])(.*?)\2/su.exec(raw.slice(index))
    if (match === null || !allowed.has(match[1]!) || out.has(match[1]!) || [...match[3]!].length > 64) return undefined
    out.set(match[1]!, match[3]!)
    index += match[0].length
  }
  return out
}

function isSafePixelAvatarSvg(value: string): boolean {
  const svg = value.trim()
  if (svg === '' || svg.length > 16_384) return false
  const lower = svg.toLowerCase()
  if (['<script', '<style', '<foreignobject', '<animate', '<set', '<use', '<image', '<text', '<a ', '<g ', '<circle', '<ellipse', '<line ', '<polyline', '<polygon', '<path', 'url(', 'javascript:', 'onload', 'onerror', 'onclick', 'onmouse', 'onfocus', 'href', 'xlink', '&#', '<?', '<!'].some(token => lower.includes(token))) return false
  const root = /^\s*<svg\b([^>]*)>\s*([\s\S]*?)\s*<\/svg>\s*$/u.exec(svg)
  if (root === null) return false
  const rootAttrs = parsePixelAttrs(root[1]!, new Set(['viewBox']))
  const viewBox = rootAttrs?.get('viewBox')
  const viewBoxMatch = /^0\s+0\s+(\d{1,2})\s+(\d{1,2})$/u.exec(viewBox ?? '')
  if (viewBoxMatch === null) return false
  const edge = Number(viewBoxMatch[1])
  if (edge !== Number(viewBoxMatch[2]) || edge < 8 || edge > 32) return false
  let body = root[2]!.trim()
  let rects = 0
  while (body !== '') {
    const rect = /^<rect\b([^>]*?)\s*\/>/u.exec(body)
    if (rect === null) return false
    const attrs = parsePixelAttrs(rect[1]!, new Set(['x', 'y', 'width', 'height', 'fill', 'opacity']))
    if (attrs === undefined) return false
    for (const name of ['x', 'y', 'width', 'height']) {
      const raw = attrs.get(name)
      if (raw !== undefined && !PIXEL_NUMBER_RE.test(raw)) return false
    }
    const fill = attrs.get('fill')
    if (fill !== undefined && !PIXEL_FILL_RE.test(fill)) return false
    const opacity = attrs.get('opacity')
    if (opacity !== undefined && (!PIXEL_OPACITY_RE.test(opacity) || Number(opacity) > 1)) return false
    rects += 1
    if (rects > 256) return false
    body = body.slice(rect[0].length).trimStart()
  }
  return true
}

const SWARM_READ_RPC_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const
export const SWARM_READ_RPC_CONTRACT_DIGEST_V1 = '5e7f9384d1f7106361aa4136728919d8cec47d0d5295018bdec38bab0da03de6' as const

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
    avatar: assetStatus, identityCard: assetStatus,
    growth: memberGrowth,
    composition: memberComposition,
    // Member-detail overlay fields (all optional, fail-closed when absent):
    // skills/callableTools are bounded enumerations (empty = declared none);
    // growthSummary is a bounded summary (empty allowed until a summary exists).
    skills: { type: 'array', maxItems: 64, items: boundedString(128) },
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
const pageRows = { tasks: taskRow, attempts: attemptRow, pendingInteractions: interactionRow } as const
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

const readCapabilities = [
  { capability: 'skillCatalog.read', state: 'available' },
  { capability: 'teams.read', state: 'available' },
  { capability: 'binding.read', state: 'available' }, { capability: 'status.read', state: 'available' },
  { capability: 'snapshot.read', state: 'available' }, { capability: 'page.read', state: 'available' },
  { capability: 'captainMembers.read', state: 'available' },
  { capability: 'captainAnnouncements.read', state: 'available' },
  { capability: 'captainDiagnostics.read', state: 'available' },
  { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
]
const projectionCapabilities = [
  { capability: 'snapshot.read', state: 'available' },
  { capability: 'receipt.read', state: 'available' },
  { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
]
const fixtureCursor = `r1:${'a'.repeat(64)}`
const fixtureBinding = { rootSessionId: 'session-fixture', teamId: 'team-fixture' }
const fixtureTeam = {
  id: 'team-fixture', name: 'Fixture Team', phase: 'active', revision: 7,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_100,
}
const fixtureResultBase = {
  binding: fixtureBinding, team: fixtureTeam, cursor: fixtureCursor, changed: true, resyncRequired: false,
}
const fixtureTotals = { roster: 0, tasks: 0, attempts: 0, pendingInteractions: 0 }
const fixtureTruncated = { roster: false, tasks: false, attempts: false, pendingInteractions: false }
const fixtureBudget = { usedTokens: 12, usedRequests: 2, usedRetries: 0, tokenLimit: 1_000 }

export const SWARM_READ_RPC_FIXTURES_V1 = deepFreezeJson({
  requests: {
    capabilities: { schemaVersion: 1, method: 'capabilities' },
    skillCatalog: { schemaVersion: 1, method: 'skillCatalog', target: { rootSessionId: 'session-fixture' } },
    teams: { schemaVersion: 1, method: 'teams', target: { rootSessionId: 'session-fixture' } },
    captainMembers: { schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    captainAnnouncements: { schemaVersion: 1, method: 'captainAnnouncements', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    captainDiagnostics: { schemaVersion: 1, method: 'captainDiagnostics', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    snapshot: { schemaVersion: 1, method: 'snapshot', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    page: {
      schemaVersion: 1, method: 'page', target: { rootSessionId: 'session-fixture' },
      afterCursor: `r1:${'a'.repeat(64)}`, page: { kind: 'tasks', offset: 0, limit: 50 },
    },
  },
  values: {
    capabilities: {
      protocol: SWARM_READ_RPC_PROTOCOL, version: 1, namespace: SWARM_READ_RPC_NAMESPACE,
      trust: { mode: 'local-single-user-target-bound', principalBound: false, listener: 'loopback' },
      capabilities: readCapabilities,
    },
    skillCatalog: {
      schemaVersion: 1,
      binding: { rootSessionId: 'session-fixture' },
      complete: true,
      skills: [{
        name: 'frontend-review', description: 'Review a frontend implementation.',
        whenToUse: 'Use after UI implementation.', modelInvocable: true,
      }],
      observedAt: 1_700_000_000_200,
    },
    teams: {
      schemaVersion: 1, binding: { rootSessionId: 'session-fixture' },
      teams: [{
        teamId: 'team-fixture', name: 'Fixture Team', phase: 'active', captainSessionId: 'session-fixture',
        displayName: 'Fixture Captain', profession: 'Coordinator', personality: 'Steady',
        avatar: { state: 'generated', svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
        identityCard: { state: 'generated' },
        goal: { state: 'generated', text: 'Deliver the Team UI.' },
        endpoints: {
          members: { method: 'captainMembers', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
          announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
          diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
        },
      }],
      observedAt: 1_700_000_000_200, complete: true,
    },
    captainMembers: {
      schemaVersion: 1, binding: fixtureBinding,
      members: [
        { name: 'worker', role: 'writer', phase: 'active', createdAt: 1_700_000_000_000,
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
          growth: { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
          composition: {
            state: 'available', reason: 'available', runtimeProvider: 'spawn',
            llmProvider: 'mock', model: 'worker-model', personaConfigured: true,
            deniedTools: ['agent_swarm_create_managed'],
          } },
        { name: 'artist', role: 'artist', phase: 'active', createdAt: 1_700_000_000_001,
          displayName: 'Pixel Painter', profession: 'Avatar artist', personality: 'Careful, meticulous',
          avatar: { state: 'generated', svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
          identityCard: { state: 'generated' },
          growth: { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
          // A corrupt child log fails CLOSED into its own row only: the row still
          // renders (identity/roster authority is the Team aggregate) while the
          // composition honestly reports the explicit failure and discloses
          // nothing beyond the recovery fence provider.
          composition: { state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: 'spawn' } },
      ],
      observedAt: 1_700_000_000_200,
    },
    captainAnnouncements: {
      schemaVersion: 1, binding: fixtureBinding,
      state: 'available',
      entries: [{ id: 'ann-00000000-0000-0000-0000-000000000001', text: 'Welcome to the Fixture Team.', createdAt: 1_700_000_000_050 }],
      observedAt: 1_700_000_000_200,
    },
    captainDiagnostics: {
      schemaVersion: 1, binding: fixtureBinding,
      diagnostics: { revision: 7, phase: 'active', taskCount: 3, attemptCount: 1, memberCount: 1, backend: 'team-domain' },
      observedAt: 1_700_000_000_200,
    },
    binding: fixtureResultBase,
    status: {
      ...fixtureResultBase, budget: fixtureBudget, totals: fixtureTotals, truncated: fixtureTruncated,
      capabilities: projectionCapabilities, observedAt: 1_700_000_000_200,
    },
    snapshot: {
      schemaVersion: 1, ...fixtureResultBase, roster: [], tasks: [], attempts: [], budget: fixtureBudget,
      pendingInteractions: [], totals: fixtureTotals, truncated: fixtureTruncated,
      capabilities: projectionCapabilities, observedAt: 1_700_000_000_200,
    },
    page: {
      kind: 'tasks', entries: [], offset: 0, limit: 50, visibleTotal: 0, authoritativeTotal: 0,
      projectionTruncated: false, cursor: fixtureCursor, changed: false,
      resyncRequired: false, observedAt: 1_700_000_000_000,
    },
    failure: {
      schemaVersion: 1, ok: false,
      error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'Target root Session is not live' },
    },
  },
})

/** Stable Unicode code-unit key order; consumers can independently verify the digest. */
export function canonicalSwarmReadRpcJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

/** Strict browser-side result validation against the frozen method schema. */
export function assertSwarmReadRpcValue(method: string, value: unknown): void {
  const key = method === 'capabilities' || method === 'skillCatalog' || method === 'teams' || method === 'captainMembers'
    || method === 'captainAnnouncements' || method === 'captainDiagnostics'
    || method === 'binding' || method === 'status'
    || method === 'snapshot' || method === 'page' ? method : undefined
  if (key === undefined) throw new Error('Swarm RPC method is not a read method')
  const schema = SWARM_READ_RPC_CONTRACT_V1.schemas.values[key]
  assertSchema(value, schema, '$', { seen: new WeakSet<object>(), nodes: 0 })
  assertResultSemantics(key, value as Record<string, unknown>)
}

/** Shared avatar safety semantics for a Team or member asset row.
 *  - `generated` must carry a strictly allowlisted `svg` and no `reason`;
 *  - `not_generated` must carry NO `svg` and exactly reason `avatar_backend_not_implemented`;
 *  - any other state may carry neither `svg` nor a contradictory reason.
 *  Wrong/contradictory reasons or states are rejected. */
function assertAvatarSemantics(row: Record<string, unknown>, label: string): void {
  const avatar = row.avatar as Record<string, unknown> | undefined
  if (avatar === undefined) return
  const state = avatar.state
  const hasSvg = avatar.svg !== undefined
  if (state === 'generated') {
    const svg = avatar.svg
    if (typeof svg !== 'string' || !isSafePixelAvatarSvg(svg)) {
      throw new Error(`Swarm RPC ${label} avatar generated must carry a safe svg`)
    }
    if (avatar.reason !== undefined) throw new Error(`Swarm RPC ${label} avatar generated must not carry a reason`)
  } else if (state === 'not_generated') {
    if (hasSvg) throw new Error(`Swarm RPC ${label} avatar not_generated must not carry svg`)
    if (avatar.reason !== 'avatar_backend_not_implemented') {
      throw new Error(`Swarm RPC ${label} avatar not_generated must carry reason avatar_backend_not_implemented`)
    }
  } else {
    // Only generated / not_generated are accepted for Team/member avatars;
    // unavailable and any other contradictory state are rejected.
    throw new Error(`Swarm RPC ${label} avatar state must be generated or not_generated`)
  }
}

/** Identity-card↔profile linkage (strict):
 *  - `generated` requires at least one profile field and no `reason`;
 *  - `not_generated` must carry no profile fields and exactly reason
 *    `identity_backend_not_implemented`;
 *  - no other state is accepted. */
function assertIdentityCardSemantics(row: Record<string, unknown>, label: string): void {
  const identityCard = row.identityCard as Record<string, unknown> | undefined
  if (identityCard === undefined) return
  const state = identityCard.state
  const hasProfile = row.displayName !== undefined || row.profession !== undefined || row.personality !== undefined
  if (state === 'generated') {
    if (!hasProfile) throw new Error(`Swarm RPC ${label} identityCard generated requires profile fields`)
    if (identityCard.reason !== undefined) throw new Error(`Swarm RPC ${label} identityCard generated must not carry a reason`)
    return
  }
  if (hasProfile) throw new Error(`Swarm RPC ${label} identityCard non-generated must not carry profile fields`)
  if (state !== 'not_generated') {
    throw new Error(`Swarm RPC ${label} identityCard state must be generated or not_generated`)
  }
  if (identityCard.reason !== 'identity_backend_not_implemented') {
    throw new Error(`Swarm RPC ${label} identityCard not_generated must carry reason identity_backend_not_implemented`)
  }
}

/** Team endpoint refs must use the canonical methods and target the outer binding
 *  `rootSessionId` (never `team.captainSessionId`, which differs for parent-root reads). */
function assertTeamEndpoints(team: Record<string, unknown>, bindingRootSessionId: string): void {
  const endpoints = team.endpoints as Record<string, unknown> | undefined
  if (endpoints === undefined) return
  const teamId = team.teamId as string
  const expectedMethods = { members: 'captainMembers', announcements: 'captainAnnouncements', diagnostics: 'captainDiagnostics' } as const
  for (const key of Object.keys(expectedMethods) as Array<keyof typeof expectedMethods>) {
    const ref = endpoints[key] as Record<string, unknown> | undefined
    if (ref === undefined) throw new Error(`Swarm RPC Team endpoint ${key} is missing`)
    if (ref.method !== expectedMethods[key]) throw new Error(`Swarm RPC Team endpoint ${key} method is inconsistent`)
    const target = ref.target as Record<string, unknown> | undefined
    if (target === undefined || target.rootSessionId !== bindingRootSessionId || target.teamId !== teamId) {
      throw new Error(`Swarm RPC Team endpoint ${key} target is inconsistent`)
    }
  }
}

/** Public-goal projection semantics: `generated` requires non-empty `text`; `not_generated`
 *  requires exactly reason `goal_not_set` and no `text`. */
function assertGoalSemantics(team: Record<string, unknown>): void {
  const goal = team.goal as Record<string, unknown> | undefined
  if (goal === undefined) return
  if (goal.state === 'generated') {
    if (typeof goal.text !== 'string' || goal.text === '' || goal.text !== goal.text.trim()) {
      throw new Error('Swarm RPC Team goal generated must carry canonical non-empty text')
    }
  } else if (goal.state === 'not_generated') {
    if (goal.text !== undefined || goal.reason !== 'goal_not_set') {
      throw new Error('Swarm RPC Team goal not_generated must carry reason goal_not_set and no text')
    }
  } else {
    throw new Error('Swarm RPC Team goal state must be generated or not_generated')
  }
}

const MEMBER_GROWTH_ENUM = { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' } as const

/** Non-sensitive availability enum: every member must expose the constant growth triad
 *  (a deviation or any content-bearing field is a contract violation). */
function assertMemberGrowth(member: Record<string, unknown>): void {
  const growth = member.growth as Record<string, unknown> | undefined
  if (growth === undefined
    || growth.privateMemory !== MEMBER_GROWTH_ENUM.privateMemory
    || growth.skills !== MEMBER_GROWTH_ENUM.skills
    || growth.capability !== MEMBER_GROWTH_ENUM.capability
    || Object.keys(growth).length !== 3) {
    throw new Error('Swarm RPC captain member growth must be the constant availability enum')
  }
}

/** Row-local composition semantics (captainMembers.composition.v1): `available` must carry
 *  exactly `available` as its reason and may carry the derived capability fields; every
 *  fail-closed state carries a non-available reason and discloses nothing beyond the
 *  recovery fence `runtimeProvider`. The declared tool-denial list stays a restriction
 *  list — bounded, non-empty entries, never an enumeration of permitted tools. */
function assertMemberComposition(member: Record<string, unknown>): void {
  const composition = member.composition as Record<string, unknown> | undefined
  if (composition === undefined) {
    throw new Error('Swarm RPC captain member row must carry a composition projection')
  }
  const state = composition.state
  const reason = composition.reason
  if (state === 'available') {
    if (reason !== 'available') {
      throw new Error('Swarm RPC captain member composition available must carry reason available')
    }
    if (composition.personaConfigured !== true && composition.personaConfigured !== false) {
      throw new Error('Swarm RPC captain member composition available must disclose personaConfigured')
    }
    return
  }
  const allowedReasons: Readonly<Record<string, readonly string[]>> = {
    pending: ['provisioning'],
    unavailable: ['startup_failed', 'removed', 'inspection_failed'],
    invalid: ['inspection_failed', 'active_session_missing', 'binding_invalid', 'descriptor_invalid', 'not_continuable', 'tool_filter_invalid'],
  }
  if (typeof state !== 'string' || typeof reason !== 'string' || !allowedReasons[state]?.includes(reason)) {
    throw new Error(`Swarm RPC captain member composition state ${String(state)} does not permit reason ${String(reason)}`)
  }
  for (const field of ['llmProvider', 'model', 'presetId', 'personaConfigured', 'deniedTools'] as const) {
    if (composition[field] !== undefined) {
      throw new Error(`Swarm RPC captain member composition fail-closed row must not carry ${field}`)
    }
  }
}

function assertResultSemantics(method: string, value: Record<string, unknown>): void {
  if (method === 'capabilities') {
    const expected = [
      'skillCatalog.read',
      'teams.read', 'binding.read', 'status.read', 'snapshot.read', 'page.read',
      'captainMembers.read', 'captainAnnouncements.read', 'captainDiagnostics.read',
      'message.write', 'control.write', 'effect.cancel',
    ]
    const entries = value.capabilities as Array<Record<string, unknown>>
    entries.forEach((entry, index) => {
      const read = index < 9
      if (entry.capability !== expected[index]
        || entry.state !== (read ? 'available' : 'unavailable')
        || (read ? entry.blocker !== undefined : entry.blocker !== 'i1b-effect-correlation')) {
        throw new Error('Swarm RPC capability state contradicts the R2 contract')
      }
    })
    return
  }
  if (method === 'skillCatalog') {
    const skills = value.skills as readonly Record<string, unknown>[]
    const names = skills.map(skill => skill.name as string)
    if (names.some((name, index) => index > 0 && names[index - 1]!.localeCompare(name) >= 0)) {
      throw new Error('Swarm RPC Skill catalog must be sorted with unique names')
    }
    return
  }
  if (method === 'teams') {
    if ((value.complete as boolean) !== true) throw new Error('Swarm RPC Team enumeration is not complete')
    const teams = value.teams as readonly Record<string, unknown>[]
    const binding = value.binding as Record<string, unknown>
    const bindingRootSessionId = binding.rootSessionId as string
    for (const team of teams) {
      const row = team as Record<string, unknown>
      assertAvatarSemantics(row, 'Team')
      assertIdentityCardSemantics(row, 'Team')
      assertGoalSemantics(row)
      assertTeamEndpoints(row, bindingRootSessionId)
    }
    return
  }
  if (method === 'captainAnnouncements') {
    // Real bounded projection: `state` is always 'available'; entries may be
    // non-empty by design. Each entry re-validates its ann-UUID id (unique),
    // canonical trimmed text, and a safe non-negative createdAt (non-decreasing).
    const entries = value.entries as readonly Record<string, unknown>[]
    const seen = new Set<string>()
    let previous = -1
    for (const entry of entries) {
      const id = entry.id as string
      if (typeof id !== 'string' || !CAPTAIN_ANNOUNCEMENT_ID_RE.test(id)) {
        throw new Error('Swarm RPC announcement id must match ann-<uuid>')
      }
      if (seen.has(id)) throw new Error('Swarm RPC announcement ids must be unique')
      seen.add(id)
      const text = entry.text as string
      if (typeof text !== 'string' || text === '' || text !== text.trim()) {
        throw new Error('Swarm RPC announcement text must be canonical (trimmed, non-empty)')
      }
      const createdAt = entry.createdAt as number
      if (!Number.isSafeInteger(createdAt) || createdAt < 0 || Number.isNaN(new Date(createdAt).getTime())) {
        throw new Error('Swarm RPC announcement createdAt must be a safe non-negative, date-valid integer')
      }
      if (createdAt < previous) throw new Error('Swarm RPC announcement createdAt must be non-decreasing')
      previous = createdAt
    }
    return
  }
  if (method === 'captainMembers') {
    // Per-member avatar/identity-card safety semantics: `generated` must carry a
    // strictly allowlisted `svg` (avatar) and its profile fields (identityCard);
    // no other state may carry `svg`.
    const members = value.members as readonly Record<string, unknown>[]
    for (const member of members) {
      const row = member as Record<string, unknown>
      assertAvatarSemantics(row, 'member')
      assertIdentityCardSemantics(row, 'member')
      assertMemberGrowth(row)
      assertMemberComposition(row)
    }
    return
  }
  if (method === 'captainDiagnostics') return
  if (method === 'page') {
    const entries = value.entries as unknown[]
    assertPageEntryKind(value.kind, entries)
    const offset = value.offset as number
    const limit = value.limit as number
    const visible = value.visibleTotal as number
    const authoritative = value.authoritativeTotal as number
    const next = value.nextOffset as number | undefined
    const expectedNext = offset + entries.length
    const hasRemaining = expectedNext < visible
    if (entries.length > limit || offset > visible || visible < expectedNext || authoritative < visible
      || (authoritative > visible && value.projectionTruncated !== true)
      || (hasRemaining ? next !== expectedNext : next !== undefined)) {
      throw new Error('Swarm RPC page totals contradict its entries')
    }
    return
  }
  const selected = value.binding as Record<string, unknown>
  const selectedTeam = value.team as Record<string, unknown>
  if (selected.teamId !== selectedTeam.id) throw new Error('Swarm RPC Team binding contradicts its Team')
  if (method === 'status' || method === 'snapshot') assertProducerCapabilities(value.capabilities)
  if (method !== 'snapshot') return
  const totalsValue = value.totals as Record<string, number>
  const truncatedValue = value.truncated as Record<string, boolean>
  for (const collection of ['roster', 'tasks', 'attempts', 'pendingInteractions'] as const) {
    const visible = (value[collection] as unknown[]).length
    const total = totalsValue[collection]
    if (total === undefined || total < visible || (total > visible && truncatedValue[collection] !== true)) {
      throw new Error(`Swarm RPC ${collection} total contradicts its projection`)
    }
  }
}

function assertPageEntryKind(kind: unknown, entries: readonly unknown[]): void {
  if (kind !== 'tasks' && kind !== 'attempts' && kind !== 'pendingInteractions') {
    throw new Error('Swarm RPC page kind is not recognized')
  }
  entries.forEach((entry, index) => {
    assertSchema(entry, pageRows[kind], `$.entries[${index}]`, { seen: new WeakSet<object>(), nodes: 0 })
  })
}

function assertProducerCapabilities(value: unknown): void {
  const expected = [
    ['snapshot.read', 'available', undefined], ['receipt.read', 'available', undefined],
    ['message.write', 'unavailable', 'i1b-effect-correlation'],
    ['control.write', 'unavailable', 'i1b-effect-correlation'],
    ['effect.cancel', 'unavailable', 'i1b-effect-correlation'],
  ] as const
  const entries = value as Array<Record<string, unknown>>
  if (entries.length !== expected.length) throw new Error('Swarm RPC projection capability set is incomplete')
  entries.forEach((entry, index) => {
    const row = expected[index]!
    if (entry.capability !== row[0] || entry.state !== row[1] || entry.blocker !== row[2]) {
      throw new Error('Swarm RPC projection capability state contradicts the frozen producer contract')
    }
  })
}

interface SchemaState { readonly seen: WeakSet<object>; nodes: number }
type JsonSchema = Record<string, unknown>

function assertSchema(value: unknown, schema: JsonSchema, path: string, state: SchemaState): void {
  state.nodes += 1
  if (state.nodes > 10_000) throw new Error('Swarm RPC result exceeds the structural bound')
  if (Array.isArray(schema.oneOf)) {
    let matches = 0
    for (const candidate of schema.oneOf) {
      if (!isSchema(candidate)) continue
      try { assertSchema(value, candidate, path, { seen: new WeakSet<object>(), nodes: state.nodes }) } catch { continue }
      matches += 1
    }
    if (matches !== 1) throw new Error(`${path} does not match exactly one result shape`)
    return
  }
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) throw new Error(`${path} has the wrong constant`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} is outside the enum`)
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} is not a string`)
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength) throw new Error(`${path} is too short`)
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) throw new Error(`${path} is too long`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${path} has the wrong shape`)
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} is not a safe integer`)
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) throw new Error(`${path} is too small`)
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) throw new Error(`${path} is too large`)
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} is not boolean`)
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} is not an array`)
    remember(value, path, state)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new Error(`${path} is too short`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${path} is too long`)
    if (isSchema(schema.items)) value.forEach((item, index) => assertSchema(item, schema.items as JsonSchema, `${path}[${index}]`, state))
  } else if (schema.type === 'object') {
    const record = strictRecord(value, path, state)
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof required === 'string' && !Object.hasOwn(record, required)) throw new Error(`${path}.${required} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) if (!Object.hasOwn(properties, key)) throw new Error(`${path}.${key} is unknown`)
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key]
      if (isSchema(childSchema)) assertSchema(child, childSchema, `${path}.${key}`, state)
    }
  }
}

function strictRecord(value: unknown, path: string, state: SchemaState): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`)
  remember(value, path, state)
  let prototype: object | null
  let keys: PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    throw new Error(`${path} is proxy-like`)
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not plain data`)
  const result = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error(`${path} has a non-string key`)
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw new Error(`${path}.${key} is proxy-like`) }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}.${key} is not a data field`)
    result[key] = descriptor.value
  }
  return result
}

function remember(value: object, path: string, state: SchemaState): void {
  if (state.seen.has(value)) throw new Error(`${path} is cyclic or aliased`)
  state.seen.add(value)
}

function isSchema(value: unknown): value is JsonSchema { return isRecord(value) }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, sortJson(child)]))
}





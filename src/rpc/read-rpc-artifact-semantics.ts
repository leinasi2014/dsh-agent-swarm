/** Browser-safe strict decoding; no Host error/runtime dependency. */
import { SWARM_READ_RPC_CONTRACT_V1, pageRows } from './read-rpc-artifact-schema.js'

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

/** Stable Unicode code-unit key order; consumers can independently verify the digest. */
export function canonicalSwarmReadRpcJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

/** Strict browser-side result validation against the frozen method schema. */
export function assertSwarmReadRpcValue(method: string, value: unknown): void {
  const key = method === 'capabilities' || method === 'toolCatalog' || method === 'skillCatalog' || method === 'teams' || method === 'captainMembers'
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
  const hasProfile = row.displayName !== undefined || row.profession !== undefined || row.personality !== undefined|| row.biography !== undefined
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
      'toolCatalog.read', 'skillCatalog.read',
      'teams.read', 'binding.read', 'status.read', 'snapshot.read', 'page.read',
      'captainMembers.read', 'captainAnnouncements.read', 'captainDiagnostics.read',
      'message.write', 'control.write', 'effect.cancel',
    ]
    const entries = value.capabilities as Array<Record<string, unknown>>
    entries.forEach((entry, index) => {
      const read = index < 10
      if (entry.capability !== expected[index]
        || entry.state !== (read ? 'available' : 'unavailable')
        || (read ? entry.blocker !== undefined : entry.blocker !== 'i1b-effect-correlation')) {
        throw new Error('Swarm RPC capability state contradicts the R2 contract')
      }
    })
    return
  }
  if (method === 'skillCatalog' || method === 'toolCatalog') {
    const skills = (method === 'toolCatalog' ? value.tools : value.skills) as readonly Record<string, unknown>[]
    const names = skills.map(skill => skill.name as string)
    if (names.some((name, index) => index > 0 && names[index - 1]!.localeCompare(name) >= 0)) {
      throw new Error('Swarm RPC catalog must be sorted with unique names')
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
    const sessionIds = new Set<string>()
    for (const member of members) {
      const row = member as Record<string, unknown>
      assertAvatarSemantics(row, 'member')
      assertIdentityCardSemantics(row, 'member')
      assertMemberGrowth(row)
      assertMemberComposition(row)
      if (row.sessionId !== undefined) {
        if (row.phase !== 'active' || (row.composition as { state?: string }).state !== 'available'
          || sessionIds.has(row.sessionId as string)) throw new Error('Member Session requires unique active membership and an available descriptor')
        sessionIds.add(row.sessionId as string)
      }
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

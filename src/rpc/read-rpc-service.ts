import { HostTargetReadService } from '../host/target-read-service.js'
/** R2/I3-R local-only HTTP RPC over the official WebServer route seam. */
import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isProxy } from 'node:util/types'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { TeamDomainError } from '../domain/error.js'
import { isSafePixelAvatarSvg } from '../domain/identity-profile.js'
import { type TeamMemberIdentityProfile } from '../domain/types.js'
import type { AgentSwarmHostReadService } from '../host/host-read-service.js'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import {
  SWARM_READ_RPC_ENDPOINT,
  SWARM_READ_RPC_NAMESPACE,
  SWARM_READ_RPC_PROTOCOL,
  SWARM_READ_RPC_VERSION,
  type SwarmReadCapabilitiesV1,
  type SwarmReadCapabilityState,
  type SwarmReadPageRequest,
  type SwarmReadPageV1,
  type SwarmReadRpcEnvelope,
  type SwarmReadRpcRequest,
  type SwarmReadRpcValue,
  type SwarmReadTargetHint,
  type SwarmReadTeamV1,
  type SwarmReadCaptainSectionMethod,
  type SwarmReadCaptainSectionRequest,
  type SwarmReadAssetStatusV1,
} from './read-rpc-contract.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** R2 local-only read RPC. No principal or write authority is exposed. */
    agentSwarmReadRpc: AgentSwarmReadRpcService
  }
}

interface SwarmWebRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface SwarmWebServer {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  register(route: SwarmWebRoute): () => void
}

export interface SwarmRequestTrustFacts {
  readonly listenerHost: SwarmWebServer['host']
  readonly listenerPort: number
  readonly remoteAddress?: string
  readonly localAddress?: string
  readonly host?: string
  readonly origin?: string
  readonly secFetchSite?: string
}

export interface SwarmRequestTrustResult {
  readonly ok: boolean
  readonly code?: 'peer-not-loopback' | 'listener-not-loopback' | 'authority-mismatch' | 'cross-site'
}

export interface AgentSwarmReadRpcDeps {
  readonly ctx: Context
  readonly runtime: AgentSwarmRuntime
  readonly hostRead: AgentSwarmHostReadService
  readonly webServer: SwarmWebServer
  readonly disposalTimeoutMs?: number
}

const MAX_BODY_BYTES = 16 * 1024
const MAX_PAGE_LIMIT = 50
const DEFAULT_PAGE_LIMIT = 50
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000
const CURSOR_PATTERN = /^r1:[a-f0-9]{64}$/u

export class AgentSwarmReadRpcService {
  private closing = false
  private readonly inFlight = new Set<Promise<unknown>>()

  private readonly reads: HostTargetReadService

  constructor(private readonly deps: AgentSwarmReadRpcDeps) {
    this.reads = new HostTargetReadService(deps.ctx, deps.runtime, deps.hostRead)
  }

  capabilities(): SwarmReadCapabilitiesV1 {
    const listener = this.deps.webServer.host === '127.0.0.1' ? 'loopback' : 'non-loopback'
    const available = listener === 'loopback'
    const reads: SwarmReadCapabilityState[] = [
      'skillCatalog.read',
      'teams.read', 'binding.read', 'status.read', 'snapshot.read', 'page.read',
      'captainMembers.read', 'captainAnnouncements.read', 'captainDiagnostics.read',
    ].map(capability => ({
      capability: capability as SwarmReadCapabilityState['capability'],
      state: available ? 'available' : 'unavailable',
      ...(available ? {} : { blocker: 'listener-not-loopback' as const }),
    }))
    return {
      protocol: SWARM_READ_RPC_PROTOCOL,
      version: SWARM_READ_RPC_VERSION,
      namespace: SWARM_READ_RPC_NAMESPACE,
      trust: { mode: 'local-single-user-target-bound', principalBound: false, listener },
      capabilities: [
        ...reads,
        { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
        { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
        { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
      ],
    }
  }

  async invoke(input: unknown): Promise<SwarmReadRpcValue> {
    const request = parseRequest(input)
    if (request.method === 'capabilities') return this.capabilities()
    if (this.deps.webServer.host !== '127.0.0.1') {
      throw new TeamDomainError('Swarm read RPC requires a loopback listener', 'SWARM_RPC_UNAVAILABLE')
    }
    if (request.method === 'teams') {
      const projection = await this.reads.teams(request.target.rootSessionId)
      return { ...projection, teams: projection.teams.map(team => teamDescriptorOf(projection.binding.rootSessionId, team, team.captainProfile, team.goal)) }
    }
    if (request.method === 'skillCatalog') {
      return await this.reads.skills(request.target.rootSessionId)
    }
    if (isCaptainSection(request)) {
      return await this.reads.section(request)
    }
    const projection = await this.reads.read(request.target, 'afterCursor' in request ? request.afterCursor : undefined)
    switch (request.method) {
      case 'binding': return bindingOf(projection)
      case 'status': return statusOf(projection)
      case 'snapshot': return projection
      case 'page': return pageOf(projection, request)
    }
  }

  /** Raw official route handler; trust and body bounds run before RPC parsing. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) return writeFailure(res, 503, 'SWARM_RPC_CLOSED', 'Swarm read RPC is closed')
    const trust = evaluateSwarmRequestTrust({
      listenerHost: this.deps.webServer.host,
      listenerPort: this.deps.webServer.port,
      ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
      ...(req.socket.localAddress === undefined ? {} : { localAddress: req.socket.localAddress }),
      ...(req.headers.host === undefined ? {} : { host: req.headers.host }),
      ...(typeof req.headers.origin !== 'string' ? {} : { origin: req.headers.origin }),
      ...(typeof req.headers['sec-fetch-site'] !== 'string' ? {} : { secFetchSite: req.headers['sec-fetch-site'] }),
    })
    if (!trust.ok) return writeFailure(res, 403, 'SWARM_RPC_FORBIDDEN', 'Swarm read RPC request is not local same-origin')
    if (req.method !== 'POST') return writeFailure(res, 405, 'SWARM_RPC_METHOD', 'Swarm read RPC accepts POST only')
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return writeFailure(res, 415, 'SWARM_RPC_CONTENT_TYPE', 'Swarm read RPC requires application/json')
    }
    const declared = req.headers['content-length']
    if (typeof declared === 'string' && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
      return writeFailure(res, 413, 'SWARM_RPC_BODY_LIMIT', 'Swarm read RPC body is too large')
    }
    const operation = this.handleAdmitted(req, res)
    this.inFlight.add(operation)
    try {
      await operation
    } finally {
      this.inFlight.delete(operation)
    }
  }

  async dispose(): Promise<void> {
    this.closing = true
    if (this.inFlight.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(this.inFlight),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TeamDomainError(
            'Swarm RPC reads did not drain before disposal timeout',
            'SWARM_RPC_DISPOSAL_TIMEOUT',
          )), this.deps.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async handleAdmitted(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const input = await readJson(req)
      const value = await this.invoke(input)
      writeEnvelope(res, 200, { schemaVersion: 1, ok: true, value })
    } catch (error) {
      const failure = publicFailure(error)
      writeFailure(res, failure.status, failure.code, failure.message)
    }
  }

}

/** Host mount: optional WebServer composition, one exact route and bounded drain. */
export function mountAgentSwarmReadRpc(ctx: Context, runtime: AgentSwarmRuntime, disposalTimeoutMs: number): void {
  ctx.inject(['webServer', 'agentSwarmHostRead'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as SwarmWebServer | undefined
    const hostRead = webCtx.get('agentSwarmHostRead') as AgentSwarmHostReadService | undefined
    if (webServer === undefined || hostRead === undefined) return
    const service = new AgentSwarmReadRpcService({ ctx: webCtx, runtime, hostRead, webServer, disposalTimeoutMs })
    webCtx.effect(() => {
      const unprovide = webCtx.provide('agentSwarmReadRpc', service)
      const unregister = webServer.register({
        kind: 'exact', path: SWARM_READ_RPC_ENDPOINT,
        handler: (req, res) => service.handle(req, res),
      })
      return async () => {
        const drained = service.dispose()
        unregister()
        await unprovide?.()
        await drained
      }
    }, 'agent-swarm: R2 read RPC')
  })
}

export function evaluateSwarmRequestTrust(facts: SwarmRequestTrustFacts): SwarmRequestTrustResult {
  if (!isLoopbackAddress(facts.remoteAddress) || !isLoopbackAddress(facts.localAddress)) {
    return { ok: false, code: 'peer-not-loopback' }
  }
  if (facts.listenerHost !== '127.0.0.1') return { ok: false, code: 'listener-not-loopback' }
  const authority = parseHttpAuthority(facts.host)
  if (authority === undefined || !isLoopbackHostname(authority.hostname) || effectivePort(authority) !== facts.listenerPort) {
    return { ok: false, code: 'authority-mismatch' }
  }
  if (facts.secFetchSite === 'cross-site') return { ok: false, code: 'cross-site' }
  if (facts.origin !== undefined) {
    try {
      const origin = new URL(facts.origin)
      if (origin.protocol !== 'http:' || origin.host !== authority.host) return { ok: false, code: 'cross-site' }
    } catch {
      return { ok: false, code: 'cross-site' }
    }
  }
  return { ok: true }
}

function parseRequest(input: unknown): SwarmReadRpcRequest {
  const base = strictFields(input, new Set(['schemaVersion', 'method', 'target', 'afterCursor', 'page']))
  if (base.schemaVersion !== 1 || typeof base.method !== 'string') invalidRequest()
  if (base.method === 'capabilities') {
    assertKeys(base, new Set(['schemaVersion', 'method']))
    return { schemaVersion: 1, method: 'capabilities' }
  }
  const target = parseTarget(base.target)
  if (base.method === 'teams') {
    assertKeys(base, new Set(['schemaVersion', 'method', 'target']))
    return { schemaVersion: 1, method: 'teams', target }
  }
  if (base.method === 'skillCatalog') {
    assertKeys(base, new Set(['schemaVersion', 'method', 'target']))
    if (target.teamId !== undefined) invalidRequest()
    return { schemaVersion: 1, method: 'skillCatalog', target }
  }
  if (isCaptainSectionMethod(base.method)) {
    assertKeys(base, new Set(['schemaVersion', 'method', 'target']))
    return { schemaVersion: 1, method: base.method, target }
  }
  if (base.method !== 'binding' && base.method !== 'status' && base.method !== 'snapshot' && base.method !== 'page') invalidRequest()
  const afterCursor = parseCursor(base.afterCursor)
  if (base.method === 'page') {
    assertKeys(base, new Set(['schemaVersion', 'method', 'target', 'afterCursor', 'page']))
    const page = parsePage(base.page)
    return { schemaVersion: 1, method: 'page', target, ...(afterCursor === undefined ? {} : { afterCursor }), page }
  }
  assertKeys(base, new Set(['schemaVersion', 'method', 'target', 'afterCursor']))
  return { schemaVersion: 1, method: base.method, target, ...(afterCursor === undefined ? {} : { afterCursor }) }
}

function parseTarget(input: unknown): SwarmReadTargetHint {
  const target = strictFields(input, new Set(['rootSessionId', 'teamId']))
  if (!boundedString(target.rootSessionId, 256) || (target.teamId !== undefined && !boundedString(target.teamId, 128))) invalidRequest()
  return { rootSessionId: target.rootSessionId, ...(target.teamId === undefined ? {} : { teamId: target.teamId }) }
}

function parsePage(input: unknown): SwarmReadPageRequest['page'] {
  const page = strictFields(input, new Set(['kind', 'offset', 'limit']))
  if (page.kind !== 'tasks' && page.kind !== 'attempts' && page.kind !== 'pendingInteractions') invalidRequest()
  const offset = page.offset ?? 0
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit)
    || (limit as number) < 1 || (limit as number) > MAX_PAGE_LIMIT) invalidRequest()
  return { kind: page.kind, offset: offset as number, limit: limit as number }
}

function parseCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) invalidRequest()
  return value
}

function strictFields(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input)) invalidRequest()
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) invalidRequest()
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) invalidRequest()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalidRequest()
    result[key] = descriptor.value
  }
  return result
}

function assertKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalidRequest()
}

function invalidRequest(): never {
  throw new TeamDomainError('Swarm RPC request failed strict validation', 'SWARM_RPC_INVALID_REQUEST')
}

function boundedString(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && [...value].length <= length
}

function isCaptainSection(request: SwarmReadRpcRequest): request is SwarmReadCaptainSectionRequest {
  return isCaptainSectionMethod(request.method)
}

function isCaptainSectionMethod(method: string): method is SwarmReadCaptainSectionMethod {
  return method === 'captainMembers' || method === 'captainAnnouncements' || method === 'captainDiagnostics'
}

/** Fold one row's MemberProfile into its fail-closed composition projection. A missing
 *  profile (an internal pairing defect that must never happen) degrades this single row
 *  to an explicit `invalid` state — it can never surface as another member's data. */
/** Build one first-level Team descriptor from the authoritative host projection row, enriched with
 *  the Team's real Captain identity profile and public goal when present (avatar/identity card
 *  re-allowlisted at read time, honest `not_generated`/`goal_not_set` otherwise — never fabricated). */
function teamDescriptorOf(rootSessionId: string, team: { teamId: string; name: string; phase: 'staged' | 'active' | 'archived'; captainSessionId: string }, captain?: TeamMemberIdentityProfile, publicGoal?: string) {
  const avatar: SwarmReadAssetStatusV1 = captain?.pixelAvatarSvg !== undefined && isSafePixelAvatarSvg(captain.pixelAvatarSvg)
    ? { state: 'generated', svg: captain.pixelAvatarSvg }
    : { state: 'not_generated', reason: 'avatar_backend_not_implemented' }
  const identityCard: SwarmReadAssetStatusV1 = captain?.displayName !== undefined || captain?.profession !== undefined || captain?.personality !== undefined
    ? { state: 'generated' }
    : { state: 'not_generated', reason: 'identity_backend_not_implemented' }
  const goal: SwarmReadTeamV1['goal'] = publicGoal !== undefined
    ? { state: 'generated', text: publicGoal }
    : { state: 'not_generated', reason: 'goal_not_set' }
  const ref = (method: SwarmReadCaptainSectionMethod) => ({ method, target: { rootSessionId, teamId: team.teamId } })
  return {
    teamId: team.teamId,
    name: team.name,
    phase: team.phase,
    captainSessionId: team.captainSessionId,
    ...(captain?.displayName === undefined ? {} : { displayName: captain.displayName }),
    ...(captain?.profession === undefined ? {} : { profession: captain.profession }),
    ...(captain?.personality === undefined ? {} : { personality: captain.personality }),
    avatar,
    identityCard,
    goal,
    endpoints: {
      members: ref('captainMembers'),
      announcements: ref('captainAnnouncements'),
      diagnostics: ref('captainDiagnostics'),
    },
  }
}

function bindingOf(projection: SwarmHostReadProjectionV1) {
  const { id, name, phase, revision, createdAt, updatedAt } = projection.team
  return {
    binding: projection.binding, team: { id, name, phase, revision, createdAt, updatedAt },
    cursor: projection.cursor, changed: projection.changed, resyncRequired: projection.resyncRequired,
  }
}

function statusOf(projection: SwarmHostReadProjectionV1) {
  return {
    ...bindingOf(projection), budget: projection.budget, totals: projection.totals,
    truncated: projection.truncated, capabilities: projection.capabilities, observedAt: projection.observedAt,
  }
}

function pageOf(projection: SwarmHostReadProjectionV1, request: SwarmReadPageRequest): SwarmReadPageV1 {
  const { kind } = request.page
  const offset = request.page.offset ?? 0
  const limit = request.page.limit ?? DEFAULT_PAGE_LIMIT
  const source = projection[kind]
  if (offset > source.length) invalidRequest()
  const entries = source.slice(offset, offset + limit)
  const next = offset + entries.length
  return {
    kind, entries, offset, limit, visibleTotal: source.length,
    authoritativeTotal: projection.totals[kind],
    ...(next < source.length ? { nextOffset: next } : {}),
    projectionTruncated: projection.truncated[kind],
    cursor: projection.cursor, changed: projection.changed,
    resyncRequired: projection.resyncRequired, observedAt: projection.observedAt,
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new TeamDomainError('Swarm RPC body is too large', 'SWARM_RPC_BODY_LIMIT')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new TeamDomainError('Swarm RPC body is not JSON', 'SWARM_RPC_INVALID_REQUEST')
  }
}

function publicFailure(error: unknown): { readonly status: number; readonly code: string; readonly message: string } {
  const code = error instanceof TeamDomainError ? error.code : 'SWARM_RPC_INTERNAL'
  const known: Record<string, readonly [number, string]> = {
    SWARM_RPC_INVALID_REQUEST: [400, 'Swarm RPC request is invalid'],
    SWARM_RPC_BODY_LIMIT: [413, 'Swarm RPC body is too large'],
    SWARM_RPC_UNAVAILABLE: [503, 'Swarm read RPC is unavailable'],
    SWARM_RPC_TARGET_NOT_LIVE: [404, 'Target root Session is not live'],
    SWARM_HOST_WORKSPACE_REQUIRED: [409, 'Target root has no workspace'],
    SWARM_HOST_BINDING_NOT_FOUND: [404, 'Target root has no Team binding'],
    SWARM_HOST_BINDING_AMBIGUOUS: [409, 'Target root has multiple Team bindings'],
    SWARM_HOST_BINDING_MISMATCH: [403, 'Target Team does not match the root captain'],
    TEAM_NOT_FOUND: [404, 'Target Team was not found'],
    TEAM_UNAUTHORIZED: [403, 'Target Team is not readable by the root captain'],
  }
  const selected = known[code]
  return selected === undefined
    ? { status: 500, code: 'SWARM_RPC_INTERNAL', message: 'Swarm read RPC failed' }
    : { status: selected[0], code, message: selected[1] }
}

function writeFailure(res: ServerResponse, status: number, code: string, message: string): void {
  writeEnvelope(res, status, { schemaVersion: 1, ok: false, error: { code, message } })
}

function writeEnvelope(res: ServerResponse, status: number, envelope: SwarmReadRpcEnvelope): void {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(envelope)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function parseHttpAuthority(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(`http://${value}`)
    return url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' ? url : undefined
  } catch {
    return undefined
  }
}

function effectivePort(url: URL): number {
  return url.port === '' ? 80 : Number(url.port)
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || isIpv4Loopback(hostname)
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0]!
  if (normalized === '::1') return true
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  return isIpv4Loopback(ipv4)
}

function isIpv4Loopback(value: string): boolean {
  const octets = value.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
}


import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { vi } from 'vitest'
import type { TeamState } from '../../src/domain/types.js'
import type { AgentSwarmHostReadService } from '../../src/host/host-read-service.js'
import type { SwarmHostReadProjectionV1 } from '../../src/host/host-read-types.js'
import type { AgentSwarmRuntime } from '../../src/runtime/orchestrator-runtime.js'
import { AgentSwarmReadRpcService, type SwarmWebServer } from '../../src/rpc/read-rpc-service.js'
export const CURSOR = `r1:${'a'.repeat(64)}`
export const ROOT = { id: 'root-session', session: { header: { cwd: 'D:\\workspace' } } } as unknown as Agent
export const OTHER = { id: 'other-session', session: { header: { cwd: 'D:\\other' } } } as unknown as Agent
export const projection: SwarmHostReadProjectionV1 = {
  schemaVersion: 1,
  binding: { rootSessionId: ROOT.id, teamId: 'team-r2' },
  team: { id: 'team-r2', name: 'R2 Team', phase: 'active', revision: 2, createdAt: 1, updatedAt: 2 },
  roster: [],
  tasks: [{
    id: 'task-1', revision: 1, subject: 'Visible', status: 'in_progress', blockedBy: [], priority: 1,
    targetMemberName: 'worker',
    createdAt: 1, updatedAt: 2,
  }],
  attempts: [],
  budget: { usedTokens: 10, usedRequests: 1, usedRetries: 0 },
  pendingInteractions: [],
  totals: { roster: 0, tasks: 4, attempts: 0, pendingInteractions: 0 },
  truncated: { roster: false, tasks: true, attempts: false, pendingInteractions: false },
  capabilities: [], cursor: CURSOR, changed: true, resyncRequired: false, observedAt: 3,
}

export function rpcHarness(options: {
  host?: SwarmWebServer['host']; root?: Agent; captain?: string; projection?: SwarmHostReadProjectionV1;
  coldCaptainSessions?: Record<string, { header: { parentSession?: string } }>;
  managedCaptains?: string[];
  coldRoot?: boolean;
  /** Fully cold: the live Agent registry has no root entry, but an official persisted Session exists. */
  fullyColdRoot?: boolean;
  persistedRootHeader?: { cwd?: string; parentSession?: string } | undefined;
  teams?: { id: string; captainSessionId: string; phase?: 'active' | 'archived' }[];
  /** Full TeamState returned by the domain snapshot for the section reads. */
  teamState?: TeamState;
  bindHostReadToCaptain?: boolean;
} = {}) {
  const root = options.root ?? ROOT
  let liveRoots: readonly Agent[] = [root]
  let session = root.session
  const team = {
    id: 'team-r2', captainSessionId: options.captain ?? root.id, phase: 'active',
    ...options.teamState,
  } as TeamState
  const teams: TeamState[] = (options.teams ?? [team]).map(entry => ({ ...team, ...entry })) as TeamState[]
  const coldSessions = options.coldCaptainSessions ?? {}
  const hostRead = {
    withTargetRead: async <T>(operation: () => Promise<T>) => await operation(),
    projectAuthorizedTeam: vi.fn((selected: TeamState, _scope: string, afterCursor?: string) => {
      lastReadInput = { teamId: selected.id,
        ...(selected.captainSessionId === root.id ? {} : { captainSessionId: selected.captainSessionId }),
        ...(afterCursor === undefined ? {} : { afterCursor }) }
      return { ...(options.projection ?? projection), binding: {
        rootSessionId: options.bindHostReadToCaptain ? selected.captainSessionId : root.id, teamId: selected.id,
      }, changed: afterCursor !== CURSOR, resyncRequired: afterCursor !== undefined && afterCursor !== CURSOR }
    }),
    listTeams: vi.fn(async (_scope: string) => {
      // Real authorities only: project the visible teams of this scope (main-brain root owns its
      // managed captains; a captain owns its own team).
      const visible = teams.map(t => ({
        teamId: t.id, name: t.id, phase: t.phase ?? 'active', captainSessionId: t.captainSessionId,
      }))
      return {
        schemaVersion: 1 as const,
        binding: { rootSessionId: root.id, rootKind: 'main-brain' as const },
        teams: Object.freeze(visible),
        observedAt: Date.now(),
        complete: true,
      }
    }),
  } as unknown as AgentSwarmHostReadService & { listTeams: ReturnType<typeof vi.fn>; projectAuthorizedTeam: ReturnType<typeof vi.fn> }
  let lastReadInput: { afterCursor?: string; teamId?: string; captainSessionId?: string } | undefined
  const ctx = {
    agents: {
      get: (id: string) => id === root.id ? (options.fullyColdRoot ? undefined : root) : undefined,
      roots: () => options.fullyColdRoot ? [] : liveRoots,
    },
    sessions: { get: (id: string) => (id === root.id ? (options.coldRoot || options.fullyColdRoot ? undefined : session) : coldSessions[id]) ?? undefined },
    sessionPersistence: {
      inspect: async (_sessionId: string) => {
        if (options.persistedRootHeader === undefined) throw new Error('no persisted root')
        return { meta: { cwd: options.persistedRootHeader.cwd, parentSession: options.persistedRootHeader.parentSession }, events: [] }
      },
    },
  } as unknown as Context
  const snapshot = vi.fn(async () => ({ team }))
  const runtime = {
    scopeOf: (agent: Agent) => agent.session.header.cwd!,
    listTeamAggregates: vi.fn(async () => teams),
    domain: { snapshot },
    managedCaptainSessionsOf: vi.fn(() => options.managedCaptains ?? []),
  } as unknown as AgentSwarmRuntime
  const webServer = { host: options.host ?? '127.0.0.1', port: 8279, register: vi.fn() } satisfies SwarmWebServer
  const service = new AgentSwarmReadRpcService({ ctx, runtime, hostRead, webServer })
  return {
    service, hostRead, snapshot, webServer,
    lastReadInput: () => lastReadInput,
    switchSession: (next: Agent['session']) => { session = next },
    setRoots: (roots: readonly Agent[]) => { liveRoots = roots },
  }
}


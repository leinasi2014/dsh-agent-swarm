import { describe, expect, it } from 'vitest'
import { CAPTAIN_ONLY_TOOLS, MEMBER_HIDDEN_TOOLS, memberJoinNotice, memberPersona } from '../src/runtime/prompts.js'
import { memberToolDeny } from '../src/runtime/tool-policy.js'
import { decideToolPermission, type ToolPermissionContext } from '../src/runtime/permission-policy.js'
import { WaitSpinFuse, type WaitSpinObservation } from '../src/runtime/wait-surface.js'
import type { ToolExecutionAuthority } from '../src/runtime/authority.js'

function observation(revision: number, outcome: WaitSpinObservation['outcome']): WaitSpinObservation {
  return {
    outcome,
    changed: outcome === 'changed',
    snapshot: { team: { revision } } as never,
  } as WaitSpinObservation
}

function turn(signal = new AbortController().signal): ToolExecutionAuthority {
  return { signal, agent: {} } as ToolExecutionAuthority
}

const member: ToolPermissionContext = {
  callerRole: 'delegated-member', sameTurnConcreteToolCall: true, openTurn: true, approvalSeamAvailable: true,
}

describe('WAIT-SPIN member admission and model surface', () => {
  it('hides wait in the member descriptor baseline and denies it before a policy allow can apply', () => {
    expect(MEMBER_HIDDEN_TOOLS).toEqual([...CAPTAIN_ONLY_TOOLS, 'agent_swarm_wait'])
    expect(memberToolDeny()).toEqual([...MEMBER_HIDDEN_TOOLS])
    expect(memberToolDeny(['agent_swarm_wait'])).toEqual([...MEMBER_HIDDEN_TOOLS])
    expect(decideToolPermission({ allow: ['agent_swarm_wait'] }, 'agent_swarm_wait', member)).toBe('deny')
  })

  it('tells a member to end its turn after no-task/submit/blocker instead of waiting', () => {
    const team = { id: 'team-wait-spin-fixture', name: 'fixture' } as never
    expect(memberPersona(team, 'worker', 'fixture role')).toContain('END YOUR TURN')
    expect(memberJoinNotice(team)).toContain('End this turn now')
  })
})

describe('WAIT-SPIN Runtime-private signal fuse', () => {
  it('reports the second same-signal same-revision no-progress', () => {
    const fuse = new WaitSpinFuse()
    const exec = turn()
    expect(fuse.note(exec, observation(8, 'no-progress'), 30_000)).toBe('ok')
    expect(fuse.note(exec, observation(8, 'no-progress'), 30_000)).toBe('no-progress-repeat')
  })

  it('resets for a new signal in one Runtime owner and a fresh Runtime owner', () => {
    const oldRuntime = new WaitSpinFuse()
    const oldTurn = turn()
    oldRuntime.note(oldTurn, observation(8, 'no-progress'), 30_000)
    expect(oldRuntime.note(turn(), observation(8, 'no-progress'), 30_000)).toBe('ok')
    const newRuntime = new WaitSpinFuse()
    expect(newRuntime.note(oldTurn, observation(8, 'no-progress'), 30_000)).toBe('ok')
  })

  it('resets on changed=true and any revision inequality, including a decrease', () => {
    const fuse = new WaitSpinFuse()
    const exec = turn()
    fuse.note(exec, observation(8, 'no-progress'), 30_000)
    expect(fuse.note(exec, observation(9, 'changed'), 30_000)).toBe('ok')
    expect(fuse.note(exec, observation(9, 'no-progress'), 30_000)).toBe('ok')
    expect(fuse.note(exec, observation(7, 'no-progress'), 30_000)).toBe('ok')
    expect(fuse.note(exec, observation(7, 'no-progress'), 30_000)).toBe('no-progress-repeat')
  })

  it('stalls only on exact consecutive 30/60/120 timeouts', () => {
    const fuse = new WaitSpinFuse()
    const exec = turn()
    expect(fuse.note(exec, observation(8, 'timed-out'), 30_000)).toBe('ok')
    expect(fuse.note(exec, observation(8, 'timed-out'), 60_000)).toBe('ok')
    expect(fuse.note(exec, observation(8, 'timed-out'), 120_000)).toBe('stalled')
  })

  it('resets the timeout sequence on a wrong step', () => {
    const fuse = new WaitSpinFuse()
    const exec = turn()
    for (const timeout of [30_000, 45_000, 60_000, 30_000, 120_000]) {
      expect(fuse.note(exec, observation(8, 'timed-out'), timeout)).toBe('ok')
    }
  })

  it('does not classify a non-timeout unchanged terminal result as a spin', () => {
    const fuse = new WaitSpinFuse()
    const exec = turn()
    fuse.note(exec, observation(8, 'no-progress'), 30_000)
    expect(fuse.note(exec, observation(8, 'unchanged-terminal'), 30_000)).toBe('ok')
    expect(fuse.note(exec, observation(8, 'no-progress'), 30_000)).toBe('ok')
  })
})

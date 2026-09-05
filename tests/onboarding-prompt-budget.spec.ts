import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { AGENT_SWARM_USAGE_PROMPT } from '../src/runtime/usage-prompt.js'
import { mountNodeComposition, SIGNAL } from './helpers/node-composition.js'

// Measure rendered strings and the registered, compiled schema, not source
// descriptions. ceil(UTF-8 bytes / 4) is a stable estimate, not a tokenizer or
// latency claim. Fixed ASCII input and fixed-length runtime ids bound the fixture.
const measure = (text: string): { bytes: number; estimatedTokens: number } => {
  const bytes = Buffer.byteLength(text, 'utf8')
  return { bytes, estimatedTokens: Math.ceil(bytes / 4) }
}

it('bounds the actual managed Captain/member onboarding and compiled tool surfaces (#185)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-onboarding-budget-'))
  const mounted = await mountNodeComposition(sandbox, { captainLlmProvider: 'mock', captainModel: 'mock' })
  const start = vi.spyOn(mounted.ctx.subagents, 'startContinuable')
  try {
    const result = await mounted.ctx.tools.execute({
      signal: SIGNAL, callId: CallId('budget-create'), name: 'agent_swarm_create_managed',
      arguments: { name: 'Budget Team', description: 'Deliver a verified repair. Preserve user identity preferences.' },
      agent: mounted.lead,
    })
    expect(result.isError).toBe(false)
    const captain = mounted.ctx.agents.get(SessionId((result.value as { captain_session_id: string }).captain_session_id))!
    const added = await mounted.ctx.tools.execute({
      signal: SIGNAL, callId: CallId('budget-member'), name: 'agent_swarm_add_member',
      arguments: { name: 'worker', role: 'Implement the repair.' }, agent: captain,
    })
    expect(added.isError).toBe(false)
    const [captainRequest, memberRequest] = start.mock.calls.map(call => call[0].request)
    expect(captainRequest).toBeDefined()
    expect(memberRequest).toBeDefined()
    const captainPersona = captainRequest!.persona ?? ''
    const captainNotice = captainRequest!.prompt.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    const memberPersona = memberRequest!.persona ?? ''
    const memberNotice = memberRequest!.prompt.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    const schemaTexts = ['agent_swarm_create_managed', 'agent_swarm_add_member', 'agent_swarm_set_captain_profile'].map(name => {
      const tool = mounted.ctx.tools.get(name)!
      expect(tool).toBeDefined()
      expect(tool.parameters).toBeDefined()
      expect(tool.output?.schema).toBeDefined()
      return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output?.schema })
    })
    const captainText = `${AGENT_SWARM_USAGE_PROMPT}\n${captainPersona}\n${captainNotice}`
    const memberText = `${AGENT_SWARM_USAGE_PROMPT}\n${memberPersona}\n${memberNotice}`
    const report = {
      global: measure(AGENT_SWARM_USAGE_PROMPT), captainPersona: measure(captainPersona), captainNotice: measure(captainNotice),
      memberPersona: measure(memberPersona), memberNotice: measure(memberNotice),
      captainTotal: measure(captainText), memberTotal: measure(memberText),
      schemas: schemaTexts.map(measure), schemasTotal: measure(schemaTexts.join('\n')),
    }
    console.info('ONBOARDING_MODEL_SURFACE', JSON.stringify(report))
    expect.soft(report.global.bytes).toBeLessThanOrEqual(1000)
    expect.soft(report.captainTotal.bytes).toBeLessThanOrEqual(4000)
    expect.soft(report.memberTotal.bytes).toBeLessThanOrEqual(3000)
    // Retain the compiled parameter/output contracts, including Skill
    // admission, provider distinction and deny-only permissions (#184).
    expect.soft(report.schemasTotal.bytes).toBeLessThanOrEqual(4800)
    expect.soft(captainText).not.toMatch(/Chinese display|until the profile succeeds|After (?:your Captain |the )profile succeeds|stop dependent recruitment/)
    expect.soft(captainPersona).toContain('optional')
    expect.soft(captainPersona).toContain("user's language")
    expect.soft(captainPersona).toContain('continue')
    expect.soft(memberText).not.toContain('agent_swarm_add_member')
    expect.soft(memberText).not.toContain('agent_swarm_review_task')
    expect.soft(memberText).not.toContain('agent_swarm_interrupt_member')
    expect.soft(schemaTexts.join('\n')).not.toMatch(/pixel grid 8\.\.32|viewBox|#RRGGBB|Must be authored/)
    expect(captainNotice).toContain('Deliver a verified repair. Preserve user identity preferences.')
    expect(captainNotice).toContain('target_member')
  } finally {
    start.mockRestore()
    mounted.adapter.open()
    for (const fiber of mounted.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true })
  }
})

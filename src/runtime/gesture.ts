/**
 * Deterministic `/swarm` gesture activation (host-plane).
 *
 * The rc.2 host has no published `dsh-commands` package, so there is no
 * official slash-command registry seam. The closed-namespace gesture boundary
 * below uses the official `agent/pre-step` waterfall instead: a genuine user
 * message starting with `/swarm` (followed by whitespace or end of text) gets
 * one deterministic activation directive appended to the frozen step batch.
 * Mid-sentence mentions stay ordinary prose, matching the reference
 * headless-CLI behaviour without inventing a second command surface.
 *
 * The boundary is stateless: it never touches the Team aggregate, never
 * starts or stops an Agent, and never broadens model authority. It only makes
 * the existing Main Brain protocol deterministic for the user's entry text.
 * @module dsh-agent-swarm/runtime/gesture
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'swarm-gesture': { readonly kind: 'swarm-gesture'; readonly goal?: string }
  }
}

/** Closed-namespace gesture: `/swarm` (with optional trailing goal). */
export const SWARM_GESTURE = '/swarm'
/** Match only a genuine leading gesture; `/swarmfoo` or a mid-sentence mention is prose. */
const GESTURE = /^\/swarm(?=$|[\t\n\r ])/u

export interface SwarmInvocation {
  readonly goal: string
}

/** Parse one text block into a `/swarm` invocation, or undefined for prose. */
export function parseSwarmInvocation(text: string): SwarmInvocation | undefined {
  const trimmed = text.trimStart()
  if (!GESTURE.test(trimmed)) return undefined
  return { goal: trimmed.slice(SWARM_GESTURE.length).trim() }
}

/** Scan the newest user message first; only genuine user text may activate. */
export function invokedSwarmInvocation(messages: readonly UserMessage[]): SwarmInvocation | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const invocation = parseSwarmInvocation(block.text)
      if (invocation !== undefined) return invocation
    }
  }
  return undefined
}

/** Deterministic activation directive consumed by the Main Brain protocol. */
export function buildSwarmActivationDirective(invocation: SwarmInvocation): string {
  const lines = [
    'The user invoked the /swarm gesture. Activate the Agent Swarm protocol now: you are the Main Brain orchestrator, not a Team member.',
    'Call agent_swarm_create_managed with name and description. The description must carry the user\'s complete requested outcome, constraints, and acceptance criteria verbatim.',
    'After creation, call agent_swarm_list_managed_teams at most once, then end this turn. Do not call agent_swarm_wait, agent_swarm_status, or agent_swarm_send_message, and do not poll.',
  ]
  if (invocation.goal === '') {
    lines.push('The goal was not given — ask the user what the team should accomplish.')
  } else {
    lines.push(`Goal: ${invocation.goal}`)
  }
  return lines.join('\n')
}

/** Install the gesture boundary for the current plugin lifetime. */
export function installSwarmGestureBoundary(ctx: Context, enabled = true): () => void {
  if (!enabled) return () => undefined
  return ctx.on('agent/pre-step', async ({ messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const invocation = invokedSwarmInvocation(messages)
    if (invocation === undefined) return decision
    signal.throwIfAborted()
    const directive = buildSwarmActivationDirective(invocation)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: directive }],
          source: { kind: 'swarm-gesture', ...(invocation.goal === '' ? {} : { goal: invocation.goal }) },
        }),
      ],
    }
  })
}

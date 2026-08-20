/**
 * Cross-group support for the model-facing tools (issue #74 split): the
 * lifecycle-owned registration wrapper and the official jsonOutput compact
 * renderer shared by every tool that declares a canonical JSON output.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

export function register(ctx: Context, tool: Parameters<typeof ctx.tools.register>[0], label: string): void {
  ctx.effect(() => ctx.tools.register(tool), `agent-swarm: ${label}`)
}

/**
 * Declare one canonical output schema with compact model-facing JSON — the
 * official `tool-agent-team` `jsonOutput` pattern (issue #15, docs/02 §7.1):
 * `defineTool` compiles the schema, the compiler checks `execute` against the
 * value the model is promised, and the pure single-block render never falls
 * back to a generic projection. Stays unfenced by the accepted issue #62
 * trade-off (quantified in docs/04 §8d): JSON.stringify output is one line
 * that can forge no fence or message boundary, and the single-block JSON is
 * the official output contract locked by the model-experience tests.
 */
export function compactJsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

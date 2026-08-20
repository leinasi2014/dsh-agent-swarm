import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable domain error that DSH tools preserve as model-visible structured metadata. */
export class TeamDomainError extends HarnessError {
  constructor(
    message: string,
    code: string,
    options?: ErrorOptions,
  ) {
    super(message, code, options)
    this.name = 'TeamDomainError'
  }
}

export function expectDomain(condition: unknown, message: string, code: string): asserts condition {
  if (!condition) throw new TeamDomainError(message, code)
}

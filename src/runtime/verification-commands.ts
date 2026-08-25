/**
 * Verification command template registry contracts and the pre-commit
 * compiler for M4B (issue #128). Template invocations never cross the Team
 * authority boundary: they become the existing concrete
 * `ReviewVerificationCommand` records before `TeamDomainPort.createTask`.
 */
import { TeamDomainError } from '../domain/error.js'
import type { ReviewVerificationCommand } from '../domain/types.js'
import type { CreateTaskInput } from '../domain/team-domain-port.js'

const IDENTIFIER = /^[a-z][a-z0-9.-]{0,63}$/
const ROUTED_COMMAND = /^dsh-verification-root:([a-z][a-z0-9.-]{0,63})\/([a-z][a-z0-9.-]{0,63}) -- ([\s\S]+)$/
const MAX_PARAMETER_CHARS = 1_024

/** One name/value parameter at a JSON/tool boundary. */
export interface VerificationTemplateParameterValue {
  readonly name: string
  readonly value: string
}

/** Captain-authored use of one registered verification command template. */
export interface VerificationTemplateInvocation {
  readonly template: string
  readonly parameters?: Readonly<Record<string, string>> | readonly VerificationTemplateParameterValue[]
  readonly timeoutMs?: number
}

/** Raw #101 command or one M4B template invocation. */
export type VerificationDeclaration = ReviewVerificationCommand | VerificationTemplateInvocation

/** Task input accepted by the runtime before template compilation. */
export type RuntimeCreateTaskInput = Omit<CreateTaskInput, 'verification' | 'targetMemberSessionId'> & {
  readonly verification?: readonly VerificationDeclaration[]
  readonly targetMemberName?: string
}

/** Stateless command template registered on the runtime. */
export interface VerificationCommandTemplate {
  /** Root-family registration that must execute expanded commands. */
  readonly rootFamily: string
  /** Capability the selected root family must explicitly provide. */
  readonly capability: string
  /** Accepted parameter names; omitted means no parameters. */
  readonly parameters?: readonly string[]
  /** Expand validated parameters into one or more concrete shell commands. */
  expand(parameters: Readonly<Record<string, string>>): string | readonly string[]
}

/** Resolved route encoded into one stored concrete command string. */
export interface VerificationCommandRoute {
  readonly family: string
  readonly capability: string
  readonly command: string
}

/** One builtin template registration. */
export interface BuiltinVerificationTemplate {
  readonly name: string
  readonly template: VerificationCommandTemplate
}

function inputError(message: string): never {
  throw new TeamDomainError(message, 'TEAM_INPUT_INVALID')
}

/** Validate one bounded lowercase registry/capability identifier. */
export function expectVerificationIdentifier(value: string, label: string, code = 'TEAM_INVALID_CONFIG'): string {
  if (!IDENTIFIER.test(value)) {
    throw new TeamDomainError(`${label} must match ${IDENTIFIER.source}`, code)
  }
  return value
}

/** Encode an internal root route without changing the persisted command record type. */
export function encodeVerificationCommand(route: VerificationCommandRoute): string {
  const family = expectVerificationIdentifier(route.family, 'verification root family')
  const capability = expectVerificationIdentifier(route.capability, 'verification root capability')
  if (route.command.trim() === '') inputError('expanded verification command must not be empty')
  return `dsh-verification-root:${family}/${capability} -- ${route.command}`
}

/** Parse compiler-produced root routing; raw #101 commands return undefined. */
export function parseVerificationCommand(command: string): VerificationCommandRoute | undefined {
  const match = ROUTED_COMMAND.exec(command)
  if (match === null) return undefined
  return { family: match[1]!, capability: match[2]!, command: match[3]! }
}

function parameterRecord(
  source: VerificationTemplateInvocation['parameters'],
): Readonly<Record<string, string>> {
  if (source === undefined) return Object.freeze({})
  const pairs = Array.isArray(source) ? source.map(entry => [entry.name, entry.value] as const) : Object.entries(source)
  const result: Record<string, string> = {}
  for (const [name, value] of pairs) {
    expectVerificationIdentifier(name, 'verification template parameter', 'TEAM_INPUT_INVALID')
    if (Object.hasOwn(result, name)) inputError(`duplicate verification template parameter "${name}"`)
    if (typeof value !== 'string' || value.length > MAX_PARAMETER_CHARS || /[\0\r\n]/.test(value)) {
      inputError(`verification template parameter "${name}" must be a single-line string of at most ${MAX_PARAMETER_CHARS} characters`)
    }
    result[name] = value
  }
  return Object.freeze(result)
}

/** Validate a template at registration and return an owned shallow copy. */
export function normalizeVerificationTemplate(
  name: string,
  template: VerificationCommandTemplate,
): VerificationCommandTemplate {
  expectVerificationIdentifier(name, 'verification template name')
  const rootFamily = expectVerificationIdentifier(template.rootFamily, 'verification template root family')
  const capability = expectVerificationIdentifier(template.capability, 'verification template capability')
  const parameters = [...(template.parameters ?? [])]
  for (const parameter of parameters) expectVerificationIdentifier(parameter, 'verification template parameter')
  if (new Set(parameters).size !== parameters.length) {
    throw new TeamDomainError(`verification template "${name}" declares duplicate parameters`, 'TEAM_INVALID_CONFIG')
  }
  return Object.freeze({ rootFamily, capability, parameters: Object.freeze(parameters), expand: template.expand })
}

function compileTemplateInvocation(
  invocation: VerificationTemplateInvocation,
  resolveTemplate: (name: string) => VerificationCommandTemplate | undefined,
): ReviewVerificationCommand[] {
  const name = expectVerificationIdentifier(invocation.template, 'verification template name', 'TEAM_INPUT_INVALID')
  const template = resolveTemplate(name)
  if (template === undefined) throw new TeamDomainError(`verification template "${name}" is unavailable`, 'TEAM_VERIFICATION_TEMPLATE_MISSING')
  const parameters = parameterRecord(invocation.parameters)
  const accepted = new Set(template.parameters ?? [])
  for (const parameter of Object.keys(parameters)) {
    if (!accepted.has(parameter)) inputError(`verification template "${name}" does not accept parameter "${parameter}"`)
  }
  let expanded: string | readonly string[]
  try {
    expanded = template.expand(parameters)
  } catch (error) {
    if (error instanceof TeamDomainError) throw error
    throw new TeamDomainError(
      `verification template "${name}" expansion failed: ${error instanceof Error ? error.message : String(error)}`,
      'TEAM_VERIFICATION_TEMPLATE_INVALID',
      { cause: error },
    )
  }
  const commands = typeof expanded === 'string' ? [expanded] : [...expanded]
  if (commands.length === 0) inputError(`verification template "${name}" expanded to no commands`)
  return commands.map(command => ({
    command: encodeVerificationCommand({ family: template.rootFamily, capability: template.capability, command }),
    ...(invocation.timeoutMs === undefined ? {} : { timeoutMs: invocation.timeoutMs }),
  }))
}

/** Expand task-level declarations into the existing stored concrete command list. */
export function compileVerificationDeclarations(
  declarations: readonly VerificationDeclaration[],
  options: {
    readonly resolveTemplate: (name: string) => VerificationCommandTemplate | undefined
    readonly maxCommands: number
  },
): ReviewVerificationCommand[] {
  const compiled: ReviewVerificationCommand[] = []
  for (const declaration of declarations) {
    const hasCommand = 'command' in declaration && declaration.command !== undefined
    const hasTemplate = 'template' in declaration && declaration.template !== undefined
    if (hasCommand === hasTemplate) inputError('one verification declaration must provide exactly one of command or template')
    if (hasCommand) {
      compiled.push({
        command: declaration.command,
        ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
      })
    } else {
      compiled.push(...compileTemplateInvocation(declaration as VerificationTemplateInvocation, options.resolveTemplate))
    }
    if (compiled.length > options.maxCommands) {
      throw new TeamDomainError('task verification command limit reached after template expansion', 'TEAM_TASK_VERIFICATION_LIMIT')
    }
  }
  return compiled
}

function argumentsSuffix(parameters: Readonly<Record<string, string>>, defaultArguments = ''): string {
  const value = parameters.args?.trim()
  const selected = value === undefined || value === '' ? defaultArguments : value
  return selected === '' ? '' : ` ${selected}`
}

function commandTemplate(rootFamily: string, command: string, defaultArguments = ''): VerificationCommandTemplate {
  return {
    rootFamily,
    capability: rootFamily,
    parameters: ['args'],
    expand: parameters => `${command}${argumentsSuffix(parameters, defaultArguments)}`,
  }
}

/** Builtin Node/Python typecheck, test, build, and lint templates. */
export function builtinVerificationTemplates(): readonly BuiltinVerificationTemplate[] {
  return [
    { name: 'node.typecheck', template: commandTemplate('node', 'pnpm typecheck') },
    { name: 'node.test', template: commandTemplate('node', 'pnpm test') },
    { name: 'node.build', template: commandTemplate('node', 'pnpm build') },
    { name: 'node.lint', template: commandTemplate('node', 'pnpm lint') },
    { name: 'python.typecheck', template: commandTemplate('python', 'python -m mypy', '.') },
    { name: 'python.test', template: commandTemplate('python', 'python -m pytest') },
    { name: 'python.build', template: commandTemplate('python', 'python -m build') },
    { name: 'python.lint', template: commandTemplate('python', 'python -m ruff check', '.') },
  ]
}

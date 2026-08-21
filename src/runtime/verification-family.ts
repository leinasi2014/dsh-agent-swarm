/** Lifecycle-owned root/template registries and pre-commit verification compiler. */
import { TeamDomainError } from '../domain/error.js'
import type { ReviewVerificationCommand } from '../domain/types.js'
import {
  assertReviewRootCapabilityAvailable,
  executableReviewRootCapabilities,
  tempReviewRootProvider,
  type ReviewRootCapabilities,
  type ReviewRootProvider,
} from './review-root.js'
import {
  builtinVerificationTemplates,
  compileVerificationDeclarations,
  expectVerificationIdentifier,
  normalizeVerificationTemplate,
  parseVerificationCommand,
  type VerificationCommandTemplate,
  type VerificationDeclaration,
} from './verification-commands.js'

interface RegisteredReviewRoot {
  readonly provider: ReviewRootProvider
  readonly capabilities?: ReviewRootCapabilities
}

/** Project-owned M4B registry family consumed by the executable Review Provider. */
export class VerificationFamily {
  private readonly roots = new Map<string, RegisteredReviewRoot>()
  private readonly templates = new Map<string, VerificationCommandTemplate>()

  constructor() {
    this.roots.set('temp', { provider: tempReviewRootProvider() })
    this.roots.set('node', {
      provider: tempReviewRootProvider(),
      capabilities: executableReviewRootCapabilities({ provides: ['node'], executable: process.execPath }),
    })
    this.roots.set('python', {
      provider: tempReviewRootProvider(),
      capabilities: executableReviewRootCapabilities({ provides: ['python'], executable: 'python' }),
    })
    for (const builtin of builtinVerificationTemplates()) {
      this.templates.set(builtin.name, normalizeVerificationTemplate(builtin.name, builtin.template))
    }
  }

  /** Resolve one root Provider without exposing registry mutation. */
  resolveRoot(name: string): ReviewRootProvider | undefined {
    return this.roots.get(name)?.provider
  }

  /** Resolve one root family's declared capabilities. */
  resolveCapabilities(name: string): ReviewRootCapabilities | undefined {
    return this.roots.get(name)?.capabilities
  }

  /** Return whether one root family is currently registered. */
  hasRoot(name: string): boolean {
    return this.roots.has(name)
  }

  /** Register a legacy root or a capability-declaring M4B root family. */
  registerRoot(name: string, provider: ReviewRootProvider, capabilities?: ReviewRootCapabilities): () => void {
    const key = name.trim()
    if (key === '') throw new TeamDomainError('review root Provider name must not be empty', 'TEAM_INVALID_CONFIG')
    if (this.roots.has(key)) throw new TeamDomainError(`review root Provider "${key}" is already registered`, 'TEAM_PROVIDER_DUPLICATE')
    let registeredCapabilities: ReviewRootCapabilities | undefined
    if (capabilities !== undefined) {
      expectVerificationIdentifier(key, 'review root family')
      const provides = [...capabilities.provides]
      if (provides.length === 0) throw new TeamDomainError('review root capabilities must not be empty', 'TEAM_INVALID_CONFIG')
      for (const capability of provides) expectVerificationIdentifier(capability, 'review root capability')
      if (new Set(provides).size !== provides.length) throw new TeamDomainError('review root capabilities must be unique', 'TEAM_INVALID_CONFIG')
      registeredCapabilities = { provides: Object.freeze(provides), checkAvailability: capabilities.checkAvailability }
    }
    const registration: RegisteredReviewRoot = {
      provider,
      ...(registeredCapabilities === undefined ? {} : { capabilities: registeredCapabilities }),
    }
    this.roots.set(key, registration)
    return () => { if (this.roots.get(key) === registration) this.roots.delete(key) }
  }

  /** Register one named stateless command template. */
  registerTemplate(name: string, template: VerificationCommandTemplate): () => void {
    const normalized = normalizeVerificationTemplate(name, template)
    if (this.templates.has(name)) {
      throw new TeamDomainError(`verification template "${name}" is already registered`, 'TEAM_PROVIDER_DUPLICATE')
    }
    this.templates.set(name, normalized)
    return () => { if (this.templates.get(name) === normalized) this.templates.delete(name) }
  }

  /** Expand declarations and fail before persistence if a routed root is unavailable. */
  async compile(
    declarations: readonly VerificationDeclaration[],
    maxCommands: number,
    signal: AbortSignal,
  ): Promise<ReviewVerificationCommand[]> {
    const commands = compileVerificationDeclarations(declarations, {
      resolveTemplate: name => this.templates.get(name),
      maxCommands,
    })
    await this.assertRootsAvailable(commands, signal)
    return commands
  }

  private async assertRootsAvailable(
    commands: readonly ReviewVerificationCommand[],
    signal: AbortSignal,
  ): Promise<void> {
    const checked = new Set<string>()
    for (const command of commands) {
      const route = parseVerificationCommand(command.command)
      if (route === undefined) continue
      const registration = this.roots.get(route.family)
      if (registration === undefined) {
        throw new TeamDomainError(`review execution root Provider "${route.family}" is unavailable`, 'TEAM_REVIEW_ROOT_PROVIDER_MISSING')
      }
      if (checked.has(route.family)) {
        if (registration.capabilities === undefined || !registration.capabilities.provides.includes(route.capability)) {
          throw new TeamDomainError(
            `review root family "${route.family}" does not provide capability "${route.capability}"`,
            'TEAM_REVIEW_ROOT_UNAVAILABLE',
          )
        }
        continue
      }
      await assertReviewRootCapabilityAvailable({
        family: route.family,
        capability: route.capability,
        capabilities: registration.capabilities,
        signal,
      })
      checked.add(route.family)
    }
  }
}

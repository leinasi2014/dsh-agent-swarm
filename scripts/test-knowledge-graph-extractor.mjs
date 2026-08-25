import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { diagnoseSourcePathIdentities, extractSourceFacts } from './knowledge-graph/extract-source.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-kg-extractor-'))
const execFileAsync = promisify(execFile)
const controlledSkips = []

async function linkOrControlledSkip(label, target, path, type) {
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'EINVAL', 'UNKNOWN'].includes(error?.code)) {
      controlledSkips.push(`${label}:${error.code}`)
      return false
    }
    throw error
  }
}

async function put(root, path, content) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

function errorCodes(facts) {
  return facts.diagnostics.filter(item => item.severity === 'error').map(item => item.code)
}

function noticeCodes(facts) {
  return facts.diagnostics.filter(item => item.severity === 'notice').map(item => item.code)
}

function expectCode(facts, code) {
  assert.ok(errorCodes(facts).includes(code), `expected ${code}; got ${JSON.stringify(facts.diagnostics)}`)
}

function tupleDigest(values) {
  return createHash('sha256').update(JSON.stringify([...values].sort())).digest('hex')
}

function assertTupleSetDigest(values, expected, label) {
  assert.equal(tupleDigest(values), expected, `KG_EXTRACT_DRIFT_LOCK ${label}`)
}

function toolModule(registerFunction, nameExpression) {
  return `
    import { defineTool } from '@deepseek-ai/dsh-tools'
    const register = (..._args: unknown[]) => undefined
    export function ${registerFunction}(ctx: unknown, runtime: unknown): void {
      register(ctx, defineTool({ name: ${nameExpression}, execute() { return runtime } }))
    }
  `
}

async function fixtureRoot(name, options = {}) {
  const root = join(sandbox, name)
  const tools = options.tools ?? [
    ['registerOneTool', "'agent_swarm_one'"],
    ['registerTwoTool', "'agent_swarm_two'"],
  ]
  await put(root, 'package.json', JSON.stringify({ name, type: 'module', exports: { '.': { default: './lib/index.mjs', types: './lib/index.d.ts' } } }))
  await put(root, 'node_modules/@deepseek-ai/dsh-tools/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-tools',
    type: 'module',
    exports: { '.': { types: './index.d.ts' } },
  }))
  await put(root, 'node_modules/@deepseek-ai/dsh-tools/index.d.ts', 'export declare function defineTool<T>(definition: T): T\n')
  await put(root, 'node_modules/@deepseek-ai/cordis/package.json', JSON.stringify({ name: '@deepseek-ai/cordis', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }))
  await put(root, 'node_modules/@deepseek-ai/cordis/index.d.ts', `
    export declare class Service {}
    export interface Context {
      provide(name: string, value: unknown): unknown
      get(name: string): unknown
      inject(names: readonly string[], callback: (ctx: Context) => unknown): unknown
      on(name: string, callback: (...args: unknown[]) => unknown): () => void
      effect(callback: () => unknown, label?: string): () => void
    }
  `)
  await put(root, 'node_modules/@deepseek-ai/schemastery/package.json', JSON.stringify({ name: '@deepseek-ai/schemastery', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }))
  await put(root, 'node_modules/@deepseek-ai/schemastery/index.d.ts', `
    interface Schema<T = unknown> { default(value: unknown): Schema<T>; min(value: number): Schema<T>; max(value: number): Schema<T>; step(value: number): Schema<T> }
    interface Static { string(): Schema<string>; number(): Schema<number>; boolean(): Schema<boolean>; union(values: readonly unknown[]): Schema; object(value: object): Schema }
    declare const z: Static
    export default z
  `)
  await put(root, 'node_modules/zod/package.json', JSON.stringify({ name: 'zod', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }))
  await put(root, 'node_modules/zod/index.d.ts', `export declare const z: { object(value: object): unknown; string(): unknown; union(value: readonly unknown[]): unknown }\n`)
  await put(root, 'node_modules/@deepseek-ai/dsh-storage-domain/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-storage-domain', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }))
  await put(root, 'node_modules/@deepseek-ai/dsh-storage-domain/index.d.ts', `export declare function defineDomain(value: object): unknown; export declare function domainTable<K, V>(schema: unknown): unknown\n`)
  await put(root, 'node_modules/@deepseek-ai/dsh-client-runtime/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-client-runtime', type: 'module', exports: { './client': { types: './client.d.ts' } } }))
  await put(root, 'node_modules/@deepseek-ai/dsh-client-runtime/client.d.ts', `
    import type { Context } from '@deepseek-ai/cordis'
    export interface SlotRegistry { inject(name: string, callback: () => unknown): () => void; register(value: { name: string; [key: string]: unknown }, component: unknown): () => void }
    export interface ClientContext extends Context { readonly slots: SlotRegistry }
  `)
  await put(root, 'node_modules/@deepseek-ai/dsh-client-ui-settings/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-settings', type: 'module', exports: { './client': { types: './client.d.ts' } } }))
  await put(root, 'node_modules/@deepseek-ai/dsh-client-ui-settings/client.d.ts', `
    export interface SettingsScope<T = unknown> {}
    export interface SettingsScopeBinder { bind<T>(value: { namespace: string }): SettingsScope<T> }
  `)
  await put(root, 'node_modules/@deepseek-ai/dsh-system-prompt/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-system-prompt', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }))
  await put(root, 'node_modules/@deepseek-ai/dsh-system-prompt/index.d.ts', `export interface SystemPrompt { section(value: object): () => void }\n`)
  await put(root, 'node_modules/@types/node/package.json', JSON.stringify({ name: '@types/node', version: '1.0.0', types: './index.d.ts' }))
  await put(root, 'node_modules/@types/node/index.d.ts', `declare module 'node:http' { export interface IncomingMessage { readonly method?: string }; export interface ServerResponse {} }\n`)
  await put(root, 'src/public-api.ts', "export { value } from './value.js'\nexport type { Shape } from './value.js'\n")
  await put(root, 'src/value.ts', 'export const value = 1\nexport interface Shape { readonly value: number }\n')
  await put(root, 'src/styles.css', '.fixture {}\n')
  for (const [registerFunction, nameExpression, file = `${registerFunction}.ts`] of tools) {
    await put(root, `src/tools/${file}`, toolModule(registerFunction, nameExpression))
  }
  const imports = tools.map(([registerFunction, , file = `${registerFunction}.ts`]) => `import { ${registerFunction} } from './tools/${file.replace(/\.ts$/u, '.js')}'`).join('\n')
  const calls = (options.registrationOrder ?? tools.map(item => item[0])).map(name => `  ${name}(ctx, runtime)`).join('\n')
  await put(root, 'src/tools.ts', `${imports}\nexport function registerAgentSwarmTools(ctx: unknown, runtime: unknown): void {\n${calls}\n}\n`)
  const permissionNames = options.permissionNames ?? tools.map(([, name]) => name.replaceAll("'", ''))
  await put(root, 'src/runtime/permission-policy.ts', `export const PLUGIN_TOOL_NAMES = ${JSON.stringify(permissionNames)} as const\n`)
  await put(root, 'src/index.ts', `
    import type { Context } from '@deepseek-ai/cordis'
    import './styles.css'
    export const inject = ['requiredService'] as const
    class Runtime {
      private readonly providers = new Map<string, unknown>()
      registerReviewProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('EMPTY')
        if (this.providers.has(key)) throw new Error('DUPLICATE')
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
    export function apply(ctx: Context, runtime: Runtime): void {
      ctx.provide('providedService', {})
      ctx.get('optionalService')
      ctx.inject(['lateService'], () => undefined)
      runtime.registerReviewProvider('fixture-provider', {})
    }
  `)
  await put(root, 'src/runtime/provider.ts', `
    export class Registry {
      registerExecutionRootProvider(name: string, provider: unknown): void { this.providers.registerProvider(name, provider) }
    }
  `)
  return root
}

try {
  const actual = await extractSourceFacts(repositoryRoot)
  assert.deepEqual(errorCodes(actual), [], `actual repository diagnostics: ${JSON.stringify(actual.diagnostics)}`)
  assert.deepEqual(actual.counts, {
    discoveredModules: 128,
    parsedModules: 128,
    toolDefinitions: 20,
    tools: 20,
    imports: 746,
    injections: 34,
    providerRegistrations: 6,
    providerRegistryMethods: 11,
    packageExports: 6,
    publicApiExportDeclarations: 48,
    registries: 7,
    serviceDefinitions: 1,
    configKeys: 43,
    domains: 4,
    domainPortMethods: 30,
    rpcMethods: 5,
    clientSlots: 6,
    lifecycleListeners: 27,
    reachableRootExports: 170,
    reachablePublicApiExports: 165,
  }, 'KG1 walking-skeleton drift lock; replace with graph reconciliation in a later milestone')
  assert.equal(actual.counts.tools, 20)
  assert.equal(actual.counts.toolDefinitions, 20)
  assert.equal(actual.counts.discoveredModules, actual.counts.parsedModules)
  assert.equal(actual.modules.length, actual.counts.discoveredModules)
  const { stdout: rgFiles } = await execFileAsync('rg', ['--files', 'src'], { cwd: repositoryRoot })
  const rgModuleCount = rgFiles.split(/\r?\n/u).filter(path => /\.(?:ts|tsx)$/u.test(path)).length
  assert.equal(actual.counts.discoveredModules, rgModuleCount, 'extractor module inventory must equal rg --files src')
  assert.deepEqual(actual.tools.map(item => item.name).sort(), [...actual.permissionPolicy.names].sort())
  assert.deepEqual(actual.tools.map(item => item.registrationOrder), Array.from({ length: 20 }, (_, index) => index + 1))
  assert.deepEqual(actual.tools.map(item => item.name), [
    'agent_swarm_create',
    'agent_swarm_add_member',
    'agent_swarm_create_task',
    'agent_swarm_continue_task',
    'agent_swarm_remove_member',
    'agent_swarm_archive',
    'agent_swarm_claim_task',
    'agent_swarm_submit_task',
    'agent_swarm_reassign_task',
    'agent_swarm_review_task',
    'agent_swarm_interrupt_member',
    'agent_swarm_send_message',
    'agent_swarm_set_budget',
    'agent_swarm_add_memory',
    'agent_swarm_add_personal_memory',
    'agent_swarm_list_memory',
    'agent_swarm_status',
    'agent_swarm_list_tasks',
    'agent_swarm_list_jobs',
    'agent_swarm_wait',
  ])
  assert.ok(actual.packageExports.some(item => item.subpath === './client'))
  assert.ok(actual.publicApiExports.length > 0)
  assert.ok(actual.injections.some(item => item.kind === 'static-inject' && item.mode === 'required'))
  assert.ok(actual.injections.some(item => item.kind === 'ctx-get' && item.mode === 'optional'))
  assert.ok(actual.providerRegistryMethods.length > 0)
  const injectionServices = kind => actual.injections.filter(item => item.kind === kind).map(item => item.service).sort()
  assert.deepEqual(injectionServices('static-inject'), ['agents', 'locale', 'sessionPersistence', 'sessions', 'sessions', 'settingsScope', 'slots', 'storageDomain', 'subagents', 'systemPrompt', 'tools'])
  assert.deepEqual(injectionServices('ctx-inject'), ['agentSwarmHostRead', 'layout', 'webServer'])
  assert.deepEqual(injectionServices('ctx-provide'), ['agentSwarmHostRead', 'agentSwarmHumanControl', 'agentSwarmHumanInteraction', 'agentSwarmPermission', 'agentSwarmProducerFloor', 'agentSwarmReadRpc', 'agentSwarmV2Initial'])
  assert.deepEqual(injectionServices('ctx-get'), ['agentSwarmHostRead', 'approval', 'layout', 'llm', 'llm', 'llm', 'llm', 'llm', 'sessions', 'skills', 'userQuestions', 'userQuestions', 'webServer'])
  assert.deepEqual(actual.providerRegistrations.map(item => `${item.file}|${item.methodSymbol}|${item.providerName}`).sort(), [
    'src/index.ts|registerReviewProvider|human',
    'src/index.ts|registerReviewProvider|reviewer-agent',
    'src/runtime/execution-root-surface.ts|registerProvider|null',
    'src/runtime/orchestrator-runtime.ts|registerProvider|null',
    'src/runtime/orchestrator-runtime.ts|registerRoot|null',
    'src/runtime/orchestrator-runtime.ts|registerTemplate|null',
  ])
  assert.deepEqual(actual.providerRegistryMethods.map(item => `${item.file}|${item.methodSymbol}`).sort(), [
    'src/runtime/execution-root-surface.ts|registerProvider',
    'src/runtime/execution-roots.ts|registerProvider',
    'src/runtime/orchestrator-runtime.ts|registerExecutionRootProvider',
    'src/runtime/orchestrator-runtime.ts|registerReviewProvider',
    'src/runtime/orchestrator-runtime.ts|registerReviewRootProvider',
    'src/runtime/orchestrator-runtime.ts|registerSchedulerProvider',
    'src/runtime/orchestrator-runtime.ts|registerVerificationCommandTemplate',
    'src/runtime/permission-surface.ts|registerHumanPrincipalVerifier',
    'src/runtime/permission-surface.ts|registerReviewerAgentProvider',
    'src/runtime/verification-family.ts|registerRoot',
    'src/runtime/verification-family.ts|registerTemplate',
  ])
  const externalRegistryTuples = actual.externalRegistryUses.map(item => [
    item.file, item.containingSymbol, item.receiver, item.method, item.declarationFiles.join(','),
  ].join('|'))
  const semanticFact = item => {
    const { anchor: _anchor, ...fact } = item
    if (fact.admission !== undefined && fact.admission !== null) {
      const { anchor: _admissionAnchor, ...admission } = fact.admission
      fact.admission = admission
    }
    return fact
  }
  const rpcTuples = [
    ...actual.rpc.constants.map(item => `constant|${JSON.stringify(semanticFact(item))}`),
    ...actual.rpc.routes.map(item => `route|${JSON.stringify(semanticFact(item))}`),
    ...actual.rpc.httpMethods.map(item => `http|${JSON.stringify(semanticFact(item))}`),
    ...actual.rpc.schemas.map(item => `schema|${JSON.stringify(semanticFact(item))}`),
    ...actual.rpc.capabilities.map(item => `cap|${JSON.stringify(semanticFact(item))}`),
    ...actual.rpc.runtimeCapabilities.map(item => `runtimecap|${JSON.stringify(semanticFact(item))}`),
    ...actual.rpc.bounds.map(item => `bound|${JSON.stringify(semanticFact(item))}`),
    ...actual.rpc.methods.values.map(item => `method|${JSON.stringify(item)}`),
    ...actual.rpc.pageKinds.values.map(item => `page|${JSON.stringify(item)}`),
  ]
  const listenerTuples = actual.lifecycle.listeners.map(item => `listener|${JSON.stringify(semanticFact(item))}`)
  const effectTuples = actual.lifecycle.effects.map(item => [item.file, item.containingSymbol, item.label, item.async, item.cleanup].join('|'))
  const exportTuples = items => items.map(item => [item.name, item.alias, item.targetName, item.spaces.join(','), item.declarations.join(',')].join('|'))
  const reexportLayerTuples = actual.reexportLayers.map(item => [
    item.file, item.order, item.kind, item.declarationTypeOnly, item.moduleSpecifier, item.resolvedModule,
    JSON.stringify(item.names), JSON.stringify(item.effectiveExports),
  ].join('|'))
  // Exact candidate drift locks over complete normalized tuple sets; later graph reconciliation replaces these KG1 locks.
  assertTupleSetDigest(externalRegistryTuples, 'b8b170bbb86e98c40372025b774c94f7881d0a951e3da13d6fc6bdc68b2f4fd9', 'external registries')
  assertTupleSetDigest(rpcTuples, 'dd9e8353c0564d866d2f19b1310e7e870d5a997761e82c81b7255223a79565ad', 'RPC')
  assertTupleSetDigest(listenerTuples, '71b5435abc8739ad326cb24105620a0235c1a16e3d4dedf1251fe335d2780edc', 'listeners')
  assertTupleSetDigest(effectTuples, '0c2f4dc23b978a1f13c675f818d72ba7920ab91293a18071fb90f4c9431a7422', 'effects')
  assertTupleSetDigest(exportTuples(actual.reachableRootExports), '771c964630864102e1ba31e13263513fc900dd90fe0bf3568ba6f1ce022a5236', 'root reachable exports')
  assertTupleSetDigest(exportTuples(actual.reachablePublicApiExports), 'a2520120278763b6cb98c2aab04470e65ff0ee6f591d5302e8b394809bb9bec5', 'public API reachable exports')
  assertTupleSetDigest(reexportLayerTuples, '7d97e3d1a334a7457423a698df7641c35ed6c6386fd211493dacdfb4de9e8e3e', 're-export semantic layers')
  assert.deepEqual(actual.packageExports.map(item => `${item.subpath}|${item.condition}|${item.target}`), [
    '.|default|./lib/index.mjs',
    '.|types|./lib/types/index.d.ts',
    './client|default|./lib/client.js',
    './client|types|./lib/types/client/plugin-entry.d.ts',
    './cordis.patch.yml|default|./cordis.patch.yml',
    './package.json|default|./package.json',
  ])
  assert.ok(actual.publicApiExports.some(item => item.moduleSpecifier === './runtime/orchestrator-runtime.js' && item.names.some(name => name.exported === 'AgentSwarmRuntime')))
  assert.deepEqual(actual.publicApiExports.filter(item => item.names.some(name => name.exported === '*')).map(item => item.moduleSpecifier), [
    './host/producer-contract.js',
    './host/producer-floor-service.js',
    './host/host-read-service.js',
  ])
  assert.ok(actual.modules.find(item => item.path === 'src/index.ts').imports.some(item => item.kind === 'source' && item.specifier === './tools.js'))
  assert.ok(actual.modules.find(item => item.path === 'src/index.ts').imports.some(item => item.kind === 'external' && item.specifier === '@deepseek-ai/cordis'))
  assert.deepEqual(noticeCodes(actual), [
    'KG_EXTRACT_DYNAMIC_PROVIDER_NAME', 'KG_EXTRACT_DYNAMIC_PROVIDER_NAME',
    'KG_EXTRACT_DYNAMIC_PROVIDER_NAME', 'KG_EXTRACT_DYNAMIC_PROVIDER_NAME',
  ])

  // KG1-B semantic drift locks are deliberately current-tree identities. They
  // are reconciliation alarms, not permanent product constants.
  assert.deepEqual(actual.registries.map(item => `${item.id}|${item.kind}|${item.builtins.map(entry => entry.name).join(',')}`), [
    'src/runtime/execution-roots.ts#ExecutionRoots.providers|map|git-worktree',
    'src/runtime/orchestrator-runtime.ts#AgentSwarmRuntime.schedulerProviders|map|priority-ready',
    'src/runtime/orchestrator-runtime.ts#AgentSwarmRuntime.reviewProviders|map|manual,executable',
    'src/runtime/permission-surface.ts#TeamPermissionSurface.humanPrincipalVerifier|single-slot|',
    'src/runtime/permission-surface.ts#TeamPermissionSurface.reviewerAgentProvider|single-slot|',
    'src/runtime/verification-family.ts#VerificationFamily.roots|map|temp,node,python',
    'src/runtime/verification-family.ts#VerificationFamily.templates|map|node.typecheck,node.test,node.build,node.lint,python.typecheck,python.test,python.build,python.lint',
  ])
  assert.deepEqual(actual.serviceDefinitions.map(item => `${item.classSymbol}:${item.serviceName}`), ['AgentSwarmRuntime:agentSwarm'])
  assert.ok(actual.registryExtensions.every(item => item.duplicateRule.startsWith('dominating-') && item.disposer.startsWith('identity-guarded:')))
  assert.ok(actual.registryExtensions.every(item => item.boundedNameRules.length > 0))
  assert.equal(actual.externalRegistryUses.length, 46)
  assert.ok(actual.externalRegistryUses.some(item => item.receiver === 'this.ctx.subagents' && item.method === 'startContinuable'))
  assert.ok(actual.externalRegistryUses.some(item => item.receiver === 'this.ctx.subagents' && item.method === 'list'))
  assert.deepEqual(actual.registryFacades.map(item => `${item.method}->${item.targetMethod}`), [
    'registerProvider->registerProvider',
    'registerReviewRootProvider->registerRoot',
    'registerVerificationCommandTemplate->registerTemplate',
    'registerExecutionRootProvider->registerProvider',
  ])
  const configKeys = actual.config.schema.properties.map(item => item.key)
  assert.deepEqual(configKeys, [
    'disposalTimeoutMs', 'enabled', 'executionRootProvider', 'executionRoots', 'executionRootsBase',
    'experimentalFreshV2', 'freshV2ArtifactContract', 'freshV2HostContract', 'freshV2LegacyManifestCapacity',
    'jobsBridge', 'lazyMemberStart', 'maxDependencies', 'maxMembers', 'maxMemories', 'maxMessageBytes',
    'maxPendingMessagesPerMember', 'maxRetainedAttempts', 'maxRetainedMessages', 'maxTaskBytes',
    'maxTasks', 'maxVerificationCommandMs', 'maxVerificationCommands', 'memberDenyTools',
    'memberLlmProvider', 'memberMaxDepth', 'memberModel', 'memberProvider', 'memberSkills',
    'memoryQueryMaxCandidates', 'memoryQueryTimeoutMs', 'memorySemanticEnabled',
    'memorySemanticModel', 'memorySemanticProvider', 'orchestrationMode', 'promptSectionOrder',
    'reviewProvider', 'reviewRootProvider', 'schedulerProvider', 'strandedAfterMs', 'toolPolicy',
    'workflowBridge', 'workflowDisposeGraceMs', 'workflowMaxTotalAgents',
  ])
  assert.deepEqual(actual.config.interface.properties.map(item => item.key), configKeys)
  const configByKey = new Map(actual.config.schema.properties.map(item => [item.key, item]))
  assert.deepEqual(configByKey.get('orchestrationMode').enumValues, ['adaptive', 'workflow'])
  assert.equal(configByKey.get('orchestrationMode').default, 'adaptive')
  assert.deepEqual(configByKey.get('strandedAfterMs').constraints, { step: 0, min: 0 })
  assert.deepEqual(configByKey.get('memoryQueryMaxCandidates').constraints, { step: 1, min: 1, max: 128 })
  assert.deepEqual(configByKey.get('toolPolicy').default, { allow: [], ask: [], deny: [] })
  assert.equal(configByKey.get('maxVerificationCommandMs').default, 600_000)
  assert.deepEqual(Object.fromEntries(['memberProvider', 'schedulerProvider', 'reviewProvider', 'reviewRootProvider', 'executionRootProvider']
    .map(key => [key, configByKey.get(key).default])), {
    memberProvider: 'spawn', schedulerProvider: 'priority-ready', reviewProvider: 'manual',
    reviewRootProvider: 'temp', executionRootProvider: 'git-worktree',
  })
  assert.ok(actual.config.effectiveConsumptions.some(item => item.key === 'schedulerProvider' && item.fallback === 'priority-ready'))
  assert.deepEqual(actual.domains.map(item => `${item.name}@${item.version}:${item.tables.map(table => table.table).join(',')}`), [
    'agent_swarm_human@1:interactions',
    'agent_swarm_v2@1:authority,teams',
    'agent_swarm@1:migration_receipts,teams',
    'agent_swarm_workflow@1:runs',
  ])
  assert.deepEqual(actual.teamDomainPort.methods.map(item => item.name), [
    'createTeam', 'findMembership', 'requireMembership', 'findReadMembership', 'requireReadMembership',
    'findAccountingMembership', 'provisionMember', 'settleMember', 'recoverProvisioningMembers',
    'removeMember', 'archiveTeam', 'createTask', 'claimTask', 'acknowledgeAssignment', 'activateInitialAssignment', 'submitTask',
    'reviewTask', 'cancelAttempt', 'retryAttempt', 'reinstateAttempt', 'queueMessage', 'acknowledgeMessage',
    'setBudget', 'adoptBudget', 'consumeTokens', 'recordSessionUsage', 'recordSessionUsageBatch',
    'addMemory', 'snapshot', 'waitForChange',
  ])
  const stateUnion = symbol => actual.stateUnions.find(item => item.symbol === symbol)?.values
  assert.deepEqual(stateUnion('TeamMemberPhase'), ['provisioning', 'active', 'failed', 'removed'])
  assert.deepEqual(stateUnion('TeamTaskStatus'), ['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled'])
  assert.deepEqual(stateUnion('TaskAttemptPhase'), ['running', 'submitted', 'verifying', 'accepted', 'rejected', 'cancelled', 'stale'])
  assert.deepEqual(stateUnion('HumanInteractionStatus'), ['pending', 'acknowledged', 'executed', 'rejected', 'failed', 'expired', 'cancelled'])
  assert.deepEqual(stateUnion('WorkflowRunOverlayState'), ['running', 'completed', 'cancelled', 'error', 'interrupted'])
  assert.deepEqual(actual.entityDiscriminants.find(item => item.entity === 'HumanInteractionTarget' && item.field === 'kind').values, ['captain', 'member', 'task', 'team'])
  const rpcConstant = symbol => actual.rpc.constants.find(item => item.symbol === symbol)?.value
  assert.equal(rpcConstant('SWARM_READ_RPC_PROTOCOL'), 'dsh-agent-swarm/read-rpc')
  assert.equal(rpcConstant('SWARM_READ_RPC_VERSION'), 1)
  assert.equal(rpcConstant('SWARM_READ_RPC_NAMESPACE'), '/swarm')
  assert.equal(rpcConstant('SWARM_READ_RPC_ENDPOINT'), '/swarm/v1')
  assert.equal(rpcConstant('SWARM_READ_RPC_CONTRACT_DIGEST_V1'), 'bd0d68edb671554bc5fc1c9eab625ffc694c0335eaf56780bb93df4e18589e09')
  assert.deepEqual(actual.rpc.methods.values, ['capabilities', 'binding', 'status', 'snapshot', 'page'])
  assert.deepEqual(actual.rpc.pageKinds.values, ['tasks', 'attempts', 'pendingInteractions'])
  assert.deepEqual(actual.rpc.schemas.map(item => item.symbol), [
    'SWARM_READ_RPC_CONTRACT_V1', 'SWARM_READ_RPC_FIXTURES_V1',
    'SwarmReadRpcMethod', 'SwarmReadPageKind', 'SwarmReadCapability', 'SwarmReadCapabilityState',
    'SwarmReadTargetHint', 'SwarmReadCapabilitiesRequest', 'SwarmReadTargetRequest',
    'SwarmReadPageRequest', 'SwarmReadRpcRequest', 'SwarmReadCapabilitiesV1', 'SwarmReadBindingV1',
    'SwarmReadStatusV1', 'SwarmReadPageV1', 'SwarmReadRpcValue', 'SwarmReadRpcSuccess',
    'SwarmReadRpcFailure', 'SwarmReadRpcEnvelope', 'SwarmWebServer', 'SwarmRequestTrustFacts',
    'SwarmRequestTrustResult', 'AgentSwarmReadRpcDeps',
  ])
  assert.ok(actual.rpc.routes.some(item => item.kind === 'exact' && item.path === '/swarm/v1'))
  assert.ok(actual.rpc.httpMethods.some(item => item.receiver === 'route-handler' && item.method === 'POST'
    && item.routePath === '/swarm/v1' && item.handlerTargetIdentity === actual.rpc.routes[0].handlerTarget.identity))
  assert.ok(actual.rpc.httpMethods.some(item => item.receiver === 'client-fetch' && item.method === 'POST'))
  assert.deepEqual(actual.rpc.capabilities.find(item => item.symbol === 'readCapabilities').entries.map(item => item.capability), [
    'binding.read', 'status.read', 'snapshot.read', 'page.read', 'message.write', 'control.write', 'effect.cancel',
  ])
  assert.deepEqual(actual.rpc.runtimeCapabilities.map(item => item.values), [[
    'binding.read', 'status.read', 'snapshot.read', 'page.read', 'message.write', 'control.write', 'effect.cancel',
  ]])
  assert.equal(actual.rpc.bounds.find(item => item.symbol === 'MAX_PAGE_LIMIT').value, 50)
  assert.deepEqual(actual.client.entrypoints.map(item => item.file), ['src/client/index.ts', 'src/client/plugin-entry.ts'])
  assert.deepEqual(actual.client.injections.flatMap(item => item.services), ['sessions', 'slots', 'locale', 'settingsScope'])
  assert.deepEqual(actual.client.settingsNamespaces.map(item => `${item.symbol}:${item.value}`), ['AGENT_SWARM_CLIENT_SETTINGS_NAMESPACE:agent-swarm'])
  assert.deepEqual(actual.client.slots.map(item => `${item.operation}:${item.name}`), [
    'inject:details', 'inject:conversation.session.header.utilities',
    'register:conversation.session.header.utilities', 'inject:settings.plugin.item',
    'register:settings.plugin.item', 'register:details',
  ])
  assert.deepEqual(actual.client.settingsFields[0].values, [
    'memorySemanticEnabled', 'memorySemanticProvider', 'memorySemanticModel', 'memoryQueryMaxCandidates',
    'memoryQueryTimeoutMs', 'memberProvider', 'memberLlmProvider', 'memberModel', 'memberDenyTools', 'memberSkills',
  ])
  assert.deepEqual(actual.client.settingsDocuments[0].fields, [...actual.client.settingsFields[0].values].sort())
  assert.ok(actual.lifecycle.listeners.some(item => item.event === 'connection/reset' && item.disposerOwner === 'context'))
  assert.ok(actual.lifecycle.listeners.some(item => item.event === 'agent/status' && item.disposerOwner === 'ctx.effect'))
  assert.ok(actual.lifecycle.listeners.some(item => item.event === 'domain/changed' && item.receiver === 'ctx'))
  assert.deepEqual(actual.lifecycle.systemPrompts.map(item => item.fields.name), ['agent-swarm:usage'])
  assert.equal(actual.lifecycle.effects.length, 30)
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: fresh-v2 model dispatch witness'))
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: fresh-v2 provider topology revocation'))
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: fresh-v2 continuation claim evidence'))
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: fresh-v2 continuation quiescence'))
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: human interaction domain' && item.cleanup === 'returned-cleanup'))
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: activation recovery' && item.async === true))
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: workflow bridge disposal'))
  assert.ok(actual.lifecycle.effects.some(item => item.label === 'agent-swarm: jobs bridge disposal'))
  assert.deepEqual(actual.packageDshMetadata.client, {
    inject: [
      '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
    ],
    platform: 'web',
  })
  assert.ok(actual.packageExports.some(item => item.subpath === './cordis.patch.yml' && item.kind === 'resource'))
  assert.ok(actual.reachableRootExports.some(item => item.name === 'apply' && item.spaces.includes('value')))
  assert.ok(actual.reachableRootExports.some(item => item.name === 'TeamDomainPort' && item.spaces.includes('type')))
  assert.ok(actual.reachablePublicApiExports.some(item => item.name === 'SWARM_PRODUCER_CONTRACT_V1' && item.spaces.includes('value')))

  const positiveRoot = await fixtureRoot('positive')
  const positive = await extractSourceFacts(positiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(positive), [])
  assert.deepEqual(positive.tools.map(item => item.name), ['agent_swarm_one', 'agent_swarm_two'])
  assert.equal(positive.modules.find(item => item.path === 'src/index.ts').imports.find(item => item.specifier === './styles.css')?.kind, 'asset')

  const aliasRoot = await fixtureRoot('alias-bindings')
  await put(aliasRoot, 'src/tools/registerOneTool.ts', toolModule('registerOneTool', "'agent_swarm_one'").replace(
    "import { defineTool } from '@deepseek-ai/dsh-tools'",
    "import { defineTool as officialTool } from '@deepseek-ai/dsh-tools'",
  ).replace('defineTool({', 'officialTool({'))
  await put(aliasRoot, 'src/tools.ts', `
    import { registerOneTool as firstTool } from './tools/registerOneTool.js'
    import { registerTwoTool } from './tools/registerTwoTool.js'
    export function registerAgentSwarmTools(ctx: unknown, runtime: unknown): void {
      firstTool(ctx, runtime)
      registerTwoTool(ctx, runtime)
    }
  `)
  const aliasFacts = await extractSourceFacts(aliasRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(aliasFacts), [])
  assert.equal(aliasFacts.tools[0].localCall, 'firstTool')
  assert.equal(aliasFacts.tools[0].registrationFunction, 'registerOneTool')

  const nestedRegistrationRoot = await fixtureRoot('nested-registration')
  await put(nestedRegistrationRoot, 'src/tools.ts', `
    import { registerOneTool } from './tools/registerOneTool.js'
    import { registerTwoTool } from './tools/registerTwoTool.js'
    export function registerInitialAgentSwarmTools(ctx: unknown, runtime: unknown): void {
      registerOneTool(ctx, runtime)
    }
    export function registerAgentSwarmTools(ctx: unknown, runtime: unknown): void {
      registerInitialAgentSwarmTools(ctx, runtime)
      registerTwoTool(ctx, runtime)
    }
  `)
  const nestedRegistration = await extractSourceFacts(nestedRegistrationRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(nestedRegistration), [])
  assert.deepEqual(nestedRegistration.tools.map(item => item.name), ['agent_swarm_one', 'agent_swarm_two'])

  const localSameNameRoot = await fixtureRoot('local-define-tool', { tools: [['registerOneTool', "'agent_swarm_one'"]] })
  await put(localSameNameRoot, 'src/tools/registerOneTool.ts', `
    function defineTool<T>(definition: T): T { return definition }
    const register = (..._args: unknown[]) => undefined
    export function registerOneTool(ctx: unknown, runtime: unknown): void {
      register(ctx, defineTool({ name: 'agent_swarm_one', execute() { return runtime } }))
    }
  `)
  const localSameName = await extractSourceFacts(localSameNameRoot, { expectedToolCount: 1 })
  expectCode(localSameName, 'KG_EXTRACT_DEFINE_TOOL_SOURCE')
  assert.equal(localSameName.counts.toolDefinitions, 0)

  const wrongDefineExportRoot = await fixtureRoot('wrong-define-export', { tools: [['registerOneTool', "'agent_swarm_one'"]] })
  await put(wrongDefineExportRoot, 'node_modules/@deepseek-ai/dsh-tools/index.d.ts', 'export declare function defineTool<T>(definition: T): T\nexport declare function other<T>(definition: T): T\n')
  await put(wrongDefineExportRoot, 'src/tools/registerOneTool.ts', `
    import { other as defineTool } from '@deepseek-ai/dsh-tools'
    const register = (..._args: unknown[]) => undefined
    export function registerOneTool(ctx: unknown, runtime: unknown): void {
      register(ctx, defineTool({ name: 'agent_swarm_one', execute() { return runtime } }))
    }
  `)
  expectCode(await extractSourceFacts(wrongDefineExportRoot, { expectedToolCount: 1 }), 'KG_EXTRACT_DEFINE_TOOL_SOURCE')

  const nonOfficialDefineRoot = await fixtureRoot('non-official-define-tool', { tools: [['registerOneTool', "'agent_swarm_one'"]] })
  await put(nonOfficialDefineRoot, 'src/tools/fake-tools.ts', 'export function defineTool<T>(definition: T): T { return definition }\n')
  await put(nonOfficialDefineRoot, 'src/tools/registerOneTool.ts', `
    import { defineTool } from './fake-tools.js'
    const register = (..._args: unknown[]) => undefined
    export function registerOneTool(ctx: unknown, runtime: unknown): void {
      register(ctx, defineTool({ name: 'agent_swarm_one', execute() { return runtime } }))
    }
  `)
  expectCode(await extractSourceFacts(nonOfficialDefineRoot, { expectedToolCount: 1 }), 'KG_EXTRACT_DEFINE_TOOL_SOURCE')

  const wrongRegistrationRoot = await fixtureRoot('wrong-registration-module', { tools: [['registerOneTool', "'agent_swarm_one'"]] })
  await put(wrongRegistrationRoot, 'src/tools/decoy.ts', 'export function registerOneTool(_ctx: unknown, _runtime: unknown): void {}\n')
  await put(wrongRegistrationRoot, 'src/tools.ts', `
    import { registerOneTool } from './tools/decoy.js'
    export function registerAgentSwarmTools(ctx: unknown, runtime: unknown): void {
      registerOneTool(ctx, runtime)
    }
  `)
  const wrongRegistration = await extractSourceFacts(wrongRegistrationRoot, { expectedToolCount: 1 })
  expectCode(wrongRegistration, 'KG_EXTRACT_TOOL_REGISTRATION_UNKNOWN')
  expectCode(wrongRegistration, 'KG_EXTRACT_TOOL_UNREGISTERED')
  assert.equal(wrongRegistration.counts.tools, 0)

  const duplicateRegistrationRoot = await fixtureRoot('duplicate-registration', {
    registrationOrder: ['registerOneTool', 'registerOneTool'],
  })
  const duplicateRegistration = await extractSourceFacts(duplicateRegistrationRoot, { expectedToolCount: 2 })
  expectCode(duplicateRegistration, 'KG_EXTRACT_TOOL_REGISTERED_TWICE')
  expectCode(duplicateRegistration, 'KG_EXTRACT_TOOL_UNREGISTERED')

  const unregisteredRoot = await fixtureRoot('unregistered-definition', { registrationOrder: ['registerOneTool'] })
  expectCode(await extractSourceFacts(unregisteredRoot, { expectedToolCount: 1 }), 'KG_EXTRACT_TOOL_UNREGISTERED')

  const wrongCaseRoot = await fixtureRoot('wrong-case-import', { tools: [['registerOneTool', "'agent_swarm_one'"]] })
  await put(wrongCaseRoot, 'src/tools.ts', `
    import { registerOneTool } from './tools/RegisterOneTool.js'
    export function registerAgentSwarmTools(ctx: unknown, runtime: unknown): void {
      registerOneTool(ctx, runtime)
    }
  `)
  expectCode(await extractSourceFacts(wrongCaseRoot, { expectedToolCount: 1 }), 'KG_EXTRACT_IMPORT_CASE_MISMATCH')

  const dynamicNoticesRoot = await fixtureRoot('dynamic-notices')
  await put(dynamicNoticesRoot, 'src/index.ts', `
    import type { Context } from '@deepseek-ai/cordis'
    const dynamicImport = './value.js'
    const dynamicService = 'optionalService'
    const dynamicProvider = 'fixture-provider'
    class Runtime {
      private readonly providers = new Map<string, unknown>()
      registerReviewProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('EMPTY')
        if (this.providers.has(key)) throw new Error('DUPLICATE')
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
    export function apply(ctx: Context, runtime: Runtime): void {
      void import(dynamicImport)
      ctx.get(dynamicService)
      runtime.registerReviewProvider(dynamicProvider, {})
    }
  `)
  const dynamicNotices = await extractSourceFacts(dynamicNoticesRoot, { expectedToolCount: 2 })
  assert.ok(noticeCodes(dynamicNotices).includes('KG_EXTRACT_DYNAMIC_IMPORT'))
  assert.ok(noticeCodes(dynamicNotices).includes('KG_EXTRACT_DYNAMIC_SERVICE_NAME'))
  assert.ok(noticeCodes(dynamicNotices).includes('KG_EXTRACT_DYNAMIC_PROVIDER_NAME'))

  const providerDecoyRoot = await fixtureRoot('provider-local-decoy')
  await put(providerDecoyRoot, 'src/provider-decoy.ts', `
    class FakeRegistry { registerReviewProvider(_name: string, _provider: unknown): void {} }
    export function install(fake: FakeRegistry): void { fake.registerReviewProvider('decoy', {}) }
  `)
  expectCode(await extractSourceFacts(providerDecoyRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_PROVIDER_CALL_WRONG_ORIGIN')
  const serviceAliasRoot = await fixtureRoot('service-origin-alias')
  await put(serviceAliasRoot, 'src/service.ts', `
    import { Service as CordisService } from '@deepseek-ai/cordis'
    export class FixtureService extends CordisService { static readonly name = 'fixtureService' }
    class LocalService {}
    export class DecoyService extends LocalService { static readonly name = 'decoyService' }
  `)
  const serviceAlias = await extractSourceFacts(serviceAliasRoot, { expectedToolCount: 2 })
  assert.deepEqual(serviceAlias.serviceDefinitions.map(item => item.classSymbol), ['FixtureService'])

  const selectionEscapeRoot = await fixtureRoot('selection-escape')
  await put(sandbox, 'outside-never-read.ts', 'export const broken = {\n')
  const selectionEscape = await extractSourceFacts(selectionEscapeRoot, {
    expectedToolCount: 0,
    sourceFiles: ['../outside-never-read.ts'],
  })
  expectCode(selectionEscape, 'KG_EXTRACT_MODULE_OUTSIDE_INVENTORY')
  assert.ok(!selectionEscape.modules.some(item => item.path.includes('outside-never-read')))
  assert.ok(!selectionEscape.diagnostics.some(item => item.code === 'KG_EXTRACT_TYPESCRIPT_PARSE' && item.file?.includes('outside-never-read')))

  const fileLinkRoot = await fixtureRoot('file-link-escape')
  const outsideFile = join(sandbox, 'outside-file.ts')
  await writeFile(outsideFile, 'export const outside = true\n', 'utf8')
  if (await linkOrControlledSkip('file-symlink', outsideFile, join(fileLinkRoot, 'src', 'linked.ts'), 'file')) {
    expectCode(await extractSourceFacts(fileLinkRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_SOURCE_REPARSE_POINT')
  }

  const directoryLinkRoot = await fixtureRoot('directory-link-escape')
  const outsideDirectory = join(sandbox, 'outside-directory')
  await put(sandbox, 'outside-directory/escape.css', '.escaped {}\n')
  await put(directoryLinkRoot, 'src/resource-user.ts', "import './linked-directory/escape.css'\n")
  if (await linkOrControlledSkip(
    process.platform === 'win32' ? 'directory-junction' : 'directory-symlink',
    outsideDirectory,
    join(directoryLinkRoot, 'src', 'linked-directory'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )) {
    expectCode(await extractSourceFacts(directoryLinkRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_SOURCE_REPARSE_POINT')
  }

  const linkedSourceRoot = join(sandbox, 'linked-source-root')
  const sourceRootTarget = join(sandbox, 'source-root-target')
  await put(linkedSourceRoot, 'package.json', JSON.stringify({ name: 'linked-source-root', type: 'module', exports: {} }))
  await put(sandbox, 'source-root-target/escape.ts', 'export const escaped = true\n')
  if (await linkOrControlledSkip(
    process.platform === 'win32' ? 'source-root-junction' : 'source-root-symlink',
    sourceRootTarget,
    join(linkedSourceRoot, 'src'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )) {
    expectCode(await extractSourceFacts(linkedSourceRoot, { expectedToolCount: 0 }), 'KG_EXTRACT_SOURCE_REPARSE_POINT')
  }

  const repositoryLinkTarget = await fixtureRoot('repository-link-target')
  const repositoryLink = join(sandbox, 'repository-link')
  if (await linkOrControlledSkip(
    process.platform === 'win32' ? 'repository-root-junction' : 'repository-root-symlink',
    repositoryLinkTarget,
    repositoryLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  )) {
    expectCode(await extractSourceFacts(repositoryLink, { expectedToolCount: 0 }), 'KG_EXTRACT_REPOSITORY_REPARSE_POINT')
  }

  const twentyOneTools = Array.from({ length: 21 }, (_, index) => [
    `registerTool${String(index + 1).padStart(2, '0')}Tool`,
    `'agent_swarm_tool_${String(index + 1).padStart(2, '0')}'`,
  ])
  const twentyOneRoot = await fixtureRoot('twenty-one-tools', { tools: twentyOneTools })
  const twentyOne = await extractSourceFacts(twentyOneRoot)
  assert.equal(twentyOne.counts.tools, 21)
  expectCode(twentyOne, 'KG_EXTRACT_TOOL_COUNT')

  const duplicateRoot = await fixtureRoot('duplicate', {
    tools: [
      ['registerOneTool', "'agent_swarm_same'"],
      ['registerTwoTool', "'agent_swarm_same'"],
    ],
    permissionNames: ['agent_swarm_same'],
  })
  expectCode(await extractSourceFacts(duplicateRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_TOOL_DUPLICATE')

  const orderRoot = await fixtureRoot('order-drift', { registrationOrder: ['registerTwoTool', 'registerOneTool'] })
  const orderFacts = await extractSourceFacts(orderRoot, { expectedToolCount: 2 })
  assert.deepEqual(orderFacts.tools.map(item => item.name), ['agent_swarm_two', 'agent_swarm_one'])
  assert.notDeepEqual(orderFacts.tools.map(item => item.name), orderFacts.permissionPolicy.names)

  const permissionRoot = await fixtureRoot('permission-drift', { permissionNames: ['agent_swarm_one', 'agent_swarm_extra'] })
  const permission = await extractSourceFacts(permissionRoot, { expectedToolCount: 2 })
  expectCode(permission, 'KG_EXTRACT_PERMISSION_TOOL_MISSING')
  expectCode(permission, 'KG_EXTRACT_PERMISSION_TOOL_EXTRA')

  const uncoveredRoot = await fixtureRoot('uncovered')
  const uncoveredFiles = [
    'src/index.ts',
    'src/public-api.ts',
    'src/tools.ts',
    'src/tools/registerOneTool.ts',
    'src/tools/registerTwoTool.ts',
    'src/runtime/permission-policy.ts',
    'src/runtime/provider.ts',
  ]
  expectCode(await extractSourceFacts(uncoveredRoot, { expectedToolCount: 2, sourceFiles: uncoveredFiles }), 'KG_EXTRACT_MODULE_UNCOVERED')

  const dynamicRoot = await fixtureRoot('dynamic-name', {
    tools: [['registerOneTool', 'TOOL_NAME']],
    permissionNames: ['agent_swarm_one'],
  })
  await put(dynamicRoot, 'src/tools/registerOneTool.ts', `
    import { defineTool } from '@deepseek-ai/dsh-tools'
    const TOOL_NAME = 'agent_swarm_one'
    const register = (..._args: unknown[]) => undefined
    export function registerOneTool(ctx: unknown, runtime: unknown): void {
      register(ctx, defineTool({ name: TOOL_NAME, execute() { return runtime } }))
    }
  `)
  expectCode(await extractSourceFacts(dynamicRoot, { expectedToolCount: 1 }), 'KG_EXTRACT_DYNAMIC_TOOL_NAME')

  const registryPositiveRoot = await fixtureRoot('semantic-registry-positive')
  await put(registryPositiveRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      constructor() { this.providers.set('builtin', {}) }
      attachExtension(name: string, provider: unknown): () => void {
        const key = name.trim()
        const aliasKey = key
        if (key === '') throw new Error('empty')
        if (this.providers.has(aliasKey)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(key, provider)
        return () => { if (provider === this.providers.get(aliasKey)) this.providers.delete(key) }
      }
    }
    export class RenamedFacade {
      constructor(private readonly registry: FixtureRegistry) {}
      bridge(name: string, value: unknown): () => void { return this.registry.attachExtension(name, value) }
      registerProvider(_name: string, _value: unknown): void {}
    }
  `)
  const registryPositive = await extractSourceFacts(registryPositiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(registryPositive), [])
  assert.ok(registryPositive.registries.some(item => item.storage === 'providers' && item.builtins[0]?.name === 'builtin'))
  assert.deepEqual(registryPositive.registryExtensions.filter(item => item.file === 'src/semantic-registry.ts').map(item => item.method), ['attachExtension'])
  assert.deepEqual(registryPositive.registryFacades.filter(item => item.file === 'src/semantic-registry.ts').map(item => item.method), ['bridge'])
  const registryNegativeRoot = await fixtureRoot('semantic-registry-negative')
  await put(registryNegativeRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        if (this.providers.has(name)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(name, provider)
        return () => undefined
      }
    }
  `)
  expectCode(await extractSourceFacts(registryNegativeRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DISPOSER_MISSING')
  const registryWrongKeyRoot = await fixtureRoot('semantic-registry-wrong-key')
  await put(registryWrongKeyRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (this.providers.has(name)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryWrongKeyRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DUPLICATE_RULE_MISSING')
  const registryIgnoredHasRoot = await fixtureRoot('semantic-registry-ignored-has')
  await put(registryIgnoredHasRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        void this.providers.has(key)
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryIgnoredHasRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DUPLICATE_RULE_MISSING')
  const registryUnconditionalDeleteRoot = await fixtureRoot('semantic-registry-unconditional-delete')
  await put(registryUnconditionalDeleteRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (this.providers.has(key)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(key, provider)
        return () => { this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryUnconditionalDeleteRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DISPOSER_MISSING')
  const registryBooleanWrappedDuplicateRoot = await fixtureRoot('semantic-registry-boolean-wrapped-duplicate')
  await put(registryBooleanWrappedDuplicateRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (this.providers.has(key) && name.length > 0) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryBooleanWrappedDuplicateRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DUPLICATE_RULE_MISSING')
  const registryReturnRejectRoot = await fixtureRoot('semantic-registry-return-reject')
  await put(registryReturnRejectRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): (() => void) | undefined {
        const key = name.trim()
        if (this.providers.has(key)) return undefined
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryReturnRejectRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DUPLICATE_RULE_MISSING')
  const registryBooleanWrappedIdentityRoot = await fixtureRoot('semantic-registry-boolean-wrapped-identity')
  await put(registryBooleanWrappedIdentityRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (this.providers.has(key)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider && name.length > 0) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryBooleanWrappedIdentityRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DISPOSER_MISSING')
  const registryWrongCleanupBranchRoot = await fixtureRoot('semantic-registry-wrong-cleanup-branch')
  await put(registryWrongCleanupBranchRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      private readonly fallback = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (this.providers.has(key)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(key, provider)
        return () => {
          if (this.providers.get(key) === provider) this.providers.delete(key)
          else this.fallback.delete(key)
        }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryWrongCleanupBranchRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_DISPOSER_MISSING')
  const registryInertBoundRoot = await fixtureRoot('semantic-registry-inert-name-bound')
  await put(registryInertBoundRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        void (key === '')
        if (this.providers.has(key)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryInertBoundRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_NAME_BOUND_MISSING')
  const registryDecoyValidatorRoot = await fixtureRoot('semantic-registry-decoy-validator')
  await put(registryDecoyValidatorRoot, 'src/semantic-registry.ts', `
    let unrelatedFailure = false
    function pretendValidator(_value: string): void { if (unrelatedFailure) throw new Error('unrelated') }
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        pretendValidator(name)
        if (this.providers.has(name)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(name, provider)
        return () => { if (this.providers.get(name) === provider) this.providers.delete(name) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryDecoyValidatorRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_NAME_BOUND_MISSING')
  const registryReturnBeforeGuardRoot = await fixtureRoot('semantic-registry-validator-return-before-guard')
  await put(registryReturnBeforeGuardRoot, 'src/semantic-registry.ts', `
    function unreachableValidator(value: string): void { return; if (value === '') throw new Error('empty') }
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        unreachableValidator(name)
        if (this.providers.has(name)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(name, provider)
        return () => { if (this.providers.get(name) === provider) this.providers.delete(name) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryReturnBeforeGuardRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_NAME_BOUND_MISSING')
  const registryUnreachableThrowRoot = await fixtureRoot('semantic-registry-validator-unreachable-throw')
  await put(registryUnreachableThrowRoot, 'src/semantic-registry.ts', `
    function unreachableThrow(value: string): void { if (value === '') { return; throw new Error('dead') } }
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        unreachableThrow(name)
        if (this.providers.has(name)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(name, provider)
        return () => { if (this.providers.get(name) === provider) this.providers.delete(name) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryUnreachableThrowRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_NAME_BOUND_MISSING')
  const registryPrefixedThrowRoot = await fixtureRoot('semantic-registry-validator-prefixed-throw')
  await put(registryPrefixedThrowRoot, 'src/semantic-registry.ts', `
    function prefixedThrow(value: string): void { if (value === '') { void value; throw new Error('empty') } }
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        prefixedThrow(name)
        if (this.providers.has(name)) throw new Error('TEAM_PROVIDER_DUPLICATE')
        this.providers.set(name, provider)
        return () => { if (this.providers.get(name) === provider) this.providers.delete(name) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryPrefixedThrowRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_NAME_BOUND_MISSING')
  const registryReturnBeforeMutationRoot = await fixtureRoot('semantic-registry-return-before-mutation')
  await put(registryReturnBeforeMutationRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        return () => undefined
        this.providers.set(key, provider)
      }
    }
  `)
  expectCode(await extractSourceFacts(registryReturnBeforeMutationRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryNestedMutationRoot = await fixtureRoot('semantic-registry-nested-unreachable-mutation')
  await put(registryNestedMutationRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        if (false) this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryNestedMutationRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryConditionalReturnRoot = await fixtureRoot('semantic-registry-conditional-return-before-mutation')
  await put(registryConditionalReturnRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        if (true) return () => undefined
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryConditionalReturnRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryBareBlockRoot = await fixtureRoot('semantic-registry-bare-block-before-mutation')
  await put(registryBareBlockRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        { return () => undefined }
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryBareBlockRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryDoubleTerminalRoot = await fixtureRoot('semantic-registry-double-terminal-guard')
  await put(registryDoubleTerminalRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        else return () => undefined
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryDoubleTerminalRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryTautologyThrowRoot = await fixtureRoot('semantic-registry-local-tautology-throw')
  await put(registryTautologyThrowRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === key) throw new Error('decoy')
        if (this.providers.has(key)) throw new Error('duplicate')
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryTautologyThrowRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryStorageAliasClearRoot = await fixtureRoot('semantic-registry-storage-alias-clear')
  await put(registryStorageAliasClearRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        const storage = this.providers
        storage.clear()
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryStorageAliasClearRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryStorageAliasChainRoot = await fixtureRoot('semantic-registry-storage-alias-chain')
  await put(registryStorageAliasChainRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        const first = this.providers
        const second = first
        second.delete(key)
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryStorageAliasChainRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryThirdPartyEffectRoot = await fixtureRoot('semantic-registry-third-party-declaration-effect')
  await put(registryThirdPartyEffectRoot, 'node_modules/third-party/package.json', JSON.stringify({ name: 'third-party', type: 'module', types: './index.d.ts' }))
  await put(registryThirdPartyEffectRoot, 'node_modules/third-party/index.d.ts', 'export declare function touch(value: string): void\n')
  await put(registryThirdPartyEffectRoot, 'src/semantic-registry.ts', `
    import { touch } from 'third-party'
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        touch(key)
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryThirdPartyEffectRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryScratchContainerRoot = await fixtureRoot('semantic-registry-local-scratch-container')
  await put(registryScratchContainerRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        const scratch = new Map<string, unknown>()
        scratch.set(key, provider)
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  const registryScratchContainer = await extractSourceFacts(registryScratchContainerRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(registryScratchContainer), [])
  assert.deepEqual(registryScratchContainer.registryExtensions.filter(item => item.file === 'src/semantic-registry.ts').map(item => item.method), ['registerProvider'])
  for (const mutator of ['clear()', 'delete(key)', 'set(key, provider)']) {
    const fixtureName = `semantic-registry-scratch-reassigned-to-storage-${mutator.slice(0, mutator.indexOf('('))}`
    const root = await fixtureRoot(fixtureName)
    await put(root, 'src/semantic-registry.ts', `
      export class FixtureRegistry {
        private readonly providers = new Map<string, unknown>()
        registerProvider(name: string, provider: unknown): () => void {
          const key = name.trim()
          if (key === '') throw new Error('empty')
          if (this.providers.has(key)) throw new Error('duplicate')
          let scratch = new Map<string, unknown>()
          scratch = this.providers
          scratch.${mutator}
          this.providers.set(key, provider)
          return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
        }
      }
    `)
    expectCode(await extractSourceFacts(root, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  }
  const registryStorageAliasReassignedRoot = await fixtureRoot('semantic-registry-storage-alias-reassigned-to-scratch')
  await put(registryStorageAliasReassignedRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        let target = this.providers
        target = new Map<string, unknown>()
        target.set(key, provider)
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryStorageAliasReassignedRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  for (const [operator, label] of [['&&=', 'and'], ['||=', 'or'], ['??=', 'nullish']]) {
    const fixtureName = `semantic-registry-scratch-${label}-storage-assignment`
    const root = await fixtureRoot(fixtureName)
    await put(root, 'src/semantic-registry.ts', `
      export class FixtureRegistry {
        private readonly providers = new Map<string, unknown>()
        registerProvider(name: string, provider: unknown): () => void {
          const key = name.trim()
          if (key === '') throw new Error('empty')
          if (this.providers.has(key)) throw new Error('duplicate')
          let scratch: any = new Map<string, unknown>()
          scratch ${operator} this.providers
          scratch.clear()
          this.providers.set(key, provider)
          return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
        }
      }
    `)
    expectCode(await extractSourceFacts(root, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  }
  const registryTrackedIncrementRoot = await fixtureRoot('semantic-registry-tracked-scratch-increment')
  await put(registryTrackedIncrementRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        let scratch: any = new Map<string, unknown>()
        scratch++
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryTrackedIncrementRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')
  const registryTrackedDecrementRoot = await fixtureRoot('semantic-registry-tracked-storage-decrement')
  await put(registryTrackedDecrementRoot, 'src/semantic-registry.ts', `
    export class FixtureRegistry {
      private readonly providers = new Map<string, unknown>()
      registerProvider(name: string, provider: unknown): () => void {
        const key = name.trim()
        if (key === '') throw new Error('empty')
        if (this.providers.has(key)) throw new Error('duplicate')
        let target: any = this.providers
        --target
        this.providers.set(key, provider)
        return () => { if (this.providers.get(key) === provider) this.providers.delete(key) }
      }
    }
  `)
  expectCode(await extractSourceFacts(registryTrackedDecrementRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN')

  const configPositiveRoot = await fixtureRoot('semantic-config-positive')
  await put(configPositiveRoot, 'src/config.ts', `
    import schema from '@deepseek-ai/schemastery'
    const { object: makeObject, union: choices, number: integer } = schema
    export interface Config { mode?: 'one' | 'two'; limit?: number }
    export const Config = makeObject({
      mode: choices(['one', 'two']).default('one'),
      limit: integer().step(1).min(1).max(8).default(4),
    })
    export function effective(config: Config): unknown {
      return { mode: config.mode ?? 'one', limit: config.limit ?? 4 }
    }
  `)
  const configPositive = await extractSourceFacts(configPositiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(configPositive), [])
  assert.deepEqual(configPositive.config.schema.properties.map(item => item.key), ['limit', 'mode'])
  const configNegativeRoot = await fixtureRoot('semantic-config-negative')
  await put(configNegativeRoot, 'src/config.ts', `
    import z from '@deepseek-ai/schemastery'
    export interface Config { mode?: 'one' | 'two'; orphan?: boolean }
    export const Config = z.object({ mode: z.union(['one', 'two']).default('one') })
    export function effective(config: Config): unknown { return config.mode ?? 'one' }
  `)
  expectCode(await extractSourceFacts(configNegativeRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_CONFIG_KEY_DRIFT')
  const configDecoyRoot = await fixtureRoot('semantic-config-local-decoy')
  await put(configDecoyRoot, 'src/config.ts', `
    const fake = { object: (value: object) => value, string: () => ({ default: (_value: string) => ({}) }) }
    export interface Config { name?: string }
    export const Config = fake.object({ name: fake.string().default('fixture') })
  `)
  expectCode(await extractSourceFacts(configDecoyRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_CONFIG_SCHEMA_DYNAMIC')

  const domainPositiveRoot = await fixtureRoot('semantic-domain-positive')
  await put(domainPositiveRoot, 'src/domain/fixture.ts', `
    import { z } from 'zod'
    import { defineDomain as buildDomain, domainTable as table } from '@deepseek-ai/dsh-storage-domain'
    const NAME = 'fixture-domain'
    const VERSION = 1
    interface RecordV1 { readonly id: string; readonly lifecycleMode: 'ready' | 'done' }
    const recordSchema = z.object({ id: z.string(), lifecycleMode: z.union(['ready', 'done']) })
    export const fixtureDomainSpec = buildDomain({
      name: NAME, version: VERSION, tables: { records: table<string, RecordV1>(recordSchema) },
    })
    export interface TeamDomainPort { read(id: string): Promise<RecordV1 | undefined> }
  `)
  const domainPositive = await extractSourceFacts(domainPositiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(domainPositive), [])
  assert.equal(domainPositive.domains[0].name, 'fixture-domain')
  assert.deepEqual(domainPositive.teamDomainPort.methods.map(item => item.name), ['read'])
  assert.deepEqual(domainPositive.entityDiscriminants.find(item => item.entity === 'RecordV1' && item.field === 'lifecycleMode')?.values, ['done', 'ready'])
  const domainNegativeRoot = await fixtureRoot('semantic-domain-negative')
  await put(domainNegativeRoot, 'src/domain/fixture.ts', `
    import { z } from 'zod'
    import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
    const dynamicVersion = () => Date.now()
    interface RecordV1 { readonly id: string }
    const recordSchema = z.object({ id: z.string() })
    export const fixtureDomainSpec = defineDomain({
      name: 'fixture-domain', version: dynamicVersion(), tables: { records: domainTable<string, RecordV1>(recordSchema) },
    })
  `)
  expectCode(await extractSourceFacts(domainNegativeRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_DOMAIN_ID_DYNAMIC')
  const domainDecoyRoot = await fixtureRoot('semantic-domain-local-decoy')
  await put(domainDecoyRoot, 'src/domain/fixture.ts', `
    import { z } from 'zod'
    function defineDomain(value: object): object { return value }
    function domainTable(_schema: unknown): object { return {} }
    export const fixtureDomainSpec = defineDomain({ name: 'decoy', version: 1, tables: { records: domainTable(z.object({ id: z.string() })) } })
  `)
  expectCode(await extractSourceFacts(domainDecoyRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_DOMAIN_CALL_WRONG_ORIGIN')

  const rpcPositiveRoot = await fixtureRoot('semantic-rpc-positive')
  const rpcPositiveSource = `
    import type { IncomingMessage, ServerResponse } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities' | 'snapshot' | 'page'
    export type PageDimension = 'tasks' | 'attempts'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface SnapshotRequest { readonly method: 'snapshot' }
    export interface PageRequest { readonly method: 'page'; readonly page: { readonly kind: PageDimension } }
    interface SwarmReadNameDecoy { readonly ignored: true }
    const SWARM_READ_RPC_NAME_DECOY = '/ignored'
    const readCapabilities = [
      { capability: 'snapshot.read', state: 'available' },
      { capability: 'message.write', state: 'unavailable', blocker: 'blocked' },
    ]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    export class Boundary {
      receive(_req: IncomingMessage, _res: ServerResponse): void {}
      describeAccess(): object { return { capabilities: [{ capability: 'snapshot.read', state: 'available' }] } }
    }
    export function mount(server: TransportPort): void {
      const { expose } = server
      expose({ kind: 'exact', path: endpointValue, handler(req: IncomingMessage): void {
        if (req.method !== 'POST') return
        void readCapabilities
      } })
    }
  `
  await put(rpcPositiveRoot, 'src/rpc/read-rpc.ts', rpcPositiveSource)
  const rpcPositive = await extractSourceFacts(rpcPositiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(rpcPositive), [])
  assert.deepEqual(rpcPositive.rpc.methods.values, ['capabilities', 'snapshot', 'page'])
  assert.deepEqual(rpcPositive.rpc.pageKinds.values, ['tasks', 'attempts'])
  assert.deepEqual(rpcPositive.rpc.runtimeCapabilities.map(item => `${item.methodSymbol}:${item.values.join(',')}`), ['describeAccess:snapshot.read'])
  assert.equal(rpcPositive.rpc.routes[0].handlerTarget.kind, 'inline')
  assert.equal(rpcPositive.rpc.routes[0].admission.method, 'POST')
  assert.equal(rpcPositive.rpc.constants.some(item => item.symbol === 'SWARM_READ_RPC_NAME_DECOY'), false)
  assert.equal(rpcPositive.rpc.schemas.some(item => item.symbol === 'SwarmReadNameDecoy'), false)
  const rpcSchemaTuples = facts => facts.rpc.schemas.map(item => `schema|${JSON.stringify(semanticFact(item))}`)
  const rpcSchemaDigest = tupleDigest(rpcSchemaTuples(rpcPositive))
  await put(rpcPositiveRoot, 'src/rpc/read-rpc.ts', rpcPositiveSource.replace(
    'export interface SnapshotRequest', 'export interface ReplacementRequest',
  ))
  const rpcSchemaCompensated = await extractSourceFacts(rpcPositiveRoot, { expectedToolCount: 2 })
  assert.equal(rpcSchemaCompensated.rpc.schemas.length, rpcPositive.rpc.schemas.length, 'replacement schema keeps the misleading count stable')
  assert.throws(() => assertTupleSetDigest(rpcSchemaTuples(rpcSchemaCompensated), rpcSchemaDigest, 'compensating RPC schema decoy'), /KG_EXTRACT_DRIFT_LOCK/u)
  const rpcNegativeRoot = await fixtureRoot('semantic-rpc-negative')
  await put(rpcNegativeRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const SWARM_READ_RPC_ENDPOINT = '/fixture/v1' as const
    export type SwarmReadRpcMethod = 'capabilities'
    export type SwarmReadPageKind = 'tasks'
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    export function mount(server: TransportPort): void {
      server.expose({ kind: 'prefix', path: SWARM_READ_RPC_ENDPOINT, handler(req: IncomingMessage): void {
        if (req.method !== 'POST') return
        void readCapabilities
      } })
    }
  `)
  expectCode(await extractSourceFacts(rpcNegativeRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_RPC_ROUTE_DRIFT')
  const rpcDecoyRoot = await fixtureRoot('semantic-rpc-local-decoy')
  await put(rpcDecoyRoot, 'src/rpc/read-rpc.ts', `
    export const SWARM_READ_RPC_ENDPOINT = '/fixture/v1' as const
    export type SwarmReadRpcMethod = 'capabilities'
    export type SwarmReadPageKind = 'tasks'
    export type SwarmFetch = (input: string, init?: { method: string }) => Promise<unknown>
    type OtherFetch = (input: string, init?: { method: string }) => Promise<unknown>
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface OtherServer { register(value: { kind: string; path: string; handler(): void }): void }
    export function mount(decoy: OtherServer): void { decoy.register({ kind: 'exact', path: SWARM_READ_RPC_ENDPOINT, handler(): void {} }); void readCapabilities }
    export function request(decoy: OtherFetch): Promise<unknown> { return decoy('/fixture/v1', { method: 'POST' }) }
  `)
  const rpcDecoy = await extractSourceFacts(rpcDecoyRoot, { expectedToolCount: 2 })
  expectCode(rpcDecoy, 'KG_EXTRACT_RPC_ROUTE_WRONG_ORIGIN')
  expectCode(rpcDecoy, 'KG_EXTRACT_RPC_CLIENT_WRONG_ORIGIN')
  const rpcDelegatedRoot = await fixtureRoot('semantic-rpc-delegated-handler')
  await put(rpcDelegatedRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage, ServerResponse } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void }
    export class Boundary {
      receive(req: IncomingMessage, _res: ServerResponse): void { if (req.method !== 'POST') return }
      describeAccess(): object { return { capabilities: [{ capability: 'snapshot.read', state: 'available' }] } }
    }
    export function mount(server: TransportPort, boundary: Boundary): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: (req, res) => {
        let requestAlias = req
        const chainedAlias = requestAlias
        return boundary.receive(chainedAlias, res)
      } })
      void readCapabilities
    }
  `)
  const rpcDelegated = await extractSourceFacts(rpcDelegatedRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(rpcDelegated), [])
  assert.equal(rpcDelegated.rpc.routes[0].handlerTarget.kind, 'delegated')
  assert.match(rpcDelegated.rpc.routes[0].handlerTarget.identity, /#Boundary\.receive@/u)
  assert.match(rpcDelegated.rpc.routes[0].handlerTarget.signature, /IncomingMessage/u)
  const rpcWrongTargetRoot = await fixtureRoot('semantic-rpc-wrong-target')
  await put(rpcWrongTargetRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    class WrongTarget { consume(_req: IncomingMessage): void {} }
    export function mount(server: TransportPort, target: WrongTarget): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: req => target.consume(req) })
      void readCapabilities
    }
  `)
  expectCode(await extractSourceFacts(rpcWrongTargetRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_RPC_HANDLER_UNBOUND')
  const rpcConsoleReadRoot = await fixtureRoot('semantic-rpc-console-read')
  await put(rpcConsoleReadRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    export function mount(server: TransportPort): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: req => { console.log(req); void req.method } })
      void readCapabilities
    }
  `)
  const rpcConsoleRead = await extractSourceFacts(rpcConsoleReadRoot, { expectedToolCount: 2 })
  expectCode(rpcConsoleRead, 'KG_EXTRACT_RPC_HANDLER_UNBOUND')
  expectCode(rpcConsoleRead, 'KG_EXTRACT_RPC_HTTP_METHOD_DRIFT')
  const rpcElsewherePostRoot = await fixtureRoot('semantic-rpc-elsewhere-post')
  await put(rpcElsewherePostRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    function elsewhere(req: IncomingMessage): void { if (req.method !== 'POST') return }
    export function mount(server: TransportPort): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: _req => undefined })
      void readCapabilities; void elsewhere
    }
  `)
  const rpcElsewherePost = await extractSourceFacts(rpcElsewherePostRoot, { expectedToolCount: 2 })
  expectCode(rpcElsewherePost, 'KG_EXTRACT_RPC_HANDLER_UNBOUND')
  expectCode(rpcElsewherePost, 'KG_EXTRACT_RPC_HTTP_METHOD_DRIFT')
  const rpcNestedGuardRoot = await fixtureRoot('semantic-rpc-nested-guard')
  await put(rpcNestedGuardRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    export function mount(server: TransportPort): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: req => {
        if (Date.now() > 0) { if (req.method !== 'POST') return }
        void readCapabilities
      } })
    }
  `)
  expectCode(await extractSourceFacts(rpcNestedGuardRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_RPC_HANDLER_UNBOUND')
  const rpcExtraDispatchRoot = await fixtureRoot('semantic-rpc-extra-dispatch')
  await put(rpcExtraDispatchRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    class Boundary { receive(req: IncomingMessage): void { if (req.method !== 'POST') return } }
    function wrong(_req: IncomingMessage): void {}
    export function mount(server: TransportPort, boundary: Boundary): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: req => {
        const alias = req
        boundary.receive(req)
        wrong(alias)
      } })
      void readCapabilities
    }
  `)
  expectCode(await extractSourceFacts(rpcExtraDispatchRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_RPC_HANDLER_UNBOUND')
  const rpcNestedArgumentCallRoot = await fixtureRoot('semantic-rpc-nested-argument-call')
  await put(rpcNestedArgumentCallRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    class Boundary { receive(req: IncomingMessage, _nested: unknown): void { if (req.method !== 'POST') return } }
    function wrong(_req: IncomingMessage): unknown { return undefined }
    export function mount(server: TransportPort, boundary: Boundary): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: req => boundary.receive(req, wrong(req)) })
      void readCapabilities
    }
  `)
  expectCode(await extractSourceFacts(rpcNestedArgumentCallRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_RPC_HANDLER_UNBOUND')
  const rpcNestedAliasCallRoot = await fixtureRoot('semantic-rpc-nested-alias-call')
  await put(rpcNestedAliasCallRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    class Boundary { receive(req: IncomingMessage, _nested: unknown): void { if (req.method !== 'POST') return } }
    function wrong(_req: IncomingMessage): unknown { return undefined }
    export function mount(server: TransportPort, boundary: Boundary): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: req => {
        const alias = req
        return boundary.receive(alias, wrong(alias))
      } })
      void readCapabilities
    }
  `)
  expectCode(await extractSourceFacts(rpcNestedAliasCallRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_RPC_HANDLER_UNBOUND')
  const rpcNestedAliasRoot = await fixtureRoot('semantic-rpc-nested-alias')
  await put(rpcNestedAliasRoot, 'src/rpc/read-rpc.ts', `
    import type { IncomingMessage } from 'node:http'
    export const endpointValue = '/fixture/v1' as const
    export type OperationSet = 'capabilities'
    export type PageDimension = 'tasks'
    export interface CapabilitiesRequest { readonly method: 'capabilities' }
    export interface PageRequest { readonly method: 'capabilities'; readonly page: { readonly kind: PageDimension } }
    const readCapabilities = [{ capability: 'snapshot.read', state: 'available' }]
    interface TransportPort { expose(value: { kind: string; path: string; handler(req: IncomingMessage): void }): () => void }
    class Boundary { receive(req: IncomingMessage): void { if (req.method !== 'POST') return } }
    export function mount(server: TransportPort, boundary: Boundary): void {
      server.expose({ kind: 'exact', path: endpointValue, handler: req => {
        { const alias = req; return boundary.receive(alias) }
      } })
      void readCapabilities
    }
  `)
  expectCode(await extractSourceFacts(rpcNestedAliasRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_RPC_HANDLER_UNBOUND')

  const clientPositiveRoot = await fixtureRoot('semantic-client-positive')
  await put(clientPositiveRoot, 'src/client/plugin-entry.ts', "export * from './team-plugin.js'\n")
  await put(clientPositiveRoot, 'src/client/team-plugin.ts', `
    import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
    import type { SettingsScope, SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
    export const scopeIdentity = 'fixture-settings'
    export type FieldChoices = 'enabled' | 'provider'
    export interface SettingsPayload { readonly enabled: boolean; readonly provider: string }
    export interface SettingsPayloadState { readonly available: boolean; readonly face: 'card' | 'dialog' }
    class SettingsController { constructor(readonly scope: SettingsScope<SettingsPayload>) {} }
    export const inject = ['sessions', 'slots']
    export function apply(ctx: ClientContext, settings: SettingsScopeBinder): void {
      const { slots: portal } = ctx
      const { bind: bindSettings } = settings
      new SettingsController(bindSettings({ namespace: scopeIdentity }))
      portal.inject('details', () => portal.register({ name: 'details', id: 'fixture' }, {}))
    }
  `)
  await put(clientPositiveRoot, 'src/client/name-decoy.ts', `
    export const PERFECT_SETTINGS_NAMESPACE = 'decoy'
    export type OtherSettingsField = 'decoy'
    export interface OtherSettingsDocument { readonly decoy: boolean }
  `)
  const clientPositive = await extractSourceFacts(clientPositiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(clientPositive), [])
  assert.deepEqual(clientPositive.client.injections[0].services, ['sessions', 'slots'])
  assert.ok(clientPositive.client.slots.some(item => item.operation === 'register' && item.name === 'details'))
  assert.deepEqual(clientPositive.client.settingsBindings.map(item => item.namespace), ['fixture-settings'])
  assert.deepEqual(clientPositive.client.settingsNamespaces.map(item => item.symbol), ['scopeIdentity'])
  assert.deepEqual(clientPositive.client.settingsFields.map(item => item.symbol), ['FieldChoices'])
  assert.deepEqual(clientPositive.client.settingsDocuments.map(item => item.symbol), ['SettingsPayload'])
  assert.equal(clientPositive.client.settingsDocuments.some(item => item.symbol === 'SettingsPayloadState'), false)
  const clientFakeBoxRoot = await fixtureRoot('semantic-client-settings-fake-box')
  await put(clientFakeBoxRoot, 'src/client/plugin-entry.ts', "export * from './team-plugin.js'\n")
  await put(clientFakeBoxRoot, 'src/client/team-plugin.ts', `
    import type { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
    export const scopeIdentity = 'fixture-settings'
    export interface UiState { readonly visible: boolean }
    interface FakeBox<T> { readonly value: T }
    class Controller { constructor(readonly scope: FakeBox<UiState>) {} }
    export function apply(settings: SettingsScopeBinder): void { new Controller(settings.bind({ namespace: scopeIdentity })) }
  `)
  expectCode(await extractSourceFacts(clientFakeBoxRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_CLIENT_SETTINGS_BINDING_UNCLOSED')
  const clientMultiGenericRoot = await fixtureRoot('semantic-client-settings-multi-generic')
  await put(clientMultiGenericRoot, 'src/client/plugin-entry.ts', "export * from './team-plugin.js'\n")
  await put(clientMultiGenericRoot, 'src/client/team-plugin.ts', `
    import type { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
    export const scopeIdentity = 'fixture-settings'
    export interface SettingsPayload { readonly enabled: boolean }
    export interface UiState { readonly visible: boolean }
    interface MultiScope<TDocument, TUi> { readonly document: TDocument; readonly ui: TUi }
    class Controller { constructor(readonly scope: MultiScope<SettingsPayload, UiState>) {} }
    export function apply(settings: SettingsScopeBinder): void { new Controller(settings.bind({ namespace: scopeIdentity })) }
  `)
  expectCode(await extractSourceFacts(clientMultiGenericRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_CLIENT_SETTINGS_BINDING_UNCLOSED')
  const clientNegativeRoot = await fixtureRoot('semantic-client-negative')
  await put(clientNegativeRoot, 'src/client/plugin-entry.ts', "export * from './team-plugin.js'\n")
  await put(clientNegativeRoot, 'src/client/team-plugin.ts', `
    import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
    const resolveSlot = (): string => 'details'
    export const inject = ['slots']
    export function apply(ctx: ClientContext): void { ctx.slots.inject(resolveSlot(), () => undefined) }
  `)
  expectCode(await extractSourceFacts(clientNegativeRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_CLIENT_SLOT_DYNAMIC')
  const clientDecoyRoot = await fixtureRoot('semantic-client-local-decoy')
  await put(clientDecoyRoot, 'src/client/plugin-entry.ts', "export * from './team-plugin.js'\n")
  await put(clientDecoyRoot, 'src/client/team-plugin.ts', `
    interface FakeSlots { inject(name: string, callback: () => unknown): void }
    export function apply(slots: FakeSlots): void { slots.inject('details', () => undefined) }
  `)
  expectCode(await extractSourceFacts(clientDecoyRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_CLIENT_SLOT_WRONG_ORIGIN')

  const eventsPositiveRoot = await fixtureRoot('semantic-events-positive')
  const eventsPositiveSource = `
    import type { Context } from '@deepseek-ai/cordis'
    export function apply(ctx: Context, target: EventTarget): void {
      const { effect: scope, on: listen } = ctx
      scope(() => listen('ready', () => undefined))
      const onDone = (): void => undefined
      target.addEventListener('done', onDone)
      target.removeEventListener('done', onDone)
    }
  `
  await put(eventsPositiveRoot, 'src/lifecycle.ts', eventsPositiveSource)
  const eventsPositive = await extractSourceFacts(eventsPositiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(eventsPositive), [])
  assert.ok(eventsPositive.lifecycle.listeners.some(item => item.event === 'ready' && item.disposerOwner === 'ctx.effect'))
  const fixtureListenerTuples = facts => facts.lifecycle.listeners.map(item => `listener|${JSON.stringify(semanticFact(item))}`)
  const fixtureListenerDigest = tupleDigest(fixtureListenerTuples(eventsPositive))
  await put(eventsPositiveRoot, 'src/lifecycle.ts', eventsPositiveSource
    .replace("const onDone = (): void => undefined", "const onDecoy = (): void => undefined")
    .replaceAll("'done', onDone", "'decoy', onDecoy"))
  const eventsCompensated = await extractSourceFacts(eventsPositiveRoot, { expectedToolCount: 2 })
  assert.equal(eventsCompensated.lifecycle.listeners.length, eventsPositive.lifecycle.listeners.length, 'replacement listener keeps the misleading count stable')
  assert.throws(() => assertTupleSetDigest(fixtureListenerTuples(eventsCompensated), fixtureListenerDigest, 'compensating listener decoy'), /KG_EXTRACT_DRIFT_LOCK/u)
  const eventsNegativeRoot = await fixtureRoot('semantic-events-negative')
  await put(eventsNegativeRoot, 'src/lifecycle.ts', `
    import type { Context } from '@deepseek-ai/cordis'
    export function apply(ctx: Context, eventName: string): void { ctx.on(eventName, () => undefined) }
  `)
  expectCode(await extractSourceFacts(eventsNegativeRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_EVENT_NAME_DYNAMIC')
  const eventsDecoyRoot = await fixtureRoot('semantic-events-local-decoy')
  await put(eventsDecoyRoot, 'src/lifecycle.ts', `
    class FakeContext { on(_name: string, _callback: () => unknown): void {}; effect(callback: () => unknown): void { callback() } }
    export function apply(ctx: FakeContext): void { ctx.effect(() => ctx.on('ready', () => undefined)) }
  `)
  const eventsDecoy = await extractSourceFacts(eventsDecoyRoot, { expectedToolCount: 2 })
  expectCode(eventsDecoy, 'KG_EXTRACT_EFFECT_WRONG_ORIGIN')
  assert.ok(eventsDecoy.lifecycle.listeners.some(item => item.authority === 'local-symbol'), 'local listener remains an explicitly-originated fact, never a Cordis fact')

  const exportPositiveRoot = await fixtureRoot('semantic-export-positive')
  await put(exportPositiveRoot, 'src/exported-class.ts', 'export class Both { readonly value = 1 }\n')
  await put(exportPositiveRoot, 'src/transitive.ts', "export { value as transitiveValue } from './value.js'\n")
  await put(exportPositiveRoot, 'src/export-layer.ts', `
    export type { Both as BothType } from './exported-class.js'
    export { Both as BothValue } from './exported-class.js'
    export * as ValueNamespace from './value.js'
    export * from './transitive.js'
  `)
  await put(exportPositiveRoot, 'src/public-api.ts', "export * from './export-layer.js'\n")
  const exportPositive = await extractSourceFacts(exportPositiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(exportPositive), [])
  assert.deepEqual(exportPositive.reachablePublicApiExports.map(item => item.name), ['BothType', 'BothValue', 'ValueNamespace', 'transitiveValue'])
  assert.ok(exportPositive.reexportLayers.some(item => item.file === 'src/export-layer.ts' && item.kind === 'namespace' && item.names[0].exported === 'ValueNamespace'))
  assert.ok(exportPositive.reexportLayers.some(item => item.file === 'src/export-layer.ts' && item.kind === 'named' && item.names.some(name => name.exported === 'BothType' && name.typeOnly)))
  assert.ok(exportPositive.reexportLayers.some(item => item.file === 'src/public-api.ts' && item.kind === 'star' && item.resolvedModule === 'src/export-layer.ts'))
  assert.deepEqual(exportPositive.reachablePublicApiExports.find(item => item.name === 'BothType')?.spaces, ['type'])
  assert.deepEqual(exportPositive.reachablePublicApiExports.find(item => item.name === 'BothValue')?.spaces, ['type', 'value'])
  assert.deepEqual(exportPositive.reachablePublicApiExports.find(item => item.name === 'ValueNamespace')?.spaces, ['value', 'namespace'])
  const exportTypeStarRoot = await fixtureRoot('semantic-export-type-star')
  await put(exportTypeStarRoot, 'src/type-star-leaf.ts', `
    export interface Shape { readonly value: number }
    export class Both { readonly value = 1 }
    export const valueOnly = 1
  `)
  await put(exportTypeStarRoot, 'src/type-star-direct.ts', "export type * from './type-star-leaf.js'\n")
  await put(exportTypeStarRoot, 'src/type-star-transitive.ts', "export * from './type-star-direct.js'\n")
  await put(exportTypeStarRoot, 'src/public-api.ts', "export * from './type-star-transitive.js'\n")
  const exportTypeStar = await extractSourceFacts(exportTypeStarRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(exportTypeStar), [])
  assert.deepEqual(exportTypeStar.reachablePublicApiExports.map(item => [item.name, item.spaces]), [
    ['Both', ['type']], ['Shape', ['type']],
  ])
  const directTypeStar = exportTypeStar.reexportLayers.find(item => item.file === 'src/type-star-direct.ts')
  const transitiveTypeStar = exportTypeStar.reexportLayers.find(item => item.file === 'src/type-star-transitive.ts')
  assert.deepEqual(directTypeStar.effectiveExports.find(item => item.name === 'Both')?.spaces, ['type'])
  assert.deepEqual(directTypeStar.effectiveExports.find(item => item.name === 'valueOnly')?.spaces, [])
  assert.deepEqual(transitiveTypeStar.effectiveExports.find(item => item.name === 'Both')?.spaces, ['type'])
  const exportTypeStarShadowRoot = await fixtureRoot('semantic-export-type-star-shadow')
  await put(exportTypeStarShadowRoot, 'src/type-star-a.ts', 'export const x = 1\n')
  await put(exportTypeStarShadowRoot, 'src/type-star-b.ts', 'export const x = 2\n')
  await put(exportTypeStarShadowRoot, 'src/type-star-middle.ts', `
    export type * from './type-star-a.js'
    export * from './type-star-b.js'
  `)
  await put(exportTypeStarShadowRoot, 'src/public-api.ts', "export * from './type-star-middle.js'\n")
  const exportTypeStarShadow = await extractSourceFacts(exportTypeStarShadowRoot, { expectedToolCount: 2 })
  expectCode(exportTypeStarShadow, 'KG_EXTRACT_EXPORT_AMBIGUOUS')
  const shadowTypeLayer = exportTypeStarShadow.reexportLayers.find(item => item.file === 'src/type-star-middle.ts' && item.declarationTypeOnly)
  assert.deepEqual(shadowTypeLayer.effectiveExports.find(item => item.name === 'x')?.spaces, [])
  const exportNegativeRoot = await fixtureRoot('semantic-export-negative')
  await put(exportNegativeRoot, 'src/public-api.ts', "export { missing } from './value.js'\n")
  expectCode(await extractSourceFacts(exportNegativeRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_EXPORT_ALIAS_UNRESOLVED')
  const exportUnresolvedRoot = await fixtureRoot('semantic-export-unresolved')
  await put(exportUnresolvedRoot, 'src/public-api.ts', "export * from './absent.js'\n")
  expectCode(await extractSourceFacts(exportUnresolvedRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_EXPORT_MODULE_UNRESOLVED')
  const exportTypeOnlyRoot = await fixtureRoot('semantic-export-type-only-violation')
  await put(exportTypeOnlyRoot, 'src/exported-class.ts', 'export class Both {}\n')
  await put(exportTypeOnlyRoot, 'src/public-api.ts', "export type { Both } from './exported-class.js'\n")
  await put(exportTypeOnlyRoot, 'src/consumer.ts', "import { Both } from './public-api.js'\nexport const invalid = new Both()\n")
  expectCode(await extractSourceFacts(exportTypeOnlyRoot, { expectedToolCount: 2 }), 'KG_EXTRACT_EXPORT_TYPE_ONLY_VIOLATION')
  const exportCompensationRoot = await fixtureRoot('semantic-export-compensation')
  const exportCompensationBefore = await extractSourceFacts(exportCompensationRoot, { expectedToolCount: 2 })
  const compensationTuples = facts => facts.reachablePublicApiExports.map(item => [item.name, item.alias, item.targetName, item.spaces.join(','), item.declarations.join(',')].join('|'))
  const compensationLayerTuples = facts => facts.reexportLayers.map(item => [
    item.file, item.order, item.kind, item.declarationTypeOnly, item.moduleSpecifier, item.resolvedModule,
    JSON.stringify(item.names), JSON.stringify(item.effectiveExports),
  ].join('|'))
  const compensationDigest = tupleDigest(compensationTuples(exportCompensationBefore))
  const compensationLayerDigest = tupleDigest(compensationLayerTuples(exportCompensationBefore))
  await put(exportCompensationRoot, 'src/decoy.ts', 'export interface Shape { readonly decoy: true }\n')
  await put(exportCompensationRoot, 'src/public-api.ts', "export { value } from './value.js'\nexport type { Shape } from './decoy.js'\n")
  const exportCompensationAfter = await extractSourceFacts(exportCompensationRoot, { expectedToolCount: 2 })
  assert.equal(exportCompensationAfter.reachablePublicApiExports.length, exportCompensationBefore.reachablePublicApiExports.length, 'decoy keeps the misleading count stable')
  assert.throws(() => assertTupleSetDigest(compensationTuples(exportCompensationAfter), compensationDigest, 'compensating export decoy'), /KG_EXTRACT_DRIFT_LOCK/u)
  assert.equal(exportCompensationAfter.reexportLayers.length, exportCompensationBefore.reexportLayers.length, 'replacement re-export keeps the layer count stable')
  assert.throws(() => assertTupleSetDigest(compensationLayerTuples(exportCompensationAfter), compensationLayerDigest, 'compensating re-export layer decoy'), /KG_EXTRACT_DRIFT_LOCK/u)

  const pathDiagnostics = diagnoseSourcePathIdentities([
    'src/Case.ts',
    'src/case.ts',
    'src/caf\u00e9.ts',
    'src/cafe\u0301.ts',
  ])
  assert.ok(pathDiagnostics.some(item => item.code === 'KG_EXTRACT_PATH_CASE_COLLISION'))
  assert.ok(pathDiagnostics.some(item => item.code === 'KG_EXTRACT_PATH_NON_NFC'))

  const twice = await extractSourceFacts(positiveRoot, { expectedToolCount: 2 })
  assert.equal(JSON.stringify(positive), JSON.stringify(twice), 'extractor output must be byte-stable for an unchanged tree')

  process.stdout.write(`knowledge-graph extractor tests: PASS (actual modules=${actual.counts.discoveredModules}, tools=${actual.counts.tools}; controlled-symlink-skips=${controlledSkips.length === 0 ? 'none' : controlledSkips.join(',')})\n`)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

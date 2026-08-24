import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
    import './styles.css'
    export const inject = ['requiredService'] as const
    export function apply(ctx: any): void {
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
    discoveredModules: 99,
    parsedModules: 99,
    toolDefinitions: 19,
    tools: 19,
    imports: 531,
    injections: 29,
    providerRegistrations: 4,
    providerRegistryMethods: 7,
    packageExports: 6,
    publicApiExportDeclarations: 48,
  }, 'KG1 walking-skeleton drift lock; replace with graph reconciliation in a later milestone')
  assert.equal(actual.counts.tools, 19)
  assert.equal(actual.counts.toolDefinitions, 19)
  assert.equal(actual.counts.discoveredModules, actual.counts.parsedModules)
  assert.equal(actual.modules.length, actual.counts.discoveredModules)
  const { stdout: rgFiles } = await execFileAsync('rg', ['--files', 'src'], { cwd: repositoryRoot })
  const rgModuleCount = rgFiles.split(/\r?\n/u).filter(path => /\.(?:ts|tsx)$/u.test(path)).length
  assert.equal(actual.counts.discoveredModules, rgModuleCount, 'extractor module inventory must equal rg --files src')
  assert.deepEqual(actual.tools.map(item => item.name).sort(), [...actual.permissionPolicy.names].sort())
  assert.deepEqual(actual.tools.map(item => item.registrationOrder), Array.from({ length: 19 }, (_, index) => index + 1))
  assert.deepEqual(actual.tools.map(item => item.name), [
    'agent_swarm_create',
    'agent_swarm_add_member',
    'agent_swarm_create_task',
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
  assert.deepEqual(injectionServices('ctx-provide'), ['agentSwarmHostRead', 'agentSwarmHumanControl', 'agentSwarmHumanInteraction', 'agentSwarmPermission', 'agentSwarmProducerFloor', 'agentSwarmReadRpc'])
  assert.deepEqual(injectionServices('ctx-get'), ['agentSwarmHostRead', 'approval', 'layout', 'llm', 'sessions', 'skills', 'userQuestions', 'userQuestions', 'webServer'])
  assert.deepEqual(actual.providerRegistrations.map(item => `${item.file}|${item.methodSymbol}|${item.providerName}`).sort(), [
    'src/index.ts|registerReviewProvider|human',
    'src/index.ts|registerReviewProvider|reviewer-agent',
    'src/runtime/execution-root-surface.ts|registerProvider|null',
    'src/runtime/orchestrator-runtime.ts|registerProvider|null',
  ])
  assert.deepEqual(actual.providerRegistryMethods.map(item => `${item.file}|${item.methodSymbol}`).sort(), [
    'src/runtime/execution-root-surface.ts|registerProvider',
    'src/runtime/execution-roots.ts|registerProvider',
    'src/runtime/orchestrator-runtime.ts|registerExecutionRootProvider',
    'src/runtime/orchestrator-runtime.ts|registerReviewProvider',
    'src/runtime/orchestrator-runtime.ts|registerReviewRootProvider',
    'src/runtime/orchestrator-runtime.ts|registerSchedulerProvider',
    'src/runtime/permission-surface.ts|registerReviewerAgentProvider',
  ])
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
  assert.deepEqual(noticeCodes(actual), ['KG_EXTRACT_DYNAMIC_PROVIDER_NAME', 'KG_EXTRACT_DYNAMIC_PROVIDER_NAME'])

  const positiveRoot = await fixtureRoot('positive')
  const positive = await extractSourceFacts(positiveRoot, { expectedToolCount: 2 })
  assert.deepEqual(errorCodes(positive), [])
  assert.deepEqual(positive.tools.map(item => item.name), ['agent_swarm_one', 'agent_swarm_two'])
  assert.equal(positive.modules.find(item => item.path === 'src/index.ts').imports[0].kind, 'asset')

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
    const dynamicImport = './value.js'
    const dynamicService = 'optionalService'
    const dynamicProvider = 'fixture-provider'
    export function apply(ctx: any, runtime: any): void {
      void import(dynamicImport)
      ctx.get(dynamicService)
      runtime.registerReviewProvider(dynamicProvider, {})
    }
  `)
  const dynamicNotices = await extractSourceFacts(dynamicNoticesRoot, { expectedToolCount: 2 })
  assert.ok(noticeCodes(dynamicNotices).includes('KG_EXTRACT_DYNAMIC_IMPORT'))
  assert.ok(noticeCodes(dynamicNotices).includes('KG_EXTRACT_DYNAMIC_SERVICE_NAME'))
  assert.ok(noticeCodes(dynamicNotices).includes('KG_EXTRACT_DYNAMIC_PROVIDER_NAME'))

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

  const twentyTools = Array.from({ length: 20 }, (_, index) => [
    `registerTool${String(index + 1).padStart(2, '0')}Tool`,
    `'agent_swarm_tool_${String(index + 1).padStart(2, '0')}'`,
  ])
  const twentyRoot = await fixtureRoot('twenty-tools', { tools: twentyTools })
  const twenty = await extractSourceFacts(twentyRoot)
  assert.equal(twenty.counts.tools, 20)
  expectCode(twenty, 'KG_EXTRACT_TOOL_COUNT')

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

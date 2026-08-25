import { fail } from './diagnostics.mjs'
import { taggedSha256 } from './canonical.mjs'
import { posix } from 'node:path'

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0

function idPart(value) {
  const normalized = String(value).normalize('NFC').toLowerCase()
    .replaceAll(/[^a-z0-9._/-]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/(?:^|\/)\.+(?=\/|$)/gu, '-')
    .replaceAll(/^-|-$/gu, '')
  if (normalized === '') fail('KG_RECONCILE_ID', `cannot derive a stable id from ${JSON.stringify(value)}`)
  return normalized
}

const sourceAuthority = { id: 'authority:source-tree', kind: 'authority' }

function maturity(availability, conditions = [], blockers = []) {
  return {
    implementation: { state: 'implemented', evidence: [] },
    verification: { state: 'none', evidence: [] },
    acceptance: { state: 'not-candidate' },
    availability: { state: availability, conditions, blockers },
  }
}

function node(id, kind, title, anchor, options = {}) {
  return {
    id, kind, classification: 'mechanical', factAuthority: sourceAuthority, title,
    anchors: options.anchors ?? [anchor],
    config: { gates: [], defaultState: options.defaultState ?? 'not-applicable', blockerCodes: [] },
    inject: { required: [], optional: [], provides: [] },
    lifecycle: options.lifecycle ?? {},
    maturity: options.maturity ?? maturity('unavailable', ['mechanical source inventory only'], ['runtime availability is not asserted by KG1-C']),
    security: {
      callerIdentity: 'unclassified', mutation: 'unclassified', dataClasses: ['unclassified'], guards: [], redlines: [],
    },
    bounds: options.bounds ?? [], tags: options.tags ?? ['inventory'],
  }
}

function edge(id, type, from, to, anchor, contract) {
  return { id, type, classification: 'mechanical', from, to, anchors: [anchor], ...(contract === undefined ? {} : { contract }) }
}

function duplicateIds(items) {
  const seen = new Set()
  const duplicates = new Set()
  for (const item of items) seen.has(item.id) ? duplicates.add(item.id) : seen.add(item.id)
  return [...duplicates].sort(compareText)
}

function failSourceIdCollisions(nodes, edges, extraNodeIds = []) {
  const nodeIds = [...new Set([...duplicateIds(nodes), ...extraNodeIds])].sort(compareText)
  const edgeIds = duplicateIds(edges)
  if (nodeIds.length > 0 || edgeIds.length > 0) {
    fail('KG_RECONCILE_SOURCE_ID_COLLISION', 'source facts collapse to duplicate stable ids', { nodeIds, edgeIds })
  }
}

function moduleNodeId(path) {
  return `module:${idPart(path)}`
}

function moduleRef(path) {
  return { id: moduleNodeId(path), kind: 'module' }
}

function surfacePart(value) {
  if (value === '.') return 'root'
  return idPart(String(value).replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, ''))
}

function methodPart(item) {
  return `${idPart(item.file)}/${idPart(item.containingSymbol)}/${idPart(item.method ?? item.methodSymbol)}`
}

function semanticValue(value) {
  if (Array.isArray(value)) return value.map(semanticValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'anchor' && key !== 'line' && key !== 'column' && !key.endsWith('Identity'))
    .map(([key, entry]) => [key, semanticValue(entry)]))
}

function semanticSelector(selector, value) {
  return `${selector}-${taggedSha256('dsh-agent-swarm/kg1-source-fact/v1', semanticValue(value)).slice(0, 16)}`
}

function canonicalIdentity(value) {
  return taggedSha256('dsh-agent-swarm/kg1-source-identity/v1', semanticValue(value))
}

function sourceAnchor(item, selector, symbol = item.symbol ?? item.method ?? item.methodSymbol ?? item.containingSymbol) {
  return { file: item.file, ...(symbol === undefined || symbol === '<module>' ? {} : { symbol }), selector: semanticSelector(selector, item) }
}

function domainForFile(file) {
  if (file.includes('/human/')) return { id: 'domain:agent-swarm-human', kind: 'domain' }
  if (file.includes('workflow')) return { id: 'domain:agent-swarm-workflow', kind: 'domain' }
  return { id: 'domain:agent-swarm', kind: 'domain' }
}

function externalPackageRoot(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function sourceImportTarget(from, specifier, modulePaths) {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier))
  const extension = posix.extname(joined)
  const candidates = ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
    ? [`${joined.slice(0, -extension.length)}.ts`, `${joined.slice(0, -extension.length)}.tsx`]
    : extension === '' ? [`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`] : [joined]
  return candidates.find(candidate => modulePaths.has(candidate))
}

function assetImportTarget(from, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier))
  if (target === '..' || target.startsWith('../') || posix.isAbsolute(target)) fail('KG_RECONCILE_IMPORT_TARGET', `asset import escapes the repository source root: ${from} -> ${specifier}`)
  return target
}

function constraintKind(key) {
  if (/ms$/iu.test(key)) return 'time-ms'
  if (/bytes?/iu.test(key)) return 'bytes'
  if (/depth/iu.test(key)) return 'depth'
  if (/revision/iu.test(key)) return 'revision'
  if (/retained/iu.test(key)) return 'retention'
  return 'items'
}

export function buildMechanicalInventory(facts) {
  const nodes = []
  const edges = []
  const normalizedNodeIdentities = new Map()
  const normalizedNodeCollisions = new Set()
  const reserveNormalizedNode = (id, identity) => {
    const normalized = canonicalIdentity(identity)
    const previous = normalizedNodeIdentities.get(id)
    if (previous !== undefined && previous !== normalized) normalizedNodeCollisions.add(id)
    else normalizedNodeIdentities.set(id, normalized)
  }
  nodes.push({
    ...node(sourceAuthority.id, sourceAuthority.kind, 'Repository source-tree authority', { file: 'package.json', selector: 'source-tree-authority' }, {
      maturity: maturity('package-exported', ['repository package source'], []),
      tags: ['authority', 'inventory'],
    }),
    security: { callerIdentity: 'unclassified', mutation: 'unclassified', dataClasses: ['unclassified'], guards: [], redlines: [] },
  })
  const packageRef = { id: 'package:dsh-agent-swarm', kind: 'package' }
  nodes.push(node(packageRef.id, packageRef.kind, 'dsh-agent-swarm package', { file: 'package.json', selector: 'package-identity' }, {
    maturity: maturity('package-exported', ['package.json exports'], []), tags: ['inventory', 'package'],
  }))
  const permissionRef = { id: 'public-capability:permission-policy/model-tools', kind: 'public-capability' }
  nodes.push(node(permissionRef.id, permissionRef.kind, 'Model-tool permission-policy inventory', {
    file: facts.permissionPolicy.file, symbol: 'PLUGIN_TOOL_NAMES', selector: 'permission-policy-tool-set',
  }, { maturity: maturity('always-registered', ['permission policy is statically declared'], []), tags: ['inventory', 'permission-policy'] }))
  edges.push(edge('edge:module-permission-policy/model-tools', 'contains', moduleRef(facts.permissionPolicy.file), permissionRef, {
    file: facts.permissionPolicy.file, symbol: 'PLUGIN_TOOL_NAMES', selector: 'permission-policy-tool-set',
  }))

  for (const item of facts.modules) {
    const ref = moduleRef(item.path)
    nodes.push(node(ref.id, ref.kind, item.path, { file: item.path, selector: 'source-module' }, { tags: ['inventory', 'module'] }))
    edges.push(edge(`edge:package-module/${idPart(item.path)}`, 'contains', packageRef, ref, { file: item.path, selector: 'source-module-containment' }))
  }
  const modulePaths = new Set(facts.modules.map(item => item.path))
  const externalPackages = new Map()
  const assetRefs = new Map()
  const importedAssetPaths = new Set()
  for (const item of facts.modules) {
    for (const imported of item.imports) {
      let target
      if (imported.kind === 'source') {
        const targetPath = sourceImportTarget(item.path, imported.specifier, modulePaths)
        if (targetPath === undefined) fail('KG_RECONCILE_IMPORT_TARGET', `source import does not resolve to an inventoried module: ${item.path} -> ${imported.specifier}`)
        target = moduleRef(targetPath)
      } else if (imported.kind === 'external') {
        const packageRoot = externalPackageRoot(imported.specifier)
        const id = `package:external/${idPart(packageRoot)}`
        reserveNormalizedNode(id, { family: 'external-package', packageRoot })
        target = externalPackages.get(id)
        if (target === undefined) {
          target = { id, kind: 'package' }
          externalPackages.set(id, target)
          nodes.push(node(id, 'package', `External package ${packageRoot}`, {
            file: item.path, selector: semanticSelector(`external-package-${idPart(packageRoot)}`, { packageRoot }),
          }, { tags: ['dependency', 'external-package', 'inventory'] }))
        }
      } else if (imported.kind === 'asset') {
        const assetPath = assetImportTarget(item.path, imported.specifier)
        importedAssetPaths.add(assetPath)
        const id = `artifact:source-resource/${idPart(assetPath)}`
        reserveNormalizedNode(id, { family: 'source-resource', assetPath })
        target = assetRefs.get(id)
        if (target === undefined) {
          target = { id, kind: 'artifact' }
          assetRefs.set(id, target)
          nodes.push(node(id, 'artifact', `Imported source resource ${assetPath}`, {
            file: item.path, selector: semanticSelector(`source-resource-${idPart(assetPath)}`, { assetPath }),
          }, { tags: ['artifact', 'dependency', 'inventory', 'source-resource'] }))
        }
      } else {
        fail('KG_RECONCILE_IMPORT_KIND', `unknown import kind ${JSON.stringify(imported.kind)} in ${item.path}`)
      }
      edges.push(edge(`edge:import/${idPart(item.path)}/${String(imported.order).padStart(3, '0')}`, 'imports', moduleRef(item.path), target, {
        file: item.path,
        selector: semanticSelector(`import-${String(imported.order).padStart(3, '0')}`, { from: item.path, target, imported }),
      }, imported.typeOnly ? 'read-only' : 'required'))
    }
  }
  for (const tool of facts.tools) {
    const toolRef = { id: `tool:${idPart(tool.name)}`, kind: 'model-tool' }
    nodes.push(node(toolRef.id, toolRef.kind, tool.name, {
      file: tool.file, symbol: tool.registrationFunction, selector: semanticSelector(`define-tool:${tool.name}`, tool),
    }, {
      maturity: maturity('always-registered', ['registerAgentSwarmTools static registration'], []),
      lifecycle: { registrationOwner: 'module:src/tools.ts' }, tags: ['inventory', 'model-tool'],
    }))
    const owner = moduleRef(tool.file)
    edges.push(edge(`edge:module-tool/${idPart(tool.file)}/${idPart(tool.name)}`, 'contains', owner, toolRef, {
      file: tool.file, symbol: tool.registrationFunction, selector: semanticSelector(`define-tool:${tool.name}`, tool),
    }))
    edges.push(edge(`edge:tool-permission/${idPart(tool.name)}`, 'registers', moduleRef(facts.permissionPolicy.file), toolRef, {
      file: facts.permissionPolicy.file, symbol: 'PLUGIN_TOOL_NAMES', selector: `permission-tool:${tool.name}`,
    }))
  }
  for (const registration of facts.toolRegistrationOrder) {
    const tool = facts.tools.find(candidate => candidate.name === registration.toolName)
    if (tool === undefined) fail('KG_RECONCILE_TOOL_REGISTRATION', `registration has no extracted tool ${registration.toolName}`)
    const order = String(registration.registrationOrder).padStart(2, '0')
    edges.push(edge(`edge:tool-registration/${order}-${idPart(registration.toolName)}`, 'registers', moduleRef('src/tools.ts'), { id: `tool:${idPart(registration.toolName)}`, kind: 'model-tool' }, {
      file: 'src/tools.ts', symbol: 'registerAgentSwarmTools', selector: semanticSelector(`registration-order-${order}`, registration),
    }))
  }

  const entrypoints = new Map()
  for (const item of facts.packageExports) {
    const part = surfacePart(item.subpath)
    const ref = { id: `entrypoint:package/${part}`, kind: 'entrypoint' }
    reserveNormalizedNode(ref.id, { family: 'package-entrypoint', subpath: item.subpath })
    if (!entrypoints.has(ref.id)) {
      nodes.push(node(ref.id, ref.kind, `Package export ${item.subpath}`, {
        file: 'package.json', exportName: item.subpath, selector: semanticSelector(`package-export-${part}`, item),
      }, { maturity: maturity('package-exported', [`package export ${item.subpath}`], []), tags: ['entrypoint', 'inventory'] }))
      entrypoints.set(ref.id, ref)
      edges.push(edge(`edge:package-entrypoint/${part}`, 'contains', packageRef, ref, { file: 'package.json', selector: `package-entrypoint-${part}` }))
    }
    edges.push(edge(`edge:package-export/${part}/${idPart(item.condition)}`, 'exports', packageRef, ref, {
      file: 'package.json', exportName: item.subpath, selector: semanticSelector(`condition-${idPart(item.condition)}-target-${idPart(item.target)}`, item),
    }))
    if (item.kind === 'resource') {
      const resource = { id: `artifact:package-resource/${surfacePart(item.target)}`, kind: 'artifact' }
      nodes.push(node(resource.id, resource.kind, `Package resource ${item.target}`, {
        file: 'package.json', exportName: item.subpath, selector: semanticSelector(`package-resource-${surfacePart(item.target)}`, item),
      }, { maturity: maturity('package-exported', [`package resource ${item.target}`], []), tags: ['artifact', 'inventory', 'package-resource'] }))
      edges.push(edge(`edge:package-resource/${part}`, 'exports', ref, resource, {
        file: 'package.json', exportName: item.subpath, selector: semanticSelector(`package-resource-${surfacePart(item.target)}`, item),
      }))
    }
  }
  const publicApiEntrypoint = { id: 'entrypoint:source/public-api', kind: 'entrypoint' }
  nodes.push(node(publicApiEntrypoint.id, publicApiEntrypoint.kind, 'Source public API', { file: 'src/public-api.ts', selector: 'source-public-api' }, {
    maturity: maturity('package-exported', ['reachable from package root'], []), tags: ['entrypoint', 'inventory'],
  }))
  edges.push(edge('edge:package-entrypoint/source-public-api', 'contains', packageRef, publicApiEntrypoint, { file: 'src/public-api.ts', selector: 'source-public-api' }))

  const injectionFacts = new Map()
  for (const item of facts.injections) {
    const list = injectionFacts.get(item.service) ?? []
    list.push(item)
    injectionFacts.set(item.service, list)
  }
  const serviceRefs = new Map()
  for (const [service, items] of [...injectionFacts].sort(([left], [right]) => compareText(left, right))) {
    const ref = { id: `service:${idPart(service)}`, kind: 'service' }
    serviceRefs.set(service, ref)
    nodes.push(node(ref.id, ref.kind, `Service ${service}`, sourceAnchor(items[0], `service-contract-${idPart(service)}`), { tags: ['inventory', 'service'] }))
  }
  facts.injections.forEach((item, index) => {
    const from = moduleRef(item.file)
    const to = serviceRefs.get(item.service)
    if (item.mode === 'provided') {
      const provider = { id: `provider:ctx/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}-${idPart(item.service)}`, kind: 'provider' }
      nodes.push(node(provider.id, provider.kind, `ctx.provide ${item.service}`, sourceAnchor(item, `service-provider-${idPart(item.service)}`), {
        maturity: maturity('always-registered', ['ctx.provide static registration'], []), tags: ['inventory', 'provider'],
      }))
      edges.push(edge(`edge:module-service-provider/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}-${idPart(item.service)}`, 'contains', from, provider,
        sourceAnchor(item, `service-provider-${idPart(item.service)}`)))
      edges.push(edge(`edge:service-provision/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}-${idPart(item.service)}`, 'provides', provider, to,
        sourceAnchor(item, `service-provision-${idPart(item.service)}`)))
      const ownerModule = nodes.find(candidate => candidate.id === from.id)
      if (!ownerModule.inject.provides.includes(to.id)) ownerModule.inject.provides.push(to.id)
      ownerModule.inject.provides.sort(compareText)
    } else {
      const type = item.mode === 'required' ? 'requires-inject' : 'optionally-injects'
      edges.push(edge(`edge:injection/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}-${idPart(item.service)}-${idPart(item.kind)}`, type, from, to,
        sourceAnchor(item, `injection-${idPart(item.kind)}-${idPart(item.service)}`), item.mode === 'optional' ? 'optional' : 'required'))
      const module = nodes.find(candidate => candidate.id === from.id)
      const target = item.mode === 'required' ? module.inject.required : module.inject.optional
      if (!target.includes(to.id)) target.push(to.id)
      target.sort(compareText)
    }
  })
  const clientMetadataInject = facts.packageDshMetadata?.client?.inject ?? []
  for (const service of clientMetadataInject) {
    const ref = { id: `service:${idPart(service)}`, kind: 'service' }
    if (!nodes.some(item => item.id === ref.id)) nodes.push(node(ref.id, ref.kind, `Client package service ${service}`, {
      file: 'package.json', selector: `dsh-client-inject-${idPart(service)}`,
    }, { tags: ['inventory', 'service'] }))
    edges.push(edge(`edge:package-client-inject/${idPart(service)}`, 'requires-inject', packageRef, ref, {
      file: 'package.json', selector: `dsh-client-inject-${idPart(service)}`,
    }, 'required'))
  }

  for (const item of facts.serviceDefinitions) {
    const ref = { id: `service:${idPart(item.serviceName)}`, kind: 'service' }
    serviceRefs.set(item.serviceName, ref)
    nodes.push(node(ref.id, ref.kind, `Service ${item.serviceName}`, sourceAnchor(item, `service-definition-${idPart(item.serviceName)}`, item.classSymbol), {
      maturity: maturity('always-registered', ['Cordis Service definition'], []), tags: ['inventory', 'service'],
    }))
    edges.push(edge(`edge:module-service/${idPart(item.file)}-${idPart(item.serviceName)}`, 'contains', moduleRef(item.file), ref,
      sourceAnchor(item, `service-definition-${idPart(item.serviceName)}`, item.classSymbol)))
  }

  const registryRefs = new Map()
  for (const item of facts.registries) {
    const ref = { id: `provider-registry:${idPart(item.file)}/${idPart(item.containingSymbol)}/${idPart(item.storage)}`, kind: 'provider-registry' }
    registryRefs.set(`${item.file}|${item.containingSymbol}|${item.storage}`, ref)
    nodes.push(node(ref.id, ref.kind, `${item.containingSymbol}.${item.storage}`, sourceAnchor(item, `registry-${idPart(item.storage)}`, item.storage), {
      maturity: maturity('always-registered', [`${item.kind} registry`], []), tags: ['inventory', 'provider-registry'],
    }))
    edges.push(edge(`edge:module-registry/${idPart(item.file)}-${idPart(item.storage)}`, 'contains', moduleRef(item.file), ref, sourceAnchor(item, `registry-${idPart(item.storage)}`, item.storage)))
    item.builtins.forEach((builtin, index) => {
      const provider = { id: `provider:builtin/${idPart(item.file)}/${idPart(item.storage)}/${idPart(builtin.name)}`, kind: 'provider' }
      nodes.push(node(provider.id, provider.kind, `Builtin Provider ${builtin.name}`, sourceAnchor(item, `builtin-${idPart(builtin.name)}`, item.storage), {
        maturity: maturity('always-registered', ['constructor-owned builtin Provider'], []), tags: ['inventory', 'provider'],
      }))
      edges.push(edge(`edge:builtin-provider/${idPart(item.file)}-${idPart(item.storage)}-${String(index + 1).padStart(2, '0')}`, 'provides', provider, ref,
        sourceAnchor(item, `builtin-${idPart(builtin.name)}`, item.storage)))
    })
  }
  const methodRefs = new Map()
  for (const item of facts.providerRegistryMethods) {
    const key = `${item.file}|${item.containingSymbol}|${item.methodSymbol}`
    const ref = { id: `service:registry-method/${methodPart(item)}`, kind: 'service' }
    methodRefs.set(key, ref)
    nodes.push(node(ref.id, ref.kind, `${item.containingSymbol}.${item.methodSymbol}`, sourceAnchor(item, `registry-method-${idPart(item.methodSymbol)}`, item.methodSymbol), {
      maturity: maturity('always-registered', ['statically proven registry method'], []), tags: ['inventory', 'service'],
    }))
    edges.push(edge(`edge:module-registry-method/${methodPart(item)}`, 'contains', moduleRef(item.file), ref, sourceAnchor(item, `registry-method-${idPart(item.methodSymbol)}`, item.methodSymbol)))
  }
  for (const item of facts.registryExtensions) {
    const provider = { id: `provider:registry-extension/${methodPart(item)}`, kind: 'provider' }
    const service = methodRefs.get(`${item.file}|${item.containingSymbol}|${item.method}`)
    const registry = registryRefs.get(`${item.file}|${item.containingSymbol}|${item.storage}`)
    nodes.push(node(provider.id, provider.kind, `Registry extension ${item.containingSymbol}.${item.method}`, sourceAnchor(item, `registry-extension-${idPart(item.method)}`), {
      maturity: maturity('always-registered', ['bounded dynamic extension point'], []), tags: ['inventory', 'provider'],
    }))
    edges.push(edge(`edge:extension-registry/${methodPart(item)}`, 'provides', provider, registry, sourceAnchor(item, `registry-extension-${idPart(item.method)}`)))
    edges.push(edge(`edge:extension-service/${methodPart(item)}`, 'provides', provider, service, sourceAnchor(item, `registry-extension-${idPart(item.method)}`)))
  }
  for (const item of facts.registryFacades) {
    const consumer = { id: `consumer:registry-facade/${methodPart(item)}`, kind: 'consumer' }
    const targetMethod = facts.providerRegistryMethods.find(candidate => candidate.file === item.targetFile && candidate.methodSymbol === item.targetMethod)
    const target = targetMethod === undefined ? undefined : methodRefs.get(`${targetMethod.file}|${targetMethod.containingSymbol}|${targetMethod.methodSymbol}`)
    nodes.push(node(consumer.id, consumer.kind, `Registry façade ${item.containingSymbol}.${item.method}`, sourceAnchor(item, `registry-facade-${idPart(item.method)}`), {
      maturity: maturity('always-registered', ['symbol-bound registry façade'], []), tags: ['consumer', 'inventory'],
    }))
    if (target !== undefined) edges.push(edge(`edge:facade-target/${methodPart(item)}`, 'consumes', consumer, target, sourceAnchor(item, `registry-facade-${idPart(item.method)}`)))
  }
  facts.providerRegistrations.forEach((item, index) => {
    const declaration = facts.providerRegistryMethods.find(candidate => candidate.file === item.methodDeclarationFile && candidate.methodSymbol === item.methodSymbol)
    if (declaration === undefined) fail('KG_RECONCILE_PROVIDER_METHOD', `no proven method for ${item.file} ${item.methodSymbol}`)
    const target = methodRefs.get(`${declaration.file}|${declaration.containingSymbol}|${declaration.methodSymbol}`)
    edges.push(edge(`edge:provider-call/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}-${idPart(item.methodSymbol)}`, 'calls', moduleRef(item.file), target,
      sourceAnchor(item, `provider-call-${idPart(item.methodSymbol)}-${item.providerName === null ? 'dynamic' : idPart(item.providerName)}`, item.containingSymbol)))
  })

  const configRefs = new Map()
  for (const item of facts.config.schema.properties) {
    const ref = { id: `config-key:${idPart(item.key)}`, kind: 'config-key' }
    configRefs.set(item.key, ref)
    const constraint = item.constraints ?? {}
    const range = { ...(typeof constraint.min === 'number' ? { min: constraint.min } : {}), ...(typeof constraint.max === 'number' ? { max: constraint.max } : {}) }
    const bounds = Object.keys(range).length === 0 ? [] : [{ name: `${item.key} range`, kind: constraintKind(item.key), value: range, source: { file: facts.config.schema.file, symbol: 'Config', selector: `config-${idPart(item.key)}` } }]
    nodes.push(node(ref.id, ref.kind, `Config ${item.key}`, { file: facts.config.schema.file, symbol: 'Config', selector: semanticSelector(`config-${idPart(item.key)}`, item) }, {
      defaultState: 'conditional', bounds,
      maturity: maturity('config-gated', [item.hasDefault ? `default ${JSON.stringify(item.default)}` : 'no static default'], []), tags: ['config', 'inventory'],
    }))
  }
  facts.config.effectiveConsumptions.forEach((item, index) => {
    const target = configRefs.get(item.key)
    if (target === undefined) fail('KG_RECONCILE_CONFIG_KEY', `effective consumption references unknown Config key ${item.key}`)
    edges.push(edge(`edge:config-consumption/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}-${idPart(item.key)}`, 'configured-by', moduleRef(item.file), target,
      sourceAnchor(item, `effective-config-${idPart(item.key)}`, item.containingSymbol)))
  })

  const domainRefs = new Map()
  for (const item of facts.domains) {
    const ref = { id: `domain:${idPart(item.name).replaceAll('_', '-')}`, kind: 'domain' }
    domainRefs.set(item.name, ref)
    nodes.push(node(ref.id, ref.kind, `Storage Domain ${item.name} v${item.version}`, sourceAnchor(item, `domain-${idPart(item.name)}`, item.symbol), {
      owner: ref, maturity: maturity('always-registered', [`domain schema version ${item.version}`], []), tags: ['domain', 'inventory'],
    }))
    item.tables.forEach(table => {
      const entityRef = { id: `entity:${idPart(item.name).replaceAll('_', '-')}/${idPart(table.recordType)}`, kind: 'entity' }
      nodes.push(node(entityRef.id, entityRef.kind, `${table.recordType} record`, sourceAnchor(item, `domain-table-${idPart(table.table)}`, item.symbol), {
        owner: ref, tags: ['entity', 'inventory'],
      }))
      edges.push(edge(`edge:domain-entity/${idPart(item.name)}-${idPart(table.table)}`, 'contains', ref, entityRef, sourceAnchor(item, `domain-table-${idPart(table.table)}`, item.symbol)))
    })
  }
  const teamDomain = domainRefs.get('agent_swarm')
  for (const item of facts.teamDomainPort.methods) {
    const ref = { id: `public-capability:team-domain-port/${idPart(item.name)}`, kind: 'public-capability' }
    nodes.push(node(ref.id, ref.kind, `TeamDomainPort.${item.name}`, { file: facts.teamDomainPort.file, symbol: item.name, selector: semanticSelector(`team-domain-port-${idPart(item.name)}`, item) }, {
      owner: teamDomain, maturity: maturity('always-registered', ['public TeamDomainPort method'], []), tags: ['domain-port', 'inventory'],
    }))
    edges.push(edge(`edge:domain-port/${idPart(item.name)}`, 'contains', teamDomain, ref, { file: facts.teamDomainPort.file, symbol: item.name, selector: semanticSelector(`team-domain-port-${idPart(item.name)}`, item) }))
  }
  for (const item of facts.stateUnions) {
    const owner = domainForFile(item.file)
    const ref = { id: `state:union/${idPart(item.symbol)}`, kind: 'state' }
    nodes.push(node(ref.id, ref.kind, `${item.symbol}: ${item.values.join(' | ')}`, sourceAnchor(item, `state-union-${idPart(item.symbol)}`), { owner, tags: ['inventory', 'state'] }))
    edges.push(edge(`edge:domain-state/${idPart(item.symbol)}`, 'contains', owner, ref, sourceAnchor(item, `state-union-${idPart(item.symbol)}`)))
  }
  for (const item of facts.entityDiscriminants) {
    const owner = domainForFile(item.file)
    const ref = { id: `state:discriminant/${idPart(item.entity)}/${idPart(item.field)}`, kind: 'state' }
    nodes.push(node(ref.id, ref.kind, `${item.entity}.${item.field}: ${item.values.join(' | ')}`, sourceAnchor(item, `entity-discriminant-${idPart(item.entity)}-${idPart(item.field)}`, item.entity), { owner, tags: ['inventory', 'state'] }))
    edges.push(edge(`edge:domain-discriminant/${idPart(item.entity)}-${idPart(item.field)}`, 'contains', owner, ref, sourceAnchor(item, `entity-discriminant-${idPart(item.entity)}-${idPart(item.field)}`, item.entity)))
  }

  const rpcRouteRefs = facts.rpc.routes.map((item, index) => {
    const ref = { id: `rpc-route:${surfacePart(item.path)}`, kind: 'rpc-route' }
    nodes.push(node(ref.id, ref.kind, `${item.admission.method} ${item.path}`, sourceAnchor(item, `rpc-route-${surfacePart(item.path)}`, item.containingSymbol), {
      maturity: maturity('profile-dependent', ['webServer injection and loopback trust admission'], []), tags: ['inventory', 'rpc-route'],
    }))
    edges.push(edge(`edge:module-rpc-route/${String(index + 1).padStart(2, '0')}`, 'contains', moduleRef(item.file), ref, sourceAnchor(item, `rpc-route-${surfacePart(item.path)}`, item.containingSymbol)))
    return ref
  })
  for (const methodName of facts.rpc.methods.values) {
    const ref = { id: `rpc-method:${idPart(methodName)}`, kind: 'rpc-method' }
    const methodFact = { methodName, source: facts.rpc.methods }
    nodes.push(node(ref.id, ref.kind, `RPC method ${methodName}`, { file: facts.rpc.methods.file, symbol: facts.rpc.methods.symbol, selector: semanticSelector(`rpc-method-${idPart(methodName)}`, methodFact) }, {
      maturity: maturity('profile-dependent', ['RPC route availability'], []), tags: ['inventory', 'rpc-method'],
    }))
    for (const route of rpcRouteRefs) edges.push(edge(`edge:rpc-route-method/${surfacePart(route.id)}-${idPart(methodName)}`, 'exposes', route, ref, { file: facts.rpc.methods.file, symbol: facts.rpc.methods.symbol, selector: semanticSelector(`rpc-method-${idPart(methodName)}`, methodFact) }))
  }
  facts.rpc.constants.forEach(item => nodes.push(node(`public-capability:rpc-constant/${idPart(item.symbol)}`, 'public-capability', `${item.symbol} = ${JSON.stringify(item.value)}`, sourceAnchor(item, `rpc-constant-${idPart(item.symbol)}`), {
    maturity: maturity('package-exported', ['exported static RPC constant'], []), tags: ['inventory', 'rpc'],
  })))
  facts.rpc.schemas.forEach(item => nodes.push(node(`entity:rpc-schema/${idPart(item.symbol)}`, 'entity', `RPC schema ${item.symbol}`, sourceAnchor(item, `rpc-schema-${idPart(item.symbol)}`), { tags: ['entity', 'inventory', 'rpc'] })))
  facts.rpc.capabilities.forEach((group, groupIndex) => group.entries.forEach(entry => nodes.push(node(
    `public-capability:rpc-declaration/${String(groupIndex + 1).padStart(2, '0')}-${idPart(group.symbol)}/${idPart(entry.capability)}`, 'public-capability', `${group.symbol}: ${entry.capability} ${entry.state}`,
    sourceAnchor(group, `rpc-capability-${idPart(group.symbol)}-${idPart(entry.capability)}`), {
      maturity: maturity(entry.state === 'available' ? 'profile-dependent' : 'unavailable', ['static capability declaration'], entry.blocker === undefined ? [] : [entry.blocker]), tags: ['inventory', 'rpc'],
    })) ))
  facts.rpc.runtimeCapabilities.forEach(group => group.values.forEach(value => nodes.push(node(
    `public-capability:rpc-runtime/${idPart(group.containingSymbol)}/${idPart(value)}`, 'public-capability', `${group.containingSymbol} runtime capability ${value}`,
    sourceAnchor(group, `rpc-runtime-capability-${idPart(value)}`, group.methodSymbol), { maturity: maturity('profile-dependent', ['runtime capabilities method'], []), tags: ['inventory', 'rpc'] },
  ))))
  facts.rpc.bounds.forEach(item => nodes.push(node(`guard:rpc-bound/${idPart(item.file)}/${idPart(item.symbol)}`, 'guard', `${item.symbol} = ${item.value}`, sourceAnchor(item, `rpc-bound-${idPart(item.symbol)}`), {
    bounds: [{ name: item.symbol, kind: /timeout/iu.test(item.symbol) ? 'time-ms' : /page/iu.test(item.symbol) ? 'pagination' : 'items', value: item.value, source: sourceAnchor(item, `rpc-bound-${idPart(item.symbol)}`) }], tags: ['guard', 'inventory', 'rpc'],
  })))
  facts.rpc.httpMethods.forEach((item, index) => nodes.push(node(`guard:rpc-http/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}`, 'guard', `${item.receiver} ${item.method}`, sourceAnchor(item, `rpc-http-${idPart(item.receiver)}-${idPart(item.method)}`, item.containingSymbol), { tags: ['guard', 'inventory', 'rpc'] })))
  facts.rpc.literalUnions.forEach(item => nodes.push(node(`state:rpc-union/${idPart(item.symbol)}`, 'state', `${item.symbol}: ${item.values.join(' | ')}`, sourceAnchor(item, `rpc-union-${idPart(item.symbol)}`), { tags: ['inventory', 'rpc', 'state'] })))

  for (const item of facts.client.entrypoints) {
    const ref = { id: `entrypoint:client/${surfacePart(item.file.replace(/^src\/client\//u, '').replace(/\.[^.]+$/u, ''))}`, kind: 'entrypoint' }
    nodes.push(node(ref.id, ref.kind, `Client entrypoint ${item.file}`, { file: item.file, selector: `client-entrypoint-${idPart(item.file)}` }, {
      maturity: maturity('package-exported', ['client package entrypoint'], []), tags: ['entrypoint', 'inventory'],
    }))
    edges.push(edge(`edge:package-client-entrypoint/${idPart(item.file)}`, 'contains', packageRef, ref, { file: item.file, selector: `client-entrypoint-${idPart(item.file)}` }))
    edges.push(edge(`edge:client-entrypoint-module/${idPart(item.file)}`, 'exports', ref, moduleRef(item.file), { file: item.file, selector: `client-entrypoint-${idPart(item.file)}` }))
  }
  facts.client.slots.forEach((item, index) => {
    const slot = { id: `ui-slot:${String(index + 1).padStart(2, '0')}-${idPart(item.name)}-${idPart(item.operation)}`, kind: 'ui-slot' }
    nodes.push(node(slot.id, slot.kind, `${item.operation} ${item.name}`, sourceAnchor(item, `client-slot-${idPart(item.operation)}-${idPart(item.name)}`, item.containingSymbol), {
      maturity: maturity('optional-injection', ['client slot registry'], []), tags: ['inventory', 'ui-slot'],
    }))
    edges.push(edge(`edge:module-ui-slot/${String(index + 1).padStart(2, '0')}`, 'contains', moduleRef(item.file), slot, sourceAnchor(item, `client-slot-${idPart(item.operation)}-${idPart(item.name)}`, item.containingSymbol)))
    if (item.operation === 'register') {
      const surface = { id: `ui-surface:${String(index + 1).padStart(2, '0')}-${idPart(item.name)}`, kind: 'ui-surface' }
      nodes.push(node(surface.id, surface.kind, `UI surface ${item.name}`, sourceAnchor(item, `client-surface-${idPart(item.name)}`, item.containingSymbol), {
        maturity: maturity('optional-injection', ['client slot available'], []), tags: ['inventory', 'ui-surface'],
      }))
      edges.push(edge(`edge:ui-slot-surface/${String(index + 1).padStart(2, '0')}`, 'exposes', slot, surface, sourceAnchor(item, `client-surface-${idPart(item.name)}`, item.containingSymbol)))
    }
  })
  const settingsSection = { id: 'settings-section:agent-swarm', kind: 'settings-section' }
  const settings = facts.client.settingsNamespaces[0]
  if (settings !== undefined) {
    nodes.push(node(settingsSection.id, settingsSection.kind, `Settings namespace ${settings.value}`, sourceAnchor(settings, `settings-namespace-${idPart(settings.value)}`), {
      maturity: maturity('optional-injection', ['settingsScope binding'], []), tags: ['inventory', 'settings'],
    }))
    const fields = facts.client.settingsFields.flatMap(item => item.values)
    for (const field of [...new Set(fields)].sort(compareText)) {
      const config = configRefs.get(field)
      if (config !== undefined) edges.push(edge(`edge:settings-config/${idPart(field)}`, 'exposes', settingsSection, config, sourceAnchor(settings, `settings-field-${idPart(field)}`)))
    }
  }
  facts.client.settingsDocuments.forEach(item => nodes.push(node(`entity:client-settings/${idPart(item.symbol)}`, 'entity', `${item.symbol}: ${item.fields.join(', ')}`, sourceAnchor(item, `settings-document-${idPart(item.symbol)}`), { tags: ['entity', 'inventory', 'settings'] })))
  facts.client.settingsBindings.forEach((item, index) => edges.push(edge(`edge:settings-binding/${String(index + 1).padStart(2, '0')}`, 'registers', moduleRef(item.file), settingsSection, sourceAnchor(item, `settings-binding-${idPart(item.namespace)}`, item.containingSymbol))))

  facts.lifecycle.listeners.forEach((item, index) => {
    const event = { id: `event:listener/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}-${idPart(item.event)}`, kind: 'event' }
    nodes.push(node(event.id, event.kind, `${item.api} ${item.event}`, sourceAnchor(item, `listener-${idPart(item.api)}-${idPart(item.event)}`, item.containingSymbol), { tags: ['event', 'inventory', 'lifecycle'] }))
    edges.push(edge(`edge:lifecycle-listener/${String(index + 1).padStart(2, '0')}`, 'listens', moduleRef(item.file), event, sourceAnchor(item, `listener-${idPart(item.api)}-${idPart(item.event)}`, item.containingSymbol)))
  })
  facts.lifecycle.effects.forEach((item, index) => {
    const event = { id: `event:effect/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}`, kind: 'event' }
    nodes.push(node(event.id, event.kind, `Lifecycle effect ${item.label}`, sourceAnchor(item, `effect-${String(index + 1).padStart(2, '0')}`, item.containingSymbol), { tags: ['event', 'inventory', 'lifecycle'] }))
    edges.push(edge(`edge:lifecycle-effect/${String(index + 1).padStart(2, '0')}`, 'registers', moduleRef(item.file), event, sourceAnchor(item, `effect-${String(index + 1).padStart(2, '0')}`, item.containingSymbol)))
  })
  facts.lifecycle.systemPrompts.forEach((item, index) => {
    const event = { id: `event:system-prompt/${String(index + 1).padStart(2, '0')}`, kind: 'event' }
    nodes.push(node(event.id, event.kind, `System prompt ${item.fields.name}`, sourceAnchor(item, `system-prompt-${idPart(item.fields.name)}`, item.containingSymbol), { tags: ['event', 'inventory', 'lifecycle'] }))
    edges.push(edge(`edge:system-prompt/${String(index + 1).padStart(2, '0')}`, 'registers', moduleRef(item.file), event, sourceAnchor(item, `system-prompt-${idPart(item.fields.name)}`, item.containingSymbol)))
  })

  facts.reexportLayers.forEach((item, index) => {
    const layer = { id: `public-capability:reexport-layer/${String(index + 1).padStart(2, '0')}-${idPart(item.file)}`, kind: 'public-capability' }
    const layerSelector = semanticSelector(`reexport-layer-${String(index + 1).padStart(2, '0')}-${idPart(item.moduleSpecifier)}`, item)
    nodes.push(node(layer.id, layer.kind, `Re-export ${item.moduleSpecifier}`, { file: item.file, selector: layerSelector }, {
      maturity: maturity('package-exported', ['reachable re-export layer'], []), tags: ['export', 'inventory'],
    }))
    edges.push(edge(`edge:reexport-layer/${String(index + 1).padStart(2, '0')}`, 'exports', moduleRef(item.file), layer, { file: item.file, selector: layerSelector }))
    if (item.resolvedModule !== null) edges.push(edge(`edge:reexport-target/${String(index + 1).padStart(2, '0')}`, 'exports', moduleRef(item.file), moduleRef(item.resolvedModule), { file: item.file, selector: semanticSelector(`reexport-target-${String(index + 1).padStart(2, '0')}-${idPart(item.moduleSpecifier)}`, item) }))
  })
  const rootEntrypoint = entrypoints.get('entrypoint:package/root')
  for (const [surface, items, entrypoint] of [
    ['root', facts.reachableRootExports, rootEntrypoint],
    ['public-api', facts.reachablePublicApiExports, publicApiEntrypoint],
  ]) {
    for (const item of items) {
      const ref = { id: `public-capability:export/${surface}/${idPart(item.name)}`, kind: 'public-capability' }
      const anchors = item.declarations.map(file => ({ file, symbol: item.targetName, selector: semanticSelector(`reachable-export-${surface}-${idPart(item.name)}`, item) }))
      nodes.push(node(ref.id, ref.kind, `${surface} export ${item.name} (${item.spaces.join('+')})`, anchors[0], {
        anchors, maturity: maturity('package-exported', [`reachable ${surface} export`], []), tags: ['export', 'inventory'],
      }))
      edges.push(edge(`edge:reachable-export/${surface}/${idPart(item.name)}`, 'exports', entrypoint, ref, anchors[0]))
    }
  }
  failSourceIdCollisions(nodes, edges, [...normalizedNodeCollisions])
  nodes.sort((left, right) => compareText(left.id, right.id))
  edges.sort((left, right) => compareText(left.id, right.id))
  return {
    schemaVersion: 2,
    project: { id: 'dsh-agent-swarm', sourceRoot: 'src', packageManifest: 'package.json' },
    inventoryPolicy: { sourceGlobs: ['src/**/*.ts', 'src/**/*.tsx'], importedAssetGlobs: [...importedAssetPaths].sort(compareText), excludedFiles: [] },
    nodes, edges, exceptions: [],
  }
}

export function mechanicalSignatures(manifest) {
  return {
    nodes: new Map(manifest.nodes.map(item => [item.id, {
      kind: item.kind, factAuthority: item.factAuthority,
      anchors: item.anchors.map(anchor => ({ file: anchor.file, symbol: anchor.symbol ?? null, exportName: anchor.exportName ?? null, selector: anchor.selector ?? null })),
    }])),
    edges: new Map(manifest.edges.map(item => [item.id, {
      type: item.type, contract: item.contract ?? null, from: item.from, to: item.to,
      anchors: item.anchors.map(anchor => ({ file: anchor.file, symbol: anchor.symbol ?? null, exportName: anchor.exportName ?? null, selector: anchor.selector ?? null })),
    }])),
  }
}

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { graphDigest } from './canonical.mjs'
import { fail } from './diagnostics.mjs'
import { assertNfc } from './strict-json.mjs'

const dynamicKeys = new Set([
  'generatedAt', 'currentBranch', 'activeTask', 'lease', 'leaseHolder', 'currentReviewer',
  'pid', 'port', 'runId', 'latestRun', 'health', 'worktreePath',
])

const edgeKinds = {
  contains: [['package', '*'], ['entrypoint', '*'], ['module', '*'], ['domain', '*'], ['flow', 'flow-branch']],
  imports: [['module', 'module'], ['module', 'package'], ['module', 'artifact']],
  exports: [['package', 'entrypoint'], ['entrypoint', '*'], ['module', '*']],
  registers: [['entrypoint', '*'], ['module', '*'], ['consumer', '*']],
  provides: [['provider', 'service'], ['provider', 'provider-registry'], ['entrypoint', 'service']],
  consumes: [['consumer', 'service'], ['model-tool', 'service'], ['ui-surface', 'service']],
  'requires-inject': [['*', 'injection'], ['*', 'service']],
  'optionally-injects': [['*', 'injection'], ['*', 'service']],
  'configured-by': [['*', 'config-key']],
  owns: [['authority', '*'], ['official-authority', '*'], ['domain', '*']],
  reads: [['*', 'authority'], ['*', 'official-authority'], ['*', 'domain'], ['*', 'entity'], ['*', 'state'], ['*', 'checkpoint'], ['*', 'fence'], ['*', 'state-predicate']],
  mutates: [['transaction', 'entity'], ['transaction', 'state'], ['transaction', 'checkpoint'], ['model-tool', 'transaction']],
  'persists-in': [['entity', 'authority'], ['entity', 'official-authority'], ['entity', 'domain'], ['state', 'authority'], ['state', 'official-authority'], ['state', 'domain']],
  emits: [['*', 'event']],
  listens: [['*', 'event']],
  projects: [['*', 'ui-surface'], ['*', 'rpc-method'], ['*', 'artifact']],
  exposes: [['rpc-route', 'rpc-method'], ['ui-slot', 'ui-surface'], ['settings-section', 'config-key'], ['service', 'public-capability']],
  triggers: [['*', 'flow'], ['*', 'transaction']],
  calls: [['*', 'provider'], ['*', 'transaction'], ['*', 'service']],
  transitions: [['transaction', 'state'], ['flow-branch', 'state']],
  checkpoints: [['transaction', 'checkpoint'], ['provider', 'checkpoint'], ['service', 'checkpoint']],
  recovers: [['service', '*'], ['provider', '*'], ['consumer', '*'], ['transaction', '*']],
  guards: [['guard', '*'], ['*', 'guard']],
  'bounded-by': [['*', 'config-key'], ['*', 'guard']],
  'verified-by': [['*', 'test'], ['*', 'gate']],
  'documented-by': [['*', 'document']],
  'accepted-by': [['*', 'artifact']],
  'blocked-by': [['*', 'redline'], ['*', 'config-key'], ['*', 'gate']],
  supersedes: [['*', '*']],
  violates: [['*', 'redline']],
}

const mechanicalEdgeKinds = new Set([
  'contains', 'imports', 'exports', 'registers', 'provides', 'consumes', 'requires-inject',
  'optionally-injects', 'configured-by', 'listens', 'exposes', 'calls',
])

function assertNoDynamicKeys(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoDynamicKeys(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (dynamicKeys.has(key)) fail('KG_DYNAMIC_FIELD', `${path}.${key} is forbidden in the canonical manifest`)
    assertNoDynamicKeys(item, `${path}.${key}`)
  }
}

function assertSortedUnique(records, field, code) {
  const values = records.map(record => record[field])
  if (new Set(values).size !== values.length) fail(code, `duplicate ${field}`)
  const sorted = [...values].sort()
  if (values.some((value, index) => value !== sorted[index])) fail('KG_NONCANONICAL_ORDER', `${field} array is not sorted`)
}

function legalEdge(edge, nodes) {
  const from = nodes.get(edge.from.id)
  const to = nodes.get(edge.to.id)
  if (!from || !to) return false
  const rules = edgeKinds[edge.type] ?? []
  return rules.some(([fromKind, toKind]) => (fromKind === '*' || fromKind === from.kind) && (toKind === '*' || toKind === to.kind))
}

function assertAnchor(root, anchor, owner) {
  if (isAbsolute(anchor.file) || anchor.file.includes('\\')) fail('KG_ANCHOR_PATH', `${owner} has a non-portable anchor`)
  const target = resolve(root, anchor.file)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('KG_ANCHOR_ESCAPE', `${owner} anchor escapes the repository`)
  if (!existsSync(target)) fail('KG_ANCHOR_MISSING', `${owner} anchor does not exist: ${anchor.file}`)
  const real = realpathSync(target)
  const realRel = relative(root, real)
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) fail('KG_ANCHOR_ESCAPE', `${owner} anchor resolves outside the repository`)
}

function resolveRef(nodes, ref, allowedKinds, code, context) {
  const node = nodes.get(ref.id)
  if (!node || node.kind !== ref.kind || !allowedKinds.includes(node.kind)) fail(code, `${context} has an unresolved or mistyped ref ${ref.id}`)
  return node
}

function edgeTargets(edges, fromId, type) {
  return new Set(edges.filter(edge => edge.from.id === fromId && edge.type === type).map(edge => edge.to.id))
}

function validateOwnershipEdges(nodes, edges) {
  const ownership = new Map()
  for (const edge of edges.filter(item => item.type === 'owns')) {
    const owners = ownership.get(edge.to.id) ?? []
    owners.push(edge.from.id)
    ownership.set(edge.to.id, owners)
  }
  for (const [target, owners] of ownership) {
    if (new Set(owners).size > 1) fail('KG_MULTIPLE_OWNERS', `${target} has multiple ownership edges`)
    const node = nodes.get(target)
    if (node.classification !== 'reviewed' || node.ownerAuthority?.id !== owners[0]) fail('KG_OWNER_EDGE', `${target} ownership edge conflicts with reviewed ownerAuthority`)
  }
  for (const edge of edges.filter(item => item.type === 'persists-in')) {
    const source = nodes.get(edge.from.id)
    if (source.ownerAuthority?.id !== edge.to.id) fail('KG_OWNER_EDGE', `${edge.id} persists in a different authority than ${source.id}.ownerAuthority`)
  }
}

function validateClassification(nodes, edges) {
  for (const node of nodes.values()) {
    const mechanical = node.classification === 'mechanical'
    if (mechanical) {
      if (node.ownerAuthority !== undefined || node.security.authoritySource !== undefined) fail('KG_MECHANICAL_RUNTIME_AUTHORITY', `${node.id} mechanical fact cannot claim runtime authority`)
      if (node.factAuthority.id !== 'authority:source-tree' || node.factAuthority.kind !== 'authority') fail('KG_MECHANICAL_FACT_AUTHORITY', `${node.id} mechanical fact must bind source-tree fact authority`)
      if (node.security.callerIdentity !== 'unclassified' || node.security.mutation !== 'unclassified' || node.security.dataClasses.length !== 1 || node.security.dataClasses[0] !== 'unclassified') {
        fail('KG_MECHANICAL_SECURITY', `${node.id} mechanical fact must keep runtime security unclassified`)
      }
      if (node.maturity.verification.state !== 'none' || node.maturity.verification.evidence.length !== 0 || node.maturity.acceptance.state !== 'not-candidate') {
        fail('KG_MECHANICAL_MATURITY', `${node.id} mechanical fact cannot claim verification or acceptance`)
      }
      continue
    }
    if (node.classification !== 'reviewed') fail('KG_CLASSIFICATION', `${node.id} has unknown classification`)
    if (node.ownerAuthority === undefined || node.ownerAuthority.id === 'authority:source-tree') fail('KG_REVIEWED_OWNER', `${node.id} reviewed fact requires a runtime owner distinct from source-tree`)
    if (node.security.authoritySource === undefined || node.security.authoritySource.id === 'authority:source-tree') fail('KG_REVIEWED_SECURITY', `${node.id} reviewed fact requires runtime security authority`)
    if (node.security.callerIdentity === 'unclassified' || node.security.mutation === 'unclassified' || node.security.dataClasses.includes('unclassified')) {
      fail('KG_REVIEWED_SECURITY', `${node.id} reviewed security cannot be unclassified`)
    }
  }
  for (const edge of edges) {
    const from = nodes.get(edge.from.id)
    const to = nodes.get(edge.to.id)
    if (edge.classification === 'mechanical') {
      if (!mechanicalEdgeKinds.has(edge.type) || edge.crash !== undefined) fail('KG_MECHANICAL_EDGE', `${edge.id} mechanical edge carries runtime semantics`)
    } else if (edge.classification === 'reviewed') {
      if (from?.classification !== 'reviewed' || to?.classification !== 'reviewed') fail('KG_EDGE_CLASSIFICATION', `${edge.id} reviewed edge endpoints must be reviewed`)
    } else fail('KG_CLASSIFICATION', `${edge.id} has unknown classification`)
  }
  for (const node of nodes.values()) {
    if (node.classification !== 'reviewed') continue
    if (['model-tool', 'rpc-method'].includes(node.kind) && node.security.mutation === 'none') {
      fail('KG_REVIEWED_CALLABLE_MODE_REQUIRED', `${node.id} reviewed callable must declare read, domain-transaction, or external-effect semantics`)
    }
    if (node.security.mutation === 'none' && ['model-tool', 'service', 'consumer', 'rpc-method', 'public-capability'].includes(node.kind) && edges.some(edge => edge.classification === 'reviewed' && ['mutates', 'triggers', 'transitions'].includes(edge.type) && edge.from.id === node.id)) {
      fail('KG_REVIEWED_SECURITY_CONFLICT', `${node.id} invokes mutation semantics while declaring mutation:none`)
    }
    if (!['read', 'domain-transaction', 'external-effect'].includes(node.security.mutation)) continue
    const owns = edges.filter(edge => edge.classification === 'reviewed' && edge.type === 'owns' && edge.from.id === node.ownerAuthority.id && edge.to.id === node.id)
    if (owns.length !== 1) fail('KG_REVIEWED_OWNER_CLOSURE', `${node.id} reviewed runtime claim requires exactly one owner edge`)
    if (node.security.mutation === 'read' && !edges.some(edge => edge.classification === 'reviewed' && edge.type === 'reads' && edge.from.id === node.id)) {
      fail('KG_REVIEWED_READ_CLOSURE', `${node.id} reviewed read claim requires a reads edge`)
    }
    if (node.security.mutation === 'read' && ['model-tool', 'rpc-method', 'public-capability'].includes(node.kind) && node.bounds.length === 0) {
      fail('KG_REVIEWED_READ_BOUND', `${node.id} reviewed public read claim requires an explicit response bound`)
    }
    if (node.security.mutation === 'external-effect' && !edges.some(edge => edge.classification === 'reviewed' && edge.type === 'calls' && edge.from.id === node.id && edge.to.kind === 'provider')) {
      fail('KG_REVIEWED_EFFECT_CLOSURE', `${node.id} reviewed external effect requires a Provider call`)
    }
    if (node.security.mutation === 'domain-transaction') {
      if (node.security.guards.length === 0) fail('KG_REVIEWED_MUTATION_GUARD', `${node.id} reviewed domain mutation requires a guard`)
      const closed = node.kind === 'transaction'
        ? edges.some(edge => edge.classification === 'reviewed' && edge.type === 'mutates' && edge.from.id === node.id)
        : edges.some(edge => edge.classification === 'reviewed' && ['triggers', 'mutates'].includes(edge.type) && edge.from.id === node.id && edge.to.kind === 'transaction')
      if (!closed) fail('KG_REVIEWED_MUTATION_CLOSURE', `${node.id} reviewed domain mutation requires typed transaction closure`)
    }
  }
}

function validateCrashContracts(nodes, edges) {
  const ordinals = new Map()
  for (const edge of edges.filter(item => item.crash)) {
    const crash = edge.crash
    const context = `${edge.id}.crash`
    const flow = resolveRef(nodes, crash.flow, ['flow'], 'KG_CRASH_REF', context)
    const branch = resolveRef(nodes, crash.branch, ['flow-branch'], 'KG_CRASH_REF', context)
    if (branch.contract?.flow.id !== flow.id) fail('KG_CRASH_BRANCH', `${context} branch does not belong to ${flow.id}`)
    const owner = resolveRef(nodes, crash.recoveryOwner, ['service', 'provider', 'consumer', 'transaction'], 'KG_RECOVERY_EXECUTOR', context)
    const decisionRefs = [...crash.expectedBefore, ...crash.committedAfter, ...(crash.checkpoint ? [crash.checkpoint] : []), ...crash.fences]
    for (const ref of crash.expectedBefore) resolveRef(nodes, ref, ['state-predicate'], 'KG_CRASH_REF', context)
    for (const ref of crash.committedAfter) resolveRef(nodes, ref, ['state-predicate'], 'KG_CRASH_REF', context)
    if (crash.checkpoint) resolveRef(nodes, crash.checkpoint, ['checkpoint'], 'KG_CRASH_REF', context)
    for (const ref of crash.fences) resolveRef(nodes, ref, ['fence'], 'KG_CRASH_REF', context)
    if (crash.idempotency) {
      for (const component of crash.idempotency.components) {
        const allowed = component.kind === 'entity-field'
          ? ['entity']
          : component.kind === 'transaction-input'
            ? ['transaction']
            : ['model-tool', 'rpc-method']
        resolveRef(nodes, component.source, allowed, 'KG_IDEMPOTENCY_REF', context)
      }
    }
    const reads = edgeTargets(edges, owner.id, 'reads')
    for (const ref of decisionRefs) {
      if (!reads.has(ref.id)) fail('KG_RECOVERY_READ_CLOSURE', `${context} recovery owner ${owner.id} does not read ${ref.id}`)
      const state = nodes.get(ref.id)
      resolveRef(nodes, state.ownerAuthority, ['authority', 'official-authority', 'domain'], 'KG_OWNER_AUTHORITY', `${context}.${ref.id}`)
    }
    const transactions = crash.recoveryTransactions.map(ref => resolveRef(nodes, ref, ['transaction'], 'KG_RECOVERY_TRANSACTION_CLOSURE', context))
    const called = edgeTargets(edges, owner.id, 'calls')
    if (crash.recoveryMode === 'state-changing' && crash.committedAfter.length === 0) {
      fail('KG_RECOVERY_COMMITTED_STATE', `${context} state-changing recovery requires committedAfter evidence`)
    }
    if (crash.recoveryMode === 'observe-block' && crash.committedAfter.length > 0) {
      fail('KG_RECOVERY_OBSERVE_MUTATION', `${context} observe-block recovery cannot declare committed state`)
    }
    if (crash.recoveryMode === 'state-changing' && transactions.length === 0) {
      fail('KG_RECOVERY_TRANSACTION_CLOSURE', `${context} state-changing recovery has no scoped transaction`)
    }
    if (crash.recoveryMode === 'observe-block' && transactions.length > 0) {
      fail('KG_RECOVERY_OBSERVE_MUTATION', `${context} observe-block recovery cannot declare a transaction`)
    }
    for (const transaction of transactions) {
      if (!called.has(transaction.id)) fail('KG_RECOVERY_TRANSACTION_CLOSURE', `${context} recovery owner ${owner.id} does not call ${transaction.id}`)
    }
    for (const predicateRef of crash.committedAfter) {
      const predicate = nodes.get(predicateRef.id)
      const entityId = predicate.contract?.predicate.entity.id
      if (!entityId) fail('KG_RECOVERY_MUTATION_CLOSURE', `${context} committed predicate ${predicate.id} has no entity`)
      const closed = transactions.some(transaction => edges.some(item => item.type === 'mutates' && item.from.id === transaction.id && item.to.id === entityId))
      if (!closed) fail('KG_RECOVERY_MUTATION_CLOSURE', `${context} does not mutate committed target ${entityId} through a typed transaction`)
    }
    if (crash.phase === 'external-effect' && (edge.type !== 'calls' || edge.to.kind !== 'provider')) {
      fail('KG_EXTERNAL_EFFECT_PROVIDER', `${context} must be a calls edge to a Provider`)
    }
    if (crash.authoritativePostState === 'unknown' && crash.retryRule !== 'exact-readback-first') {
      fail('KG_BLIND_RETRY', `${edge.id} retries an unknown external effect without exact read-back`)
    }
    const key = `${flow.id}\0${branch.id}`
    const values = ordinals.get(key) ?? []
    values.push(crash.ordinal)
    ordinals.set(key, values)
  }
  for (const [key, values] of ordinals) {
    const sorted = [...values].sort((a, b) => a - b)
    if (new Set(sorted).size !== sorted.length || sorted.some((value, index) => value !== index)) {
      fail('KG_CRASH_ORDINAL', `${key.replace('\0', '/')} ordinals must be unique and contiguous from zero`)
    }
  }
}

export function validateManifestSemantics(root, manifest) {
  assertNfc(manifest)
  assertNoDynamicKeys(manifest)
  assertSortedUnique(manifest.nodes, 'id', 'KG_DUPLICATE_NODE')
  assertSortedUnique(manifest.edges, 'id', 'KG_DUPLICATE_EDGE')
  assertSortedUnique(manifest.exceptions, 'id', 'KG_DUPLICATE_EXCEPTION')

  const nodes = new Map(manifest.nodes.map(node => [node.id, node]))
  for (const node of manifest.nodes) {
    for (const anchor of node.anchors) assertAnchor(root, anchor, node.id)
    const factAuthority = nodes.get(node.factAuthority.id)
    if (!factAuthority || factAuthority.kind !== node.factAuthority.kind || !['authority', 'official-authority', 'domain'].includes(factAuthority.kind)) {
      fail('KG_FACT_AUTHORITY', `${node.id} has an unresolved or mistyped factAuthority`)
    }
    if (node.classification === 'reviewed') {
      const authority = nodes.get(node.ownerAuthority.id)
      if (!authority || authority.kind !== node.ownerAuthority.kind || !['authority', 'official-authority', 'domain'].includes(authority.kind)) {
        fail('KG_OWNER_AUTHORITY', `${node.id} has an unresolved or mistyped ownerAuthority`)
      }
      const securityAuthority = nodes.get(node.security.authoritySource.id)
      if (!securityAuthority || securityAuthority.kind !== node.security.authoritySource.kind || !['authority', 'official-authority', 'domain'].includes(securityAuthority.kind)) {
        fail('KG_SECURITY_AUTHORITY', `${node.id} has an unresolved or mistyped security authority`)
      }
    }
    if (node.lifecycle.recoveryOwner) {
      const owner = nodes.get(node.lifecycle.recoveryOwner.id)
      if (!owner || owner.kind !== node.lifecycle.recoveryOwner.kind || !['service', 'provider', 'consumer', 'transaction'].includes(owner.kind)) {
        fail('KG_RECOVERY_EXECUTOR', `${node.id} has a non-executable recovery owner`)
      }
    }
    if (node.kind === 'state-predicate' && node.contract?.nodeKind !== 'state-predicate') fail('KG_NODE_CONTRACT', `${node.id} requires a state-predicate contract`)
    if (node.kind === 'flow-branch' && node.contract?.nodeKind !== 'flow-branch') fail('KG_NODE_CONTRACT', `${node.id} requires a flow-branch contract`)
    if (!['state-predicate', 'flow-branch'].includes(node.kind) && node.contract) fail('KG_NODE_CONTRACT', `${node.id} cannot carry a contract`)
    if (node.kind === 'state-predicate') {
      const predicate = node.contract.predicate
      const entity = resolveRef(nodes, predicate.entity, ['entity'], 'KG_PREDICATE_REF', node.id)
      const schema = resolveRef(nodes, predicate.field.schema, ['entity'], 'KG_PREDICATE_REF', node.id)
      if (entity.id !== schema.id) fail('KG_PREDICATE_REF', `${node.id} field schema differs from predicate entity`)
    }
    if (node.kind === 'flow-branch') resolveRef(nodes, node.contract.flow, ['flow'], 'KG_FLOW_REF', node.id)
  }

  for (const edge of manifest.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      const node = nodes.get(endpoint.id)
      if (!node || node.kind !== endpoint.kind) fail('KG_EDGE_ENDPOINT', `${edge.id} has an unresolved or mistyped endpoint ${endpoint.id}`)
    }
    for (const anchor of edge.anchors) assertAnchor(root, anchor, edge.id)
    if (edge.type === 'mutates' && edge.to.kind === 'transaction' && edge.from.kind !== 'model-tool') {
      fail('KG_TRANSACTION_RELATION', `${edge.id} must use calls, not mutates, to invoke a transaction`)
    }
    if (!legalEdge(edge, nodes)) fail('KG_EDGE_KIND', `${edge.id} is not legal for ${edge.from.kind} -> ${edge.to.kind}`)
    if (edge.type === 'violates') fail('KG_REDLINE_VIOLATION', `${edge.id} records a prohibited implemented relation`)
    if (edge.crash && !['calls', 'mutates', 'checkpoints', 'recovers', 'triggers'].includes(edge.type)) fail('KG_CRASH_EDGE', `${edge.id} cannot carry crash semantics`)
  }

  validateOwnershipEdges(nodes, manifest.edges)
  validateCrashContracts(nodes, manifest.edges)
  validateClassification(nodes, manifest.edges)

  for (const exception of manifest.exceptions) {
    exception.evidence.forEach(anchor => assertAnchor(root, anchor, exception.id))
    if (exception.scope === '*' || exception.scope.includes('**')) fail('KG_EXCEPTION_WILDCARD', `${exception.id} has an unbounded scope`)
  }

  return { digest: graphDigest(manifest), nodeCount: manifest.nodes.length, edgeCount: manifest.edges.length }
}

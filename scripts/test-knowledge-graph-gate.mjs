import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, graphDigest } from './knowledge-graph/canonical.mjs'
import { KnowledgeGraphError } from './knowledge-graph/diagnostics.mjs'
import { compareGeneratedFiles, resolveGeneratedOutputRoot, writeGeneratedFiles } from './knowledge-graph/io.mjs'
import { validateManifestSemantics } from './knowledge-graph/model.mjs'
import { renderAtlas } from './knowledge-graph/render.mjs'
import { compileSchema, loadSchema } from './knowledge-graph/schema.mjs'
import { assertNfc, JSON_LIMITS, parseStrictJson } from './knowledge-graph/strict-json.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const schemaPath = resolve(root, 'docs/knowledge-graph/schema/manifest.schema.json')
const sandbox = await mkdtemp(join(tmpdir(), 'swarm-knowledge-graph-'))
const recoveryId = 'service:runtime-recovery'

const authority = (id, kind, title, file) => ({
  id, kind, title, anchors: [{ file }], ownerAuthority: { id, kind },
  config: { gates: [], defaultState: 'not-applicable', blockerCodes: [] },
  inject: { required: [], optional: [], provides: [] }, lifecycle: {},
  maturity: {
    implementation: { state: 'implemented', evidence: [] },
    verification: { state: 'static', evidence: [] },
    acceptance: { state: 'candidate' },
    availability: { state: 'always-registered', conditions: [], blockers: [] },
  },
  security: { authoritySource: { id, kind }, callerIdentity: 'none', mutation: 'none', dataClasses: ['public'], guards: [], redlines: [] },
  bounds: [], tags: [],
})

function node(id, kind, title, owner, extra = {}) {
  return {
    id, kind, title, anchors: [{ file: 'src/index.ts' }], ownerAuthority: owner,
    config: { gates: [], defaultState: 'enabled', blockerCodes: [] },
    inject: { required: [], optional: [], provides: [] }, lifecycle: {},
    maturity: {
      implementation: { state: 'implemented', evidence: [] },
      verification: { state: 'unit', evidence: [] },
      acceptance: { state: 'candidate' },
      availability: { state: 'always-registered', conditions: [], blockers: [] },
    },
    security: { authoritySource: owner, callerIdentity: 'internal-provider', mutation: 'read', dataClasses: ['team'], guards: [], redlines: [] },
    bounds: [], tags: [], ...extra,
  }
}

function minimalManifest() {
  const team = { id: 'domain:agent-swarm', kind: 'domain' }
  const session = { id: 'official-authority:session', kind: 'official-authority' }
  const recovery = { id: 'service:runtime-recovery', kind: 'service' }
  const nodes = [
    authority(team.id, team.kind, 'Team domain', 'src/domain/team-domain.ts'),
    node('entity:attempt', 'entity', 'Attempt', team),
    node('fence:attempt-id', 'fence', 'Attempt fence', team),
    node('flow-branch:assignment/normal', 'flow-branch', 'Assignment normal branch', team, { contract: { nodeKind: 'flow-branch', flow: { id: 'flow:assignment', kind: 'flow' } } }),
    node('flow:assignment', 'flow', 'Assignment flow', team),
    authority(session.id, session.kind, 'Official Session authority', 'docs/OFFICIAL_BASELINE.json'),
    node('checkpoint:session-accepted', 'checkpoint', 'Session accepted frame', session),
    node('consumer:assignment', 'consumer', 'Assignment consumer', team),
    node('provider:subagent', 'provider', 'Official Subagent provider', session),
    node(recovery.id, recovery.kind, 'Runtime recovery service', team, { lifecycle: { recoveryOwner: recovery } }),
    node('state-predicate:attempt-reserved', 'state-predicate', 'Attempt is reserved', team, {
      contract: { nodeKind: 'state-predicate', predicate: { entity: { id: 'entity:attempt', kind: 'entity' }, field: { schema: { id: 'entity:attempt', kind: 'entity' }, selector: 'attemptId' }, operator: 'present' } },
    }),
    node('transaction:acknowledge-assignment', 'transaction', 'Acknowledge assignment', team),
  ].sort((a, b) => a.id.localeCompare(b.id))
  const edge = (id, type, from, to, extra = {}) => ({ id, type, from, to, anchors: [{ file: 'src/index.ts' }], ...extra })
  const edges = [
    edge('edge:assignment/branch', 'contains', { id: 'flow:assignment', kind: 'flow' }, { id: 'flow-branch:assignment/normal', kind: 'flow-branch' }),
    edge('edge:attempt/authority', 'persists-in', { id: 'entity:attempt', kind: 'entity' }, team),
    edge('edge:consumer/service', 'consumes', { id: 'consumer:assignment', kind: 'consumer' }, recovery),
    edge('edge:recovery/checkpoint', 'reads', recovery, { id: 'checkpoint:session-accepted', kind: 'checkpoint' }),
    edge('edge:recovery/fence', 'reads', recovery, { id: 'fence:attempt-id', kind: 'fence' }),
    edge('edge:recovery/predicate', 'reads', recovery, { id: 'state-predicate:attempt-reserved', kind: 'state-predicate' }),
    edge('edge:recovery/transaction', 'calls', recovery, { id: 'transaction:acknowledge-assignment', kind: 'transaction' }),
    edge('edge:runtime/subagent-effect', 'calls', recovery, { id: 'provider:subagent', kind: 'provider' }, {
      crash: {
        flow: { id: 'flow:assignment', kind: 'flow' }, branch: { id: 'flow-branch:assignment/normal', kind: 'flow-branch' }, ordinal: 0,
        phase: 'external-effect', durability: 'external-unknown', recoveryMode: 'state-changing', expectedBefore: [{ id: 'state-predicate:attempt-reserved', kind: 'state-predicate' }],
        committedAfter: [{ id: 'state-predicate:attempt-reserved', kind: 'state-predicate' }], checkpoint: { id: 'checkpoint:session-accepted', kind: 'checkpoint' },
        fences: [{ id: 'fence:attempt-id', kind: 'fence' }], recoveryTransactions: [{ id: 'transaction:acknowledge-assignment', kind: 'transaction' }], failureCode: 'SUBAGENT_RESULT_UNKNOWN', authoritativePostState: 'unknown',
        idempotency: { domainTag: 'dsh-agent-swarm/assignment/v1', components: [{ source: { id: 'transaction:acknowledge-assignment', kind: 'transaction' }, kind: 'transaction-input', selector: 'attemptId' }] },
        retryRule: 'exact-readback-first', recoveryOwner: recovery,
      },
    }),
    edge('edge:transaction/attempt', 'mutates', { id: 'transaction:acknowledge-assignment', kind: 'transaction' }, { id: 'entity:attempt', kind: 'entity' }),
  ].sort((a, b) => a.id.localeCompare(b.id))
  return {
    schemaVersion: 1,
    project: { id: 'dsh-agent-swarm', sourceRoot: 'src', packageManifest: 'package.json' },
    inventoryPolicy: { sourceGlobs: ['src/**/*.ts', 'src/**/*.tsx'], importedAssetGlobs: [], excludedFiles: [] },
    nodes, edges, exceptions: [],
  }
}

function expectCode(name, code, action) {
  try {
    action()
  } catch (error) {
    if (error instanceof KnowledgeGraphError && error.code === code) return
    throw new Error(`${name}: expected ${code}, got ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`${name}: expected ${code}, but action passed`)
}

try {
  const schema = await loadSchema(schemaPath)
  const validateSchema = compileSchema(schema)
  const manifest = minimalManifest()
  validateSchema(manifest)
  const summary = validateManifestSemantics(root, manifest)
  if (summary.digest !== graphDigest(manifest)) throw new Error('positive: digest mismatch')

  const once = renderAtlas(manifest, summary.digest)
  const twice = renderAtlas(parseStrictJson(canonicalJson(manifest), 'roundtrip'), summary.digest)
  if (JSON.stringify([...once]) !== JSON.stringify([...twice])) throw new Error('positive: generation is nondeterministic')
  const output = join(sandbox, 'generated')
  await writeGeneratedFiles(output, once)
  await compareGeneratedFiles(output, twice)

  expectCode('duplicate-key', 'KG_JSON_DUPLICATE_KEY', () => parseStrictJson('{"x":1,"x":2}', 'duplicate'))
  parseStrictJson(`${'['.repeat(JSON_LIMITS.depth)}0${']'.repeat(JSON_LIMITS.depth)}`, 'depth-boundary')
  expectCode('depth-limit', 'KG_JSON_DEPTH_LIMIT', () => parseStrictJson(`${'['.repeat(JSON_LIMITS.depth + 1)}0${']'.repeat(JSON_LIMITS.depth + 1)}`, 'deep'))
  parseStrictJson(`"${'x'.repeat(JSON_LIMITS.stringCodeUnits)}"`, 'string-boundary')
  expectCode('string-limit', 'KG_JSON_STRING_LIMIT', () => parseStrictJson(`"${'x'.repeat(JSON_LIMITS.stringCodeUnits + 1)}"`, 'long-string'))
  expectCode('size-limit', 'KG_JSON_SIZE_LIMIT', () => parseStrictJson(`"${'x'.repeat(JSON_LIMITS.bytes)}"`, 'oversize'))
  expectCode('token-limit', 'KG_JSON_TOKEN_LIMIT', () => parseStrictJson(`[${'0,'.repeat(JSON_LIMITS.tokens)}0]`, 'many-tokens'))
  expectCode('non-nfc', 'KG_JSON_NON_NFC', () => assertNfc({ title: 'e\u0301' }))
  expectCode('dynamic-field', 'KG_DYNAMIC_FIELD', () => validateManifestSemantics(root, { ...manifest, runId: 'live' }))
  expectCode('duplicate-node', 'KG_DUPLICATE_NODE', () => {
    const broken = structuredClone(manifest)
    broken.nodes.splice(1, 0, structuredClone(broken.nodes[0]))
    validateManifestSemantics(root, broken)
  })
  expectCode('authority-as-recovery', 'KG_RECOVERY_EXECUTOR', () => {
    const broken = structuredClone(manifest)
    broken.nodes.find(item => item.id === recoveryId).lifecycle.recoveryOwner = { id: 'domain:agent-swarm', kind: 'domain' }
    validateManifestSemantics(root, broken)
  })
  expectCode('illegal-edge', 'KG_EDGE_KIND', () => {
    const broken = structuredClone(manifest)
    broken.edges.find(item => item.id === 'edge:transaction/attempt').from = { id: 'entity:attempt', kind: 'entity' }
    validateManifestSemantics(root, broken)
  })
  expectCode('blind-retry', 'KG_BLIND_RETRY', () => {
    const broken = structuredClone(manifest)
    broken.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash.retryRule = 'same-fenced-operation'
    validateManifestSemantics(root, broken)
  })
  expectCode('empty-committed-state', 'KG_RECOVERY_COMMITTED_STATE', () => {
    const broken = structuredClone(manifest)
    broken.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash.committedAfter = []
    validateManifestSemantics(root, broken)
  })
  expectCode('state-changing-missing-transaction-call', 'KG_RECOVERY_TRANSACTION_CLOSURE', () => {
    const broken = structuredClone(manifest)
    broken.edges = broken.edges.filter(item => item.id !== 'edge:recovery/transaction')
    validateManifestSemantics(root, broken)
  })
  expectCode('observe-with-transaction', 'KG_RECOVERY_OBSERVE_MUTATION', () => {
    const broken = structuredClone(manifest)
    const crash = broken.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash
    crash.recoveryMode = 'observe-block'
    crash.committedAfter = []
    validateManifestSemantics(root, broken)
  })
  expectCode('observe-with-mutation-relation', 'KG_TRANSACTION_RELATION', () => {
    const broken = structuredClone(manifest)
    const crash = broken.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash
    crash.recoveryMode = 'observe-block'
    crash.committedAfter = []
    crash.recoveryTransactions = []
    broken.edges = broken.edges.filter(item => item.id !== 'edge:recovery/transaction')
    broken.edges.push({ id: 'edge:recovery/invalid-mutation', type: 'mutates', from: { id: recoveryId, kind: 'service' }, to: { id: 'transaction:acknowledge-assignment', kind: 'transaction' }, anchors: [{ file: 'src/index.ts' }] })
    broken.edges.sort((a, b) => a.id.localeCompare(b.id))
    validateManifestSemantics(root, broken)
  })
  expectCode('observe-with-committed-state', 'KG_RECOVERY_OBSERVE_MUTATION', () => {
    const broken = structuredClone(manifest)
    const crash = broken.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash
    crash.recoveryMode = 'observe-block'
    crash.recoveryTransactions = []
    validateManifestSemantics(root, broken)
  })
  expectCode('idempotency-kind-mismatch', 'KG_IDEMPOTENCY_REF', () => {
    const broken = structuredClone(manifest)
    broken.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash.idempotency.components[0].kind = 'entity-field'
    validateManifestSemantics(root, broken)
  })
  expectCode('dangling-crash-ref', 'KG_CRASH_REF', () => {
    const broken = structuredClone(manifest)
    broken.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash.checkpoint = { id: 'checkpoint:missing', kind: 'checkpoint' }
    validateManifestSemantics(root, broken)
  })
  expectCode('missing-session-read', 'KG_RECOVERY_READ_CLOSURE', () => {
    const broken = structuredClone(manifest)
    broken.edges = broken.edges.filter(item => item.id !== 'edge:recovery/checkpoint')
    validateManifestSemantics(root, broken)
  })
  expectCode('missing-target-mutation', 'KG_RECOVERY_MUTATION_CLOSURE', () => {
    const broken = structuredClone(manifest)
    broken.edges = broken.edges.filter(item => item.id !== 'edge:transaction/attempt')
    validateManifestSemantics(root, broken)
  })
  expectCode('wrong-persistence-owner', 'KG_OWNER_EDGE', () => {
    const broken = structuredClone(manifest)
    broken.edges.find(item => item.id === 'edge:attempt/authority').to = { id: 'official-authority:session', kind: 'official-authority' }
    validateManifestSemantics(root, broken)
  })
  expectCode('multiple-state-owners', 'KG_MULTIPLE_OWNERS', () => {
    const broken = structuredClone(manifest)
    broken.edges.push(
      { id: 'edge:attempt/owner-official', type: 'owns', from: { id: 'official-authority:session', kind: 'official-authority' }, to: { id: 'entity:attempt', kind: 'entity' }, anchors: [{ file: 'src/index.ts' }] },
      { id: 'edge:attempt/owner-team', type: 'owns', from: { id: 'domain:agent-swarm', kind: 'domain' }, to: { id: 'entity:attempt', kind: 'entity' }, anchors: [{ file: 'src/index.ts' }] },
    )
    broken.edges.sort((a, b) => a.id.localeCompare(b.id))
    validateManifestSemantics(root, broken)
  })
  {
    const observeOnly = structuredClone(manifest)
    const crash = observeOnly.edges.find(item => item.id === 'edge:runtime/subagent-effect').crash
    crash.recoveryMode = 'observe-block'
    crash.committedAfter = []
    crash.recoveryTransactions = []
    validateManifestSemantics(root, observeOnly)
  }
  await writeFile(join(output, 'availability.md'), 'manual edit\n', 'utf8')
  try {
    await compareGeneratedFiles(output, once)
    throw new Error('manual-edit: expected KG_GENERATED_DRIFT')
  } catch (error) {
    if (!(error instanceof KnowledgeGraphError) || error.code !== 'KG_GENERATED_DRIFT') throw error
  }

  await writeGeneratedFiles(output, once)
  await mkdir(join(output, 'stale-directory'))
  try {
    await compareGeneratedFiles(output, once)
    throw new Error('unexpected-directory: expected KG_GENERATED_FILESET')
  } catch (error) {
    if (!(error instanceof KnowledgeGraphError) || error.code !== 'KG_GENERATED_FILESET') throw error
  }
  await rm(join(output, 'stale-directory'), { recursive: true })
  const preserved = join(output, 'operator-note.txt')
  await writeFile(preserved, 'preserve me\n', 'utf8')
  try {
    await writeGeneratedFiles(output, once)
    throw new Error('unknown-file-write: expected KG_GENERATED_FILESET')
  } catch (error) {
    if (!(error instanceof KnowledgeGraphError) || error.code !== 'KG_GENERATED_FILESET') throw error
  }
  if (await readFile(preserved, 'utf8') !== 'preserve me\n') throw new Error('unknown-file-write: unknown file was modified')

  expectCode('absolute-output', 'KG_OUTPUT_SCOPE', () => resolveGeneratedOutputRoot(root, resolve(sandbox, 'outside')))
  expectCode('parent-output', 'KG_OUTPUT_SCOPE', () => resolveGeneratedOutputRoot(root, '../outside'))
  expectCode('root-output', 'KG_OUTPUT_SCOPE', () => resolveGeneratedOutputRoot(root, '.'))
  expectCode('dot-output', 'KG_OUTPUT_SCOPE', () => resolveGeneratedOutputRoot(root, 'docs/generated/knowledge-graph/.'))
  expectCode('normalized-parent-output', 'KG_OUTPUT_SCOPE', () => resolveGeneratedOutputRoot(root, 'docs/generated/knowledge-graph/../knowledge-graph'))
  expectCode('prefixed-dot-output', 'KG_OUTPUT_SCOPE', () => resolveGeneratedOutputRoot(root, './docs/generated/knowledge-graph'))
  const fakeRoot = join(sandbox, 'fake-project')
  const outside = join(sandbox, 'junction-target')
  await mkdir(join(fakeRoot, 'docs', 'generated'), { recursive: true })
  await mkdir(outside)
  await symlink(outside, join(fakeRoot, 'docs', 'generated', 'knowledge-graph'), 'junction')
  expectCode('junction-output', 'KG_OUTPUT_SYMLINK', () => resolveGeneratedOutputRoot(fakeRoot))

  const hostile = structuredClone(manifest)
  hostile.nodes[0].title = '<img src=x onerror=alert(1)>\u2028line\u0001'
  const hostileView = renderAtlas(hostile, graphDigest(hostile)).get('domain-state.md')
  if (hostileView.includes('<img') || hostileView.includes('\u2028') || hostileView.includes('\u0001')) throw new Error('renderer-injection: raw hostile label survived')
  if (!hostileView.includes('&lt;img') || !hostileView.includes('&#8232;') || !hostileView.includes('&#1;')) throw new Error('renderer-injection: expected escaping missing')

  const unknown = structuredClone(manifest)
  unknown.unknownField = true
  try {
    validateSchema(unknown)
    throw new Error('unknown-field: expected KG_SCHEMA_MISMATCH')
  } catch (error) {
    if (!(error instanceof KnowledgeGraphError) || error.code !== 'KG_SCHEMA_MISMATCH') throw error
  }

  console.log('Knowledge graph KG0 positive fixture, 34 negative cases, and 2 limit-boundary checks: PASS')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

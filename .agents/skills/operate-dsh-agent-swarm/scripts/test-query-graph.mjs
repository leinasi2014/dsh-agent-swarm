import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runQuery } from './query-graph.mjs'

const root = join(tmpdir(), `dsh-graph-query-${process.pid}-${Date.now()}`)
const atlasPath = join(root, 'docs', 'generated', 'knowledge-graph', 'atlas.json')
const maturity = {
  implementation: { state: 'implemented', evidence: [] },
  verification: { state: 'static', evidence: [] },
  acceptance: { state: 'candidate' },
  availability: { state: 'always-registered', conditions: [], blockers: [] },
}
const node = (id, title, classification = 'reviewed') => ({
  id, kind: 'service', title, classification, tags: [], anchors: [{ file: `src/${id.slice(8)}.ts` }],
  maturity: classification === 'mechanical' ? {
    ...maturity, verification: { state: 'none', evidence: [] }, acceptance: { state: 'not-candidate' },
  } : maturity,
})
const atlas = {
  schemaVersion: 1,
  manifestDigest: 'fixture-digest',
  graph: {
    schemaVersion: 2,
    nodes: [node('service:alpha', 'Alpha service'), node('service:alpha-two', 'Alpha alternate'), node('service:beta', 'Beta service'), node('service:mechanical', 'Mechanical location', 'mechanical')],
    edges: [
      { id: 'edge:alpha-beta', type: 'calls', classification: 'reviewed', from: { id: 'service:alpha' }, to: { id: 'service:beta' }, anchors: [{ file: 'src/alpha.ts' }] },
      { id: 'edge:beta-mechanical', type: 'contains', classification: 'mechanical', from: { id: 'service:beta' }, to: { id: 'service:mechanical' }, anchors: [{ file: 'src/beta.ts' }] },
    ],
  },
}
const pass = async (_projectRoot, env) => {
  assert.equal(env.KG_GENERATED_FIXTURE, 'forwarded')
  return { status: 0, stdout: 'PASS', stderr: '' }
}
const run = args => runQuery(args, { projectRoot: root, verify: pass, env: { KG_GENERATED_FIXTURE: 'forwarded' } })

try {
  await mkdir(join(root, 'docs', 'generated', 'knowledge-graph'), { recursive: true })
  await writeFile(atlasPath, JSON.stringify(atlas), 'utf8')

  const positive = await run(['show', 'service:alpha'])
  assert.equal(positive.exitCode, 0)
  assert.equal(positive.value.data.node.id, 'service:alpha')
  assert.deepEqual(positive.value.data.node.maturity, maturity)
  assert.equal((await run(['check'])).value.data.runtimeAuthority, false)
  assert.deepEqual((await run(['anchors', 'service:alpha'])).value.data.anchors, [{ file: 'src/alpha.ts' }])

  const missingNode = await run(['show', 'does-not-exist'])
  assert.equal(missingNode.value.error.code, 'KG_QUERY_NOT_FOUND')

  const ambiguous = await run(['show', 'Alpha'])
  assert.equal(ambiguous.value.error.code, 'KG_QUERY_AMBIGUOUS')
  assert.equal(ambiguous.value.error.details.candidates.length, 2)

  const limited = await run(['search', 'alpha', '--limit', '1'])
  assert.equal(limited.value.data.matches.length, 1)
  assert.equal(limited.value.data.truncated, true)
  assert.equal((await run(['search', 'alpha', '--limit', '101'])).value.error.code, 'KG_QUERY_LIMIT')
  const environmentLimited = await runQuery(['search', 'alpha'], {
    projectRoot: root,
    verify: pass,
    env: { KG_GENERATED_FIXTURE: 'forwarded', KG_QUERY_LIMIT: '1' },
  })
  assert.equal(environmentLimited.value.data.matches.length, 1)
  assert.equal(environmentLimited.value.data.truncated, true)

  const path = await run(['path', 'service:alpha', 'service:mechanical', '--depth', '2'])
  assert.equal(path.value.data.depth, 2)
  assert.deepEqual(path.value.data.nodes.map(item => item.id), ['service:alpha', 'service:beta', 'service:mechanical'])

  const mechanical = await run(['show', 'service:mechanical'])
  assert.equal(mechanical.value.data.interpretation.scope, 'source-location-only')
  assert.equal(mechanical.value.data.interpretation.runtimeAuthority, false)

  const realtime = await run(['search', 'current runtime status'])
  assert.equal(realtime.value.error.code, 'KG_QUERY_RUNTIME_AUTHORITY')

  const stableA = await run(['edges', 'service:alpha'])
  const stableB = await run(['edges', 'service:alpha'])
  assert.equal(JSON.stringify(stableA.value), JSON.stringify(stableB.value))

  const drift = await runQuery(['check'], {
    projectRoot: root,
    verify: async () => ({ status: 1, stdout: '', stderr: 'KG_GENERATED_DRIFT: atlas.json differs from deterministic output' }),
  })
  assert.equal(drift.value.error.code, 'KG_GENERATED_DRIFT')

  const generatedMissing = await runQuery(['check'], {
    projectRoot: root,
    verify: async () => ({ status: 1, stdout: '', stderr: 'KG_GENERATED_MISSING: generated directory is missing' }),
  })
  assert.equal(generatedMissing.value.error.code, 'KG_GENERATED_MISSING')

  await rm(atlasPath)
  const missing = await run(['check'])
  assert.equal(missing.value.error.code, 'KG_QUERY_ATLAS_MISSING')

  console.log('Operate-skill graph helper positive, not-found, ambiguous, limit, path, missing, drift, mechanical, runtime-authority, and stable-output cases: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}
